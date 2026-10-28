-- Payroll posting, payments and reversal (docs/erp/COMPLETION_PROGRAM.md D-1..D-3).
--
--   approved → posted (one journal entry per run) → reversed (a reversing entry, only while
--   nothing is paid). Payments are recorded against posted runs, per payslip, never above
--   the payslip's net payable; a payment is corrected by reversing it, never edited.
--
-- Accounts are the accountant's: each component's expense/liability account and the
-- net-salaries account (setting hr.payroll_net_pay_account). Posting is refused while any
-- of them is missing; nothing here names an account.
BEGIN;

-- ---------------------------------------------------------------------------
-- Run: posting and reversal stamps
-- ---------------------------------------------------------------------------
ALTER TABLE "PayrollRun"
  ADD COLUMN "postedAt" TIMESTAMP(3),
  ADD COLUMN "postedById" TEXT,
  ADD COLUMN "postedBy" TEXT,
  ADD COLUMN "postingDate" TEXT,
  ADD COLUMN "journalEntryId" TEXT,
  ADD COLUMN "netPayAccountId" TEXT,
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedById" TEXT,
  ADD COLUMN "reversedBy" TEXT,
  ADD COLUMN "reversalReason" TEXT,
  ADD COLUMN "reversalEntryId" TEXT;

CREATE UNIQUE INDEX "PayrollRun_journalEntryId_key" ON "PayrollRun"("journalEntryId");
CREATE UNIQUE INDEX "PayrollRun_reversalEntryId_key" ON "PayrollRun"("reversalEntryId");
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_reversalEntryId_fkey" FOREIGN KEY ("reversalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_netPayAccountId_fkey" FOREIGN KEY ("netPayAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollRun" DROP CONSTRAINT "PayrollRun_values";
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_values" CHECK (
  "period" ~ '^\d{4}-(0[1-9]|1[0-2])$'
  AND "runType" IN ('regular', 'off_cycle', 'correction')
  AND (("runType" = 'correction') = ("correctionOfRunId" IS NOT NULL))
  AND "status" IN ('draft', 'calculated', 'pending_approval', 'approved', 'posted', 'reversed', 'cancelled')
  AND "attendanceFrom" ~ '^\d{4}-\d{2}-\d{2}$' AND "attendanceTo" ~ '^\d{4}-\d{2}-\d{2}$' AND "attendanceTo" >= "attendanceFrom"
  AND ("status" NOT IN ('calculated', 'pending_approval', 'approved', 'posted', 'reversed') OR ("calculationHash" IS NOT NULL AND "calculatedAt" IS NOT NULL))
  AND ("status" NOT IN ('pending_approval', 'approved', 'posted', 'reversed') OR ("submittedAt" IS NOT NULL AND "submittedBy" IS NOT NULL))
  AND ("status" NOT IN ('approved', 'posted', 'reversed') OR ("approvedAt" IS NOT NULL AND "approvedBy" IS NOT NULL))
  AND ("status" NOT IN ('posted', 'reversed') OR ("postedAt" IS NOT NULL AND "postedBy" IS NOT NULL AND "journalEntryId" IS NOT NULL AND "netPayAccountId" IS NOT NULL AND "postingDate" ~ '^\d{4}-\d{2}-\d{2}$'))
  AND (("status" = 'reversed') = ("reversalEntryId" IS NOT NULL))
  AND ("status" <> 'reversed' OR ("reversedAt" IS NOT NULL AND "reversedBy" IS NOT NULL AND length(btrim(coalesce("reversalReason", ''))) > 0))
  AND ("status" <> 'cancelled' OR length(btrim(coalesce("cancelledReason", ''))) > 0)
  AND ("approvedById" IS NULL OR (("preparedById" IS NULL OR "approvedById" <> "preparedById") AND ("submittedById" IS NULL OR "approvedById" <> "submittedById")))
  AND "netPayable" = "gross" - "employeeDeductions" - "advanceRecovery"
  AND "gross" >= 0 AND "employeeDeductions" >= 0 AND "employerContributions" >= 0 AND "advanceRecovery" >= 0 AND "headcount" >= 0
  AND ("status" NOT IN ('pending_approval', 'approved', 'posted', 'reversed') OR "netPayable" >= 0)
  AND "version" >= 1
);

-- A reversed run frees its month for a new regular run, like a cancelled one.
DROP INDEX "PayrollRun_one_regular_per_period";
CREATE UNIQUE INDEX "PayrollRun_one_regular_per_period" ON "PayrollRun" ("period") WHERE "runType" = 'regular' AND "status" NOT IN ('cancelled', 'reversed');

CREATE OR REPLACE FUNCTION hr_payroll_run_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll runs are never deleted (%)', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF NEW."number" <> OLD."number" OR NEW."period" <> OLD."period" OR NEW."runType" <> OLD."runType"
     OR NEW."correctionOfRunId" IS DISTINCT FROM OLD."correctionOfRunId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'payroll run % cannot change its number, period or type', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" IN ('cancelled', 'reversed') THEN
    RAISE EXCEPTION 'payroll run % is %', OLD."number", OLD."status" USING ERRCODE = 'P0001';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'draft' AND NEW."status" IN ('calculated', 'cancelled'))
    OR (OLD."status" = 'calculated' AND NEW."status" IN ('pending_approval', 'cancelled'))
    OR (OLD."status" = 'pending_approval' AND NEW."status" IN ('approved', 'calculated'))
    OR (OLD."status" = 'approved' AND NEW."status" IN ('calculated', 'posted'))
    OR (OLD."status" = 'posted' AND NEW."status" = 'reversed')) THEN
    RAISE EXCEPTION 'payroll run % cannot go from % to %', OLD."number", OLD."status", NEW."status" USING ERRCODE = 'P0001';
  END IF;
  -- Submitted, approved and posted figures are frozen: only the status and its stamps move.
  IF OLD."status" IN ('pending_approval', 'approved', 'posted') AND
     (NEW."calculationHash" IS DISTINCT FROM OLD."calculationHash" OR NEW."netPayable" <> OLD."netPayable" OR NEW."gross" <> OLD."gross"
      OR NEW."employeeDeductions" <> OLD."employeeDeductions" OR NEW."employerContributions" <> OLD."employerContributions"
      OR NEW."advanceRecovery" <> OLD."advanceRecovery" OR NEW."headcount" <> OLD."headcount") THEN
    RAISE EXCEPTION 'payroll run % is %: its figures are frozen', OLD."number", OLD."status" USING ERRCODE = 'P0001';
  END IF;
  -- Posting stamps are written once.
  IF OLD."status" = 'posted' AND (NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId" OR NEW."postedAt" IS DISTINCT FROM OLD."postedAt"
      OR NEW."netPayAccountId" IS DISTINCT FROM OLD."netPayAccountId" OR NEW."postingDate" IS DISTINCT FROM OLD."postingDate") THEN
    RAISE EXCEPTION 'payroll run % is posted: its posting cannot change', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- An adjustment applied by a posted run goes back to open only when that run is reversed.
CREATE OR REPLACE FUNCTION hr_payroll_adjustment_guard() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll adjustments are never deleted (%)', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" = 'applied' AND NEW."status" = 'open' AND NEW."reservedRunEmployeeId" IS NULL THEN
    SELECT r."status" INTO st FROM "PayrollRun" r JOIN "PayrollRunEmployee" e ON e."runId" = r."id" WHERE e."id" = OLD."reservedRunEmployeeId";
    IF st IS DISTINCT FROM 'reversed' THEN
      RAISE EXCEPTION 'payroll adjustment % is applied', OLD."number" USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD."status" IN ('applied', 'cancelled') THEN
    RAISE EXCEPTION 'payroll adjustment % is %', OLD."number", OLD."status" USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'reservedRunEmployeeId', 'cancelledBy', 'version'])
     <> (to_jsonb(OLD) - ARRAY['status', 'reservedRunEmployeeId', 'cancelledBy', 'version']) THEN
    RAISE EXCEPTION 'payroll adjustment % cannot change its employee, month, component or amount', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Journal: payroll sources
-- ---------------------------------------------------------------------------
ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_values";
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_values" CHECK (
  "number" ~ '^JE-[0-9]{4}-[0-9]{5,}$' AND "date" ~ '^\d{4}-\d{2}-\d{2}$' AND "total" > 0 AND length(btrim("description")) > 0
  AND "sourceType" IN ('manual', 'sales_invoice', 'credit_note', 'supplier_bill', 'debit_note', 'customer_receipt', 'supplier_payment', 'stock_valuation', 'reversal', 'expense', 'employee_transaction', 'opening_balance', 'receipt_reversal', 'payment_reversal', 'customer_refund', 'supplier_refund', 'payroll_run', 'payroll_payment')
  AND (("sourceType" = 'reversal') = ("reversalOfId" IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
CREATE TABLE "PayrollPayment" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "cashAccountId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "journalEntryId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversedBy" TEXT,
    "reversalReason" TEXT,
    "reversalEntryId" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayrollPayment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PayrollPaymentLine" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "runEmployeeId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    CONSTRAINT "PayrollPaymentLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollPayment_number_key" ON "PayrollPayment"("number");
CREATE UNIQUE INDEX "PayrollPayment_journalEntryId_key" ON "PayrollPayment"("journalEntryId");
CREATE UNIQUE INDEX "PayrollPayment_reversalEntryId_key" ON "PayrollPayment"("reversalEntryId");
CREATE UNIQUE INDEX "PayrollPayment_idempotencyKey_key" ON "PayrollPayment"("idempotencyKey");
CREATE INDEX "PayrollPayment_runId_idx" ON "PayrollPayment"("runId");
CREATE UNIQUE INDEX "PayrollPaymentLine_paymentId_runEmployeeId_key" ON "PayrollPaymentLine"("paymentId", "runEmployeeId");
CREATE INDEX "PayrollPaymentLine_runEmployeeId_idx" ON "PayrollPaymentLine"("runEmployeeId");

ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_reversalEntryId_fkey" FOREIGN KEY ("reversalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollPaymentLine" ADD CONSTRAINT "PayrollPaymentLine_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PayrollPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollPaymentLine" ADD CONSTRAINT "PayrollPaymentLine_runEmployeeId_fkey" FOREIGN KEY ("runEmployeeId") REFERENCES "PayrollRunEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_values" CHECK (
  "number" ~ '^PPY-[0-9]{4}-[0-9]{5,}$' AND "date" ~ '^\d{4}-\d{2}-\d{2}$' AND "amount" > 0
  AND "method" IN ('cash', 'bank_transfer', 'cheque', 'wallet', 'other')
  AND (("reversalEntryId" IS NULL) = ("reversedAt" IS NULL))
  AND ("reversedAt" IS NULL OR ("reversedBy" IS NOT NULL AND length(btrim(coalesce("reversalReason", ''))) > 0))
);
ALTER TABLE "PayrollPaymentLine" ADD CONSTRAINT "PayrollPaymentLine_values" CHECK ("amount" > 0);

-- A payment is recorded once and only ever gains its reversal stamps.
CREATE OR REPLACE FUNCTION hr_payroll_payment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll payments are never deleted (%)', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF OLD."reversedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'payroll payment % is reversed', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['journalEntryId', 'reversedAt', 'reversedById', 'reversedBy', 'reversalReason', 'reversalEntryId'])
     <> (to_jsonb(OLD) - ARRAY['journalEntryId', 'reversedAt', 'reversedById', 'reversedBy', 'reversalReason', 'reversalEntryId'])
     OR (OLD."journalEntryId" IS NOT NULL AND NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId") THEN
    RAISE EXCEPTION 'payroll payment % cannot change', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PayrollPayment_guard" BEFORE UPDATE OR DELETE ON "PayrollPayment"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_payment_guard();

-- Lines are append-only; each one is paid only on a posted run's included payslip and
-- never takes what was paid on it above its net payable (reversed payments do not count).
CREATE OR REPLACE FUNCTION hr_payroll_payment_line_guard() RETURNS trigger AS $$
DECLARE
  slip record;
  st text;
  paid numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payroll payment lines are append-only' USING ERRCODE = 'P0001';
  END IF;
  SELECT e."id", e."runId", e."inclusion", e."netPayable" INTO slip FROM "PayrollRunEmployee" e WHERE e."id" = NEW."runEmployeeId" FOR UPDATE;
  SELECT r."status" INTO st FROM "PayrollRun" r WHERE r."id" = slip."runId";
  IF st IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'payroll run is %: only a posted run is paid', st USING ERRCODE = 'P0001';
  END IF;
  IF slip."inclusion" <> 'included' THEN
    RAISE EXCEPTION 'payslip % is on hold', slip."id" USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "PayrollPayment" p WHERE p."id" = NEW."paymentId" AND p."runId" = slip."runId") THEN
    RAISE EXCEPTION 'payment and payslip belong to different runs' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum(l."amount"), 0) INTO paid FROM "PayrollPaymentLine" l JOIN "PayrollPayment" p ON p."id" = l."paymentId"
    WHERE l."runEmployeeId" = NEW."runEmployeeId" AND p."reversedAt" IS NULL;
  IF paid + NEW."amount" > slip."netPayable" THEN
    RAISE EXCEPTION 'payslip % would be paid % of its net %', slip."id", paid + NEW."amount", slip."netPayable" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PayrollPaymentLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollPaymentLine"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_payment_line_guard();

-- At commit: a payment equals its lines and has its journal entry.
CREATE OR REPLACE FUNCTION hr_payroll_payment_complete() RETURNS trigger AS $$
DECLARE
  -- Fired from both tables: read the id through jsonb (a record field is checked against one row type).
  pid text := CASE WHEN TG_TABLE_NAME = 'PayrollPayment' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'paymentId' END;
  p record;
  lines numeric;
BEGIN
  SELECT * INTO p FROM "PayrollPayment" WHERE "id" = pid;
  SELECT coalesce(sum("amount"), 0) INTO lines FROM "PayrollPaymentLine" WHERE "paymentId" = pid;
  IF lines <> p."amount" THEN
    RAISE EXCEPTION 'payroll payment % is % but its lines are %', p."number", p."amount", lines USING ERRCODE = 'P0001';
  END IF;
  IF p."journalEntryId" IS NULL THEN
    RAISE EXCEPTION 'payroll payment % has no journal entry', p."number" USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "PayrollPayment_complete" AFTER INSERT ON "PayrollPayment"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hr_payroll_payment_complete();
CREATE CONSTRAINT TRIGGER "PayrollPaymentLine_complete" AFTER INSERT ON "PayrollPaymentLine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hr_payroll_payment_complete();

-- Same posture as every other public table (20261029090000).
ALTER TABLE "PayrollPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayrollPaymentLine" ENABLE ROW LEVEL SECURITY;

COMMIT;
