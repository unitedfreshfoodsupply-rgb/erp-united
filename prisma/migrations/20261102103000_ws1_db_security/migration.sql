-- Remediation 2026-11: the database-security baseline for the WS1 table, as every earlier
-- migration does: RLS on the new table (deny-all to the browser API). The REVOKEs for the
-- cash-balance functions live in 20261102111000, after 20261102110000 creates them.
ALTER TABLE "PurchaseRequest" ENABLE ROW LEVEL SECURITY;
