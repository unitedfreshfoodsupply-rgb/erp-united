-- HR phase 2: work schedules, public holidays, attendance days with an append-only revision
-- trail, corrections, and the device seam (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.4, §4.3).
-- No schedule, holiday or statutory value is seeded: those are company / legal inputs.
BEGIN;

-- AlterTable
ALTER TABLE "EmployeeEmployment" ADD COLUMN     "workScheduleId" TEXT;

-- CreateTable
CREATE TABLE "WorkSchedule" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "weeklyHours" DECIMAL(6,2) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkScheduleDay" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "isWorkingDay" BOOLEAN NOT NULL,
    "start" TEXT,
    "end" TEXT,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "nightStart" TEXT,
    "nightEnd" TEXT,

    CONSTRAINT "WorkScheduleDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicHoliday" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "reference" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceDay" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "firstIn" TIMESTAMP(3),
    "lastOut" TIMESTAMP(3),
    "workedMinutes" INTEGER NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeDayMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeNightMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeRestDayMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeHolidayMinutes" INTEGER NOT NULL DEFAULT 0,
    "leaveRequestId" TEXT,
    "source" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "lockedRunId" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "enteredById" TEXT,
    "enteredBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceDayRevision" (
    "id" TEXT NOT NULL,
    "attendanceDayId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "reason" TEXT,
    "correctionId" TEXT,
    "changedById" TEXT,
    "changedBy" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceDayRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceCorrection" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "requested" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvalRequestId" TEXT,
    "retroStatus" TEXT NOT NULL DEFAULT 'none',
    "retroAdjustmentId" TEXT,
    "appliedRevision" INTEGER,
    "requestedById" TEXT,
    "requestedBy" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionComment" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceSource" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "integrationId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceIdentity" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceEvent" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "direction" TEXT NOT NULL,
    "payload" JSONB,
    "batchId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceImportBatch" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventCount" INTEGER NOT NULL,
    "accepted" INTEGER NOT NULL,
    "duplicates" INTEGER NOT NULL,
    "unmatched" INTEGER NOT NULL,

    CONSTRAINT "AttendanceImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkSchedule_code_key" ON "WorkSchedule"("code");

-- CreateIndex
CREATE UNIQUE INDEX "WorkScheduleDay_scheduleId_weekday_key" ON "WorkScheduleDay"("scheduleId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "PublicHoliday_date_key" ON "PublicHoliday"("date");

-- CreateIndex
CREATE INDEX "AttendanceDay_date_idx" ON "AttendanceDay"("date");

-- CreateIndex
CREATE INDEX "AttendanceDay_state_idx" ON "AttendanceDay"("state");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDay_employeeId_date_key" ON "AttendanceDay"("employeeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDayRevision_attendanceDayId_revision_key" ON "AttendanceDayRevision"("attendanceDayId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceCorrection_number_key" ON "AttendanceCorrection"("number");

-- CreateIndex
CREATE INDEX "AttendanceCorrection_employeeId_date_idx" ON "AttendanceCorrection"("employeeId", "date");

-- CreateIndex
CREATE INDEX "AttendanceCorrection_status_idx" ON "AttendanceCorrection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSource_code_key" ON "AttendanceSource"("code");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSource_integrationId_key" ON "AttendanceSource"("integrationId");

-- CreateIndex
CREATE INDEX "AttendanceIdentity_employeeId_idx" ON "AttendanceIdentity"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceIdentity_sourceId_externalUserId_key" ON "AttendanceIdentity"("sourceId", "externalUserId");

-- CreateIndex
CREATE INDEX "AttendanceEvent_sourceId_externalUserId_occurredAt_idx" ON "AttendanceEvent"("sourceId", "externalUserId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceEvent_sourceId_externalEventId_key" ON "AttendanceEvent"("sourceId", "externalEventId");

-- AddForeignKey
ALTER TABLE "EmployeeEmployment" ADD CONSTRAINT "EmployeeEmployment_workScheduleId_fkey" FOREIGN KEY ("workScheduleId") REFERENCES "WorkSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkScheduleDay" ADD CONSTRAINT "WorkScheduleDay_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "WorkSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDayRevision" ADD CONSTRAINT "AttendanceDayRevision_attendanceDayId_fkey" FOREIGN KEY ("attendanceDayId") REFERENCES "AttendanceDay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDayRevision" ADD CONSTRAINT "AttendanceDayRevision_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "AttendanceCorrection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSource" ADD CONSTRAINT "AttendanceSource_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceIdentity" ADD CONSTRAINT "AttendanceIdentity_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "AttendanceSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceIdentity" ADD CONSTRAINT "AttendanceIdentity_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "AttendanceSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "AttendanceImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceImportBatch" ADD CONSTRAINT "AttendanceImportBatch_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "AttendanceSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Schedules and holidays
-- ---------------------------------------------------------------------------
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_values" CHECK (
  "code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$'
  AND length(btrim("nameAr")) > 0
  AND "weeklyHours" >= 0 AND "weeklyHours" <= 168
  AND (NOT "isDefault" OR "active")
  AND "version" >= 1
);
CREATE UNIQUE INDEX "WorkSchedule_one_default" ON "WorkSchedule" ("isDefault") WHERE "isDefault";

ALTER TABLE "WorkScheduleDay" ADD CONSTRAINT "WorkScheduleDay_values" CHECK (
  "weekday" BETWEEN 0 AND 6
  AND ("start" IS NULL OR "start" ~ '^([01]\d|2[0-3]):[0-5]\d$')
  AND ("end" IS NULL OR "end" ~ '^([01]\d|2[0-3]):[0-5]\d$')
  AND ("nightStart" IS NULL OR "nightStart" ~ '^([01]\d|2[0-3]):[0-5]\d$')
  AND ("nightEnd" IS NULL OR "nightEnd" ~ '^([01]\d|2[0-3]):[0-5]\d$')
  AND (("nightStart" IS NULL) = ("nightEnd" IS NULL))
  AND ("nightStart" IS NULL OR "nightStart" <> "nightEnd")
  AND CASE WHEN "isWorkingDay" THEN "start" IS NOT NULL AND "end" IS NOT NULL AND "start" <> "end"
           ELSE "start" IS NULL AND "end" IS NULL END
  AND "breakMinutes" BETWEEN 0 AND 600
);

ALTER TABLE "PublicHoliday" ADD CONSTRAINT "PublicHoliday_values" CHECK (
  "date" ~ '^\d{4}-\d{2}-\d{2}$' AND length(btrim("nameAr")) > 0
);

-- ---------------------------------------------------------------------------
-- Attendance days
-- ---------------------------------------------------------------------------
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_values" CHECK (
  "date" ~ '^\d{4}-\d{2}-\d{2}$'
  AND "status" IN ('present', 'absent', 'absent_unpaid', 'leave', 'holiday', 'rest_day', 'suspended')
  AND "source" IN ('manual', 'device', 'correction', 'leave', 'system')
  AND "state" IN ('draft', 'confirmed', 'locked')
  AND (("state" = 'locked') = ("lockedRunId" IS NOT NULL))
  AND "workedMinutes" BETWEEN 0 AND 2880 AND "lateMinutes" BETWEEN 0 AND 1440 AND "earlyLeaveMinutes" BETWEEN 0 AND 1440
  AND "overtimeDayMinutes" BETWEEN 0 AND 1440 AND "overtimeNightMinutes" BETWEEN 0 AND 1440
  AND "overtimeRestDayMinutes" BETWEEN 0 AND 1440 AND "overtimeHolidayMinutes" BETWEEN 0 AND 1440
  AND (("firstIn" IS NULL) = ("lastOut" IS NULL))
  AND ("lastOut" IS NULL OR "lastOut" >= "firstIn")
  -- Only a worked day carries times and minutes.
  AND ("status" = 'present' OR ("firstIn" IS NULL AND "workedMinutes" = 0 AND "lateMinutes" = 0 AND "earlyLeaveMinutes" = 0
       AND "overtimeDayMinutes" = 0 AND "overtimeNightMinutes" = 0 AND "overtimeRestDayMinutes" = 0 AND "overtimeHolidayMinutes" = 0))
  -- A leave day exists only through an approved leave request (phase 3).
  AND ("status" <> 'leave' OR "leaveRequestId" IS NOT NULL)
  AND "version" >= 1
);

-- Days are never deleted. Every update moves the version by one (the revision trigger
-- below then requires the matching revision row). Locking and unlocking change only the
-- state. Values of a locked day change only through an approved correction, which marks
-- its transaction with united.attendance_correction.
CREATE OR REPLACE FUNCTION hr_attendance_day_guard() RETURNS trigger AS $$
DECLARE
  data_changed boolean;
  correcting text := current_setting('united.attendance_correction', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attendance days are never deleted (%)', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."employeeId" <> OLD."employeeId" OR NEW."date" <> OLD."date" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'attendance day identity is immutable (%)', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'attendance day % must move from version % to %', OLD."id", OLD."version", OLD."version" + 1 USING ERRCODE = 'P0001';
  END IF;
  data_changed := (to_jsonb(NEW) - ARRAY['state', 'lockedRunId', 'version', 'updatedAt'])
               <> (to_jsonb(OLD) - ARRAY['state', 'lockedRunId', 'version', 'updatedAt']);
  IF NEW."state" <> OLD."state" AND NOT (
       (OLD."state" = 'draft' AND NEW."state" = 'confirmed')
    OR (OLD."state" = 'confirmed' AND NEW."state" IN ('draft', 'locked'))
    OR (OLD."state" = 'locked' AND NEW."state" = 'confirmed')) THEN
    RAISE EXCEPTION 'attendance day % cannot go from % to %', OLD."id", OLD."state", NEW."state" USING ERRCODE = 'P0001';
  END IF;
  IF (OLD."state" = 'locked' OR NEW."state" = 'locked') AND OLD."state" <> NEW."state" AND data_changed THEN
    RAISE EXCEPTION 'locking or unlocking attendance day % cannot change its values', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  IF OLD."state" = 'locked' AND NEW."state" = 'locked' AND (NEW."lockedRunId" <> OLD."lockedRunId") THEN
    RAISE EXCEPTION 'attendance day % is locked by another run', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  IF OLD."state" = 'locked' AND data_changed AND (coalesce(correcting, '') = '' OR NEW."source" <> 'correction') THEN
    RAISE EXCEPTION 'attendance day % is locked by payroll; only an approved correction can change it', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttendanceDay_guard" BEFORE UPDATE OR DELETE ON "AttendanceDay"
  FOR EACH ROW EXECUTE FUNCTION hr_attendance_day_guard();

-- Every version of a day has its revision row, checked at commit.
CREATE OR REPLACE FUNCTION hr_attendance_day_has_revision() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AttendanceDayRevision" r WHERE r."attendanceDayId" = NEW."id" AND r."revision" = NEW."version") THEN
    RAISE EXCEPTION 'attendance day % version % has no revision row', NEW."id", NEW."version" USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "AttendanceDay_revision_required" AFTER INSERT OR UPDATE ON "AttendanceDay"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hr_attendance_day_has_revision();

ALTER TABLE "AttendanceDayRevision" ADD CONSTRAINT "AttendanceDayRevision_values" CHECK (
  "revision" >= 1
  AND "action" IN ('entered', 'compiled', 'confirmed', 'reopened', 'corrected', 'locked', 'unlocked', 'leave')
  AND ("action" NOT IN ('reopened', 'corrected') OR length(btrim(coalesce("reason", ''))) > 0)
  AND ("action" <> 'corrected' OR "correctionId" IS NOT NULL)
);

-- Shared by the append-only tables of this phase.
CREATE OR REPLACE FUNCTION hr_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttendanceDayRevision_append_only" BEFORE UPDATE OR DELETE ON "AttendanceDayRevision"
  FOR EACH ROW EXECUTE FUNCTION hr_append_only();

-- ---------------------------------------------------------------------------
-- Corrections
-- ---------------------------------------------------------------------------
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_values" CHECK (
  "date" ~ '^\d{4}-\d{2}-\d{2}$'
  AND "status" IN ('pending', 'approved', 'rejected', 'cancelled')
  AND "retroStatus" IN ('none', 'pending', 'applied')
  AND length(btrim("reason")) > 0
  AND ("status" NOT IN ('approved', 'rejected') OR ("decidedAt" IS NOT NULL AND "decidedBy" IS NOT NULL))
  AND ("status" <> 'approved' OR "appliedRevision" IS NOT NULL)
  AND ("retroStatus" = 'none' OR "status" = 'approved')
  -- Segregation of duties: whoever asked for a correction does not decide it.
  AND ("decidedById" IS NULL OR "requestedById" IS NULL OR "decidedById" <> "requestedById")
  AND "version" >= 1
);
CREATE UNIQUE INDEX "AttendanceCorrection_one_pending" ON "AttendanceCorrection" ("employeeId", "date") WHERE "status" = 'pending';

-- ---------------------------------------------------------------------------
-- Device seam
-- ---------------------------------------------------------------------------
ALTER TABLE "AttendanceSource" ADD CONSTRAINT "AttendanceSource_values" CHECK (
  "code" ~ '^[a-z][a-z0-9_-]{1,30}$'
  AND length(btrim("name")) > 0
  AND "kind" IN ('manual', 'device', 'import_file')
  AND ("kind" <> 'manual' OR "integrationId" IS NULL)
);

ALTER TABLE "AttendanceIdentity" ADD CONSTRAINT "AttendanceIdentity_values" CHECK (length(btrim("externalUserId")) > 0);

ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_values" CHECK (
  length(btrim("externalEventId")) > 0 AND length(btrim("externalUserId")) > 0
  AND "direction" IN ('in', 'out', 'unknown')
);
CREATE TRIGGER "AttendanceEvent_append_only" BEFORE UPDATE OR DELETE ON "AttendanceEvent"
  FOR EACH ROW EXECUTE FUNCTION hr_append_only();

ALTER TABLE "AttendanceImportBatch" ADD CONSTRAINT "AttendanceImportBatch_values" CHECK (
  "eventCount" >= 0 AND "accepted" >= 0 AND "duplicates" >= 0 AND "unmatched" >= 0
  AND "accepted" + "duplicates" = "eventCount" AND "unmatched" <= "accepted"
);
CREATE TRIGGER "AttendanceImportBatch_append_only" BEFORE UPDATE OR DELETE ON "AttendanceImportBatch"
  FOR EACH ROW EXECUTE FUNCTION hr_append_only();

-- Devices authenticate as integrations with their own scope.
ALTER TABLE "Integration" DROP CONSTRAINT "Integration_values";
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_values" CHECK ("code" ~ '^[a-z][a-z0-9_-]{1,30}$' AND "scopes" <@ ARRAY['orders.create', 'orders.status', 'attendance.ingest']::text[] AND cardinality("scopes") > 0 AND ("active" OR "revokedAt" IS NOT NULL));

-- Row-level security like the other HR tables (no policies: only the server's own connection reads them).
ALTER TABLE "WorkSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkScheduleDay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublicHoliday" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceDay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceDayRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceCorrection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceImportBatch" ENABLE ROW LEVEL SECURITY;

-- The source every hand-entered day belongs to.
INSERT INTO "AttendanceSource" ("id", "code", "name", "kind", "createdBy") VALUES ('att_src_manual', 'manual', 'Manual register', 'manual', 'system');

COMMIT;
