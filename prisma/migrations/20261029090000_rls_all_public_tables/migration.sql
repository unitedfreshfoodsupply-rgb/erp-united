-- Every table in "public" follows the posture the rest of the schema already documents:
-- row-level security ON, no policies. The application connects through Prisma as the table
-- owner / a BYPASSRLS role, so nothing changes for it; the Supabase Data API roles (anon,
-- authenticated) can read or write nothing. These tables were the exceptions — including
-- "User" (password hashes) and "AuditLog".
BEGIN;

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerGroupMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerLegalEntity" ENABLE ROW LEVEL SECURITY;
-- Prisma's own bookkeeping table (absent when migrations are replayed into a shadow database).
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Defence in depth on Supabase: the Data API roles get no table or sequence privileges in
-- "public", now or for tables created later by this owner. Skipped where the roles do not
-- exist (local, CI). The application never uses these roles: attachments go to Supabase
-- Storage with the service key, outside "public".
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
