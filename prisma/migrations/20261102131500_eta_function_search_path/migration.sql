-- Pin search_path on the ETA UUID guard (Supabase advisor "function_search_path_mutable"),
-- as 20261030131000 did for every earlier business-rule trigger function.
ALTER FUNCTION eta_document_uuid_guard() SET search_path = public, pg_temp;
