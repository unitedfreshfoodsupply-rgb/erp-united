/**
 * Rebuilds the test database from fixtures: every business table is emptied and the
 * demo fixtures in prisma/seed.ts are loaded again.
 *
 * This replaces the old snapshot-restore script, which read a `supabase-snapshot-*`
 * file from an untracked backups/ directory — so it could not run on a fresh clone,
 * and it was built to rewrite the live database. A test baseline has to be something
 * the repository can reproduce on its own.
 *
 * Guarded: refuses to run unless UNITED_TEST_DB=1 and DATABASE_URL is local.
 */
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./_guard";
import { runSeed } from "../prisma/seed";

assertTestDatabase();

const prisma = new PrismaClient();

async function main() {
  // Every application table, discovered rather than listed, so a table added by a
  // later migration can't be silently left holding stale rows.
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length) {
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  await runSeed(prisma);

  // WS6: auth.mfa_required_roles defaults to SUPER_ADMIN and ACCOUNTANT — in production
  // those accounts must enrol a second factor before reaching anything. The regression
  // suites sign in as `admin` and `karim` hundreds of times a run and cannot carry an
  // authenticator, so the TEST database turns the requirement off (an explicit,
  // attributed override row, exactly what an administrator would write). The
  // requirement itself is exercised end to end by tests/mfa.test.ts, which switches it
  // back on for its own accounts.
  await prisma.systemSetting.create({
    data: { key: "auth.mfa_required_roles", value: [], updatedBy: "test-reset (tests/reset-db.ts)" },
  });

  const [users, orders, items] = await Promise.all([
    prisma.user.count(),
    prisma.order.count(),
    prisma.orderItem.count(),
  ]);
  console.log(`test database rebuilt from fixtures — ${tables.length} tables, ${users} users, ${orders} orders, ${items} lines`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
