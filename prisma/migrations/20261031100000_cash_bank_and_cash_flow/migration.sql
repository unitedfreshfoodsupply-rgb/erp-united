-- Cash and bank management, explicit cash-flow classification and the accounts the
-- fixed-asset and VAT-settlement work posts to. Additive: existing rows keep their values;
-- new columns are nullable or defaulted; no data is rewritten except the classification
-- of the seeded system accounts (which only the cash-flow report reads).

-- 1. Cash-flow classification per account (operating / investing / financing). NULL on a
--    postable non-cash balance-sheet account means "not classified yet": the report shows
--    it under operating and flags it so the accountant classifies it. Header accounts may
--    carry one so the accounts created under them inherit it.
ALTER TABLE "Account" ADD COLUMN "cashFlowCategory" TEXT;
ALTER TABLE "Account" ADD CONSTRAINT "Account_cashFlowCategory_known" CHECK ("cashFlowCategory" IS NULL OR "cashFlowCategory" IN ('operating', 'investing', 'financing'));
-- Accounts whose balance belongs to a subledger other than AR/AP/inventory (fixed assets):
-- manual journals and service-bill lines may not post to them directly.
ALTER TABLE "Account" ADD COLUMN "controlledBy" TEXT;
ALTER TABLE "Account" ADD CONSTRAINT "Account_controlledBy_known" CHECK ("controlledBy" IS NULL OR "controlledBy" IN ('fixed_assets'));

-- 2. Accounts for fixed assets and VAT settlement. Category cost / accumulated-depreciation
--    accounts are created under 1700 when a category is defined.
INSERT INTO "Account" ("id", "code", "name", "nameAr", "type", "parentId", "postable", "systemKey", "cashFlowCategory") VALUES
  ('acc_1700', '1700', 'Fixed assets', 'الأصول الثابتة', 'asset', 'acc_1000', false, NULL, 'investing'),
  ('acc_2250', '2250', 'VAT payable to the tax authority', 'ضريبة القيمة المضافة المستحقة للمصلحة', 'liability', 'acc_2000', true, 'vat_payable', 'operating'),
  ('acc_4300', '4300', 'Gain on disposal of fixed assets', 'أرباح بيع واستبعاد الأصول الثابتة', 'revenue', 'acc_4000', true, 'fa_disposal_gain', NULL),
  ('acc_6400', '6400', 'Depreciation', 'إهلاك الأصول الثابتة', 'expense', 'acc_6000', true, 'fa_depreciation', NULL),
  ('acc_6500', '6500', 'Loss on disposal of fixed assets', 'خسائر بيع واستبعاد الأصول الثابتة', 'expense', 'acc_6000', true, 'fa_disposal_loss', NULL)
ON CONFLICT ("id") DO NOTHING;

UPDATE "Account" SET "cashFlowCategory" = 'operating'
  WHERE "systemKey" IN ('ar', 'inventory', 'vat_input', 'employee_advances', 'ap', 'grni', 'vat_output', 'employee_payable', 'vat_payable') AND "cashFlowCategory" IS NULL;
UPDATE "Account" SET "cashFlowCategory" = 'financing'
  WHERE "systemKey" IN ('capital', 'retained_earnings', 'opening_equity') AND "cashFlowCategory" IS NULL;
UPDATE "Account" SET "cashFlowCategory" = 'operating' WHERE "id" IN ('acc_1000', 'acc_2000') AND "cashFlowCategory" IS NULL;
UPDATE "Account" SET "cashFlowCategory" = 'financing' WHERE "id" = 'acc_3000' AND "cashFlowCategory" IS NULL;

-- Journal sources added by this release (treasury, VAT returns, fiscal-year closing, fixed
-- assets, opening batches). Same rule otherwise.
ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_values";
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_values" CHECK (
  "number" ~ '^JE-[0-9]{4}-[0-9]{5,}$' AND "date" ~ '^\d{4}-\d{2}-\d{2}$' AND "total" > 0 AND length(btrim("description")) > 0
  AND "sourceType" IN ('manual', 'sales_invoice', 'credit_note', 'supplier_bill', 'debit_note', 'customer_receipt', 'supplier_payment', 'stock_valuation', 'reversal', 'expense', 'employee_transaction', 'opening_balance', 'receipt_reversal', 'payment_reversal', 'customer_refund', 'supplier_refund', 'payroll_run', 'payroll_payment',
    'cash_transfer', 'cash_transfer_reversal', 'vat_settlement', 'vat_payment', 'year_end_close', 'year_end_reopen', 'asset_acquisition', 'asset_improvement', 'asset_depreciation', 'asset_disposal', 'opening_batch')
  AND (("sourceType" = 'reversal') = ("reversalOfId" IS NOT NULL))
);

-- 3. Cash boxes and bank accounts: bank details and optimistic locking.
ALTER TABLE "CashAccount" ADD COLUMN "bankName" TEXT;
ALTER TABLE "CashAccount" ADD COLUMN "accountNumber" TEXT;
ALTER TABLE "CashAccount" ADD COLUMN "notes" TEXT;
ALTER TABLE "CashAccount" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "CashAccount_accountId_key" ON "CashAccount"("accountId");

-- 4. Transfers between cash boxes and bank accounts.
CREATE TABLE "CashTransfer" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "fromCashAccountId" TEXT NOT NULL,
    "toCashAccountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "fee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "feeAccountId" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL,
    "entryId" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "reversedBy" TEXT,
    "reversalReason" TEXT,
    "reversalEntryId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CashTransfer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CashTransfer_accounts_differ" CHECK ("fromCashAccountId" <> "toCashAccountId"),
    CONSTRAINT "CashTransfer_amounts" CHECK ("amount" > 0 AND "fee" >= 0 AND ("fee" = 0 OR "feeAccountId" IS NOT NULL)),
    CONSTRAINT "CashTransfer_status_known" CHECK ("status" IN ('pending_approval', 'posted', 'rejected')),
    CONSTRAINT "CashTransfer_posted_has_entry" CHECK ("status" <> 'posted' OR "entryId" IS NOT NULL),
    CONSTRAINT "CashTransfer_reversal_complete" CHECK (("reversedAt" IS NULL) = ("reversalEntryId" IS NULL) AND ("reversedAt" IS NULL OR "status" = 'posted'))
);
CREATE UNIQUE INDEX "CashTransfer_number_key" ON "CashTransfer"("number");
CREATE UNIQUE INDEX "CashTransfer_idempotencyKey_key" ON "CashTransfer"("idempotencyKey");
CREATE UNIQUE INDEX "CashTransfer_entryId_key" ON "CashTransfer"("entryId");
CREATE UNIQUE INDEX "CashTransfer_reversalEntryId_key" ON "CashTransfer"("reversalEntryId");
CREATE INDEX "CashTransfer_date_idx" ON "CashTransfer"("date");
CREATE INDEX "CashTransfer_fromCashAccountId_idx" ON "CashTransfer"("fromCashAccountId");
CREATE INDEX "CashTransfer_toCashAccountId_idx" ON "CashTransfer"("toCashAccountId");
ALTER TABLE "CashTransfer" ADD CONSTRAINT "CashTransfer_fromCashAccountId_fkey" FOREIGN KEY ("fromCashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashTransfer" ADD CONSTRAINT "CashTransfer_toCashAccountId_fkey" FOREIGN KEY ("toCashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashTransfer" ADD CONSTRAINT "CashTransfer_feeAccountId_fkey" FOREIGN KEY ("feeAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashTransfer" ADD CONSTRAINT "CashTransfer_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashTransfer" ADD CONSTRAINT "CashTransfer_reversalEntryId_fkey" FOREIGN KEY ("reversalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A transfer is never deleted. What was agreed (accounts, amounts, date) never changes;
-- the status moves once out of pending approval, and a posted transfer may be reversed once.
CREATE OR REPLACE FUNCTION cash_transfer_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CashTransfer is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW."number", NEW."date", NEW."fromCashAccountId", NEW."toCashAccountId", NEW."amount", NEW."fee", NEW."feeAccountId", NEW."createdBy", NEW."idempotencyKey")
     IS DISTINCT FROM (OLD."number", OLD."date", OLD."fromCashAccountId", OLD."toCashAccountId", OLD."amount", OLD."fee", OLD."feeAccountId", OLD."createdBy", OLD."idempotencyKey") THEN
    RAISE EXCEPTION 'a cash transfer''s accounts, amounts and date are fixed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'pending_approval' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'a decided cash transfer keeps its status' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."entryId" IS NOT NULL AND NEW."entryId" IS DISTINCT FROM OLD."entryId" THEN
    RAISE EXCEPTION 'a posted cash transfer keeps its journal entry' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."reversedAt" IS NOT NULL AND (NEW."reversedAt", NEW."reversalEntryId", NEW."reversedBy", NEW."reversalReason") IS DISTINCT FROM (OLD."reversedAt", OLD."reversalEntryId", OLD."reversedBy", OLD."reversalReason") THEN
    RAISE EXCEPTION 'a cash transfer is reversed once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION cash_transfer_guard() FROM PUBLIC;
CREATE TRIGGER "CashTransfer_guard" BEFORE UPDATE OR DELETE ON "CashTransfer" FOR EACH ROW EXECUTE FUNCTION cash_transfer_guard();

ALTER TABLE "CashTransfer" ENABLE ROW LEVEL SECURITY;
