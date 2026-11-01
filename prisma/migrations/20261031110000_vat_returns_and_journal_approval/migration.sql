-- VAT returns (settlement of input against output VAT, payment to the tax authority, and
-- the lock on a filed period) and manual journals waiting for approval. Additive.

-- 1. VAT returns.
CREATE TABLE "VatReturn" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "periodFrom" TEXT NOT NULL,
    "periodTo" TEXT NOT NULL,
    -- GL balances at periodTo (before the settlement): output VAT owed, input VAT claimable
    -- (including any credit carried forward from earlier returns).
    "outputTax" DECIMAL(18,2) NOT NULL,
    "inputTax" DECIMAL(18,2) NOT NULL,
    -- Input set off against output; what is owed to the authority; input carried forward.
    "inputUsed" DECIMAL(18,2) NOT NULL,
    "payable" DECIMAL(18,2) NOT NULL,
    "carryForward" DECIMAL(18,2) NOT NULL,
    -- The documents' own totals for the period (the VAT summary), kept as filed.
    "documentsOutputTax" DECIMAL(18,2) NOT NULL,
    "documentsInputTax" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL,
    "entryId" TEXT,
    "filedById" TEXT,
    "filedBy" TEXT NOT NULL,
    "filedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference" TEXT,
    "notes" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidBy" TEXT,
    "paymentDate" TEXT,
    "paymentCashAccountId" TEXT,
    "paymentReference" TEXT,
    "paymentEntryId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "voidEntryId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "VatReturn_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VatReturn_dates" CHECK ("periodFrom" ~ '^\d{4}-\d{2}-\d{2}$' AND "periodTo" ~ '^\d{4}-\d{2}-\d{2}$' AND "periodFrom" <= "periodTo"),
    CONSTRAINT "VatReturn_status_known" CHECK ("status" IN ('filed', 'paid', 'voided')),
    CONSTRAINT "VatReturn_amounts" CHECK ("outputTax" >= 0 AND "inputTax" >= 0 AND "inputUsed" >= 0 AND "payable" >= 0 AND "carryForward" >= 0
      AND "inputUsed" <= "inputTax" AND "inputUsed" <= "outputTax" AND "payable" = "outputTax" - "inputUsed" AND "carryForward" = "inputTax" - "inputUsed"),
    CONSTRAINT "VatReturn_paid" CHECK (("status" = 'paid') = ("paidAt" IS NOT NULL) AND ("paidAt" IS NULL OR ("paymentEntryId" IS NOT NULL OR "payable" = 0))),
    CONSTRAINT "VatReturn_voided" CHECK (("status" = 'voided') = ("voidedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "VatReturn_number_key" ON "VatReturn"("number");
CREATE UNIQUE INDEX "VatReturn_entryId_key" ON "VatReturn"("entryId");
CREATE UNIQUE INDEX "VatReturn_paymentEntryId_key" ON "VatReturn"("paymentEntryId");
CREATE UNIQUE INDEX "VatReturn_voidEntryId_key" ON "VatReturn"("voidEntryId");
CREATE INDEX "VatReturn_periodTo_idx" ON "VatReturn"("periodTo");
-- Two live returns never cover the same day (a voided one frees its period). Checked by
-- a trigger under one lock rather than an exclusion constraint, so no extension is needed.
CREATE OR REPLACE FUNCTION vat_return_no_overlap() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'voided' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('accounting:vat-return'));
  IF EXISTS (SELECT 1 FROM "VatReturn" WHERE "id" <> NEW."id" AND "status" <> 'voided' AND "periodFrom" <= NEW."periodTo" AND "periodTo" >= NEW."periodFrom") THEN
    RAISE EXCEPTION 'VAT returns overlap (% – %)', NEW."periodFrom", NEW."periodTo" USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION vat_return_no_overlap() FROM PUBLIC;
CREATE TRIGGER "VatReturn_no_overlap" BEFORE INSERT OR UPDATE ON "VatReturn" FOR EACH ROW EXECUTE FUNCTION vat_return_no_overlap();
ALTER TABLE "VatReturn" ADD CONSTRAINT "VatReturn_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VatReturn" ADD CONSTRAINT "VatReturn_paymentEntryId_fkey" FOREIGN KEY ("paymentEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VatReturn" ADD CONSTRAINT "VatReturn_voidEntryId_fkey" FOREIGN KEY ("voidEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VatReturn" ADD CONSTRAINT "VatReturn_paymentCashAccountId_fkey" FOREIGN KEY ("paymentCashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A filed return keeps its figures; it moves filed → paid or filed → voided, once.
CREATE OR REPLACE FUNCTION vat_return_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'VatReturn is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW."number", NEW."periodFrom", NEW."periodTo", NEW."outputTax", NEW."inputTax", NEW."inputUsed", NEW."payable", NEW."carryForward", NEW."documentsOutputTax", NEW."documentsInputTax", NEW."entryId", NEW."filedBy", NEW."filedAt")
     IS DISTINCT FROM (OLD."number", OLD."periodFrom", OLD."periodTo", OLD."outputTax", OLD."inputTax", OLD."inputUsed", OLD."payable", OLD."carryForward", OLD."documentsOutputTax", OLD."documentsInputTax", OLD."entryId", OLD."filedBy", OLD."filedAt") THEN
    RAISE EXCEPTION 'a filed VAT return keeps its figures' USING ERRCODE = 'restrict_violation';
  END IF;
  -- filed → paid | voided. A nil return is "paid" on filing (nothing to pay, no payment
  -- entry); it may still be voided. A return actually paid keeps its status.
  IF OLD."status" <> 'filed' AND NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'paid' AND NEW."status" = 'voided' AND OLD."payable" = 0 AND OLD."paymentEntryId" IS NULL) THEN
    RAISE EXCEPTION 'a paid or voided VAT return keeps its status' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION vat_return_guard() FROM PUBLIC;
CREATE TRIGGER "VatReturn_guard" BEFORE UPDATE OR DELETE ON "VatReturn" FOR EACH ROW EXECUTE FUNCTION vat_return_guard();

-- Nothing but the return itself moves input or output VAT inside a filed period: the
-- figures the authority received stay the figures in the ledger.
CREATE OR REPLACE FUNCTION vat_period_lock() RETURNS trigger AS $$
DECLARE k text; e record;
BEGIN
  SELECT "systemKey" INTO k FROM "Account" WHERE "id" = NEW."accountId";
  IF k IS NULL OR k NOT IN ('vat_input', 'vat_output') THEN RETURN NEW; END IF;
  SELECT "date", "sourceType" INTO e FROM "JournalEntry" WHERE "id" = NEW."entryId";
  IF e."sourceType" = 'vat_settlement' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM "VatReturn" WHERE "status" <> 'voided' AND e."date" BETWEEN "periodFrom" AND "periodTo") THEN
    RAISE EXCEPTION 'the VAT period of % is filed', e."date" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION vat_period_lock() FROM PUBLIC;
CREATE TRIGGER "JournalLine_vat_period_lock" BEFORE INSERT ON "JournalLine" FOR EACH ROW EXECUTE FUNCTION vat_period_lock();

ALTER TABLE "VatReturn" ENABLE ROW LEVEL SECURITY;

-- 2. Manual journals waiting for approval (above the threshold, when approval is on).
CREATE TABLE "JournalRequest" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL,
    "entryId" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "requestedById" TEXT,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "JournalRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JournalRequest_status_known" CHECK ("status" IN ('pending_approval', 'posted', 'rejected', 'cancelled')),
    CONSTRAINT "JournalRequest_total" CHECK ("total" > 0),
    CONSTRAINT "JournalRequest_posted_has_entry" CHECK (("status" = 'posted') = ("entryId" IS NOT NULL))
);
CREATE UNIQUE INDEX "JournalRequest_number_key" ON "JournalRequest"("number");
CREATE UNIQUE INDEX "JournalRequest_entryId_key" ON "JournalRequest"("entryId");
CREATE UNIQUE INDEX "JournalRequest_idempotencyKey_key" ON "JournalRequest"("idempotencyKey");
CREATE INDEX "JournalRequest_status_idx" ON "JournalRequest"("status");
ALTER TABLE "JournalRequest" ADD CONSTRAINT "JournalRequest_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION journal_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'JournalRequest is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW."number", NEW."date", NEW."description", NEW."lines", NEW."total", NEW."requestedBy", NEW."idempotencyKey")
     IS DISTINCT FROM (OLD."number", OLD."date", OLD."description", OLD."lines", OLD."total", OLD."requestedBy", OLD."idempotencyKey") THEN
    RAISE EXCEPTION 'a journal request keeps what was asked' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'pending_approval' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'a decided journal request keeps its status' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION journal_request_guard() FROM PUBLIC;
CREATE TRIGGER "JournalRequest_guard" BEFORE UPDATE OR DELETE ON "JournalRequest" FOR EACH ROW EXECUTE FUNCTION journal_request_guard();

ALTER TABLE "JournalRequest" ENABLE ROW LEVEL SECURITY;
