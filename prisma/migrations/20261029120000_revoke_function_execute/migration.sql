-- Functions in the public schema are executable only by their owner (the application role).
--
-- 20261029090000 revoked the Data API roles' table and sequence grants, but functions
-- keep PostgreSQL's default EXECUTE for PUBLIC (which anon/authenticated inherit), and a
-- Supabase project also grants new functions to anon/authenticated by default. Today
-- every function here is a trigger function, which cannot be called directly, so nothing
-- was reachable; this closes the door for any function added later (PostgREST exposes
-- public functions as /rpc/<name>). Triggers keep firing: a trigger runs its function
-- without an EXECUTE check on the user whose statement fired it.
BEGIN;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
COMMIT;
