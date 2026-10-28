-- ===========================================================================
-- HR Phase 1 — employee foundation (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.2–3.3, §9).
--
-- Additive only: four new tables, one nullable column, one CHECK widened. Existing rows
-- keep their meaning; Employee.departmentId / jobTitle / active stay the current values and
-- are mirrored by the open EmployeeEmployment row (backfilled below, one per employee).
-- Wrapped in one transaction: a failure leaves the schema exactly as it was.
-- ===========================================================================
BEGIN;

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "managerEmployeeId" TEXT;

-- CreateTable
CREATE TABLE "EmployeeEmployment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "effectiveTo" TEXT,
    "event" TEXT NOT NULL,
    "departmentId" TEXT,
    "jobTitle" TEXT,
    "managerEmployeeId" TEXT,
    "employmentType" TEXT,
    "contractStart" TEXT,
    "contractEnd" TEXT,
    "probationEnd" TEXT,
    "status" TEXT NOT NULL,
    "terminationReason" TEXT,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeEmployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeePrivateInfo" (
    "employeeId" TEXT NOT NULL,
    "nationalId" TEXT,
    "birthDate" TEXT,
    "nationality" TEXT,
    "insuranceNumber" TEXT,
    "insuranceStartDate" TEXT,
    "taxRegistrationNo" TEXT,
    "address" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeePrivateInfo_pkey" PRIMARY KEY ("employeeId")
);

-- CreateTable
CREATE TABLE "EmployeeBankAccount" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "iban" TEXT,
    "holderName" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "verifiedById" TEXT,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),

    CONSTRAINT "EmployeeBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "documentNumber" TEXT,
    "issueDate" TEXT,
    "expiryDate" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeEmployment_employeeId_effectiveFrom_idx" ON "EmployeeEmployment"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "EmployeeEmployment_departmentId_idx" ON "EmployeeEmployment"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeePrivateInfo_nationalId_key" ON "EmployeePrivateInfo"("nationalId");

-- CreateIndex
CREATE INDEX "EmployeeBankAccount_employeeId_idx" ON "EmployeeBankAccount"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeDocument_attachmentId_key" ON "EmployeeDocument"("attachmentId");

-- CreateIndex
CREATE INDEX "EmployeeDocument_employeeId_idx" ON "EmployeeDocument"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeeDocument_expiryDate_idx" ON "EmployeeDocument"("expiryDate");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_managerEmployeeId_fkey" FOREIGN KEY ("managerEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeEmployment" ADD CONSTRAINT "EmployeeEmployment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeEmployment" ADD CONSTRAINT "EmployeeEmployment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeEmployment" ADD CONSTRAINT "EmployeeEmployment_managerEmployeeId_fkey" FOREIGN KEY ("managerEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeePrivateInfo" ADD CONSTRAINT "EmployeePrivateInfo_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeBankAccount" ADD CONSTRAINT "EmployeeBankAccount_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Employment history: shape, one open row per employee, no overlapping ranges,
-- append-only except closing the open row once.
-- ---------------------------------------------------------------------------
ALTER TABLE "EmployeeEmployment" ADD CONSTRAINT "EmployeeEmployment_values" CHECK (
  "effectiveFrom" ~ '^\d{4}-\d{2}-\d{2}$'
  -- effectiveTo = effectiveFrom − 1 day is an empty range: a row superseded on its own first day.
  AND ("effectiveTo" IS NULL OR ("effectiveTo" ~ '^\d{4}-\d{2}-\d{2}$' AND "effectiveTo"::date >= "effectiveFrom"::date - 1))
  AND "event" IN ('hire', 'transfer', 'promotion', 'status_change', 'contract_change', 'termination', 'rehire')
  AND "status" IN ('active', 'suspended', 'terminated')
  AND ("status" <> 'terminated' OR length(btrim(coalesce("terminationReason", ''))) > 0)
  AND ("managerEmployeeId" IS NULL OR "managerEmployeeId" <> "employeeId")
  AND length(btrim("reason")) > 0
  AND ("contractStart" IS NULL OR "contractStart" ~ '^\d{4}-\d{2}-\d{2}$')
  AND ("contractEnd" IS NULL OR "contractEnd" ~ '^\d{4}-\d{2}-\d{2}$')
  AND ("probationEnd" IS NULL OR "probationEnd" ~ '^\d{4}-\d{2}-\d{2}$')
);
CREATE UNIQUE INDEX "EmployeeEmployment_one_open" ON "EmployeeEmployment"("employeeId") WHERE "effectiveTo" IS NULL;

CREATE OR REPLACE FUNCTION hr_employment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EmployeeEmployment is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- The only permitted change: closing the open row, once.
    IF OLD."effectiveTo" IS NOT NULL OR NEW."effectiveTo" IS NULL
       OR (to_jsonb(NEW) - 'effectiveTo') IS DISTINCT FROM (to_jsonb(OLD) - 'effectiveTo') THEN
      RAISE EXCEPTION 'EmployeeEmployment is append-only (only closing the open row is allowed)' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "EmployeeEmployment" e
    WHERE e."employeeId" = NEW."employeeId" AND e."id" <> NEW."id"
      AND e."effectiveFrom" <= coalesce(NEW."effectiveTo", '9999-12-31')
      AND NEW."effectiveFrom" <= coalesce(e."effectiveTo", '9999-12-31')
  ) THEN
    RAISE EXCEPTION 'employment periods of employee % overlap', NEW."employeeId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- Deferred so "close the open row, then insert the next" inside one transaction is checked
-- against the final state, whatever order the two statements run in.
CREATE CONSTRAINT TRIGGER "EmployeeEmployment_no_overlap" AFTER INSERT OR UPDATE ON "EmployeeEmployment"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hr_employment_guard();
CREATE TRIGGER "EmployeeEmployment_append_only" BEFORE UPDATE OR DELETE ON "EmployeeEmployment"
FOR EACH ROW EXECUTE FUNCTION hr_employment_guard();

-- ---------------------------------------------------------------------------
-- Confidential data: shapes; bank accounts keep history (only deactivation and
-- verification may change a row); one primary active account per employee.
-- ---------------------------------------------------------------------------
ALTER TABLE "EmployeePrivateInfo" ADD CONSTRAINT "EmployeePrivateInfo_values" CHECK (
  ("birthDate" IS NULL OR "birthDate" ~ '^\d{4}-\d{2}-\d{2}$')
  AND ("insuranceStartDate" IS NULL OR "insuranceStartDate" ~ '^\d{4}-\d{2}-\d{2}$')
  AND ("nationalId" IS NULL OR length(btrim("nationalId")) > 0)
);
ALTER TABLE "EmployeeBankAccount" ADD CONSTRAINT "EmployeeBankAccount_values" CHECK (
  length(btrim("bankName")) > 0 AND length(btrim("accountNumber")) > 0 AND length(btrim("holderName")) > 0
  AND ("active" OR "deactivatedAt" IS NOT NULL)
);
CREATE UNIQUE INDEX "EmployeeBankAccount_one_primary" ON "EmployeeBankAccount"("employeeId") WHERE "isPrimary" AND "active";
CREATE OR REPLACE FUNCTION hr_bank_account_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EmployeeBankAccount is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."employeeId", NEW."bankName", NEW."accountNumber", NEW."iban", NEW."holderName", NEW."createdById", NEW."createdBy", NEW."createdAt")
     IS DISTINCT FROM (OLD."employeeId", OLD."bankName", OLD."accountNumber", OLD."iban", OLD."holderName", OLD."createdById", OLD."createdBy", OLD."createdAt")
     OR (OLD."active" = false AND NEW."active" = true) THEN
    RAISE EXCEPTION 'a bank account is replaced, never edited' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "EmployeeBankAccount_guard" BEFORE UPDATE OR DELETE ON "EmployeeBankAccount"
FOR EACH ROW EXECUTE FUNCTION hr_bank_account_guard();

ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_values" CHECK (
  "docType" IN ('id_document', 'employment_contract', 'insurance_form', 'certificate', 'medical', 'other')
  AND ("issueDate" IS NULL OR "issueDate" ~ '^\d{4}-\d{2}-\d{2}$')
  AND ("expiryDate" IS NULL OR "expiryDate" ~ '^\d{4}-\d{2}-\d{2}$')
);

-- Employee files may be filed under their own categories (existing categories unchanged).
ALTER TABLE "Attachment" DROP CONSTRAINT "Attachment_category_known";
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_category_known" CHECK ("category" IN
  ('contract', 'invoice', 'delivery_note', 'purchase_document', 'quality_photo', 'receipt', 'tax_document', 'other',
   'id_document', 'employment_contract', 'insurance_form', 'certificate', 'medical'));

-- Row-level security like the other HR tables (no policies: only the server's own connection
-- reads them). Before the backfill: a table with queued deferred-trigger events cannot be altered.
ALTER TABLE "EmployeeEmployment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeePrivateInfo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeBankAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeDocument" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Backfill: one open employment row per existing employee, mirroring today's values.
-- An inactive employee becomes "suspended" (not "terminated"): nothing records why they
-- were deactivated, and a termination needs a reason. HR can record the real event later.
-- ---------------------------------------------------------------------------
INSERT INTO "EmployeeEmployment" ("id", "employeeId", "effectiveFrom", "event", "departmentId", "jobTitle", "status", "reason", "createdBy")
SELECT
  'emp_hist_' || e."id",
  e."id",
  CASE WHEN e."hireDate" ~ '^\d{4}-\d{2}-\d{2}$' THEN e."hireDate"
       ELSE to_char(e."createdAt" AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') END,
  'hire',
  e."departmentId",
  e."jobTitle",
  CASE WHEN e."active" THEN 'active' ELSE 'suspended' END,
  'Initial record created from the employee register (HR phase 1 migration)',
  'system'
FROM "Employee" e;

COMMIT;
