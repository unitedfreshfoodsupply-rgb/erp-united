import { prisma } from "@/lib/prisma";
import { asText } from "@/lib/http";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { advisoryXactLock } from "@/lib/dbLock";
import { assertPermission } from "@/lib/authz-core";
import { currentTx, inTx } from "@/lib/tx";
import type { ServiceActor } from "@/lib/core/actor";
import {
  SETTING_DEFS,
  SETTING_KEYS,
  isSettingKey,
  parseSettingValue,
  type OperationalSettings,
  type SettingKey,
  type SettingValue,
} from "@/lib/core/settings-registry";

/**
 * Configuration service.
 *
 * Reads are hot — every quantity write consults the shortage threshold, every board
 * poll classifies against the time thresholds — so resolved values are cached in
 * process for a few seconds. A write clears the cache on the node that made it; any
 * other node converges within CACHE_TTL_MS. The app runs as a single long-lived
 * server (see README), so in practice a change applies on the next request.
 */

const CACHE_TTL_MS = 10_000;
let cache: { at: number; values: Map<SettingKey, unknown> } | null = null;

function invalidate() {
  cache = null;
}

/** Drops the in-process cache, so the next read sees the database. Writes through
 * updateSetting() already do this; scripts and tests that write the table directly
 * call it themselves. */
export function invalidateSettingsCache() {
  invalidate();
}

/**
 * Inside an inTx transaction a cache miss is read through that transaction (release gate D-3,
 * Nov 2026). The pool may hold a single connection (Supavisor, connection_limit=1), which the
 * open transaction already has: read through the global client, the miss waited for a second
 * connection until the pool timeout and failed the transaction — the load test hit it on
 * receipts. Read through the transaction it is one more query; the result is not shared, since
 * it may include the transaction's own uncommitted writes.
 */
async function loadAll(): Promise<Map<SettingKey, unknown>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;
  const tx = currentTx();
  const rows = await (tx ?? prisma).systemSetting.findMany();
  const values = new Map<SettingKey, unknown>();
  for (const key of SETTING_KEYS) values.set(key, SETTING_DEFS[key].default);
  for (const row of rows) {
    if (!isSettingKey(row.key)) continue; // a key the code no longer defines is inert
    const parsed = parseSettingValue(row.key, row.value);
    if (parsed.ok) values.set(row.key, parsed.value);
    else {
      // Only reachable through a hand edit of the table: every write path validates.
      // Fall back to the documented default rather than run a policy on garbage.
      console.error(`[settings] stored value for ${row.key} is invalid (${parsed.error}); using default`);
    }
  }
  if (!tx) cache = { at: Date.now(), values };
  return values;
}

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  return (await loadAll()).get(key) as SettingValue<K>;
}

export async function getOperationalSettings(): Promise<OperationalSettings> {
  const v = await loadAll();
  return {
    shortageReviewThresholdPct: v.get("orders.shortage_review_threshold_pct") as number,
    waitingToStartMinutes: v.get("orders.waiting_to_start_minutes") as number,
    stalledMinutes: v.get("orders.stalled_minutes") as number,
    deliverySoonMinutes: v.get("orders.delivery_soon_minutes") as number,
  };
}

export type SettingRow = {
  key: SettingKey;
  group: string;
  label: string;
  description: string;
  unit: string;
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  /** 0 when no override row exists yet — what an editor sends back as expected_version. */
  version: number;
  updatedBy: string | null;
  updatedAt: Date | null;
};

/** Every setting with its effective value and provenance, for the admin screen. */
export async function listSettings(): Promise<SettingRow[]> {
  const rows = await prisma.systemSetting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return SETTING_KEYS.map((key) => {
    const def = SETTING_DEFS[key];
    const row = byKey.get(key);
    const parsed = row ? parseSettingValue(key, row.value) : null;
    const value = parsed?.ok ? parsed.value : def.default;
    return {
      key,
      group: def.group,
      label: def.label,
      description: def.description,
      unit: def.unit,
      value,
      defaultValue: def.default,
      isDefault: !row,
      version: row?.version ?? 0,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

/**
 * Changes one setting. Requires settings.manage and a reason — a policy change with
 * no stated why is exactly what nobody can explain six months later.
 *
 * Optimistic concurrency like every other write: the editor sends back the version
 * it saw (0 for "still on the default"); a stale version is a 409. `value: null`
 * removes the override and returns the setting to its code default.
 */
export async function updateSetting(
  rawKey: unknown,
  rawValue: unknown,
  actor: ServiceActor,
  opts: { reason?: string; expectedVersion?: number }
) {
  assertPermission(actor, "settings.manage");
  if (!isSettingKey(rawKey)) throw new ApiError(404, "الإعداد ده مش موجود");
  const key = rawKey;
  const reason = asText(opts.reason, "reason")?.trim();
  if (!reason) throw new ApiError(400, "لازم تكتب سبب تغيير الإعداد");

  const resetting = rawValue === null;
  let value: unknown = null;
  if (!resetting) {
    const parsed = parseSettingValue(key, rawValue);
    if (!parsed.ok) throw new ApiError(400, `${SETTING_DEFS[key].label}: ${parsed.error}`);
    value = parsed.value;
  }

  const result = await inTx(async (tx) => {
    // Serialises writers of this key, so the version check and the write are one step
    // even when no row exists yet (an upsert race would otherwise lose an update).
    await advisoryXactLock(tx, `system-setting:${key}`);
    const existing = await tx.systemSetting.findUnique({ where: { key } });
    const currentVersion = existing?.version ?? 0;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== currentVersion) {
      throw new ApiError(409, `الإعداد اتغيّر من واحد تاني، حدّث الشاشة (النسخة الحالية: ${currentVersion})`);
    }
    const oldValue = existing ? existing.value : SETTING_DEFS[key].default;

    if (resetting) {
      if (!existing) return { changed: false };
      await tx.systemSetting.delete({ where: { key } });
    } else if (JSON.stringify(oldValue) === JSON.stringify(value)) {
      return { changed: false };
    } else if (existing) {
      await tx.systemSetting.update({
        where: { key },
        data: { value: value as never, version: { increment: 1 }, updatedById: actor.id, updatedBy: actor.name },
      });
    } else {
      await tx.systemSetting.create({
        data: { key, value: value as never, version: 1, updatedById: actor.id, updatedBy: actor.name },
      });
    }

    await writeAudit(
      {
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: resetting ? "setting_reset" : "setting_changed",
        entityType: "system_setting",
        entityId: key,
        fieldChanged: key,
        oldValue: JSON.stringify(oldValue),
        newValue: JSON.stringify(resetting ? SETTING_DEFS[key].default : value),
        reason,
        source: "user",
        deviceId: actor.deviceId,
      },
      tx
    );
    return { changed: true };
  });

  invalidate();
  const row = (await listSettings()).find((s) => s.key === key)!;
  return { setting: row, changed: result.changed };
}
