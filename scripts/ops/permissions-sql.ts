/**
 * Prints the permission-catalogue sync (what `npm run db:sync-permissions` does through Prisma,
 * lib/authz-core.ts syncPermissionCatalogue) as one SQL transaction, for a database reached only
 * through the Supabase SQL editor. Same result: every permission in lib/permissions.ts upserted,
 * permissions the code no longer defines dropped, each role's bundle set to ROLE_PERMISSIONS.
 *
 *   npx tsx scripts/ops/permissions-sql.ts > sync-permissions.sql
 */
import { PERMISSION_DEFS, ROLE_PERMISSIONS } from "../../lib/permissions";
import { ROLES } from "../../lib/types";

const q = (s: string | null | undefined) => (s === null || s === undefined ? "NULL" : `'${s.replace(/'/g, "''")}'`);

export function permissionsSql(): string {
  const perms = PERMISSION_DEFS.map((d) => `(gen_random_uuid()::text, ${q(d.key)}, ${q(d.group)}, ${q(d.label)}, ${q(d.description)})`).join(",\n  ");
  const pairs = ROLES.flatMap((r) => (ROLE_PERMISSIONS[r] ?? []).map((k) => `(${q(r)}, ${q(k)})`)).join(",\n  ");
  return `BEGIN;
INSERT INTO "Permission" (id, key, "group", label, description) VALUES
  ${perms}
ON CONFLICT (key) DO UPDATE SET "group" = EXCLUDED."group", label = EXCLUDED.label, description = EXCLUDED.description;
DELETE FROM "Permission" WHERE key NOT IN (${PERMISSION_DEFS.map((d) => q(d.key)).join(", ")});
CREATE TEMP TABLE wanted_role_permission (role text, key text) ON COMMIT DROP;
INSERT INTO wanted_role_permission VALUES
  ${pairs};
DELETE FROM "RolePermission" rp USING "Permission" p
  WHERE rp."permissionId" = p.id AND NOT EXISTS (SELECT 1 FROM wanted_role_permission w WHERE w.role = rp.role AND w.key = p.key);
INSERT INTO "RolePermission" (id, role, "permissionId")
  SELECT gen_random_uuid()::text, w.role, p.id FROM wanted_role_permission w JOIN "Permission" p ON p.key = w.key
  ON CONFLICT (role, "permissionId") DO NOTHING;
COMMIT;`;
}

if (require.main === module) console.log(permissionsSql());
