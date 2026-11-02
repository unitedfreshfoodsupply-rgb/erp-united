-- Remediation 2026-11: the cash-balance trigger functions run as triggers only; PUBLIC (and
-- so the browser API roles) may not execute them. Ordered after 20261102110000, which
-- creates them (a rehearsal on the restored production dump caught the earlier ordering).
REVOKE EXECUTE ON FUNCTION united_cash_line_lock() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION united_cash_never_negative() FROM PUBLIC;
