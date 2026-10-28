-- HR phase 3: leave types, effective-dated policies with tiers (verified by a second person),
-- an append-only leave ledger, and leave requests (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.5, §4.4).
-- No leave type or entitlement is seeded: the values are statutory / company inputs (§7 S2, S3).
BEGIN;

-- CreateTable
CREATE TABLE "LeaveType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "payMode" TEXT NOT NULL,
    "paidPercent" DECIMAL(5,2),
    "countsDays" TEXT NOT NULL,
    "requiresAttachment" BOOLEAN NOT NULL DEFAULT false,
    "allowNegativeBalance" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeavePolicy" (
    "id" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "effectiveTo" TEXT,
    "accrualMethod" TEXT NOT NULL,
    "carryOverMaxDays" DECIMAL(6,2),
    "carryOverExpiryMonths" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sourceReference" TEXT NOT NULL,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedById" TEXT,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeavePolicyTier" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "minServiceMonths" INTEGER NOT NULL,
    "minAge" INTEGER,
    "daysPerYear" DECIMAL(6,2) NOT NULL,

    CONSTRAINT "LeavePolicyTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveLedgerEntry" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvalRequestId" TEXT,
    "requestedById" TEXT,
    "requestedBy" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionComment" TEXT,
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_code_key" ON "LeaveType"("code");

-- CreateIndex
CREATE INDEX "LeavePolicy_leaveTypeId_status_idx" ON "LeavePolicy"("leaveTypeId", "status");

-- CreateIndex
CREATE INDEX "LeavePolicyTier_policyId_idx" ON "LeavePolicyTier"("policyId");

-- CreateIndex
CREATE INDEX "LeaveLedgerEntry_employeeId_leaveTypeId_idx" ON "LeaveLedgerEntry"("employeeId", "leaveTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveLedgerEntry_sourceType_sourceId_kind_key" ON "LeaveLedgerEntry"("sourceType", "sourceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveRequest_number_key" ON "LeaveRequest"("number");

-- CreateIndex
CREATE INDEX "LeaveRequest_employeeId_startDate_idx" ON "LeaveRequest"("employeeId", "startDate");

-- CreateIndex
CREATE INDEX "LeaveRequest_status_idx" ON "LeaveRequest"("status");

-- AddForeignKey
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "LeaveRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicyTier" ADD CONSTRAINT "LeavePolicyTier_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "LeavePolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Leave types
-- ---------------------------------------------------------------------------
ALTER TABLE "LeaveType" ADD CONSTRAINT "LeaveType_values" CHECK (
  "code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$'
  AND length(btrim("nameAr")) > 0
  AND "payMode" IN ('paid', 'unpaid', 'partially_paid')
  AND CASE WHEN "payMode" = 'partially_paid' THEN "paidPercent" > 0 AND "paidPercent" < 100 ELSE "paidPercent" IS NULL END
  AND "countsDays" IN ('working', 'calendar')
  AND "version" >= 1
);

-- ---------------------------------------------------------------------------
-- Policies: draft → verified (by someone else) → retired. A verified policy never changes
-- except to be retired / end-dated; its tiers change only while it is a draft.
-- ---------------------------------------------------------------------------
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_values" CHECK (
  "effectiveFrom" ~ '^\d{4}-\d{2}-\d{2}$'
  AND ("effectiveTo" IS NULL OR ("effectiveTo" ~ '^\d{4}-\d{2}-\d{2}$' AND "effectiveTo" >= "effectiveFrom"))
  AND "accrualMethod" IN ('none', 'annual_upfront', 'monthly')
  AND "status" IN ('draft', 'verified', 'retired')
  AND length(btrim("sourceReference")) > 0
  AND ("carryOverMaxDays" IS NULL OR "carryOverMaxDays" >= 0)
  AND ("carryOverExpiryMonths" IS NULL OR "carryOverExpiryMonths" BETWEEN 0 AND 120)
  AND ("status" = 'draft' OR ("verifiedAt" IS NOT NULL AND "verifiedBy" IS NOT NULL))
  -- Four eyes: whoever entered the values does not verify them.
  AND ("verifiedById" IS NULL OR "createdById" IS NULL OR "verifiedById" <> "createdById")
  AND "version" >= 1
);

CREATE OR REPLACE FUNCTION hr_leave_policy_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN
      RAISE EXCEPTION 'leave policy % is % and cannot be deleted', OLD."id", OLD."status" USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'retired' THEN
    RAISE EXCEPTION 'leave policy % is retired and cannot change', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" = 'verified' THEN
    IF NEW."status" NOT IN ('verified', 'retired')
       OR (to_jsonb(NEW) - ARRAY['status', 'effectiveTo', 'version']) <> (to_jsonb(OLD) - ARRAY['status', 'effectiveTo', 'version'])
       OR (OLD."effectiveTo" IS NOT NULL AND NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo") THEN
      RAISE EXCEPTION 'verified leave policy % can only be retired or end-dated', OLD."id" USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LeavePolicy_guard" BEFORE UPDATE OR DELETE ON "LeavePolicy"
  FOR EACH ROW EXECUTE FUNCTION hr_leave_policy_guard();

-- Two verified policies of the same type never apply on the same day.
CREATE OR REPLACE FUNCTION hr_leave_policy_no_overlap() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'verified' AND EXISTS (
    SELECT 1 FROM "LeavePolicy" p
    WHERE p."leaveTypeId" = NEW."leaveTypeId" AND p."id" <> NEW."id" AND p."status" = 'verified'
      AND p."effectiveFrom" <= coalesce(NEW."effectiveTo", '9999-12-31')
      AND NEW."effectiveFrom" <= coalesce(p."effectiveTo", '9999-12-31')
  ) THEN
    RAISE EXCEPTION 'leave policy % overlaps another verified policy of the same type', NEW."id" USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "LeavePolicy_no_overlap" AFTER INSERT OR UPDATE ON "LeavePolicy"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hr_leave_policy_no_overlap();

ALTER TABLE "LeavePolicyTier" ADD CONSTRAINT "LeavePolicyTier_values" CHECK (
  "minServiceMonths" BETWEEN 0 AND 1200
  AND ("minAge" IS NULL OR "minAge" BETWEEN 14 AND 100)
  AND "daysPerYear" >= 0 AND "daysPerYear" <= 366
);

CREATE OR REPLACE FUNCTION hr_leave_tier_guard() RETURNS trigger AS $$
DECLARE
  pid text := CASE WHEN TG_OP = 'DELETE' THEN OLD."policyId" ELSE NEW."policyId" END;
  st text;
BEGIN
  SELECT "status" INTO st FROM "LeavePolicy" WHERE "id" = pid;
  -- st IS NULL: the policy itself is being deleted (a draft — its own guard checked that).
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'tiers of a % leave policy cannot change', st USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LeavePolicyTier_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LeavePolicyTier"
  FOR EACH ROW EXECUTE FUNCTION hr_leave_tier_guard();

-- ---------------------------------------------------------------------------
-- Ledger: append-only, each kind with its sign; (sourceType, sourceId, kind) is idempotent.
-- ---------------------------------------------------------------------------
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_values" CHECK (
  "date" ~ '^\d{4}-\d{2}-\d{2}$'
  AND length(btrim("sourceType")) > 0 AND length(btrim("sourceId")) > 0
  AND CASE "kind"
        WHEN 'allocation' THEN "days" > 0
        WHEN 'accrual' THEN "days" > 0
        WHEN 'carry_over' THEN "days" > 0
        WHEN 'taken_reversal' THEN "days" > 0
        WHEN 'taken' THEN "days" < 0
        WHEN 'expiry' THEN "days" < 0
        WHEN 'encashment' THEN "days" < 0
        WHEN 'adjustment' THEN "days" <> 0 AND length(btrim(coalesce("note", ''))) > 0
        ELSE false END
);
CREATE TRIGGER "LeaveLedgerEntry_append_only" BEFORE UPDATE OR DELETE ON "LeaveLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION hr_append_only();

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_values" CHECK (
  "startDate" ~ '^\d{4}-\d{2}-\d{2}$' AND "endDate" ~ '^\d{4}-\d{2}-\d{2}$' AND "endDate" >= "startDate"
  AND "days" > 0
  AND "status" IN ('pending', 'approved', 'rejected', 'cancelled')
  AND ("status" NOT IN ('approved', 'rejected') OR ("decidedAt" IS NOT NULL AND "decidedBy" IS NOT NULL))
  AND ("status" <> 'cancelled' OR "cancelledBy" IS NOT NULL)
  -- Segregation of duties: whoever recorded a leave request does not decide it.
  AND ("decidedById" IS NULL OR "requestedById" IS NULL OR "decidedById" <> "requestedById")
  AND "version" >= 1
);

CREATE OR REPLACE FUNCTION hr_leave_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'leave requests are never deleted (%)', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'approvalRequestId', 'decidedById', 'decidedBy', 'decidedAt', 'decisionComment', 'cancelledBy', 'cancelReason', 'version'])
     <> (to_jsonb(OLD) - ARRAY['status', 'approvalRequestId', 'decidedById', 'decidedBy', 'decidedAt', 'decisionComment', 'cancelledBy', 'cancelReason', 'version']) THEN
    RAISE EXCEPTION 'leave request % cannot change its employee, type, dates or days', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'pending' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
    OR (OLD."status" = 'approved' AND NEW."status" = 'cancelled')) THEN
    RAISE EXCEPTION 'leave request % cannot go from % to %', OLD."number", OLD."status", NEW."status" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LeaveRequest_guard" BEFORE UPDATE OR DELETE ON "LeaveRequest"
  FOR EACH ROW EXECUTE FUNCTION hr_leave_request_guard();

-- An employee's pending or approved requests never overlap.
CREATE OR REPLACE FUNCTION hr_leave_request_no_overlap() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN ('pending', 'approved') AND EXISTS (
    SELECT 1 FROM "LeaveRequest" r
    WHERE r."employeeId" = NEW."employeeId" AND r."id" <> NEW."id" AND r."status" IN ('pending', 'approved')
      AND r."startDate" <= NEW."endDate" AND NEW."startDate" <= r."endDate"
  ) THEN
    RAISE EXCEPTION 'leave request % overlaps another open request of the same employee', NEW."number" USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "LeaveRequest_no_overlap" AFTER INSERT OR UPDATE ON "LeaveRequest"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hr_leave_request_no_overlap();

ALTER TABLE "LeaveType" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeavePolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeavePolicyTier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeaveLedgerEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeaveRequest" ENABLE ROW LEVEL SECURITY;

COMMIT;
