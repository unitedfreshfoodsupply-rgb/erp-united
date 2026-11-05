import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { applyOverrides } from "@/lib/authz-core";
import type { Permission } from "@/lib/permissions";
import type { Role } from "@/lib/types";
import type { Tx } from "@/lib/tx";

/**
 * In-app notification centre.
 *
 * Notifications are written by the service that causes them, inside its transaction:
 * an approval that rolls back never leaves a "please approve" message behind, and
 * one that commits always has one. Recipients are resolved from EFFECTIVE permissions
 * (role bundle + overrides), the same way access is, so whoever can act on something
 * is whoever gets told about it.
 */

export type Severity = "info" | "warning" | "critical";

export type NotificationInput = {
  type: string;
  severity?: Severity;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  link?: string | null;
  /** Stored once per recipient for a given key. */
  dedupeKey?: string | null;
};

/** Active users whose effective permissions include `permission`. */
export async function usersWithPermission(db: Pick<Tx, "user">, permission: Permission): Promise<string[]> {
  const users = await db.user.findMany({
    where: { active: true },
    select: {
      id: true,
      role: true,
      permissionOverrides: { select: { effect: true, permission: { select: { key: true } } } },
    },
  });
  return users.filter((u) => applyOverrides(u.role as Role, u.permissionOverrides).has(permission)).map((u) => u.id);
}

/** Writes one notification per recipient. Duplicate dedupe keys are skipped. */
export async function notify(
  tx: Pick<Tx, "notification" | "user">,
  to: { userIds?: string[]; permission?: Permission; exclude?: (string | null | undefined)[] },
  n: NotificationInput
) {
  const ids = new Set(to.userIds ?? []);
  if (to.permission) for (const id of await usersWithPermission(tx, to.permission)) ids.add(id);
  for (const x of to.exclude ?? []) if (x) ids.delete(x);
  if (ids.size === 0) return 0;
  const res = await tx.notification.createMany({
    data: [...ids].map((recipientId) => ({
      recipientId,
      type: n.type,
      severity: n.severity ?? "info",
      title: n.title,
      body: n.body ?? null,
      entityType: n.entityType ?? null,
      entityId: n.entityId ?? null,
      link: n.link ?? null,
      dedupeKey: n.dedupeKey ?? null,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

/**
 * notify() for many events at once (the awaiting-stock check after one receipt): one insert per
 * 500 rows instead of one per event. Recipients are given resolved; duplicate keys are skipped.
 */
export async function notifyMany(tx: Pick<Tx, "notification">, events: { userIds: string[]; n: NotificationInput }[]) {
  const data = events.flatMap(({ userIds, n }) =>
    [...new Set(userIds)].map((recipientId) => ({
      recipientId,
      type: n.type,
      severity: n.severity ?? "info",
      title: n.title,
      body: n.body ?? null,
      entityType: n.entityType ?? null,
      entityId: n.entityId ?? null,
      link: n.link ?? null,
      dedupeKey: n.dedupeKey ?? null,
    }))
  );
  let count = 0;
  for (let i = 0; i < data.length; i += 500) count += (await tx.notification.createMany({ data: data.slice(i, i + 500), skipDuplicates: true })).count;
  return count;
}

// --- the signed-in user's own inbox. Every query is scoped to recipientId, so one
// user can never read or mark another user's notifications (no IDOR by id). ------

export async function myNotifications(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { recipientId: userId, ...(opts.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({ where: { recipientId: userId, readAt: null } }),
  ]);
  return { items, unread };
}

export async function markRead(userId: string, input: { ids?: unknown; all?: unknown }) {
  if (input.all === true) {
    const r = await prisma.notification.updateMany({ where: { recipientId: userId, readAt: null }, data: { readAt: new Date() } });
    return r.count;
  }
  if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.length > 200 || !input.ids.every((x) => typeof x === "string")) {
    throw new ApiError(400, "حدد الإشعارات (ids) أو all: true");
  }
  const r = await prisma.notification.updateMany({
    where: { recipientId: userId, id: { in: input.ids as string[] }, readAt: null },
    data: { readAt: new Date() },
  });
  return r.count;
}
