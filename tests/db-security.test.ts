/* Database security posture (docs/erp/COMPLETION_PROGRAM.md B-1): every table in "public" has
   row-level security on with no policies, so only the application's own connection (table
   owner / BYPASSRLS) reads it; where Supabase's Data API roles exist they hold no privileges.
   A table added later without RLS fails this suite. */
import { PrismaClient } from "@prisma/client";
import { makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";

const { check, section, finish } = makeChecker();

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  section("1. ROW-LEVEL SECURITY ON EVERY PUBLIC TABLE");
  const missing = await db.$queryRaw<{ relname: string }[]>`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY 1`;
  check("no public table without RLS", missing.length === 0, missing.map((m) => m.relname));
  const policies = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_policies WHERE schemaname = 'public'`;
  check("no policies: only the owner connection reads (deny by default)", Number(policies[0].n) === 0, Number(policies[0].n));

  section("2. DATA API ROLES HOLD NOTHING (where they exist)");
  const roles = await db.$queryRaw<{ rolname: string }[]>`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`;
  for (const { rolname } of roles) {
    const grants = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM information_schema.role_table_grants WHERE grantee = ${rolname} AND table_schema = 'public'`;
    check(`${rolname} has no table privileges in public`, Number(grants[0].n) === 0, Number(grants[0].n));
  }
  if (!roles.length) check("no Data API roles in this database (local/CI) — nothing to revoke", true);
  // PUBLIC (which every role inherits) holds no EXECUTE on public functions: nothing is
  // reachable through PostgREST /rpc, now or for a function added later.
  const publicExec = await db.$queryRaw<{ proname: string }[]>`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND has_function_privilege('public', p.oid, 'EXECUTE')`;
  check("no public function is executable by PUBLIC", publicExec.length === 0, publicExec.map((f) => f.proname));
  for (const { rolname } of roles) {
    const exec = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND has_function_privilege(${rolname}, p.oid, 'EXECUTE')`;
    check(`${rolname} executes no public function`, Number(exec[0].n) === 0, Number(exec[0].n));
  }

  section("3. THE APPLICATION CONNECTION STILL READS");
  check("the app role reads users", (await db.user.count()) >= 1);
  await db.$disconnect();
  finish("DB SECURITY");
}

main().catch((e) => { console.error(e); process.exit(1); });
