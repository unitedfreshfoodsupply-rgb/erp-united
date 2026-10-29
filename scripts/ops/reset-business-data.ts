/**
 * Clears demo and test business data so the database is ready for real master data, keeping
 * one administrator, the schema, the permission catalogue and the bootstrap configuration.
 *
 *   npx tsx scripts/ops/reset-business-data.ts                       dry run: what goes, what stays
 *   npx tsx scripts/ops/reset-business-data.ts --execute --confirm=<db>@<host>
 *   npx tsx scripts/ops/reset-business-data.ts --print-sql --expect-db=<db>   SQL for the SQL editor
 *
 * Kept: _prisma_migrations, Permission, RolePermission (all rows); the administrator
 * (--keep-user, default "admin", must be an active SUPER_ADMIN) and their permission
 * overrides; the bootstrap rows of lib/core/reference-data.ts — currencies, tax classes,
 * units of measure, company, branch, main warehouse and its locations, chart of accounts,
 * cash/bank accounts — and the system "manual" attendance source.
 * Everything else in "public" is business data and is emptied, including settings (they fall
 * back to their defaults), closed accounting periods, ETA codes and issuer profile, document
 * number counters (they restart), integrations, login attempts, notifications and the audit log.
 *
 * Safety: --execute needs --confirm naming the exact database and host; a snapshot of every
 * public table is copied into schema reset_backup_<timestamp> first (locked to the owner);
 * the reset is one statement (all or nothing), refuses if a kept table still references an
 * emptied one (TRUNCATE without CASCADE), and re-checks the administrator before committing.
 * It never runs from CI or the test harness.
 */
import { PrismaClient } from "@prisma/client";
import { CASH_ACCOUNTS, CHART_OF_ACCOUNTS, CURRENCIES, DEFAULT_ORG, TAX_RATES, UNITS_OF_MEASURE } from "../../lib/core/reference-data";

const KEEP_ALL = ["_prisma_migrations", "Permission", "RolePermission"];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const list = (xs: readonly string[]) => xs.map(q).join(", ");

/** Mixed tables: the rows matching `keep` stay. Order matters — children before parents. */
export function mixedTables(keepUser: string): { table: string; keep: string }[] {
  const admin = `(SELECT id FROM "User" WHERE username = ${q(keepUser)})`;
  return [
    { table: "UserPermissionOverride", keep: `"userId" IN ${admin}` },
    { table: "User", keep: `username = ${q(keepUser)}` },
    { table: "CashAccount", keep: `id IN (${list(CASH_ACCOUNTS.map((c) => c.id))})` },
    { table: "Account", keep: `id IN (${list(CHART_OF_ACCOUNTS.map((a) => a.id))})` },
    { table: "StorageLocation", keep: `id IN (${list(DEFAULT_ORG.locations.map((l) => l.id))})` },
    { table: "Warehouse", keep: `id = ${q(DEFAULT_ORG.warehouse.id)}` },
    { table: "Branch", keep: `id = ${q(DEFAULT_ORG.branch.id)}` },
    { table: "Company", keep: `id = ${q(DEFAULT_ORG.company.id)}` },
    { table: "UnitOfMeasure", keep: `code IN (${list(UNITS_OF_MEASURE.map((u) => u.code))})` },
    { table: "TaxRate", keep: `code IN (${list(TAX_RATES.map((t) => t.code))})` },
    { table: "Currency", keep: `code IN (${list(CURRENCIES.map((c) => c.code))})` },
    { table: "AttendanceSource", keep: `id = 'att_src_manual'` },
  ];
}

/** Every other public table is business data, discovered so a new table is never left behind. */
export function businessTables(all: string[], keepUser: string): string[] {
  const mixed = new Set(mixedTables(keepUser).map((m) => m.table));
  return all.filter((t) => !KEEP_ALL.includes(t) && !mixed.has(t)).sort();
}

/** The reset as one statement: checks, TRUNCATE of business tables, deletes of extra rows in
 * mixed tables, then DELETE of the business tables a kept table references (`viaDelete` —
 * TRUNCATE refuses those while the foreign key exists, even with no referencing rows), a
 * re-check, and one audit row recording the reset. */
export function resetSql(all: string[], keepUser: string, expectDb: string, viaDelete: string[] = []): string {
  const mixed = mixedTables(keepUser).filter((m) => all.includes(m.table));
  const business = businessTables(all, keepUser);
  const truncated = business.filter((t) => !viaDelete.includes(t));
  const guard = `
  IF current_database() <> ${q(expectDb)} THEN
    RAISE EXCEPTION 'reset refused: connected to %, expected %', current_database(), ${q(expectDb)};
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE username = ${q(keepUser)} AND role = 'SUPER_ADMIN' AND active) THEN
    RAISE EXCEPTION 'reset refused: % is not an active SUPER_ADMIN', ${q(keepUser)};
  END IF;`;
  return `DO $reset$
DECLARE kept_id text;
BEGIN${guard}
  SELECT id INTO kept_id FROM "User" WHERE username = ${q(keepUser)};
  TRUNCATE TABLE ${truncated.map((t) => `"public"."${t}"`).join(", ")} RESTART IDENTITY;
${mixed.map((m) => `  DELETE FROM "public"."${m.table}" WHERE NOT (${m.keep});`).join("\n")}
${viaDelete.map((t) => `  DELETE FROM "public"."${t}";`).join("\n")}
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE id = kept_id AND role = 'SUPER_ADMIN' AND active) OR (SELECT count(*) FROM "User") <> 1 THEN
    RAISE EXCEPTION 'reset aborted: the administrator check failed after the reset';
  END IF;
  INSERT INTO "AuditLog" (id, "userId", "userName", role, action, "entityType", "entityId", "newValue", reason, source)
  SELECT gen_random_uuid()::text, id, name, role, 'business_data_reset', 'system', 'database', ${q(`${business.length} business tables emptied`)}, 'Demo and test data cleared before real data import', 'system'
  FROM "User" WHERE id = kept_id;
END
$reset$;`;
}

/** A copy of every public table, before anything is deleted, readable only by the owner. */
export function snapshotSql(all: string[], schema: string): string {
  return `DO $snap$
BEGIN
  EXECUTE ${q(`CREATE SCHEMA "${schema}"`)};
  EXECUTE ${q(`REVOKE ALL ON SCHEMA "${schema}" FROM PUBLIC`)};
${all.map((t) => `  EXECUTE ${q(`CREATE TABLE "${schema}"."${t}" AS TABLE "public"."${t}"`)};`).join("\n")}
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE ${q(`REVOKE ALL ON ALL TABLES IN SCHEMA "${schema}" FROM anon, authenticated`)}; END IF;
END
$snap$;`;
}

function arg(name: string) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

async function main() {
  const keepUser = arg("keep-user") || "admin";
  const prisma = new PrismaClient();
  try {
    const all = (await prisma.$queryRaw<{ t: string }[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`).map((r) => r.t);
    const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    const host = new URL(process.env.DATABASE_URL ?? "postgresql://unknown").hostname;
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

    // Business tables a kept (mixed) table references: emptied with DELETE after the kept rows
    // are trimmed. A kept table referencing a business table whose kept rows still point at it
    // makes the DELETE fail and the whole reset roll back.
    const fks = await prisma.$queryRawUnsafe<{ child: string; parent: string }[]>(`
      SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`);
    const strip = (s: string) => s.replace(/^public\./, "").replace(/"/g, "");
    const businessAll = businessTables(all, keepUser);
    const kept = new Set(all.filter((t) => !businessAll.includes(t)));
    const viaDelete = [...new Set(fks.filter((f) => businessAll.includes(strip(f.parent)) && kept.has(strip(f.child))).map((f) => strip(f.parent)))];
    const bad = fks.filter((f) => KEEP_ALL.includes(strip(f.child)) && businessAll.includes(strip(f.parent)));

    if (arg("print-sql") !== undefined) {
      const expectDb = arg("expect-db");
      if (!expectDb) throw new Error("--print-sql needs --expect-db=<database name> (the SQL refuses any other database)");
      console.log(`-- Business data reset — generated ${new Date().toISOString()} for database ${expectDb}, keeping ${keepUser}\n`);
      console.log(snapshotSql(all, `reset_backup_${stamp}`) + "\n");
      if (bad.length) throw new Error(`refused: tables kept whole reference business tables: ${bad.map((b) => `${strip(b.child)} → ${strip(b.parent)}`).join(", ")}`);
      console.log(resetSql(all, keepUser, expectDb, viaDelete));
      return;
    }

    // Dry run (always shown, also before --execute).
    const business = businessAll;
    const count = async (sql: string) => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql))[0].n);
    const rows: [string, number, number][] = [];
    for (const t of business) { const n = await count(`SELECT count(*) AS n FROM "public"."${t}"`); if (n) rows.push([t, n, 0]); }
    for (const m of mixedTables(keepUser).filter((x) => all.includes(x.table))) {
      const n = await count(`SELECT count(*) AS n FROM "public"."${m.table}"`);
      const keep = await count(`SELECT count(*) AS n FROM "public"."${m.table}" WHERE ${m.keep}`);
      rows.push([m.table, n - keep, keep]);
    }
    for (const t of KEEP_ALL.filter((x) => all.includes(x))) rows.push([t, 0, await count(`SELECT count(*) AS n FROM "public"."${t}"`)]);
    const admin = await prisma.user.findUnique({ where: { username: keepUser }, select: { role: true, active: true } });
    console.log(`Target: database "${db}" on ${host} — keep user "${keepUser}" (${admin ? `${admin.role}, ${admin.active ? "active" : "INACTIVE"}` : "NOT FOUND"})`);
    console.log(`${"table".padEnd(32)} ${"delete".padStart(8)} ${"keep".padStart(8)}`);
    for (const [t, d, k] of rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) if (d || k) console.log(`${t.padEnd(32)} ${String(d).padStart(8)} ${String(k).padStart(8)}`);
    console.log(`${business.length} business tables would be emptied; ${rows.reduce((s, r) => s + r[1], 0)} rows deleted in total.`);
    if (viaDelete.length) console.log(`Emptied with DELETE (a kept table references them): ${viaDelete.join(", ")}`);
    if (bad.length) console.log(`BLOCKED: tables kept whole reference business tables: ${bad.map((b) => `${strip(b.child)} → ${strip(b.parent)}`).join(", ")}`);

    if (arg("execute") === undefined) { console.log("Dry run only. Nothing was changed."); return; }
    const confirm = arg("confirm");
    if (confirm !== `${db}@${host}`) throw new Error(`refused: pass --confirm=${db}@${host} to reset exactly this database`);
    if (!admin || admin.role !== "SUPER_ADMIN" || !admin.active) throw new Error(`refused: "${keepUser}" is not an active SUPER_ADMIN`);
    if (bad.length) throw new Error("refused: see BLOCKED above");
    const schema = `reset_backup_${stamp}`;
    await prisma.$executeRawUnsafe(snapshotSql(all, schema));
    console.log(`Snapshot taken: schema ${schema} (${all.length} tables).`);
    await prisma.$executeRawUnsafe(resetSql(all, keepUser, db, viaDelete));
    const users = await prisma.user.findMany({ select: { username: true, role: true, active: true } });
    console.log(`Reset done. Users left: ${users.map((u) => `${u.username} (${u.role}${u.active ? "" : ", inactive"})`).join(", ")}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
