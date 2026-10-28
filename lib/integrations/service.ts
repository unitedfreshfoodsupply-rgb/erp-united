import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { inTx } from "@/lib/tx";
import { assertPermission } from "@/lib/authz-core";
import { parse, text } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";

/**
 * Integrations (n8n, Hermes, …) are input channels, not sources of truth: they submit
 * orders and read their status back. Each has its own key (stored only as a hash,
 * shown once), its own scopes, and can be revoked alone. Every call — accepted or
 * refused — is written to an append-only log with its outcome and duration; the key
 * is never logged.
 *
 * The shared N8N_API_KEY environment key keeps working (scope orders.create) so a
 * running n8n flow does not break on deploy; its calls are logged as "legacy".
 */

export const SCOPES = ["orders.create", "orders.status", "attendance.ingest"] as const;
export type Scope = (typeof SCOPES)[number];
export type Caller = { integrationId: string | null; code: string; name: string; scopes: readonly Scope[] };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function sameSecret(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Who is calling, from x-api-key; null when the request carries no key (a signed-in user). */
export async function integrationCaller(req: NextRequest): Promise<Caller | null> {
  const key = req.headers.get("x-api-key");
  if (!key) return null;
  const row = await prisma.integration.findUnique({ where: { keyHash: sha(key) } });
  if (row) {
    if (!row.active) throw new ApiError(401, "مفتاح التكامل ده اتلغى");
    await prisma.integration.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
    return { integrationId: row.id, code: row.code, name: row.name, scopes: row.scopes as Scope[] };
  }
  const legacy = process.env.N8N_API_KEY;
  if (legacy && sameSecret(key, legacy)) return { integrationId: null, code: "legacy", name: "n8n", scopes: ["orders.create"] };
  throw new ApiError(401, "API key غلط");
}

export function requireScope(caller: Caller, scope: Scope) {
  if (!caller.scopes.includes(scope)) throw new ApiError(403, `مفتاح التكامل ده مش مسموح له بـ ${scope}`);
}

/**
 * Runs an integration call and logs it, whatever happens. `run` returns the response
 * body plus what to record (external id, result); errors become the usual API error
 * response and are logged with their status.
 */
export async function loggedIntegrationCall(
  req: NextRequest,
  run: (caller: Caller) => Promise<{ body: unknown; status?: number; externalId?: string | null; result?: string | null }>
) {
  const started = Date.now();
  const path = new URL(req.url).pathname;
  let caller: Caller | null = null;
  try {
    caller = await integrationCaller(req);
    if (!caller) throw new ApiError(401, "التكامل محتاج x-api-key");
    const out = await run(caller);
    await prisma.integrationLog.create({ data: { integrationId: caller.integrationId, caller: caller.code, method: req.method, path, status: out.status ?? 200, externalId: out.externalId ?? null, result: out.result ?? null, durationMs: Date.now() - started } });
    return NextResponse.json(out.body, { status: out.status ?? 200 });
  } catch (err) {
    const res = handleApiError(err);
    const message = err instanceof ApiError ? err.message : "server error";
    await prisma.integrationLog
      .create({ data: { integrationId: caller?.integrationId ?? null, caller: caller?.code ?? "unknown", method: req.method, path, status: res.status, error: message.slice(0, 500), durationMs: Date.now() - started } })
      .catch(() => undefined);
    return res;
  }
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

export async function createIntegration(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "integrations.manage");
  const v = parse(z.object({ code: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/, "الكود حروف إنجليزي صغيرة وأرقام"), name: text("الاسم", 100), scopes: z.array(z.enum(SCOPES)).min(1, "اختار صلاحية واحدة على الأقل") }), input);
  const key = `uk_${randomBytes(24).toString("base64url")}`;
  try {
    const row = await inTx(async (tx) => {
      const r = await tx.integration.create({ data: { code: v.code, name: v.name, scopes: [...new Set(v.scopes)], keyHash: sha(key), keyPrefix: key.slice(0, 8), createdBy: actor.name } });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "integration_created", entityType: "integration", entityId: r.id, fieldChanged: r.code, newValue: `${r.name} · ${r.scopes.join(", ")} · ${r.keyPrefix}…`, source: "user", deviceId: actor.deviceId }, tx);
      return r;
    });
    // The only time the key exists outside the caller's hands.
    return { integration: present(row), key };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ApiError(409, "الكود ده مستخدم لتكامل تاني");
    throw err;
  }
}

export async function revokeIntegration(id: string, actor: ServiceActor) {
  assertPermission(actor, "integrations.manage");
  const row = await prisma.integration.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, "التكامل مش موجود");
  if (!row.active) throw new ApiError(409, "التكامل ده متلغي بالفعل");
  return inTx(async (tx) => {
    const updated = await tx.integration.update({ where: { id }, data: { active: false, revokedAt: new Date(), revokedBy: actor.name } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "integration_revoked", entityType: "integration", entityId: id, fieldChanged: row.code, oldValue: "active", newValue: "revoked", source: "user", deviceId: actor.deviceId }, tx);
    return present(updated);
  });
}

const present = (r: { id: string; code: string; name: string; keyPrefix: string; scopes: string[]; active: boolean; lastUsedAt: Date | null; createdBy: string; createdAt: Date; revokedAt: Date | null }) => ({
  id: r.id, code: r.code, name: r.name, keyPrefix: r.keyPrefix, scopes: r.scopes, active: r.active, lastUsedAt: r.lastUsedAt, createdBy: r.createdBy, createdAt: r.createdAt, revokedAt: r.revokedAt,
});

export async function listIntegrations() {
  const [rows, logs] = await Promise.all([
    prisma.integration.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.integrationLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return { integrations: rows.map(present), logs };
}

// ---------------------------------------------------------------------------
// Status read-back: where is the order the channel submitted?
// ---------------------------------------------------------------------------

export async function orderStatusByExternalId(externalId: string) {
  const o = await prisma.order.findUnique({
    where: { externalId },
    select: {
      orderNumber: true, status: true, deliveryDate: true, updatedAt: true,
      tripStops: { where: { active: true }, select: { status: true, deliveredAt: true, receiverName: true, trip: { select: { number: true, status: true } } } },
      invoices: { where: { status: { not: "void" } }, select: { number: true, status: true, issueDate: true } },
    },
  });
  if (!o) throw new ApiError(404, "مفيش أوردر بالرقم الخارجي ده");
  const stop = o.tripStops[0];
  const inv = o.invoices[0];
  // Quantities and money stay inside the ERP; the channel learns the state of things.
  return {
    externalId, orderNumber: o.orderNumber, status: o.status, deliveryDate: o.deliveryDate, updatedAt: o.updatedAt,
    trip: stop ? { number: stop.trip.number, status: stop.trip.status, delivery: stop.status, deliveredAt: stop.deliveredAt, receiverName: stop.receiverName } : null,
    invoice: inv ? { number: inv.number, status: inv.status, issueDate: inv.issueDate } : null,
  };
}
