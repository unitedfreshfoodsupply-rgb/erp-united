-- Phased opening migration (Nov 2026). The business enters its opening position in phases:
-- suppliers first, customers later, then the rest (cash, banks, stock, assets, capital…) once
-- the legacy trial balance is known. Each phase is an approved batch posted against a dedicated,
-- provisional clearing account (3900); the migration closes only when every reconciliation
-- passes, the clearing account is back to zero and a second person approves. Additive: two new
-- tables, nullable columns, one new account, widened CHECKs, guards. No row is changed.

-- 1. The provisional clearing account. Equity, under 3000, beside opening-balance equity (3300).
--    Its classification is provisional until the accountant approves it (decision AD-1).
INSERT INTO "Account" ("id", "code", "name", "nameAr", "type", "parentId", "postable", "systemKey", "cashFlowCategory") VALUES
  ('acc_3900', '3900', 'Opening balance clearing (provisional)', 'حساب وسيط الأرصدة الافتتاحية (مؤقت)', 'equity', 'acc_3000', true, 'opening_clearing', 'financing')
ON CONFLICT DO NOTHING;

-- Only opening batches move it: a manual journal, a document or a reversal on it is refused here
-- as well as in the application (CONTROL_ACCOUNTS).
CREATE OR REPLACE FUNCTION opening_clearing_guard() RETURNS trigger AS $$
DECLARE k text; st text;
BEGIN
  SELECT a."systemKey" INTO k FROM "Account" a WHERE a."id" = NEW."accountId";
  IF k IS DISTINCT FROM 'opening_clearing' THEN RETURN NEW; END IF;
  SELECT e."sourceType" INTO st FROM "JournalEntry" e WHERE e."id" = NEW."entryId";
  IF st IS DISTINCT FROM 'opening_batch' AND st IS DISTINCT FROM 'opening_balance' THEN
    RAISE EXCEPTION 'the opening clearing account is moved by opening batches only' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION opening_clearing_guard() FROM PUBLIC;
CREATE TRIGGER "JournalLine_opening_clearing" BEFORE INSERT ON "JournalLine" FOR EACH ROW EXECUTE FUNCTION opening_clearing_guard();

-- 2. The migration itself: one per company, open → closing (closure requested) → closed.
CREATE TABLE "OpeningMigration" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT 'opening',
    "cutoverDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "notes" TEXT,
    "attestations" JSONB,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closeRequestedById" TEXT,
    "closeRequestedBy" TEXT,
    "closeRequestedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closeEvidence" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "OpeningMigration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OpeningMigration_values" CHECK ("key" = 'opening' AND "status" IN ('open', 'closing', 'closed')
      AND "cutoverDate" ~ '^\d{4}-\d{2}-\d{2}$' AND (("status" = 'closed') = ("closedAt" IS NOT NULL)))
);
CREATE UNIQUE INDEX "OpeningMigration_key_key" ON "OpeningMigration"("key");

-- Never deleted; once closed it stays closed, with its date.
CREATE OR REPLACE FUNCTION opening_migration_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'OpeningMigration is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD."status" = 'closed' THEN RAISE EXCEPTION 'a closed opening migration does not change' USING ERRCODE = 'restrict_violation'; END IF;
  IF NEW."cutoverDate" IS DISTINCT FROM OLD."cutoverDate" THEN RAISE EXCEPTION 'the opening migration keeps its cut-off date' USING ERRCODE = 'restrict_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION opening_migration_guard() FROM PUBLIC;
CREATE TRIGGER "OpeningMigration_guard" BEFORE UPDATE OR DELETE ON "OpeningMigration" FOR EACH ROW EXECUTE FUNCTION opening_migration_guard();

-- 3. Source rows that could not be posted (no ERP record, wrong category, a figure to decide):
--    kept, each with its evidence, until resolved or excluded with a reason.
CREATE TABLE "OpeningException" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "sourceRow" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceAmount" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolvedById" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "OpeningException_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OpeningException_values" CHECK ("segment" IN ('suppliers', 'customers', 'other') AND "status" IN ('open', 'resolved', 'excluded')
      AND length(btrim("sourceFile")) > 0 AND length(btrim("sourceRow")) > 0 AND length(btrim("reason")) > 0
      AND (("status" = 'open') = ("resolvedAt" IS NULL)) AND ("status" = 'open' OR length(btrim(coalesce("resolution", ''))) > 0))
);
CREATE UNIQUE INDEX "OpeningException_migrationId_segment_sourceFile_sourceRow_key" ON "OpeningException"("migrationId", "segment", "sourceFile", "sourceRow");
CREATE INDEX "OpeningException_migrationId_status_idx" ON "OpeningException"("migrationId", "status");
ALTER TABLE "OpeningException" ADD CONSTRAINT "OpeningException_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "OpeningMigration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An exception is never deleted, and a decided one stays decided.
CREATE OR REPLACE FUNCTION opening_exception_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'OpeningException is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD."status" <> 'open' THEN RAISE EXCEPTION 'a decided opening exception does not change' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW."migrationId", NEW."segment", NEW."sourceFile", NEW."sourceRow", NEW."sourceName", NEW."sourceAmount") IS DISTINCT FROM (OLD."migrationId", OLD."segment", OLD."sourceFile", OLD."sourceRow", OLD."sourceName", OLD."sourceAmount") THEN
    RAISE EXCEPTION 'an opening exception keeps its source evidence' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION opening_exception_guard() FROM PUBLIC;
CREATE TRIGGER "OpeningException_guard" BEFORE UPDATE OR DELETE ON "OpeningException" FOR EACH ROW EXECUTE FUNCTION opening_exception_guard();

-- 4. Phase batches: kind 'phase' with a segment, inside the migration, with the source file.
ALTER TABLE "OpeningBatch" ADD COLUMN "migrationId" TEXT;
ALTER TABLE "OpeningBatch" ADD COLUMN "segment" TEXT;
ALTER TABLE "OpeningBatch" ADD COLUMN "sourceFile" TEXT;
ALTER TABLE "OpeningBatch" ADD COLUMN "sourceSha256" TEXT;
ALTER TABLE "OpeningBatch" ADD CONSTRAINT "OpeningBatch_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "OpeningMigration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "OpeningBatch_migrationId_idx" ON "OpeningBatch"("migrationId");
ALTER TABLE "OpeningBatch" DROP CONSTRAINT "OpeningBatch_values";
ALTER TABLE "OpeningBatch" ADD CONSTRAINT "OpeningBatch_values" CHECK ("kind" IN ('initial', 'correction', 'phase') AND "status" IN ('draft', 'pending_approval', 'posted', 'cancelled')
  AND "cutoverDate" ~ '^\d{4}-\d{2}-\d{2}$' AND (("status" = 'posted') = ("postedAt" IS NOT NULL)));
ALTER TABLE "OpeningBatch" ADD CONSTRAINT "OpeningBatch_phase" CHECK (
  ("kind" = 'phase') = ("migrationId" IS NOT NULL AND "segment" IS NOT NULL)
  AND ("segment" IS NULL OR "segment" IN ('suppliers', 'customers', 'other'))
  AND ("sourceSha256" IS NULL OR "sourceSha256" ~ '^[0-9a-f]{64}$'));

-- The guard also keeps a submitted batch's migration, segment and source.
CREATE OR REPLACE FUNCTION opening_batch_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'OpeningBatch is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD."status" IN ('posted', 'cancelled') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'a posted or cancelled opening batch keeps its status' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."number", NEW."kind", NEW."cutoverDate", NEW."migrationId", NEW."segment", NEW."sourceFile", NEW."sourceSha256") IS DISTINCT FROM (OLD."number", OLD."kind", OLD."cutoverDate", OLD."migrationId", OLD."segment", OLD."sourceFile", OLD."sourceSha256") AND OLD."status" <> 'draft' THEN
    RAISE EXCEPTION 'a submitted opening batch keeps its dates' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;

-- A line may also move opening-balance equity into the clearing account (equity_transfer).
ALTER TABLE "OpeningBatchLine" DROP CONSTRAINT "OpeningBatchLine_values";
ALTER TABLE "OpeningBatchLine" ADD CONSTRAINT "OpeningBatchLine_values" CHECK ("kind" IN ('gl', 'customer', 'supplier', 'stock', 'asset', 'equity_transfer') AND "debit" >= 0 AND "credit" >= 0);

-- 5. A party opening balance names the batch that posted it (NULL: a direct entry or an
--    initial/correction batch from before this change). Set on insert only (append-only table).
ALTER TABLE "PartyOpeningBalance" ADD COLUMN "openingBatchId" TEXT;
ALTER TABLE "PartyOpeningBalance" ADD CONSTRAINT "PartyOpeningBalance_openingBatchId_fkey" FOREIGN KEY ("openingBatchId") REFERENCES "OpeningBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "PartyOpeningBalance_openingBatchId_idx" ON "PartyOpeningBalance"("openingBatchId");

ALTER TABLE "OpeningMigration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OpeningException" ENABLE ROW LEVEL SECURITY;
