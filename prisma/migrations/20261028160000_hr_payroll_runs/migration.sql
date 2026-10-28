-- HR phase 5: payroll runs up to approval — runs, payslips, lines, calculation snapshots and
-- one-off adjustments; on-account salary payments; attendance locked by a run
-- (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.7, §3.8, §4.1). No posting, no payment: those need the
-- accountant's account decisions (§12 A1) and come in a later phase.
BEGIN;

-- AlterTable
ALTER TABLE "EmployeeTransaction" ADD COLUMN     "payrollPeriod" TEXT;

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "runType" TEXT NOT NULL DEFAULT 'regular',
    "correctionOfRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "attendanceFrom" TEXT NOT NULL,
    "attendanceTo" TEXT NOT NULL,
    "preparedById" TEXT,
    "preparedBy" TEXT NOT NULL,
    "submittedById" TEXT,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvalRequestId" TEXT,
    "approvedById" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "calculatedAt" TIMESTAMP(3),
    "calculationHash" TEXT,
    "engineVersion" TEXT,
    "gross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "employeeDeductions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "employerContributions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "advanceRecovery" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "headcount" INTEGER NOT NULL DEFAULT 0,
    "exceptions" JSONB,
    "cancelledReason" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunEmployee" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "inclusion" TEXT NOT NULL DEFAULT 'included',
    "holdReason" TEXT,
    "advanceRecoveryRequested" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "employmentSnapshot" JSONB,
    "compensationIds" TEXT[],
    "inputsSnapshot" JSONB,
    "gross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "employeeDeductions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "employerContributions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netEntitlement" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "advanceRecovery" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "exceptions" JSONB,
    "inputsHash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PayrollRunEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunLine" (
    "id" TEXT NOT NULL,
    "runEmployeeId" TEXT NOT NULL,
    "payComponentId" TEXT,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "kind" TEXT NOT NULL,
    "quantity" DECIMAL(18,4),
    "rate" DECIMAL(18,6),
    "base" DECIMAL(18,2),
    "amount" DECIMAL(18,2) NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "ruleSetId" TEXT,
    "ruleSetVersion" INTEGER,
    "explanation" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PayrollRunLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollCalculationSnapshot" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "calculationHash" TEXT NOT NULL,
    "totals" JSONB NOT NULL,
    "payslips" JSONB NOT NULL,
    "calculatedById" TEXT,
    "calculatedBy" TEXT NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollCalculationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAdjustment" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "targetPeriod" TEXT NOT NULL,
    "payComponentId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "originId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reservedRunEmployeeId" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "cancelledBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_number_key" ON "PayrollRun"("number");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_idempotencyKey_key" ON "PayrollRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PayrollRun_period_idx" ON "PayrollRun"("period");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunEmployee_runId_employeeId_key" ON "PayrollRunEmployee"("runId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollRunLine_runEmployeeId_idx" ON "PayrollRunLine"("runEmployeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollCalculationSnapshot_runId_sequence_key" ON "PayrollCalculationSnapshot"("runId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollAdjustment_number_key" ON "PayrollAdjustment"("number");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_employeeId_targetPeriod_idx" ON "PayrollAdjustment"("employeeId", "targetPeriod");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_status_idx" ON "PayrollAdjustment"("status");

-- AddForeignKey
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_lockedRunId_fkey" FOREIGN KEY ("lockedRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_correctionOfRunId_fkey" FOREIGN KEY ("correctionOfRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunEmployee" ADD CONSTRAINT "PayrollRunEmployee_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunEmployee" ADD CONSTRAINT "PayrollRunEmployee_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunLine" ADD CONSTRAINT "PayrollRunLine_runEmployeeId_fkey" FOREIGN KEY ("runEmployeeId") REFERENCES "PayrollRunEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCalculationSnapshot" ADD CONSTRAINT "PayrollCalculationSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_payComponentId_fkey" FOREIGN KEY ("payComponentId") REFERENCES "PayComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_reservedRunEmployeeId_fkey" FOREIGN KEY ("reservedRunEmployeeId") REFERENCES "PayrollRunEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_values" CHECK (
  "period" ~ '^\d{4}-(0[1-9]|1[0-2])$'
  AND "runType" IN ('regular', 'off_cycle', 'correction')
  AND (("runType" = 'correction') = ("correctionOfRunId" IS NOT NULL))
  AND "status" IN ('draft', 'calculated', 'pending_approval', 'approved', 'cancelled')
  AND "attendanceFrom" ~ '^\d{4}-\d{2}-\d{2}$' AND "attendanceTo" ~ '^\d{4}-\d{2}-\d{2}$' AND "attendanceTo" >= "attendanceFrom"
  AND ("status" NOT IN ('calculated', 'pending_approval', 'approved') OR ("calculationHash" IS NOT NULL AND "calculatedAt" IS NOT NULL))
  AND ("status" NOT IN ('pending_approval', 'approved') OR ("submittedAt" IS NOT NULL AND "submittedBy" IS NOT NULL))
  AND ("status" <> 'approved' OR ("approvedAt" IS NOT NULL AND "approvedBy" IS NOT NULL))
  AND ("status" <> 'cancelled' OR length(btrim(coalesce("cancelledReason", ''))) > 0)
  -- Segregation of duties, whatever the global approval setting: whoever prepared or
  -- submitted a run never approves it.
  AND ("approvedById" IS NULL OR (("preparedById" IS NULL OR "approvedById" <> "preparedById") AND ("submittedById" IS NULL OR "approvedById" <> "submittedById")))
  AND "netPayable" = "gross" - "employeeDeductions" - "advanceRecovery"
  AND "gross" >= 0 AND "employeeDeductions" >= 0 AND "employerContributions" >= 0 AND "advanceRecovery" >= 0 AND "headcount" >= 0
  AND ("status" NOT IN ('pending_approval', 'approved') OR "netPayable" >= 0)
  AND "version" >= 1
);
-- One regular run per month.
CREATE UNIQUE INDEX "PayrollRun_one_regular_per_period" ON "PayrollRun" ("period") WHERE "runType" = 'regular' AND "status" <> 'cancelled';

CREATE OR REPLACE FUNCTION hr_payroll_run_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll runs are never deleted (%)', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF NEW."number" <> OLD."number" OR NEW."period" <> OLD."period" OR NEW."runType" <> OLD."runType"
     OR NEW."correctionOfRunId" IS DISTINCT FROM OLD."correctionOfRunId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'payroll run % cannot change its number, period or type', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" IN ('cancelled') THEN
    RAISE EXCEPTION 'payroll run % is %', OLD."number", OLD."status" USING ERRCODE = 'P0001';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'draft' AND NEW."status" IN ('calculated', 'cancelled'))
    OR (OLD."status" = 'calculated' AND NEW."status" IN ('pending_approval', 'cancelled'))
    OR (OLD."status" = 'pending_approval' AND NEW."status" IN ('approved', 'calculated'))
    OR (OLD."status" = 'approved' AND NEW."status" = 'calculated')) THEN
    RAISE EXCEPTION 'payroll run % cannot go from % to %', OLD."number", OLD."status", NEW."status" USING ERRCODE = 'P0001';
  END IF;
  -- Submitted and approved figures are frozen: only the status (and its stamps) may move.
  IF OLD."status" IN ('pending_approval', 'approved') AND NEW."status" = OLD."status" AND
     (NEW."calculationHash" IS DISTINCT FROM OLD."calculationHash" OR NEW."netPayable" <> OLD."netPayable" OR NEW."gross" <> OLD."gross") THEN
    RAISE EXCEPTION 'payroll run % is %: its figures are frozen', OLD."number", OLD."status" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PayrollRun_guard" BEFORE UPDATE OR DELETE ON "PayrollRun"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_run_guard();

-- ---------------------------------------------------------------------------
-- Payslips and lines: writable only while the run is a draft or calculated.
-- ---------------------------------------------------------------------------
ALTER TABLE "PayrollRunEmployee" ADD CONSTRAINT "PayrollRunEmployee_values" CHECK (
  "inclusion" IN ('included', 'on_hold')
  AND ("inclusion" <> 'on_hold' OR length(btrim(coalesce("holdReason", ''))) > 0)
  AND "advanceRecoveryRequested" >= 0
  AND "gross" >= 0 AND "employeeDeductions" >= 0 AND "employerContributions" >= 0 AND "advanceRecovery" >= 0
  AND "netEntitlement" = "gross" - "employeeDeductions"
  AND "netPayable" = "netEntitlement" - "advanceRecovery"
  -- A negative net exists only on a payslip that carries a blocking exception (and a run with
  -- one cannot be submitted); its carry-forward rule is open (§12 P8).
  AND ("netPayable" >= 0 OR jsonb_path_exists(coalesce("exceptions", '[]'::jsonb), '$[*] ? (@.severity == "error")'))
  AND "version" >= 1
);

CREATE OR REPLACE FUNCTION hr_payroll_frozen_guard() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  IF TG_TABLE_NAME = 'PayrollRunEmployee' THEN
    SELECT "status" INTO st FROM "PayrollRun" WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."runId" ELSE NEW."runId" END;
  ELSE
    SELECT r."status" INTO st FROM "PayrollRun" r JOIN "PayrollRunEmployee" e ON e."runId" = r."id"
    WHERE e."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."runEmployeeId" ELSE NEW."runEmployeeId" END;
  END IF;
  IF st IS NOT NULL AND st NOT IN ('draft', 'calculated') THEN
    RAISE EXCEPTION 'payroll run is %: its payslips and lines are frozen', st USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PayrollRunEmployee_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollRunEmployee"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_frozen_guard();
CREATE TRIGGER "PayrollRunLine_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollRunLine"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_frozen_guard();

ALTER TABLE "PayrollRunLine" ADD CONSTRAINT "PayrollRunLine_values" CHECK (
  "amount" >= 0
  AND "kind" IN ('earning', 'deduction', 'employer_contribution', 'recovery')
  AND "sourceType" IN ('compensation', 'attendance', 'leave', 'adjustment', 'advance_recovery', 'statutory')
  AND (("ruleSetId" IS NULL) = ("ruleSetVersion" IS NULL))
);

ALTER TABLE "PayrollCalculationSnapshot" ADD CONSTRAINT "PayrollCalculationSnapshot_values" CHECK ("sequence" >= 1 AND length("calculationHash") = 64);
CREATE TRIGGER "PayrollCalculationSnapshot_append_only" BEFORE UPDATE OR DELETE ON "PayrollCalculationSnapshot"
  FOR EACH ROW EXECUTE FUNCTION hr_append_only();

-- ---------------------------------------------------------------------------
-- Adjustments: on one payslip at most.
-- ---------------------------------------------------------------------------
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_values" CHECK (
  "targetPeriod" ~ '^\d{4}-(0[1-9]|1[0-2])$'
  AND "amount" > 0
  AND length(btrim("reason")) > 0
  AND "origin" IN ('manual', 'attendance_correction', 'leave_change', 'prior_run_correction')
  AND "status" IN ('open', 'reserved', 'applied', 'cancelled')
  AND (("status" IN ('reserved', 'applied')) = ("reservedRunEmployeeId" IS NOT NULL))
  AND ("status" <> 'cancelled' OR "cancelledBy" IS NOT NULL)
  AND "version" >= 1
);

CREATE OR REPLACE FUNCTION hr_payroll_adjustment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll adjustments are never deleted (%)', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" IN ('applied', 'cancelled') THEN
    RAISE EXCEPTION 'payroll adjustment % is %', OLD."number", OLD."status" USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'reservedRunEmployeeId', 'cancelledBy', 'version'])
     <> (to_jsonb(OLD) - ARRAY['status', 'reservedRunEmployeeId', 'cancelledBy', 'version']) THEN
    RAISE EXCEPTION 'payroll adjustment % cannot change its employee, month, component or amount', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PayrollAdjustment_guard" BEFORE UPDATE OR DELETE ON "PayrollAdjustment"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_adjustment_guard();

-- ---------------------------------------------------------------------------
-- On-account salary payments: an advance against one month's pay, recovered in full by that
-- month's run (APPROVED §2.4). Existing transaction types are unchanged.
-- ---------------------------------------------------------------------------
ALTER TABLE "EmployeeTransaction" DROP CONSTRAINT "EmployeeTransaction_values";
ALTER TABLE "EmployeeTransaction" ADD CONSTRAINT "EmployeeTransaction_values" CHECK (
  "type" IN ('advance', 'reimbursement', 'advance_return', 'salary_on_account') AND "amount" > 0 AND "date" ~ '^\d{4}-\d{2}-\d{2}$'
  AND (("type" = 'salary_on_account') = ("payrollPeriod" IS NOT NULL))
  AND ("payrollPeriod" IS NULL OR "payrollPeriod" ~ '^\d{4}-(0[1-9]|1[0-2])$')
);

-- Statutory rule sets get their own guard function (phase 4 borrowed the leave-policy one,
-- whose messages name leave policies).
CREATE OR REPLACE FUNCTION hr_rule_set_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN
      RAISE EXCEPTION 'rule set % is % and cannot be deleted', OLD."id", OLD."status" USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'retired' THEN
    RAISE EXCEPTION 'rule set % is retired and cannot change', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" = 'verified' THEN
    IF NEW."status" NOT IN ('verified', 'retired')
       OR (to_jsonb(NEW) - ARRAY['status', 'effectiveTo', 'version']) <> (to_jsonb(OLD) - ARRAY['status', 'effectiveTo', 'version'])
       OR (OLD."effectiveTo" IS NOT NULL AND NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo") THEN
      RAISE EXCEPTION 'verified rule set % can only be retired or end-dated', OLD."id" USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER "StatutoryRuleSet_guard" ON "StatutoryRuleSet";
CREATE TRIGGER "StatutoryRuleSet_guard" BEFORE UPDATE OR DELETE ON "StatutoryRuleSet"
  FOR EACH ROW EXECUTE FUNCTION hr_rule_set_guard();

ALTER TABLE "PayrollRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayrollRunEmployee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayrollRunLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayrollCalculationSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayrollAdjustment" ENABLE ROW LEVEL SECURITY;

COMMIT;
