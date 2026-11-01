-- Preflight for the accounting gap-closure migrations (20261031100000 … 20261031150000).
-- READ ONLY. Run against the target database BEFORE `prisma migrate deploy`.
-- Every query must return zero rows; any row is a conflict the migration would fail on
-- (or would silently mis-handle) and must be resolved first.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/gap-closure-preflight.sql

\echo '1. account codes / system keys the release creates must be free (unique code, unique systemKey)'
SELECT "id", "code", "systemKey" FROM "Account"
WHERE ("code" IN ('1700', '2250', '4300', '6400', '6500') AND "id" NOT IN ('acc_1700', 'acc_2250', 'acc_4300', 'acc_6400', 'acc_6500'))
   OR ("systemKey" IN ('vat_payable', 'fa_disposal_gain', 'fa_depreciation', 'fa_disposal_loss') AND "id" NOT IN ('acc_2250', 'acc_4300', 'acc_6400', 'acc_6500'));

\echo '2. the parent header accounts the new accounts hang under must exist'
SELECT p.id AS missing_parent FROM (VALUES ('acc_1000'), ('acc_2000'), ('acc_4000'), ('acc_6000')) AS p(id)
WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = p.id);

\echo '3. one cash box / bank account per GL account (new unique index CashAccount.accountId)'
SELECT "accountId", count(*) FROM "CashAccount" GROUP BY "accountId" HAVING count(*) > 1;

\echo '4. no object the release creates exists already (a half-applied earlier attempt)'
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('CashTransfer', 'VatReturn', 'JournalRequest', 'FiscalYear', 'AssetCategory', 'FixedAsset', 'AssetEvent', 'DepreciationRun', 'AssetDepreciationLine', 'OpeningBatch', 'OpeningBatchLine', 'CostCenter');
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema = 'public' AND ((table_name = 'Account' AND column_name IN ('cashFlowCategory', 'controlledBy'))
   OR (table_name = 'JournalLine' AND column_name = 'costCenterId') OR (table_name = 'AccountingPeriod' AND column_name = 'reopenCount'));

\echo '5. migration history: none of the six gap-closure migrations applied, none failed or rolled back'
SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"
WHERE migration_name >= '20261031100000' OR finished_at IS NULL OR rolled_back_at IS NOT NULL;

\echo '6. existing journal entries satisfy the widened source-type rule (they always do; a sanity check)'
SELECT "sourceType", count(*) FROM "JournalEntry"
WHERE "sourceType" NOT IN ('manual', 'sales_invoice', 'credit_note', 'supplier_bill', 'debit_note', 'customer_receipt', 'supplier_payment', 'stock_valuation', 'reversal', 'expense', 'employee_transaction', 'opening_balance', 'receipt_reversal', 'payment_reversal', 'customer_refund', 'supplier_refund', 'payroll_run', 'payroll_payment')
GROUP BY "sourceType";

\echo 'Preflight done: every section above must show (0 rows).'
