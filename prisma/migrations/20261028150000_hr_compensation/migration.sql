-- HR phase 4: the pay-component catalogue, effective-dated compensation packages approved by
-- a second person, and statutory rule sets verified by a second person before payroll may use
-- them (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.6, §3.10). No component, salary or statutory value
-- is seeded.
BEGIN;

-- CreateTable
CREATE TABLE "PayComponent" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "kind" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "systemRole" TEXT,
    "taxable" BOOLEAN,
    "insurable" BOOLEAN,
    "expenseAccountId" TEXT,
    "liabilityAccountId" TEXT,
    "payslipOrder" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeCompensation" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "effectiveTo" TEXT,
    "insurableWage" DECIMAL(18,2),
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvalRequestId" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionComment" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeCompensation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeCompensationLine" (
    "id" TEXT NOT NULL,
    "compensationId" TEXT NOT NULL,
    "payComponentId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "EmployeeCompensationLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatutoryRuleSet" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "effectiveTo" TEXT,
    "parameters" JSONB NOT NULL,
    "sourceReference" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedById" TEXT,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "StatutoryRuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayComponent_code_key" ON "PayComponent"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PayComponent_systemRole_key" ON "PayComponent"("systemRole");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeCompensation_number_key" ON "EmployeeCompensation"("number");

-- CreateIndex
CREATE INDEX "EmployeeCompensation_employeeId_effectiveFrom_idx" ON "EmployeeCompensation"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "EmployeeCompensation_status_idx" ON "EmployeeCompensation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeCompensationLine_compensationId_payComponentId_key" ON "EmployeeCompensationLine"("compensationId", "payComponentId");

-- CreateIndex
CREATE INDEX "StatutoryRuleSet_code_status_idx" ON "StatutoryRuleSet"("code", "status");

-- AddForeignKey
ALTER TABLE "PayComponent" ADD CONSTRAINT "PayComponent_expenseAccountId_fkey" FOREIGN KEY ("expenseAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayComponent" ADD CONSTRAINT "PayComponent_liabilityAccountId_fkey" FOREIGN KEY ("liabilityAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeCompensation" ADD CONSTRAINT "EmployeeCompensation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeCompensationLine" ADD CONSTRAINT "EmployeeCompensationLine_compensationId_fkey" FOREIGN KEY ("compensationId") REFERENCES "EmployeeCompensation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeCompensationLine" ADD CONSTRAINT "EmployeeCompensationLine_payComponentId_fkey" FOREIGN KEY ("payComponentId") REFERENCES "PayComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Pay components
-- ---------------------------------------------------------------------------
ALTER TABLE "PayComponent" ADD CONSTRAINT "PayComponent_values" CHECK (
  "code" ~ '^[A-Za-z][A-Za-z0-9_]{1,29}$'
  AND length(btrim("nameAr")) > 0
  AND "kind" IN ('earning', 'deduction', 'employer_contribution', 'information')
  AND "method" IN ('fixed', 'input', 'system')
  AND (("method" = 'system') = ("systemRole" IS NOT NULL))
  AND ("systemRole" IS NULL OR "systemRole" IN ('overtime_day', 'overtime_night', 'overtime_rest_day', 'overtime_holiday',
       'unpaid_absence', 'partial_leave', 'social_insurance_employee', 'social_insurance_employer', 'income_tax',
       'other_levy_employee', 'other_levy_employer', 'advance_recovery', 'rounding'))
  -- Tax and insurance treatment is the accountant's decision; until both are set, the component stays inactive.
  AND (NOT "active" OR ("taxable" IS NOT NULL AND "insurable" IS NOT NULL))
  AND "payslipOrder" BETWEEN 0 AND 9999
  AND "version" >= 1
);

-- ---------------------------------------------------------------------------
-- Compensation packages
-- ---------------------------------------------------------------------------
ALTER TABLE "EmployeeCompensation" ADD CONSTRAINT "EmployeeCompensation_values" CHECK (
  "effectiveFrom" ~ '^\d{4}-\d{2}-\d{2}$'
  AND ("effectiveTo" IS NULL OR ("effectiveTo" ~ '^\d{4}-\d{2}-\d{2}$' AND "effectiveTo"::date >= "effectiveFrom"::date - 1))
  AND "status" IN ('pending', 'approved', 'rejected', 'cancelled', 'superseded')
  AND length(btrim("reason")) > 0
  AND ("insurableWage" IS NULL OR "insurableWage" >= 0)
  AND ("status" NOT IN ('approved', 'rejected', 'superseded') OR ("decidedAt" IS NOT NULL AND "decidedBy" IS NOT NULL))
  AND ("status" <> 'superseded' OR "effectiveTo" IS NOT NULL)
  AND ("effectiveTo" IS NULL OR "status" IN ('approved', 'superseded'))
  -- Segregation of duties: whoever proposed a package does not approve it.
  AND ("decidedById" IS NULL OR "createdById" IS NULL OR "decidedById" <> "createdById")
  AND "version" >= 1
);

CREATE OR REPLACE FUNCTION hr_compensation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compensation packages are never deleted (%)', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'approvalRequestId', 'decidedById', 'decidedBy', 'decidedAt', 'decisionComment', 'effectiveTo', 'version'])
     <> (to_jsonb(OLD) - ARRAY['status', 'approvalRequestId', 'decidedById', 'decidedBy', 'decidedAt', 'decisionComment', 'effectiveTo', 'version']) THEN
    RAISE EXCEPTION 'compensation package % cannot change its employee, dates or amounts', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'pending' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
    OR (OLD."status" = 'approved' AND NEW."status" = 'superseded')) THEN
    RAISE EXCEPTION 'compensation package % cannot go from % to %', OLD."number", OLD."status", NEW."status" USING ERRCODE = 'P0001';
  END IF;
  -- An approved package is only ever closed, once.
  IF NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo" AND (OLD."effectiveTo" IS NOT NULL OR OLD."status" <> 'approved') THEN
    RAISE EXCEPTION 'compensation package % end date can only be set once, on an approved package', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EmployeeCompensation_guard" BEFORE UPDATE OR DELETE ON "EmployeeCompensation"
  FOR EACH ROW EXECUTE FUNCTION hr_compensation_guard();

-- Approved packages of one employee never overlap (an empty range — superseded on its first day — never applied).
CREATE OR REPLACE FUNCTION hr_compensation_no_overlap() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'approved' AND EXISTS (
    SELECT 1 FROM "EmployeeCompensation" c
    WHERE c."employeeId" = NEW."employeeId" AND c."id" <> NEW."id" AND c."status" = 'approved'
      AND c."effectiveFrom" <= coalesce(NEW."effectiveTo", '9999-12-31')
      AND NEW."effectiveFrom" <= coalesce(c."effectiveTo", '9999-12-31')
  ) THEN
    RAISE EXCEPTION 'compensation package % overlaps another approved package', NEW."number" USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "EmployeeCompensation_no_overlap" AFTER INSERT OR UPDATE ON "EmployeeCompensation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hr_compensation_no_overlap();

ALTER TABLE "EmployeeCompensationLine" ADD CONSTRAINT "EmployeeCompensationLine_values" CHECK ("amount" > 0);

-- Lines are written with their package and frozen once it leaves `pending`.
CREATE OR REPLACE FUNCTION hr_compensation_line_guard() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT "status" INTO st FROM "EmployeeCompensation" WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."compensationId" ELSE NEW."compensationId" END;
  IF st IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'the lines of a % compensation package cannot change', coalesce(st, 'missing') USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EmployeeCompensationLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EmployeeCompensationLine"
  FOR EACH ROW EXECUTE FUNCTION hr_compensation_line_guard();

-- ---------------------------------------------------------------------------
-- Statutory rule sets: draft → verified (by someone else) → retired; never edited once verified.
-- ---------------------------------------------------------------------------
ALTER TABLE "StatutoryRuleSet" ADD CONSTRAINT "StatutoryRuleSet_values" CHECK (
  "code" ~ '^[a-z][a-z0-9_]{2,40}$'
  AND "effectiveFrom" ~ '^\d{4}-\d{2}-\d{2}$'
  AND ("effectiveTo" IS NULL OR ("effectiveTo" ~ '^\d{4}-\d{2}-\d{2}$' AND "effectiveTo" >= "effectiveFrom"))
  AND "status" IN ('draft', 'verified', 'retired')
  AND length(btrim("sourceReference")) > 0
  AND jsonb_typeof("parameters") = 'object'
  AND ("status" = 'draft' OR ("verifiedAt" IS NOT NULL AND "verifiedBy" IS NOT NULL))
  AND ("verifiedById" IS NULL OR "createdById" IS NULL OR "verifiedById" <> "createdById")
  AND "version" >= 1
);

-- The same rule as leave policies (hr_leave_policy_guard is generic over status / effectiveTo / version).
CREATE TRIGGER "StatutoryRuleSet_guard" BEFORE UPDATE OR DELETE ON "StatutoryRuleSet"
  FOR EACH ROW EXECUTE FUNCTION hr_leave_policy_guard();

CREATE OR REPLACE FUNCTION hr_rule_set_no_overlap() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'verified' AND EXISTS (
    SELECT 1 FROM "StatutoryRuleSet" r
    WHERE r."code" = NEW."code" AND r."id" <> NEW."id" AND r."status" = 'verified'
      AND r."effectiveFrom" <= coalesce(NEW."effectiveTo", '9999-12-31')
      AND NEW."effectiveFrom" <= coalesce(r."effectiveTo", '9999-12-31')
  ) THEN
    RAISE EXCEPTION 'rule set % overlaps another verified rule set with code %', NEW."id", NEW."code" USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "StatutoryRuleSet_no_overlap" AFTER INSERT OR UPDATE ON "StatutoryRuleSet"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hr_rule_set_no_overlap();

ALTER TABLE "PayComponent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeCompensation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeCompensationLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StatutoryRuleSet" ENABLE ROW LEVEL SECURITY;

COMMIT;
