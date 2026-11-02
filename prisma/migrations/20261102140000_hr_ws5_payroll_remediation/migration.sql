-- WS5 HR & payroll remediation (docs/erp/REMEDIATION_PLAN_2026-11.md, audit ledger HR-03..HR-22).
--
-- Additive: new columns (with defaults), new tables, new constraints. Three existing CHECK
-- constraints are replaced by versions that accept everything they accepted before plus the
-- new run types (final settlement, correction) — no row that passed the old check fails the
-- new one. New constraints that tighten rules are NOT VALID: they bind every new or changed
-- row without re-judging history.
--
--  * HR-04  a package may be explicitly exempt from social insurance (with a reason, approved
--           with the package); otherwise an insurable wage of 0 blocks payroll.
--  * HR-11/12 final settlements: a payroll run of type final_settlement for one leaver, with
--           manual settlement items (notice etc.) and leave encashment of encashable types.
--  * HR-07  correction runs post only the differences against what is posted for the month:
--           their lines (sourceType 'correction') and payslip figures may be negative; an
--           employee's negative difference is carried to employee advances (recovery < 0).
--  * HR-17  advance instalment plans, approved by a second person.
--  * HR-22  whoever prepared or submitted a run neither approves, posts nor pays it; a run
--           with an unknown (NULL) preparer, submitter, approver or poster cannot move on.
BEGIN;

-- ---------------------------------------------------------------------------
-- HR-04: explicit social-insurance exemption on a package
-- ---------------------------------------------------------------------------
ALTER TABLE "EmployeeCompensation"
  ADD COLUMN "insuranceExempt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "insuranceExemptReason" TEXT;
ALTER TABLE "EmployeeCompensation" ADD CONSTRAINT "EmployeeCompensation_insurance_exempt" CHECK (
  NOT "insuranceExempt"
  OR (length(btrim(coalesce("insuranceExemptReason", ''))) > 0 AND coalesce("insurableWage", 0) = 0)
) NOT VALID;

-- ---------------------------------------------------------------------------
-- HR-11: which leave types are paid out (encashed) at the end of service
-- ---------------------------------------------------------------------------
ALTER TABLE "LeaveType" ADD COLUMN "encashable" BOOLEAN NOT NULL DEFAULT false;

-- The computed component that pays encashed leave days (role leave_encashment).
ALTER TABLE "PayComponent" DROP CONSTRAINT "PayComponent_values";
ALTER TABLE "PayComponent" ADD CONSTRAINT "PayComponent_values" CHECK (
  "code" ~ '^[A-Za-z][A-Za-z0-9_]{1,29}$'
  AND length(btrim("nameAr")) > 0
  AND "kind" IN ('earning', 'deduction', 'employer_contribution', 'information')
  AND "method" IN ('fixed', 'input', 'system')
  AND (("method" = 'system') = ("systemRole" IS NOT NULL))
  AND ("systemRole" IS NULL OR "systemRole" IN ('overtime_day', 'overtime_night', 'overtime_rest_day', 'overtime_holiday',
       'unpaid_absence', 'partial_leave', 'social_insurance_employee', 'social_insurance_employer', 'income_tax',
       'other_levy_employee', 'other_levy_employer', 'advance_recovery', 'rounding', 'leave_encashment'))
  AND (NOT "active" OR ("taxable" IS NOT NULL AND "insurable" IS NOT NULL))
  AND "payslipOrder" BETWEEN 0 AND 9999
  AND "version" >= 1
);

-- ---------------------------------------------------------------------------
-- Runs: final settlement and correction types; signed figures for both
-- ---------------------------------------------------------------------------
ALTER TABLE "PayrollRun" ADD COLUMN "reason" TEXT;

ALTER TABLE "PayrollRun" DROP CONSTRAINT "PayrollRun_values";
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_values" CHECK (
  "period" ~ '^\d{4}-(0[1-9]|1[0-2])$'
  AND "runType" IN ('regular', 'off_cycle', 'correction', 'final_settlement')
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
  -- A correction or a final settlement posts differences: its totals may be negative.
  AND ("runType" IN ('correction', 'final_settlement') OR ("gross" >= 0 AND "employeeDeductions" >= 0 AND "employerContributions" >= 0 AND "advanceRecovery" >= 0))
  AND "headcount" >= 0
  AND ("status" NOT IN ('pending_approval', 'approved', 'posted', 'reversed') OR "netPayable" >= 0)
  AND "version" >= 1
);

-- HR-07 / HR-12: a correction and a settlement say why they exist.
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_reason_required" CHECK (
  "runType" NOT IN ('correction', 'final_settlement') OR length(btrim(coalesce("reason", ''))) > 0
) NOT VALID;

-- HR-22: segregation that a NULL cannot slip through. Approved (and later) runs name their
-- preparer, submitter and approver, all known and the approver different; posted runs name a
-- poster who neither prepared nor submitted them.
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_segregation" CHECK (
  ("status" NOT IN ('approved', 'posted', 'reversed')
    OR ("preparedById" IS NOT NULL AND "submittedById" IS NOT NULL AND "approvedById" IS NOT NULL
        AND "approvedById" <> "preparedById" AND "approvedById" <> "submittedById"))
  AND ("status" NOT IN ('posted', 'reversed')
    OR ("postedById" IS NOT NULL AND "postedById" <> "preparedById" AND "postedById" <> "submittedById"))
) NOT VALID;

-- One open correction per original run at a time (it is posted or cancelled before the next).
CREATE UNIQUE INDEX "PayrollRun_one_open_correction" ON "PayrollRun" ("correctionOfRunId")
  WHERE "runType" = 'correction' AND "status" IN ('draft', 'calculated', 'pending_approval', 'approved');

-- Payslips of correction and settlement runs carry signed figures (set from the run, never by hand).
ALTER TABLE "PayrollRunEmployee" ADD COLUMN "signed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PayrollRunEmployee" DROP CONSTRAINT "PayrollRunEmployee_values";
ALTER TABLE "PayrollRunEmployee" ADD CONSTRAINT "PayrollRunEmployee_values" CHECK (
  "inclusion" IN ('included', 'on_hold')
  AND ("inclusion" <> 'on_hold' OR length(btrim(coalesce("holdReason", ''))) > 0)
  AND "advanceRecoveryRequested" >= 0
  AND ("signed" OR ("gross" >= 0 AND "employeeDeductions" >= 0 AND "employerContributions" >= 0 AND "advanceRecovery" >= 0))
  AND "netEntitlement" = "gross" - "employeeDeductions"
  AND "netPayable" = "netEntitlement" - "advanceRecovery"
  AND ("netPayable" >= 0 OR jsonb_path_exists(coalesce("exceptions", '[]'::jsonb), '$[*] ? (@.severity == "error")'))
  AND "version" >= 1
);

CREATE OR REPLACE FUNCTION hr_payslip_signed() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "runType" IN ('correction', 'final_settlement') INTO NEW."signed" FROM "PayrollRun" WHERE "id" = NEW."runId";
    NEW."signed" := coalesce(NEW."signed", false);
  ELSE
    NEW."signed" := OLD."signed";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION hr_payslip_signed() FROM PUBLIC;
CREATE TRIGGER "PayrollRunEmployee_signed" BEFORE INSERT OR UPDATE ON "PayrollRunEmployee"
  FOR EACH ROW EXECUTE FUNCTION hr_payslip_signed();

ALTER TABLE "PayrollRunLine" DROP CONSTRAINT "PayrollRunLine_values";
ALTER TABLE "PayrollRunLine" ADD CONSTRAINT "PayrollRunLine_values" CHECK (
  -- Only a difference line of a correction or settlement ('correction') may be negative.
  ("amount" >= 0 OR "sourceType" = 'correction')
  AND "kind" IN ('earning', 'deduction', 'employer_contribution', 'recovery')
  AND "sourceType" IN ('compensation', 'attendance', 'leave', 'adjustment', 'advance_recovery', 'statutory', 'settlement', 'correction')
  AND (("ruleSetId" IS NULL) = ("ruleSetVersion" IS NULL))
);

-- HR-22: a payment is recorded by someone known who neither prepared nor submitted the run.
CREATE OR REPLACE FUNCTION hr_payroll_payment_segregation() RETURNS trigger AS $$
DECLARE
  r record;
BEGIN
  SELECT "preparedById", "submittedById", "number" INTO r FROM "PayrollRun" WHERE "id" = NEW."runId";
  IF NEW."createdById" IS NULL OR r."preparedById" IS NULL OR r."submittedById" IS NULL
     OR NEW."createdById" = r."preparedById" OR NEW."createdById" = r."submittedById" THEN
    RAISE EXCEPTION 'payroll run %: a payment is recorded by a known user who neither prepared nor submitted the run', r."number" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION hr_payroll_payment_segregation() FROM PUBLIC;
CREATE TRIGGER "PayrollPayment_segregation" BEFORE INSERT ON "PayrollPayment"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_payment_segregation();

-- ---------------------------------------------------------------------------
-- HR-12: final settlement of a leaver (inputs; the figures live on its payroll run)
-- ---------------------------------------------------------------------------
CREATE TABLE "EmployeeFinalSettlement" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "terminationEmploymentId" TEXT NOT NULL,
    "lastWorkingDay" TEXT NOT NULL,
    "encashLeave" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "EmployeeFinalSettlement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeFinalSettlement_runId_key" ON "EmployeeFinalSettlement"("runId");
CREATE INDEX "EmployeeFinalSettlement_employeeId_idx" ON "EmployeeFinalSettlement"("employeeId");
CREATE INDEX "EmployeeFinalSettlement_terminationEmploymentId_idx" ON "EmployeeFinalSettlement"("terminationEmploymentId");
ALTER TABLE "EmployeeFinalSettlement" ADD CONSTRAINT "EmployeeFinalSettlement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeFinalSettlement" ADD CONSTRAINT "EmployeeFinalSettlement_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeFinalSettlement" ADD CONSTRAINT "EmployeeFinalSettlement_terminationEmploymentId_fkey" FOREIGN KEY ("terminationEmploymentId") REFERENCES "EmployeeEmployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeFinalSettlement" ADD CONSTRAINT "EmployeeFinalSettlement_values" CHECK (
  "lastWorkingDay" ~ '^\d{4}-\d{2}-\d{2}$' AND length(btrim("reason")) > 0 AND "version" >= 1
);
ALTER TABLE "EmployeeFinalSettlement" ENABLE ROW LEVEL SECURITY;

CREATE TABLE "EmployeeFinalSettlementItem" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "payComponentId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    CONSTRAINT "EmployeeFinalSettlementItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmployeeFinalSettlementItem_settlementId_idx" ON "EmployeeFinalSettlementItem"("settlementId");
CREATE INDEX "EmployeeFinalSettlementItem_payComponentId_idx" ON "EmployeeFinalSettlementItem"("payComponentId");
ALTER TABLE "EmployeeFinalSettlementItem" ADD CONSTRAINT "EmployeeFinalSettlementItem_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "EmployeeFinalSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeFinalSettlementItem" ADD CONSTRAINT "EmployeeFinalSettlementItem_payComponentId_fkey" FOREIGN KEY ("payComponentId") REFERENCES "PayComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeFinalSettlementItem" ADD CONSTRAINT "EmployeeFinalSettlementItem_values" CHECK ("amount" > 0 AND length(btrim("reason")) > 0);
ALTER TABLE "EmployeeFinalSettlementItem" ENABLE ROW LEVEL SECURITY;

-- A settlement and its items change only while its run is a draft or calculated; never deleted
-- once the run has left that state.
CREATE OR REPLACE FUNCTION hr_settlement_frozen() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  IF TG_TABLE_NAME = 'EmployeeFinalSettlement' THEN
    SELECT "status" INTO st FROM "PayrollRun" WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."runId" ELSE NEW."runId" END;
  ELSE
    SELECT r."status" INTO st FROM "PayrollRun" r JOIN "EmployeeFinalSettlement" s ON s."runId" = r."id"
    WHERE s."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."settlementId" ELSE NEW."settlementId" END;
  END IF;
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'EmployeeFinalSettlement' THEN
    RAISE EXCEPTION 'final settlements are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF st IS NOT NULL AND st NOT IN ('draft', 'calculated') THEN
    RAISE EXCEPTION 'final settlement run is %: its inputs are frozen', st USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION hr_settlement_frozen() FROM PUBLIC;
CREATE TRIGGER "EmployeeFinalSettlement_frozen" BEFORE UPDATE OR DELETE ON "EmployeeFinalSettlement"
  FOR EACH ROW EXECUTE FUNCTION hr_settlement_frozen();
CREATE TRIGGER "EmployeeFinalSettlementItem_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "EmployeeFinalSettlementItem"
  FOR EACH ROW EXECUTE FUNCTION hr_settlement_frozen();

-- ---------------------------------------------------------------------------
-- HR-17: advance instalment plans (one per advance), approved by a second person
-- ---------------------------------------------------------------------------
CREATE TABLE "EmployeeAdvancePlan" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "advanceTransactionId" TEXT NOT NULL,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "instalmentAmount" DECIMAL(18,2) NOT NULL,
    "startPeriod" TEXT NOT NULL,
    "allowAboveCap" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "EmployeeAdvancePlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeAdvancePlan_advanceTransactionId_key" ON "EmployeeAdvancePlan"("advanceTransactionId");
CREATE INDEX "EmployeeAdvancePlan_employeeId_status_idx" ON "EmployeeAdvancePlan"("employeeId", "status");
ALTER TABLE "EmployeeAdvancePlan" ADD CONSTRAINT "EmployeeAdvancePlan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeAdvancePlan" ADD CONSTRAINT "EmployeeAdvancePlan_advanceTransactionId_fkey" FOREIGN KEY ("advanceTransactionId") REFERENCES "EmployeeTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeAdvancePlan" ADD CONSTRAINT "EmployeeAdvancePlan_values" CHECK (
  "totalAmount" > 0 AND "instalmentAmount" > 0 AND "instalmentAmount" <= "totalAmount"
  AND "startPeriod" ~ '^\d{4}-(0[1-9]|1[0-2])$'
  AND length(btrim("reason")) > 0
  AND "status" IN ('pending', 'active', 'cancelled')
  AND ("status" <> 'active' OR ("approvedAt" IS NOT NULL AND "approvedBy" IS NOT NULL AND "approvedById" IS NOT NULL))
  AND ("approvedById" IS NULL OR ("createdById" IS NOT NULL AND "approvedById" <> "createdById"))
  AND ("status" <> 'cancelled' OR length(btrim(coalesce("cancelReason", ''))) > 0)
  AND "version" >= 1
);
CREATE OR REPLACE FUNCTION hr_advance_plan_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'advance plans are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'approvedById', 'approvedBy', 'approvedAt', 'cancelledBy', 'cancelReason', 'version'])
     <> (to_jsonb(OLD) - ARRAY['status', 'approvedById', 'approvedBy', 'approvedAt', 'cancelledBy', 'cancelReason', 'version']) THEN
    RAISE EXCEPTION 'advance plan % cannot change its amounts or dates', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'pending' AND NEW."status" IN ('active', 'cancelled'))
    OR (OLD."status" = 'active' AND NEW."status" = 'cancelled')) THEN
    RAISE EXCEPTION 'advance plan % cannot go from % to %', OLD."id", OLD."status", NEW."status" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION hr_advance_plan_guard() FROM PUBLIC;
CREATE TRIGGER "EmployeeAdvancePlan_guard" BEFORE UPDATE OR DELETE ON "EmployeeAdvancePlan"
  FOR EACH ROW EXECUTE FUNCTION hr_advance_plan_guard();
ALTER TABLE "EmployeeAdvancePlan" ENABLE ROW LEVEL SECURITY;

COMMIT;
