-- Opening balances as one controlled batch: staged lines (GL accounts, customers, suppliers,
-- stock, fixed assets), validated as one opening trial balance, approved by a second person,
-- posted once. Additive.

CREATE TABLE "OpeningBatch" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'initial',
    "cutoverDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedById" TEXT,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "postedAt" TIMESTAMP(3),
    "entryIds" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "OpeningBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OpeningBatch_values" CHECK ("kind" IN ('initial', 'correction') AND "status" IN ('draft', 'pending_approval', 'posted', 'cancelled')
      AND "cutoverDate" ~ '^\d{4}-\d{2}-\d{2}$' AND (("status" = 'posted') = ("postedAt" IS NOT NULL)))
);
CREATE UNIQUE INDEX "OpeningBatch_number_key" ON "OpeningBatch"("number");
CREATE UNIQUE INDEX "OpeningBatch_idempotencyKey_key" ON "OpeningBatch"("idempotencyKey");
-- One initial opening ever posts; corrections follow it.
CREATE UNIQUE INDEX "OpeningBatch_one_initial_posted" ON "OpeningBatch"("kind") WHERE "kind" = 'initial' AND "status" = 'posted';

CREATE TABLE "OpeningBatchLine" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "OpeningBatchLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OpeningBatchLine_values" CHECK ("kind" IN ('gl', 'customer', 'supplier', 'stock', 'asset') AND "debit" >= 0 AND "credit" >= 0)
);
CREATE UNIQUE INDEX "OpeningBatchLine_batchId_lineNo_key" ON "OpeningBatchLine"("batchId", "lineNo");
ALTER TABLE "OpeningBatchLine" ADD CONSTRAINT "OpeningBatchLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "OpeningBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A batch is never deleted; a posted or cancelled batch keeps its status, and a submitted
-- one keeps its kind and date.
CREATE OR REPLACE FUNCTION opening_batch_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'OpeningBatch is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD."status" IN ('posted', 'cancelled') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'a posted or cancelled opening batch keeps its status' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."number", NEW."kind", NEW."cutoverDate") IS DISTINCT FROM (OLD."number", OLD."kind", OLD."cutoverDate") AND OLD."status" <> 'draft' THEN
    RAISE EXCEPTION 'a submitted opening batch keeps its dates' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION opening_batch_guard() FROM PUBLIC;
CREATE TRIGGER "OpeningBatch_guard" BEFORE UPDATE OR DELETE ON "OpeningBatch" FOR EACH ROW EXECUTE FUNCTION opening_batch_guard();

-- Lines change only while their batch is a draft.
CREATE OR REPLACE FUNCTION opening_batch_line_frozen() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT "status" INTO st FROM "OpeningBatch" WHERE "id" = COALESCE(NEW."batchId", OLD."batchId");
  IF st <> 'draft' THEN RAISE EXCEPTION 'opening batch lines are frozen once submitted' USING ERRCODE = 'restrict_violation'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION opening_batch_line_frozen() FROM PUBLIC;
CREATE TRIGGER "OpeningBatchLine_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "OpeningBatchLine" FOR EACH ROW EXECUTE FUNCTION opening_batch_line_frozen();

ALTER TABLE "OpeningBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OpeningBatchLine" ENABLE ROW LEVEL SECURITY;
