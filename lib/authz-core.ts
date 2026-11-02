import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import {
  ABSOLUTE_ROLE,
  ALL_PERMISSIONS,
  PERMISSION_DEFS,
  ROLE_PERMISSIONS,
  isPermission,
  type Permission,
} from "@/lib/permissions";
import { ROLES, type Role } from "@/lib/types";

/**
 * The authorization rules themselves, with no framework dependency.
 *
 * lib/authz.ts adds the request-scoped layer on top — reading the session cookie and
 * memoising the lookup with React's cache(). That layer can only exist inside a React
 * request, so the rules live here instead. Without this split, a seed script, a
 * migration or a profiler that merely imports the order service crashes at module
 * load, because importing authz.ts evaluates cache() outside any request.
 *
 * Effective permissions = the role's bundle + the user's grants - the user's revokes.
 * Revoke beats grant beats bundle; the unique index on (userId, permissionId) means a
 * user can't hold both effects for one permission, so the order is unambiguous.
 */

type OverrideRow = { effect: string; permission: { key: string } };

/** Pure part of the resolution, so it can be applied to rows fetched either on their
 * own or alongside the user in a single query. */
export function applyOverrides(role: Role, overrides: OverrideRow[]): Set<Permission> {
  if (role === ABSOLUTE_ROLE) return new Set<Permission>(ALL_PERMISSIONS);
  const base = new Set<Permission>(ROLE_PERMISSIONS[role] ?? []);
  for (const o of overrides) {
    const key = o.permission.key;
    if (!isPermission(key)) continue; // a key the code no longer knows grants nothing
    if (o.effect === "grant") base.add(key);
    else if (o.effect === "revoke") base.delete(key);
  }
  return base;
}

export async function resolveEffectivePermissions(
  userId: string,
  role: Role
): Promise<Set<Permission>> {
  if (role === ABSOLUTE_ROLE) return new Set<Permission>(ALL_PERMISSIONS);
  const overrides = await prisma.userPermissionOverride.findMany({
    where: { userId },
    select: { effect: true, permission: { select: { key: true } } },
  });
  return applyOverrides(role, overrides);
}

export type AuthStateRow = {
  id: string;
  name: string;
  username: string;
  role: string;
  active: boolean;
  sessionEpoch: number;
  mustChangePassword: boolean;
  /** WS6: true once a second factor is confirmed (User.mfaEnabledAt is set). */
  mfa_enabled: boolean;
  effect: string | null;
  permission_key: string | null;
};

/**
 * Identity and permission overrides in ONE round trip.
 *
 * Every protected request pays this. Prisma's `include` for a to-many relation issues
 * a second query, so the obvious version costs two network crossings before any real
 * work starts — on a database a region away that is a fixed ~260ms tax on every page
 * and every action. A left join returns the same information in one.
 */
export async function loadUserWithOverrides(userId: string) {
  const rows = await prisma.$queryRaw<AuthStateRow[]>`
    SELECT u."id", u."name", u."username", u."role", u."active", u."sessionEpoch", u."mustChangePassword",
           (u."mfaEnabledAt" IS NOT NULL) AS mfa_enabled,
           o."effect" AS effect, p."key" AS permission_key
    FROM "User" u
    LEFT JOIN "UserPermissionOverride" o ON o."userId" = u."id"
    LEFT JOIN "Permission" p ON p."id" = o."permissionId"
    WHERE u."id" = ${userId}
  `;
  if (rows.length === 0) return null;
  const { id, name, username, role, active, sessionEpoch, mustChangePassword, mfa_enabled } = rows[0];
  const overrides = rows
    .filter((r) => r.effect !== null && r.permission_key !== null)
    .map((r) => ({ effect: r.effect as string, permission: { key: r.permission_key as string } }));
  return { user: { id, name, username, role, active, sessionEpoch, mustChangePassword, mfaEnabled: mfa_enabled === true }, overrides };
}

export function forbiddenMessage(missing: Permission[]) {
  return `مالكش صلاحية تعمل ده (محتاج: ${missing.join("، ")})`;
}

/** Throws 403 unless the actor holds the permission. Used inside services so the
 * rule holds no matter which route reached them. */
export function assertPermission(
  actor: { permissions?: readonly string[] },
  permission: Permission,
  message?: string
) {
  if (!actorCan(actor, permission)) {
    throw new ApiError(403, message ?? forbiddenMessage([permission]));
  }
}

/** Fails closed: an actor with no resolved permission list can do nothing. */
export function actorCan(actor: { permissions?: readonly string[] }, permission: Permission) {
  return Array.isArray(actor.permissions) && actor.permissions.includes(permission);
}

// ---------------------------------------------------------------------------
// Catalogue sync
// ---------------------------------------------------------------------------

/**
 * Mirrors the code catalogue into the database: inserts new permissions, updates
 * changed labels, and rebuilds every role bundle except SUPER_ADMIN (which the
 * resolver never reads from the table). Idempotent, so it is safe to run on every
 * deploy, and it is the only thing that writes RolePermission.
 */
export async function syncPermissionCatalogue() {
  for (const def of PERMISSION_DEFS) {
    await prisma.permission.upsert({
      where: { key: def.key },
      update: { group: def.group, label: def.label, description: def.description },
      create: { key: def.key, group: def.group, label: def.label, description: def.description },
    });
  }

  const rows = await prisma.permission.findMany({ select: { id: true, key: true } });
  const idByKey = new Map(rows.map((r) => [r.key, r.id]));

  // Anything in the table that the code no longer defines is dropped, so a removed
  // permission stops granting access instead of lingering as an orphan.
  const known = new Set<string>(PERMISSION_DEFS.map((d) => d.key));
  const stale = rows.filter((r) => !known.has(r.key)).map((r) => r.id);
  if (stale.length) await prisma.permission.deleteMany({ where: { id: { in: stale } } });

  for (const role of ROLES) {
    const wanted = new Set(ROLE_PERMISSIONS[role] ?? []);
    const existing = await prisma.rolePermission.findMany({
      where: { role },
      select: { id: true, permissionId: true },
    });
    const existingIds = new Set(existing.map((e) => e.permissionId));

    const toAdd = [...wanted]
      .map((key) => idByKey.get(key))
      .filter((id): id is string => !!id && !existingIds.has(id));
    if (toAdd.length) {
      await prisma.rolePermission.createMany({
        data: toAdd.map((permissionId) => ({ role, permissionId })),
        skipDuplicates: true,
      });
    }

    const wantedIds = new Set([...wanted].map((k) => idByKey.get(k)).filter(Boolean) as string[]);
    const toRemove = existing.filter((e) => !wantedIds.has(e.permissionId)).map((e) => e.id);
    if (toRemove.length) await prisma.rolePermission.deleteMany({ where: { id: { in: toRemove } } });
  }

  return {
    permissions: PERMISSION_DEFS.length,
    roles: ROLES.length,
  };
}

