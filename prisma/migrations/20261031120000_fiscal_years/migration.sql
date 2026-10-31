-- Fiscal years (closing revenue and expenses into retained earnings) and the record of a
-- controlled reopening of a month or a year. Additive.

CREATE TABLE "FiscalYear" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "closingEntryId" TEXT,
    "netIncome" DECIMAL(18,2),
    "closeCount" INTEGER NOT NULL DEFAULT 0,
    "reopenedAt" TIMESTAMP(3),
    "reopenedBy" TEXT,
    "reopenReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "FiscalYear_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FiscalYear_values" CHECK ("code" ~ '^\d{4}$' AND "startDate" ~ '^\d{4}-\d{2}-01$' AND "endDate" > "startDate" AND "status" IN ('open', 'closed')
      AND (("status" = 'closed') = ("closedAt" IS NOT NULL)))
);
CREATE UNIQUE INDEX "FiscalYear_code_key" ON "FiscalYear"("code");
CREATE UNIQUE INDEX "FiscalYear_closingEntryId_key" ON "FiscalYear"("closingEntryId");
ALTER TABLE "FiscalYear" ADD CONSTRAINT "FiscalYear_closingEntryId_fkey" FOREIGN KEY ("closingEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A fiscal year is never deleted and its bounds never move once it exists.
CREATE OR REPLACE FUNCTION fiscal_year_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FiscalYear is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW."code", NEW."startDate", NEW."endDate") IS DISTINCT FROM (OLD."code", OLD."startDate", OLD."endDate") THEN
    RAISE EXCEPTION 'a fiscal year keeps its dates' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."closeCount" < OLD."closeCount" THEN RAISE EXCEPTION 'closeCount only grows' USING ERRCODE = 'restrict_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION fiscal_year_guard() FROM PUBLIC;
CREATE TRIGGER "FiscalYear_guard" BEFORE UPDATE OR DELETE ON "FiscalYear" FOR EACH ROW EXECUTE FUNCTION fiscal_year_guard();
ALTER TABLE "FiscalYear" ENABLE ROW LEVEL SECURITY;

-- Accounting periods: the last reopening (who, when, why) and how many times.
ALTER TABLE "AccountingPeriod" ADD COLUMN "reopenCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AccountingPeriod" ADD COLUMN "reopenedAt" TIMESTAMP(3);
ALTER TABLE "AccountingPeriod" ADD COLUMN "reopenedBy" TEXT;
ALTER TABLE "AccountingPeriod" ADD COLUMN "reopenReason" TEXT;
