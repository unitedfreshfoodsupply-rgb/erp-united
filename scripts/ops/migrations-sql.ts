/**
 * Prints the migrations after a given one as a single SQL transaction, each recorded in
 * _prisma_migrations exactly as `prisma migrate deploy` records it (checksum = SHA-256 of the
 * migration file, finished_at set, one applied step), for a database reached only through the
 * Supabase SQL editor. Afterwards `prisma migrate status` sees them as applied and the
 * checksums match the files.
 *
 *   npx tsx scripts/ops/migrations-sql.ts --after=<last applied migration name> > deploy.sql
 *
 * The transaction refuses to run unless the database's latest applied migration is exactly
 * --after (so it cannot be applied twice or out of order). Each file's own BEGIN;/COMMIT; lines
 * are dropped so the whole set is all-or-nothing; a file that needs to run outside a
 * transaction (CONCURRENTLY, ALTER TYPE … ADD VALUE) is refused.
 */
import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const DIR = join(__dirname, "../../prisma/migrations");

export function pendingMigrations(after: string): { name: string; sql: string; checksum: string }[] {
  const names = readdirSync(DIR).filter((n) => /^\d{14}_/.test(n)).sort();
  if (!names.includes(after)) throw new Error(`unknown migration ${after}`);
  return names.filter((n) => n > after).map((name) => {
    const raw = readFileSync(join(DIR, name, "migration.sql"), "utf8");
    if (/CONCURRENTLY|ADD\s+VALUE/i.test(raw)) throw new Error(`${name} cannot run inside a transaction`);
    const sql = raw.split("\n").filter((l) => !/^\s*(BEGIN|COMMIT);\s*$/i.test(l)).join("\n");
    return { name, sql, checksum: createHash("sha256").update(raw).digest("hex") };
  });
}

/** The statements (no BEGIN/COMMIT) — the caller decides the transaction. */
export function migrationsSql(after: string): string {
  const list = pendingMigrations(after);
  const guard = `DO $guard$ BEGIN
  IF (SELECT max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) <> '${after}' THEN
    RAISE EXCEPTION 'migrations refused: latest applied migration is not ${after}';
  END IF;
END $guard$;`;
  const body = list.map((m) => `-- ${m.name}\n${m.sql}\nINSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)\nVALUES (gen_random_uuid()::text, '${m.checksum}', now(), '${m.name}', NULL, NULL, now(), 1);`).join("\n\n");
  return `${guard}\n\n${body}`;
}

function arg(name: string) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(hit.indexOf("=") + 1);
}

if (require.main === module) {
  const after = arg("after");
  if (!after) throw new Error("--after=<last applied migration name> is required");
  console.log(`BEGIN;\n${migrationsSql(after)}\nCOMMIT;`);
}
