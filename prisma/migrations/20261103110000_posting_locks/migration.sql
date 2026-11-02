-- Maturity 2026-11 (ACC-02) — nothing posts into a closed fiscal year or on/before the lock date.
--
-- Until now the database refused only dates inside a CLOSED MONTH row. A month that never
-- had a posting has no row, so a posting dated in it was accepted even when its fiscal year
-- was closed — changing a closed year's result after its closing entry. Now the same
-- trigger also refuses:
--   * a date inside a closed FiscalYear (except the year-end close and reopen entries,
--     which the close/reopen workflows post under their own locks);
--   * a date on or before the accounting.lock_date setting, when one is set (default: none).
-- Replaces the function body only; the trigger, its lock and its existing check are unchanged.

CREATE OR REPLACE FUNCTION accounting_period_open() RETURNS trigger AS $$
DECLARE
  lock_date TEXT;
  closed_year TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('accounting-period:' || substring(NEW."date" from 1 for 7)));

  -- Wait for any period update (close) to commit before deciding whether this date
  -- is open. Lock all matching ranges in stable order in case legacy periods overlap.
  PERFORM 1
  FROM "AccountingPeriod"
  WHERE NEW."date" BETWEEN "startDate" AND "endDate"
  ORDER BY "code"
  FOR UPDATE;

  IF EXISTS (SELECT 1 FROM "AccountingPeriod" WHERE "status" = 'closed' AND NEW."date" BETWEEN "startDate" AND "endDate") THEN
    RAISE EXCEPTION 'the accounting period of % is closed', NEW."date" USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."sourceType" NOT IN ('year_end_close', 'year_end_reopen') THEN
    SELECT "code" INTO closed_year FROM "FiscalYear" WHERE "status" = 'closed' AND NEW."date" BETWEEN "startDate" AND "endDate" LIMIT 1;
    IF closed_year IS NOT NULL THEN
      RAISE EXCEPTION 'fiscal_year_closed: the fiscal year % of % is closed', closed_year, NEW."date" USING ERRCODE = 'check_violation';
    END IF;
    SELECT "value" #>> '{}' INTO lock_date FROM "SystemSetting" WHERE "key" = 'accounting.lock_date';
    IF lock_date IS NOT NULL AND lock_date <> '' AND NEW."date" <= lock_date THEN
      RAISE EXCEPTION 'accounting_lock_date: % is on or before the lock date %', NEW."date", lock_date USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION accounting_period_open() FROM PUBLIC;
