-- Rollback of the accounting gap-closure migrations (20261031100000 … 20261031150000),
-- returning the schema exactly to migration 20261030131000_function_search_path.
--
-- WHEN: only if the release must be withdrawn BEFORE its features were used. The script
-- refuses (and changes nothing) if any data exists that only the new release could have
-- written — rolling back then would destroy accounting records. After the features are in
-- use, roll the application back instead: the old application runs on the new schema (all
-- changes are additive; the old code never writes the new columns, tables or source types).
--
-- HOW: in one transaction, after a backup:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f scripts/ops/gap-closure-rollback.sql
-- then `npm run db:sync-permissions` with the OLD application to drop the five permissions.
-- Rehearsed on scratch databases (docs/erp/ACCOUNTING_VERIFICATION.md §3).

-- 0. Refuse if the new features hold data.
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "CashTransfer") + (SELECT count(*) FROM "VatReturn") + (SELECT count(*) FROM "JournalRequest")
       + (SELECT count(*) FROM "FiscalYear") + (SELECT count(*) FROM "AssetCategory") + (SELECT count(*) FROM "FixedAsset")
       + (SELECT count(*) FROM "OpeningBatch") + (SELECT count(*) FROM "CostCenter")
       + (SELECT count(*) FROM "JournalEntry" WHERE "sourceType" IN ('cash_transfer', 'cash_transfer_reversal', 'vat_settlement', 'vat_payment', 'year_end_close', 'year_end_reopen', 'asset_acquisition', 'asset_improvement', 'asset_depreciation', 'asset_disposal', 'opening_batch'))
       + (SELECT count(*) FROM "JournalLine" WHERE "accountId" IN ('acc_2250', 'acc_4300', 'acc_6400', 'acc_6500'))
       + (SELECT count(*) FROM "Account" WHERE "parentId" = 'acc_1700')
       + (SELECT count(*) FROM "AccountingPeriod" WHERE "reopenCount" > 0)
  INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'gap-closure rollback refused: % rows were written by the new features — roll back the application only', n;
  END IF;
END $$;

-- 6. Cost centers (20261031150000).
CREATE OR REPLACE FUNCTION accounting_line_guard() RETURNS trigger AS $$
DECLARE acc record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'JournalLine is append-only' USING ERRCODE = 'restrict_violation'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."entryId", NEW."accountId", NEW."debit", NEW."credit", NEW."partyType", NEW."partyId", NEW."description") IS DISTINCT FROM (OLD."entryId", OLD."accountId", OLD."debit", OLD."credit", OLD."partyType", OLD."partyId", OLD."description") THEN
      RAISE EXCEPTION 'JournalLine is append-only (only the reconciliation mark may change)' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "postable", "active", "code" INTO acc FROM "Account" WHERE "id" = NEW."accountId";
  IF NOT acc."postable" OR NOT acc."active" THEN
    RAISE EXCEPTION 'account % takes no postings', acc."code" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
ALTER TABLE "FixedAsset" DROP COLUMN "costCenterId";
ALTER TABLE "SupplierBillServiceLine" DROP COLUMN "costCenterId";
ALTER TABLE "Expense" DROP COLUMN "costCenterId";
ALTER TABLE "JournalLine" DROP COLUMN "costCenterId";
DROP TABLE "CostCenter";

-- 5. Opening batches (20261031140000).
DROP TABLE "OpeningBatchLine";
DROP TABLE "OpeningBatch";
DROP FUNCTION opening_batch_line_frozen();
DROP FUNCTION opening_batch_guard();

-- 4. Fixed assets (20261031130000).
ALTER TABLE "SupplierBillServiceLine" DROP CONSTRAINT "SupplierBillServiceLine_capital";
ALTER TABLE "SupplierBillServiceLine" DROP COLUMN "assetCategoryId", DROP COLUMN "assetName", DROP COLUMN "improvesAssetId";
DROP TABLE "AssetDepreciationLine";
DROP TABLE "DepreciationRun";
DROP TABLE "AssetEvent";
DROP TABLE "FixedAsset";
DROP TABLE "AssetCategory";
DROP FUNCTION fixed_asset_guard();
DROP FUNCTION depreciation_line_guard();
DROP FUNCTION depreciation_run_guard();

-- 3. Fiscal years (20261031120000).
ALTER TABLE "AccountingPeriod" DROP COLUMN "reopenCount", DROP COLUMN "reopenedAt", DROP COLUMN "reopenedBy", DROP COLUMN "reopenReason";
DROP TABLE "FiscalYear";
DROP FUNCTION fiscal_year_guard();

-- 2. VAT returns and journal approval (20261031110000).
DROP TRIGGER "JournalLine_vat_period_lock" ON "JournalLine";
DROP FUNCTION vat_period_lock();
DROP TABLE "JournalRequest";
DROP FUNCTION journal_request_guard();
DROP TABLE "VatReturn";
DROP FUNCTION vat_return_guard();
DROP FUNCTION vat_return_no_overlap();

-- 1. Cash and bank, cash-flow classification (20261031100000).
DROP TABLE "CashTransfer";
DROP FUNCTION cash_transfer_guard();
DROP INDEX "CashAccount_accountId_key";
ALTER TABLE "CashAccount" DROP COLUMN "bankName", DROP COLUMN "accountNumber", DROP COLUMN "notes", DROP COLUMN "version";
ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_values";
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_values" CHECK (
  "number" ~ '^JE-[0-9]{4}-[0-9]{5,}$' AND "date" ~ '^\d{4}-\d{2}-\d{2}$' AND "total" > 0 AND length(btrim("description")) > 0
  AND "sourceType" IN ('manual', 'sales_invoice', 'credit_note', 'supplier_bill', 'debit_note', 'customer_receipt', 'supplier_payment', 'stock_valuation', 'reversal', 'expense', 'employee_transaction', 'opening_balance', 'receipt_reversal', 'payment_reversal', 'customer_refund', 'supplier_refund', 'payroll_run', 'payroll_payment')
  AND (("sourceType" = 'reversal') = ("reversalOfId" IS NOT NULL))
);
DELETE FROM "Account" WHERE "id" IN ('acc_2250', 'acc_4300', 'acc_6400', 'acc_6500', 'acc_1700');
ALTER TABLE "Account" DROP CONSTRAINT "Account_controlledBy_known", DROP COLUMN "controlledBy";
ALTER TABLE "Account" DROP CONSTRAINT "Account_cashFlowCategory_known", DROP COLUMN "cashFlowCategory";

-- Migration history: the six are no longer applied.
DELETE FROM "_prisma_migrations" WHERE "migration_name" IN (
  '20261031100000_cash_bank_and_cash_flow', '20261031110000_vat_returns_and_journal_approval', '20261031120000_fiscal_years',
  '20261031130000_fixed_assets', '20261031140000_opening_batches', '20261031150000_cost_centers');
