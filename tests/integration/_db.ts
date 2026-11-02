/** Integration tests call services directly against the (guarded) test database. */
import { assertTestDatabase } from "../_guard";

assertTestDatabase();

export { prisma } from "@/lib/prisma";
export { inTx } from "@/lib/tx";
import { prisma as db } from "@/lib/prisma";
import { invalidateSettingsCache } from "@/lib/core/settings-service";

/** A 9-digit buyer tax registration number, unique enough per run (MIG-01: invoices need one). */
export const taxNo = () => String(100000000 + Math.floor(Math.random() * 899999999));

/**
 * Switches a setting for a scenario that exercises a configuration-gated path (e.g. direct
 * opening entries, off by default since November 2026) and returns the restore function.
 */
export async function withSetting(key: string, value: unknown) {
  const before = await db.systemSetting.findUnique({ where: { key } });
  await db.systemSetting.upsert({ where: { key }, update: { value: value as never, version: { increment: 1 }, updatedBy: "integration-test" }, create: { key, value: value as never, updatedBy: "integration-test" } });
  invalidateSettingsCache();
  return async () => {
    if (before) await db.systemSetting.update({ where: { key }, data: { value: before.value as never, version: { increment: 1 } } });
    else await db.systemSetting.delete({ where: { key } });
    invalidateSettingsCache();
  };
}

/** A fake actor with exactly the permissions a test needs. */
export function actor(name: string, permissions: string[], id: string | null = null, role = "SUPERVISOR") {
  return { id, name, role: role as any, permissions, source: "user" as const };
}
