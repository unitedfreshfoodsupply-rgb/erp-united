-- Remediation 2026-11: the database-security baseline for the WS1/WS2 objects, as every
-- earlier migration does: RLS on the new table (deny-all to the browser API), and no
-- EXECUTE for PUBLIC on the new trigger functions (they run as triggers, never via /rpc).
ALTER TABLE "PurchaseRequest" ENABLE ROW LEVEL SECURITY;
REVOKE EXECUTE ON FUNCTION united_cash_line_lock() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION united_cash_never_negative() FROM PUBLIC;
