-- Remediation 2026-11 (L2 / C9): a cash box or bank account never goes below zero —
-- through ANY posting path (payments, refunds, expenses, payroll, VAT, assets,
-- reversals), enforced by the database rather than by each service.
--
--  1. BEFORE INSERT: a journal line on a cash/bank account takes a per-account advisory
--     lock held to commit, so two transactions spending the same box queue up.
--  2. DEFERRED, at commit: after the transaction's lines are all in, the account's
--     balance must be >= 0 unless the account explicitly allows an overdraft.
-- Additive: one column (default: no overdraft), two functions, two triggers.

ALTER TABLE "CashAccount" ADD COLUMN "allowOverdraft" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION united_cash_line_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CashAccount" c WHERE c."accountId" = NEW."accountId") THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('united:cash-balance:' || NEW."accountId", 0));
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION united_cash_never_negative() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  acct RECORD;
  bal NUMERIC;
BEGIN
  SELECT c."code", c."allowOverdraft" INTO acct FROM "CashAccount" c WHERE c."accountId" = NEW."accountId";
  IF NOT FOUND OR acct."allowOverdraft" THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(l."debit" - l."credit"), 0) INTO bal FROM "JournalLine" l WHERE l."accountId" = NEW."accountId";
  IF bal < 0 THEN
    RAISE EXCEPTION 'cash_account_negative: % would be % (cash and bank accounts never go below zero)', acct."code", bal
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "JournalLine_cash_lock"
  BEFORE INSERT ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION united_cash_line_lock();

CREATE CONSTRAINT TRIGGER "JournalLine_cash_never_negative"
  AFTER INSERT ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."credit" > 0)
  EXECUTE FUNCTION united_cash_never_negative();
