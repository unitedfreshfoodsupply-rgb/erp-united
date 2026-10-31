import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { inTx, type Tx } from "@/lib/tx";
import { isValidISODate } from "@/lib/dates";
import { parse, text } from "@/lib/core/validation";
import { getSetting } from "@/lib/core/settings-service";
import type { ServiceActor } from "@/lib/core/actor";

/**
 * Cost centers — warehouses, transport, each vehicle, operations, departments,
 * administration, sales. A reporting dimension on revenue and expense lines: an expense,
 * a service-bill line, a manual journal line, and the depreciation of an asset assigned to
 * one carry it into the journal. It never touches inventory valuation or product cost
 * (those stay with the stock ledger), so it cannot double-count what grading, waste or
 * COGS already priced. When `accounting.cost_center_required` is on, every expense line
 * entered by a person must name one; system postings (COGS, stock adjustments) never do.
 * Reallocating a cost between centers is a manual journal between the same expense
 * account with two cost centers.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const KINDS = ["warehouse", "transport", "vehicle", "operations", "department", "administration", "sales", "other"] as const;

/**
 * Checks the cost center a person put on a line: it exists and is active, it is only on a
 * revenue or expense account, and (when the setting is on) an expense line has one.
 */
export async function checkCostCenter(tx: Tx | typeof prisma, costCenterId: string | null | undefined, account: { code: string; type: string }) {
  if (costCenterId) {
    if (account.type !== "revenue" && account.type !== "expense") throw new ApiError(400, `مركز التكلفة بيتحط على حسابات الإيرادات والمصروفات بس (الحساب ${account.code})`);
    const cc = await tx.costCenter.findUnique({ where: { id: costCenterId }, select: { active: true } });
    if (!cc?.active) throw new ApiError(400, "مركز التكلفة مش موجود أو موقوف");
    return costCenterId;
  }
  if (account.type === "expense" && (await getSetting("accounting.cost_center_required"))) throw new ApiError(400, `حدد مركز التكلفة لسطر المصروف (الحساب ${account.code})`);
  return null;
}

const input = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{2,20}$/, "الكود حروف إنجليزي كبيرة وأرقام (2–20)"),
  name: text("الاسم بالإنجليزي", 100),
  name_ar: text("الاسم بالعربي", 100),
  kind: z.enum(KINDS, { errorMap: () => ({ message: "نوع مركز التكلفة غير معروف" }) }),
  parent_id: z.string().optional().nullable(),
  warehouse_id: z.string().optional().nullable(),
  vehicle_id: z.string().optional().nullable(),
  department_id: z.string().optional().nullable(),
});

async function checkLinks(tx: Tx, v: { parent_id?: string | null; warehouse_id?: string | null; vehicle_id?: string | null; department_id?: string | null }, selfId?: string) {
  if (v.parent_id) {
    if (v.parent_id === selfId) throw new ApiError(400, "مركز التكلفة مينفعش يكون تحت نفسه");
    // No cycles: walk up from the new parent.
    let p: string | null = v.parent_id;
    for (let i = 0; p && i < 50; i++) {
      if (p === selfId) throw new ApiError(400, "كده هيبقى المركز تحت واحد من فروعه");
      const row: { parentId: string | null } | null = await tx.costCenter.findUnique({ where: { id: p }, select: { parentId: true } });
      if (!row) throw new ApiError(404, "المركز الرئيسي مش موجود");
      p = row.parentId;
    }
  }
  if (v.warehouse_id && !(await tx.warehouse.findUnique({ where: { id: v.warehouse_id } }))) throw new ApiError(404, "المخزن مش موجود");
  if (v.vehicle_id && !(await tx.vehicle.findUnique({ where: { id: v.vehicle_id } }))) throw new ApiError(404, "العربية مش موجودة");
  if (v.department_id && !(await tx.department.findUnique({ where: { id: v.department_id } }))) throw new ApiError(404, "القسم مش موجود");
}

export async function createCostCenter(body: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(input, body);
  return inTx(async (tx) => {
    if (await tx.costCenter.findUnique({ where: { code: v.code } })) throw new ApiError(409, `الكود ${v.code} مستخدم`);
    await checkLinks(tx, v);
    const c = await tx.costCenter.create({ data: { code: v.code, name: v.name, nameAr: v.name_ar, kind: v.kind, parentId: v.parent_id ?? null, warehouseId: v.warehouse_id ?? null, vehicleId: v.vehicle_id ?? null, departmentId: v.department_id ?? null, createdBy: actor.name } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "cost_center_created", entityType: "cost_center", entityId: c.id, newValue: `${c.code} · ${c.nameAr} · ${c.kind}`, source: "user", deviceId: actor.deviceId }, tx);
    return c;
  });
}

export async function updateCostCenter(id: string, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(input.omit({ code: true }).partial().extend({ active: z.boolean().optional(), version: z.number().int().optional() }), body);
  return inTx(async (tx) => {
    const c = await tx.costCenter.findUnique({ where: { id } });
    if (!c) throw new ApiError(404, "مركز التكلفة مش موجود");
    if (v.version !== undefined && v.version !== c.version) throw new ApiError(409, "اتعدّل من واحد تاني — حدّث الشاشة");
    await checkLinks(tx, v, id);
    if (v.active === false && (await tx.costCenter.count({ where: { parentId: id, active: true } }))) throw new ApiError(409, "تحته مراكز شغالة — اوقفها الأول");
    const updated = await tx.costCenter.update({
      where: { id, version: c.version },
      data: {
        ...(v.name !== undefined ? { name: v.name } : {}), ...(v.name_ar !== undefined ? { nameAr: v.name_ar } : {}), ...(v.kind !== undefined ? { kind: v.kind } : {}),
        ...(v.parent_id !== undefined ? { parentId: v.parent_id } : {}), ...(v.warehouse_id !== undefined ? { warehouseId: v.warehouse_id } : {}),
        ...(v.vehicle_id !== undefined ? { vehicleId: v.vehicle_id } : {}), ...(v.department_id !== undefined ? { departmentId: v.department_id } : {}),
        ...(v.active !== undefined ? { active: v.active } : {}), version: { increment: 1 },
      },
    });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: v.active === false ? "cost_center_deactivated" : v.active === true ? "cost_center_activated" : "cost_center_updated", entityType: "cost_center", entityId: id, newValue: JSON.stringify(v), source: "user", deviceId: actor.deviceId }, tx);
    return updated;
  });
}

export async function listCostCenters(opts: { includeInactive?: boolean } = {}) {
  return prisma.costCenter.findMany({ where: opts.includeInactive ? {} : { active: true }, orderBy: { code: "asc" }, include: { warehouse: { select: { code: true, name: true, nameAr: true } }, vehicle: { select: { code: true, plate: true } }, department: { select: { code: true, name: true, nameAr: true } } } });
}

/**
 * Revenue and expense per cost center and account over a range, with what carries no cost
 * center; the grand totals equal the P&L's revenue and expenses for the same range.
 */
export async function costCenterReport(from: string, to: string) {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "الفترة غير صالحة");
  const rows = await prisma.$queryRaw<{ costCenterId: string | null; accountId: string; code: string; name: string; nameAr: string; type: string; amount: Prisma.Decimal }[]>`
    SELECT l."costCenterId", a."id" AS "accountId", a."code", a."name", a."nameAr", a."type",
      sum(CASE WHEN a."type" = 'revenue' THEN l."credit" - l."debit" ELSE l."debit" - l."credit" END) AS amount
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE a."type" IN ('revenue', 'expense') AND e."date" BETWEEN ${from} AND ${to} AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')
    GROUP BY l."costCenterId", a."id", a."code", a."name", a."nameAr", a."type"
    HAVING sum(l."debit" - l."credit") <> 0
    ORDER BY a."code"`;
  const centers = new Map((await prisma.costCenter.findMany()).map((c) => [c.id, c]));
  type Group = { costCenter: { id: string; code: string; name: string; nameAr: string; kind: string } | null; revenue: Prisma.Decimal; expenses: Prisma.Decimal; lines: { accountId: string; code: string; name: string; nameAr: string; type: string; amount: string }[] };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = r.costCenterId ?? "";
    const c = r.costCenterId ? centers.get(r.costCenterId) : null;
    const g = groups.get(key) ?? { costCenter: c ? { id: c.id, code: c.code, name: c.name, nameAr: c.nameAr, kind: c.kind } : null, revenue: D(0), expenses: D(0), lines: [] };
    const amt = D(r.amount);
    if (r.type === "revenue") g.revenue = g.revenue.plus(amt); else g.expenses = g.expenses.plus(amt);
    g.lines.push({ accountId: r.accountId, code: r.code, name: r.name, nameAr: r.nameAr, type: r.type, amount: amt.toFixed(2) });
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => (a.costCenter?.code ?? "~").localeCompare(b.costCenter?.code ?? "~"));
  const total = (k: "revenue" | "expenses") => list.reduce((s, g) => s.plus(g[k]), D(0));
  return {
    from, to,
    centers: list.map((g) => ({ ...g, revenue: g.revenue.toFixed(2), expenses: g.expenses.toFixed(2), net: g.revenue.minus(g.expenses).toFixed(2) })),
    totals: { revenue: total("revenue").toFixed(2), expenses: total("expenses").toFixed(2), unallocatedExpenses: (groups.get("")?.expenses ?? D(0)).toFixed(2) },
  };
}
