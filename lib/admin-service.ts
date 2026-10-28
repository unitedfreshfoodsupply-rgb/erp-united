import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { asText } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit, writeAuditMany } from "@/lib/audit";
import { inTx } from "@/lib/tx";
import { advisoryXactLock } from "@/lib/dbLock";
import { resolveEffectivePermissions, type AuthContext } from "@/lib/authz";
import {
  ABSOLUTE_ROLE,
  ALL_PERMISSIONS,
  PERMISSION_DEFS,
  ROLE_PERMISSIONS,
  isPermission,
  type Permission,
} from "@/lib/permissions";
import { ROLES, isRole, type Role } from "@/lib/types";

// ---------------------------------------------------------------------------
// User administration.
//
// Two classes of danger this module is built around:
//
//  1. Lockout — removing the last account that can administer the system. Every path
//     that could do it (disable, role change) is serialised on one advisory lock and
//     re-counts the remaining active super admins inside the transaction, so two
//     administrators demoting each other at the same instant cannot both succeed.
//  2. Escalation — a caller granting themselves more than they hold. Roles and
//     permission keys from the request body are validated against the code catalogue,
//     never trusted; SUPER_ADMIN can only be assigned by a SUPER_ADMIN; and overrides
//     cannot mint a permission the granter does not hold themselves.
// ---------------------------------------------------------------------------

const SUPER_ADMIN_LOCK = "rbac:super-admin-guard";
// 4 was the original MVP minimum, short enough to make credential guessing
// realistic against a login endpoint with no other protection. Raising it only
// affects NEW passwords being set — an existing account's current hash still logs
// in exactly as before, so this cannot lock anyone out on deploy.
const MIN_PASSWORD_LENGTH = 8;

export type AdminUserDTO = {
  id: string;
  name: string;
  username: string;
  role: Role;
  active: boolean;
  version: number;
  createdAt: Date;
  overrideCount: number;
};

function assertUsername(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9_.-]{3,32}$/i.test(value.trim())) {
    throw new ApiError(400, "اسم المستخدم لازم يكون من ٣ لـ ٣٢ حرف/رقم إنجليزي من غير مسافات");
  }
}

function assertPassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, `كلمة السر لازم تكون ${MIN_PASSWORD_LENGTH} خانات على الأقل`);
  }
}

/** Roles arrive as free text in a JSON body — validate against the code list, never cast. */
function assertRole(value: unknown): asserts value is Role {
  if (!isRole(value)) throw new ApiError(400, "الدور ده مش معروف");
}

function assertPermissionKey(value: unknown): asserts value is Permission {
  if (!isPermission(value)) throw new ApiError(400, "الصلاحية دي مش معروفة");
}

/**
 * Only a super admin may create or hand out the super admin role. Without this, any
 * account that picked up users.change_role through an override could promote itself
 * past every other guard in the system.
 */
function assertMayAssignRole(actor: AuthContext, role: Role) {
  if (role === ABSOLUTE_ROLE && actor.role !== ABSOLUTE_ROLE) {
    throw new ApiError(403, "بس مدير النظام يقدر يدي دور مدير النظام");
  }
}

/**
 * A super admin account is managed only by a super admin. Without this, anyone who
 * picked up users.edit (or users.disable, users.change_role) through an override
 * could reset a super admin's password and sign in as them — the shortest path from
 * a narrow grant to the whole system.
 */
function assertMayManage(actor: AuthContext, target: { role: string }) {
  if (target.role === ABSOLUTE_ROLE && actor.role !== ABSOLUTE_ROLE) {
    throw new ApiError(403, "بس مدير النظام يقدر يعدّل حساب مدير نظام");
  }
}

/**
 * Refuses to leave the system with no active super admin. Runs inside the caller's
 * transaction, after the write, and rolls it back if the count reached zero — a check
 * done before the write could be raced by a second administrator doing the same thing.
 */
async function assertSuperAdminSurvives(tx: {
  user: { count: (args: { where: Prisma.UserWhereInput }) => Promise<number> };
}) {
  const remaining = await tx.user.count({ where: { role: ABSOLUTE_ROLE, active: true } });
  if (remaining === 0) {
    throw new ApiError(
      409,
      "مينفعش تشيل آخر مدير نظام نشط — لازم يفضل حساب واحد على الأقل يقدر يدير النظام"
    );
  }
}

export async function listUsers(): Promise<AdminUserDTO[]> {
  const users = await prisma.user.findMany({
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    include: { _count: { select: { permissionOverrides: true } } },
  });
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role as Role,
    active: u.active,
    version: u.version,
    createdAt: u.createdAt,
    overrideCount: u._count.permissionOverrides,
  }));
}

export async function createUser(
  input: { name: string; username: string; password: string; role: string; mustChangePassword?: unknown },
  actor: AuthContext
) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new ApiError(400, "الاسم مطلوب");
  assertUsername(input.username);
  assertPassword(input.password);
  assertRole(input.role);
  assertMayAssignRole(actor, input.role);

  const username = input.username.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(input.password, 10);

  const role = input.role;
  return inTx(async (tx) => {
    let user;
    try {
      user = await tx.user.create({ data: { name, username, passwordHash, role, mustChangePassword: input.mustChangePassword === true } });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        throw new ApiError(409, `اسم المستخدم "${username}" مستخدم بالفعل`);
      }
      throw err;
    }

    await writeAudit(
      {
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "user_created",
        entityType: "user",
        entityId: user.id,
        fieldChanged: "role",
        newValue: `${user.username} · ${user.role}`,
        source: "user",
        deviceId: actor.deviceId,
      },
      tx
    );
    return user;
  });
}

export async function updateUser(
  id: string,
  fields: Partial<{ name: string; username: string; password: string; mustChangePassword: unknown }>,
  actor: AuthContext,
  expectedVersion?: number
) {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "المستخدم مش موجود");
  assertMayManage(actor, existing);
  if (expectedVersion !== undefined && expectedVersion !== existing.version) {
    throw new ApiError(409, `بيانات المستخدم اتغيّرت من واحد تاني (النسخة الحالية: ${existing.version})`);
  }

  const data: Record<string, unknown> = {};
  const changes: [string, string | null, string | null][] = [];

  if (fields.name !== undefined) {
    const name = fields.name.trim();
    if (!name) throw new ApiError(400, "الاسم مطلوب");
    if (name !== existing.name) {
      data.name = name;
      changes.push(["name", existing.name, name]);
    }
  }
  if (fields.username !== undefined) {
    assertUsername(fields.username);
    const username = fields.username.trim().toLowerCase();
    if (username !== existing.username) {
      data.username = username;
      changes.push(["username", existing.username, username]);
    }
  }
  if (fields.password !== undefined) {
    assertPassword(fields.password);
    data.passwordHash = await bcrypt.hash(fields.password, 10);
    // Ends every session signed in with the old password — including a stolen one.
    data.sessionEpoch = { increment: 1 };
    data.passwordChangedAt = new Date();
    // A password an administrator chose is known to someone else: on request, the
    // account can do nothing until its owner picks their own.
    data.mustChangePassword = fields.mustChangePassword === true;
    if (fields.mustChangePassword === true) changes.push(["mustChangePassword", String(existing.mustChangePassword), "true"]);
    // Never record the old or the new secret — only that it was replaced.
    changes.push(["password", null, "(اتغيّرت)"]);
  }
  if (changes.length === 0) return existing;

  return inTx(async (tx) => {
    let updated;
    try {
      updated = await tx.user.update({
        where: { id, version: existing.version },
        data: { ...data, version: { increment: 1 } },
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "P2025") throw new ApiError(409, "بيانات المستخدم اتغيّرت من واحد تاني، حدّث الشاشة");
      if (code === "P2002") throw new ApiError(409, "اسم المستخدم مستخدم بالفعل");
      throw err;
    }

    await writeAuditMany(
      changes.map(([field, oldValue, newValue]) => ({
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "user_updated",
        entityType: "user" as const,
        entityId: id,
        fieldChanged: field,
        oldValue,
        newValue,
        source: "user" as const,
        deviceId: actor.deviceId,
      })),
      tx
    );
    return updated;
  });
}

export async function setUserActive(
  id: string,
  active: boolean,
  actor: AuthContext,
  expectedVersion?: number
) {
  if (typeof active !== "boolean") throw new ApiError(400, "قيمة التفعيل لازم تكون true أو false");
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "المستخدم مش موجود");
  assertMayManage(actor, existing);
  if (existing.active === active) return existing;
  if (!active && existing.id === actor.id) {
    throw new ApiError(400, "مينفعش توقف حسابك بنفسك");
  }
  if (expectedVersion !== undefined && expectedVersion !== existing.version) {
    throw new ApiError(409, `بيانات المستخدم اتغيّرت من واحد تاني (النسخة الحالية: ${existing.version})`);
  }

  const updated = await prisma.$transaction(
    async (tx) => {
      await advisoryXactLock(tx, SUPER_ADMIN_LOCK);
      let result;
      try {
        result = await tx.user.update({
          where: { id, version: existing.version },
          // Disabling also ends every session, so re-enabling later does not bring a
          // session from before (perhaps a stolen one) back to life.
          data: { active, version: { increment: 1 }, ...(active ? {} : { sessionEpoch: { increment: 1 } }) },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === "P2025") {
          throw new ApiError(409, "بيانات المستخدم اتغيّرت من واحد تاني، حدّث الشاشة");
        }
        throw err;
      }
      await assertSuperAdminSurvives(tx);
      await writeAudit(
        {
          userId: actor.id,
          userName: actor.name,
          role: actor.role,
          action: active ? "user_enabled" : "user_disabled",
          entityType: "user",
          entityId: id,
          fieldChanged: "active",
          oldValue: String(existing.active),
          newValue: String(active),
          source: "user",
          deviceId: actor.deviceId,
        },
        tx
      );
      return result;
    },
    { maxWait: 15_000, timeout: 20_000 }
  );

  return updated;
}

export async function changeUserRole(
  id: string,
  role: unknown,
  actor: AuthContext,
  expectedVersion?: number
) {
  assertRole(role);
  assertMayAssignRole(actor, role);
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "المستخدم مش موجود");
  if (existing.role === role) return existing;
  if (expectedVersion !== undefined && expectedVersion !== existing.version) {
    throw new ApiError(409, `بيانات المستخدم اتغيّرت من واحد تاني (النسخة الحالية: ${existing.version})`);
  }
  assertMayManage(actor, existing);
  // Nobody changes their own role: up is self-escalation, and down is how an
  // administrator locks themselves out one keystroke before realising it.
  if (existing.id === actor.id) {
    throw new ApiError(400, "مينفعش تغيّر دور حسابك بنفسك");
  }

  const updated = await prisma.$transaction(
    async (tx) => {
      await advisoryXactLock(tx, SUPER_ADMIN_LOCK);
      let result;
      try {
        result = await tx.user.update({
          where: { id, version: existing.version },
          data: { role, version: { increment: 1 } },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === "P2025") {
          throw new ApiError(409, "بيانات المستخدم اتغيّرت من واحد تاني، حدّث الشاشة");
        }
        throw err;
      }
      await assertSuperAdminSurvives(tx);
      await writeAudit(
        {
          userId: actor.id,
          userName: actor.name,
          role: actor.role,
          action: "user_role_changed",
          entityType: "user",
          entityId: id,
          fieldChanged: "role",
          oldValue: existing.role,
          newValue: role,
          source: "user",
          deviceId: actor.deviceId,
        },
        tx
      );
      return result;
    },
    { maxWait: 15_000, timeout: 20_000 }
  );

  return updated;
}

/** "Sign out everywhere": every existing session of the user stops working on its
 * next request (a lost tablet, a shared password, a departure). */
export async function revokeUserSessions(id: string, actor: AuthContext) {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "المستخدم مش موجود");
  assertMayManage(actor, existing);
  return inTx(async (tx) => {
    const updated = await tx.user.update({ where: { id }, data: { sessionEpoch: { increment: 1 }, version: { increment: 1 } } });
    await writeAudit(
      { userId: actor.id, userName: actor.name, role: actor.role, action: "user_sessions_revoked", entityType: "user", entityId: id, fieldChanged: "sessionEpoch", newValue: existing.username, source: "user", deviceId: actor.deviceId },
      tx
    );
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Per-user permission overrides
// ---------------------------------------------------------------------------

export type EffectivePermissionRow = {
  key: Permission;
  group: string;
  label: string;
  description: string;
  fromRole: boolean;
  override: "grant" | "revoke" | null;
  effective: boolean;
};

export async function getUserPermissionDetail(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      permissionOverrides: {
        include: { permission: { select: { key: true } } },
      },
    },
  });
  if (!user) throw new ApiError(404, "المستخدم مش موجود");

  const role = user.role as Role;
  const base = new Set<string>(ROLE_PERMISSIONS[role] ?? []);
  const overrideByKey = new Map(
    user.permissionOverrides.map((o) => [o.permission.key, o.effect as "grant" | "revoke"])
  );
  const effective = await resolveEffectivePermissions(user.id, role);
  const absolute = role === ABSOLUTE_ROLE;

  const rows: EffectivePermissionRow[] = PERMISSION_DEFS.map((def) => ({
    key: def.key,
    group: def.group,
    label: def.label,
    description: def.description,
    fromRole: absolute || base.has(def.key),
    override: absolute ? null : overrideByKey.get(def.key) ?? null,
    effective: effective.has(def.key),
  }));

  return {
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role,
      active: user.active,
      version: user.version,
    },
    absoluteRole: absolute,
    permissions: rows,
  };
}

/**
 * Set or clear one per-user override.
 *
 * Two rules worth stating plainly:
 *  - You cannot grant a permission you do not hold yourself. Otherwise settings.manage
 *    alone would be enough to assemble every other permission in the system.
 *  - Overrides on a SUPER_ADMIN are refused rather than silently ignored. The resolver
 *    already ignores them for that role, and storing a row that does nothing would
 *    read, in the admin UI, like a restriction that is actually in force.
 */
export async function setUserPermissionOverride(
  userId: string,
  permissionKey: unknown,
  effect: "grant" | "revoke" | null,
  actor: AuthContext,
  reason?: string
) {
  assertPermissionKey(permissionKey);
  if (effect !== null && effect !== "grant" && effect !== "revoke") {
    throw new ApiError(400, "نوع الاستثناء لازم يكون grant أو revoke");
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, "المستخدم مش موجود");
  // Your own permissions are someone else's decision.
  if (user.id === actor.id) throw new ApiError(400, "مينفعش تعدّل صلاحياتك بنفسك");
  if (user.role === ABSOLUTE_ROLE) {
    throw new ApiError(400, "مدير النظام عنده كل الصلاحيات دايمًا — مفيش استثناءات عليه");
  }
  if (effect === "grant" && !actor.can(permissionKey)) {
    throw new ApiError(403, "مينفعش تدي صلاحية انت نفسك مش معاك");
  }

  const permission = await prisma.permission.findUnique({ where: { key: permissionKey } });
  if (!permission) throw new ApiError(404, "الصلاحية مش موجودة في الكتالوج");

  const existing = await prisma.userPermissionOverride.findUnique({
    where: { userId_permissionId: { userId, permissionId: permission.id } },
  });

  if (effect === null) {
    if (!existing) return { cleared: false };
    await inTx(async (tx) => {
      await tx.userPermissionOverride.delete({ where: { id: existing.id } });
      await writeAudit(
        {
          userId: actor.id,
          userName: actor.name,
          role: actor.role,
          action: "user_permission_override_cleared",
          entityType: "user_permission",
          entityId: userId,
          fieldChanged: permissionKey,
          oldValue: existing.effect,
          newValue: "(الرجوع لصلاحيات الدور)",
          reason,
          source: "user",
          deviceId: actor.deviceId,
        },
        tx
      );
    });
    return { cleared: true };
  }

  const saved = await inTx(async (tx) => {
    const row = await tx.userPermissionOverride.upsert({
      where: { userId_permissionId: { userId, permissionId: permission.id } },
      update: { effect, reason: asText(reason, "reason")?.trim() || null, grantedById: actor.id, grantedBy: actor.name },
      create: {
        userId,
        permissionId: permission.id,
        effect,
        reason: asText(reason, "reason")?.trim() || null,
        grantedById: actor.id,
        grantedBy: actor.name,
      },
    });
    await writeAudit(
      {
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: effect === "grant" ? "user_permission_granted" : "user_permission_revoked",
        entityType: "user_permission",
        entityId: userId,
        fieldChanged: permissionKey,
        oldValue: existing?.effect ?? "(صلاحيات الدور)",
        newValue: effect,
        reason,
        source: "user",
        deviceId: actor.deviceId,
      },
      tx
    );
    return row;
  });

  return { override: saved };
}

// ---------------------------------------------------------------------------
// Matrix & system overview
// ---------------------------------------------------------------------------

export async function permissionMatrix() {
  const [stored, userCounts] = await Promise.all([
    prisma.rolePermission.findMany({ include: { permission: { select: { key: true } } } }),
    prisma.user.groupBy({ by: ["role", "active"], _count: { _all: true } }),
  ]);

  const storedByRole = new Map<string, Set<string>>();
  for (const row of stored) {
    if (!storedByRole.has(row.role)) storedByRole.set(row.role, new Set());
    storedByRole.get(row.role)!.add(row.permission.key);
  }

  const roles = ROLES.map((role) => {
    const isAbsolute = role === ABSOLUTE_ROLE;
    const fromCode = new Set<string>(ROLE_PERMISSIONS[role] ?? []);
    const fromDb = storedByRole.get(role) ?? new Set<string>();
    // A mismatch means the database was edited directly, or a deploy hasn't synced.
    // Surfacing it beats silently trusting either side.
    const inSync = isAbsolute || (fromCode.size === fromDb.size && [...fromCode].every((k) => fromDb.has(k)));
    return {
      role,
      absolute: isAbsolute,
      permissions: isAbsolute ? [...ALL_PERMISSIONS] : [...fromCode].sort(),
      inSync,
      activeUsers: userCounts.filter((c) => c.role === role && c.active).reduce((s, c) => s + c._count._all, 0),
      disabledUsers: userCounts.filter((c) => c.role === role && !c.active).reduce((s, c) => s + c._count._all, 0),
    };
  });

  return {
    permissions: PERMISSION_DEFS.map((d) => ({ ...d })),
    roles,
    catalogueInSync: roles.every((r) => r.inSync),
  };
}

export async function systemAccessOverview() {
  const [users, overrides, superAdmins] = await Promise.all([
    prisma.user.groupBy({ by: ["active"], _count: { _all: true } }),
    prisma.userPermissionOverride.findMany({
      include: {
        permission: { select: { key: true, label: true } },
        user: { select: { id: true, name: true, username: true, role: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    prisma.user.count({ where: { role: ABSOLUTE_ROLE, active: true } }),
  ]);

  return {
    totalUsers: users.reduce((s, u) => s + u._count._all, 0),
    activeUsers: users.find((u) => u.active)?._count._all ?? 0,
    disabledUsers: users.find((u) => !u.active)?._count._all ?? 0,
    activeSuperAdmins: superAdmins,
    overrides: overrides.map((o) => ({
      userId: o.userId,
      userName: o.user.name,
      username: o.user.username,
      role: o.user.role as Role,
      permissionKey: o.permission.key,
      permissionLabel: o.permission.label,
      effect: o.effect as "grant" | "revoke",
      reason: o.reason,
      grantedBy: o.grantedBy,
      updatedAt: o.updatedAt,
    })),
  };
}

/** Security-relevant slice of the shared audit trail. */
export async function securityAuditLog(limit = 80) {
  return prisma.auditLog.findMany({
    where: { entityType: { in: ["user", "user_permission", "system_setting"] } },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
}
