-- Remediation 2026-11: the ETA UUID guard runs as a trigger only; like every other
-- business-rule function, PUBLIC (and so the browser API roles) may not execute it.
REVOKE EXECUTE ON FUNCTION eta_document_uuid_guard() FROM PUBLIC;
