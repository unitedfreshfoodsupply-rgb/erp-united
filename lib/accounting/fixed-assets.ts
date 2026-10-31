import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { optText, parse, text } from "@/lib/core/validation";
import { idempotencyKeyField, lockKey } from "@/lib/core/idempotency";
import type { ServiceActor } from "@/lib/core/actor";
import { postJournal, type PostLine } from "@/lib/accounting/ledger";

/**
 * Fixed assets.
 *
 *   acquisition (supplier bill capital line)  Dr asset cost (category)   Cr AP            — posted by the bill
 *   acquisition (paid directly)               Dr asset cost              Cr cash / bank
 *   improvement                               Dr asset cost              Cr AP / cash / bank
 *   monthly depreciation (one entry a month)  Dr depreciation expense    Cr accumulated depreciation (category)
 *   disposal                                  Dr cash (proceeds + VAT)   Dr accumulated depreciation
 *                                             Cr asset cost              Cr VAT output (if taxed)
 *                                             Cr gain on disposal / Dr loss on disposal (the difference)
 *   opening (go-live, from the opening batch) Dr asset cost  Cr opening equity;  Dr opening equity  Cr accumulated depreciation
 *   transfer (location, custodian, vehicle)   no entry — the asset's cost stays in its category's accounts
 *
 * Depreciation is computed per asset and month, never twice for the same month (unique
 * in the database): straight line spreads what is left to depreciate (cost − residual −
 * accumulated) over the months left of its life, so an improvement or a change of
 * estimate is taken prospectively; declining balance applies the annual rate to the book
 * value and switches to straight line when that is larger, so the asset still reaches its
 * residual value at the end of its life. Months missed (an asset entered late, a month
 * not run) are caught up by the next run. Closing a month runs its depreciation first.
 *
 * Each category has its own cost and accumulated-depreciation accounts, owned by the
 * register (no manual journal or ordinary bill line can touch them); the integrity check
 * proves the register equals them.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const r2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
type Actorish = { id: string | null; name: string; role: string; deviceId?: string };
const dateField = (label: string) => z.string().refine(isValidISODate, `${label} لازم يكون YYYY-MM-DD`);
const money = (label: string, allowZero = false) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s) || (!allowZero && Number(s) <= 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} لازم يكون ${allowZero ? "صفر أو أكتر" : "أكبر من صفر"} بحد أقصى خانتين عشريتين` });
      return z.NEVER;
    }
    return D(s);
  });
const audit = (tx: Tx, actor: Actorish, entityType: "fixed_asset" | "asset_category" | "depreciation_run", id: string, action: string, detail: string, reason?: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType, entityId: id, newValue: detail, reason, source: "user", deviceId: actor.deviceId }, tx);

const monthOf = (date: string) => date.slice(0, 7);
const addMonths = (period: string, k: number) => {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const monthEnd = (period: string) => { const [y, m] = period.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const monthsBetween = (a: string, b: string) => { const [y1, m1] = a.split("-").map(Number); const [y2, m2] = b.split("-").map(Number); return (y2 - y1) * 12 + (m2 - m1); };

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const categoryInput = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{2,20}$/, "الكود حروف إنجليزي كبيرة وأرقام (2–20)"),
  name: text("الاسم بالإنجليزي", 100),
  name_ar: text("الاسم بالعربي", 100),
  depreciable: z.boolean().default(true),
  method: z.enum(["straight_line", "declining_balance"], { errorMap: () => ({ message: "طريقة الإهلاك: قسط ثابت أو متناقص" }) }).default("straight_line"),
  useful_life_months: z.number().int().min(1, "العمر الإنتاجي شهر على الأقل").max(1200),
  residual_percent: z.number().min(0).max(100).default(0),
  declining_rate: z.number().gt(0).max(100).optional(),
  depreciation_start: z.enum(["same_month", "next_month"], { errorMap: () => ({ message: "بداية الإهلاك: نفس شهر التشغيل أو الشهر اللي بعده" }) }),
  capitalization_threshold: z.number().min(0).max(1_000_000_000).default(0),
});

/**
 * A new category with its own accounts under 1700 (cost; and accumulated depreciation when
 * it depreciates — classified investing / operating for the cash-flow statement). Every
 * policy value is the accountant's explicit choice: nothing is assumed.
 */
export async function createCategory(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.assets.manage");
  const v = parse(categoryInput, input);
  if (v.method === "declining_balance" && !v.declining_rate) throw new ApiError(400, "حدد نسبة الإهلاك السنوية للقسط المتناقص");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, "accounting:asset-category:create");
    if (await tx.assetCategory.findUnique({ where: { code: v.code } })) throw new ApiError(409, `الكود ${v.code} مستخدم`);
    const used = new Set((await tx.account.findMany({ where: { code: { gte: "1701", lte: "1799" } }, select: { code: true } })).map((a) => a.code));
    const free: string[] = [];
    for (let n = 1701; n <= 1799 && free.length < 2; n++) if (!used.has(String(n))) free.push(String(n));
    if (free.length < (v.depreciable ? 2 : 1)) throw new ApiError(409, "الأكواد المتاحة تحت الأصول الثابتة (1701–1799) خلصت");
    const cost = await tx.account.create({ data: { code: free[0], name: `${v.name} — cost`, nameAr: `${v.name_ar} — التكلفة`, type: "asset", parentId: "acc_1700", postable: true, controlledBy: "fixed_assets", cashFlowCategory: "investing" } });
    // Accumulated depreciation is a contra-asset; its change is the non-cash depreciation
    // added back under operating (disposals are moved to investing by the cash-flow report).
    const accum = v.depreciable ? await tx.account.create({ data: { code: free[1], name: `${v.name} — accumulated depreciation`, nameAr: `${v.name_ar} — مجمع الإهلاك`, type: "asset", parentId: "acc_1700", postable: true, controlledBy: "fixed_assets", cashFlowCategory: "operating" } }) : null;
    const expense = v.depreciable ? await tx.account.findUnique({ where: { systemKey: "fa_depreciation" } }) : null;
    const c = await tx.assetCategory.create({
      data: {
        code: v.code, name: v.name, nameAr: v.name_ar, depreciable: v.depreciable, method: v.method, usefulLifeMonths: v.useful_life_months, residualPercent: v.residual_percent,
        decliningRate: v.method === "declining_balance" ? v.declining_rate! : null, depreciationStart: v.depreciation_start, capitalizationThreshold: v.capitalization_threshold,
        assetAccountId: cost.id, accumulatedAccountId: accum?.id ?? null, expenseAccountId: expense?.id ?? null, createdBy: actor.name,
      },
    });
    await audit(tx, actor, "asset_category", c.id, "asset_category_created", `${c.code} · ${c.nameAr} · ${v.method} · ${v.useful_life_months} شهر · متبقي ${v.residual_percent}% · حد ${v.capitalization_threshold} · GL ${cost.code}${accum ? `/${accum.code}` : ""}`);
    return c;
  });
}

/** Policy changes apply to assets registered afterwards; existing assets keep theirs (change them per asset). */
export async function updateCategory(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.assets.manage");
  const v = parse(categoryInput.partial().omit({ code: true, depreciable: true }).extend({ active: z.boolean().optional(), version: z.number().int().optional() }), input);
  return inTx(async (tx) => {
    const c = await tx.assetCategory.findUnique({ where: { id } });
    if (!c) throw new ApiError(404, "الفئة مش موجودة");
    if (v.version !== undefined && v.version !== c.version) throw new ApiError(409, "الفئة اتعدّلت من واحد تاني — حدّث الشاشة");
    const method = v.method ?? c.method;
    if (method === "declining_balance" && !(v.declining_rate ?? c.decliningRate)) throw new ApiError(400, "حدد نسبة الإهلاك السنوية للقسط المتناقص");
    const updated = await tx.assetCategory.update({
      where: { id, version: c.version },
      data: {
        ...(v.name !== undefined ? { name: v.name } : {}), ...(v.name_ar !== undefined ? { nameAr: v.name_ar } : {}), ...(v.method !== undefined ? { method: v.method } : {}),
        ...(v.useful_life_months !== undefined ? { usefulLifeMonths: v.useful_life_months } : {}), ...(v.residual_percent !== undefined ? { residualPercent: v.residual_percent } : {}),
        ...(v.declining_rate !== undefined ? { decliningRate: v.declining_rate } : {}), ...(v.depreciation_start !== undefined ? { depreciationStart: v.depreciation_start } : {}),
        ...(v.capitalization_threshold !== undefined ? { capitalizationThreshold: v.capitalization_threshold } : {}), ...(v.active !== undefined ? { active: v.active } : {}),
        version: { increment: 1 },
      },
    });
    await audit(tx, actor, "asset_category", c.id, "asset_category_updated", JSON.stringify(v));
    return updated;
  });
}

export async function listCategories() {
  const rows = await prisma.assetCategory.findMany({ orderBy: { code: "asc" }, include: { assetAccount: { select: { code: true } }, accumulatedAccount: { select: { code: true } }, _count: { select: { assets: true } } } });
  return rows.map((c) => ({ ...c, residualPercent: c.residualPercent.toFixed(2), decliningRate: c.decliningRate?.toFixed(2) ?? null, capitalizationThreshold: c.capitalizationThreshold.toFixed(2) }));
}

// ---------------------------------------------------------------------------
// Registering assets
// ---------------------------------------------------------------------------

type NewAsset = { name: string; nameAr?: string | null; category: { id: string; usefulLifeMonths: number; residualPercent: Prisma.Decimal; method: string; decliningRate: Prisma.Decimal | null; depreciationStart: string };
  cost: Prisma.Decimal; acquisitionDate: string; sourceType: "supplier_bill" | "cash" | "opening"; sourceId?: string | null; supplierId?: string | null;
  openingAccumulated?: Prisma.Decimal; openingMonthsUsed?: number; inServiceDate?: string | null; usefulLifeMonths?: number; residualValue?: Prisma.Decimal; extra?: Partial<Prisma.FixedAssetUncheckedCreateInput> };

/** Creates the register row (draft, or in service when a date is given) — no posting here. */
async function insertAsset(tx: Tx, a: NewAsset, actor: Actorish) {
  const residual = a.residualValue ?? r2(a.cost.times(a.category.residualPercent).dividedBy(100));
  if (residual.greaterThan(a.cost)) throw new ApiError(400, "القيمة المتبقية أكبر من التكلفة");
  return tx.fixedAsset.create({
    data: {
      number: await nextDocumentNumber(tx, "accounting.fixed_asset", a.acquisitionDate), name: a.name, nameAr: a.nameAr ?? null, categoryId: a.category.id,
      status: a.inServiceDate ? "in_service" : "draft", acquisitionDate: a.acquisitionDate, inServiceDate: a.inServiceDate ?? null, cost: a.cost, residualValue: residual,
      usefulLifeMonths: a.usefulLifeMonths ?? a.category.usefulLifeMonths, method: a.category.method, decliningRate: a.category.decliningRate, depreciationStart: a.category.depreciationStart,
      accumulated: a.openingAccumulated ?? 0, openingAccumulated: a.openingAccumulated ?? 0, openingMonthsUsed: a.openingMonthsUsed ?? 0,
      sourceType: a.sourceType, sourceId: a.sourceId ?? null, supplierId: a.supplierId ?? null, createdById: actor.id, createdBy: actor.name, ...(a.extra ?? {}),
    },
  });
}

/**
 * Called by the supplier-bill posting, inside its transaction, with the bill's entry: each
 * capital line registers its asset (draft: placed in service separately) or adds to the
 * asset it improves. The entry itself already debited the category's cost account.
 */
export async function capitalizeBillLines(tx: Tx, billId: string, entryId: string, actor: Actorish) {
  const bill = await tx.supplierBill.findUniqueOrThrow({ where: { id: billId }, include: { serviceLines: { include: { assetCategory: true } } } });
  for (const l of bill.serviceLines) {
    if (l.assetCategory) {
      const asset = await insertAsset(tx, { name: l.assetName ?? l.description, category: l.assetCategory, cost: l.net, acquisitionDate: bill.billDate, sourceType: "supplier_bill", sourceId: l.id, supplierId: bill.supplierId }, actor);
      await tx.assetEvent.create({ data: { assetId: asset.id, type: "acquisition", date: bill.billDate, costDelta: l.net, entryId, details: { billId: bill.id, billNumber: bill.number, serviceLineId: l.id }, createdById: actor.id, createdBy: actor.name } });
      await audit(tx, actor, "fixed_asset", asset.id, "fixed_asset_created", `${asset.number} · ${asset.name} · ${l.net.toFixed(2)} · ${bill.number}`);
    } else if (l.improvesAssetId) {
      const asset = await tx.fixedAsset.findUniqueOrThrow({ where: { id: l.improvesAssetId } });
      if (asset.status === "disposed") throw new ApiError(409, `الأصل ${asset.number} اتستبعد — مينفعش يتحسّن`);
      await tx.fixedAsset.update({ where: { id: asset.id, version: asset.version }, data: { cost: { increment: l.net }, version: { increment: 1 } } });
      await tx.assetEvent.create({ data: { assetId: asset.id, type: "improvement", date: bill.billDate, costDelta: l.net, entryId, details: { billId: bill.id, billNumber: bill.number, serviceLineId: l.id }, createdById: actor.id, createdBy: actor.name } });
      await audit(tx, actor, "fixed_asset", asset.id, "fixed_asset_improved", `${asset.number} · +${l.net.toFixed(2)} · ${bill.number}`);
    }
  }
}

/** A supplier allowance (debit note) on a capital line takes the amount back off the asset's cost. */
export async function adjustForDebitNote(tx: Tx, debitNoteId: string, entryId: string, actor: Actorish) {
  const dn = await tx.debitNote.findUniqueOrThrow({ where: { id: debitNoteId }, include: { serviceLines: { include: { serviceLine: true } } } });
  for (const l of dn.serviceLines) {
    const line = l.serviceLine;
    const asset = line.assetCategoryId
      ? await tx.fixedAsset.findFirst({ where: { sourceType: "supplier_bill", sourceId: line.id } })
      : line.improvesAssetId ? await tx.fixedAsset.findUnique({ where: { id: line.improvesAssetId } }) : null;
    if (!asset) continue;
    if (asset.status === "disposed") throw new ApiError(409, `الأصل ${asset.number} اتستبعد — الخصم يتسجل بقيد يدوي على أرباح/خسائر الاستبعاد`);
    const cost = asset.cost.minus(l.net);
    if (cost.lessThan(asset.accumulated) || cost.lessThan(0)) throw new ApiError(409, `الخصم أكبر من القيمة الدفترية للأصل ${asset.number}`);
    await tx.fixedAsset.update({ where: { id: asset.id, version: asset.version }, data: { cost, residualValue: Prisma.Decimal.min(asset.residualValue, cost), version: { increment: 1 } } });
    await tx.assetEvent.create({ data: { assetId: asset.id, type: "cost_adjustment", date: dn.issueDate, costDelta: l.net.negated(), entryId, details: { debitNoteId: dn.id, debitNoteNumber: dn.number }, createdById: actor.id, createdBy: actor.name } });
  }
}

const placementFields = {
  warehouse_id: z.string().optional().nullable(),
  location: optText("المكان", 200).optional(),
  custodian_employee_id: z.string().optional().nullable(),
  vehicle_id: z.string().optional().nullable(),
  cost_center_id: z.string().optional().nullable(),
  serial_number: optText("الرقم التسلسلي", 100).optional(),
  plate_number: optText("رقم اللوحة", 50).optional(),
  notes: optText("ملاحظات", 1000).optional(),
};

async function checkPlacement(tx: Tx, v: { warehouse_id?: string | null; custodian_employee_id?: string | null; vehicle_id?: string | null; cost_center_id?: string | null }) {
  if (v.cost_center_id && !(await tx.costCenter.findFirst({ where: { id: v.cost_center_id, active: true } }))) throw new ApiError(400, "مركز التكلفة مش موجود أو موقوف");
  if (v.warehouse_id && !(await tx.warehouse.findUnique({ where: { id: v.warehouse_id } }))) throw new ApiError(404, "المخزن مش موجود");
  if (v.custodian_employee_id && !(await tx.employee.findUnique({ where: { id: v.custodian_employee_id } }))) throw new ApiError(404, "الموظف المسؤول مش موجود");
  if (v.vehicle_id && !(await tx.vehicle.findUnique({ where: { id: v.vehicle_id } }))) throw new ApiError(404, "العربية مش موجودة");
}

/** Bought for cash or bank (no supplier bill): Dr cost / Cr cash. */
export async function acquireAsset(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.assets.manage");
  const v = parse(z.object({
    category_id: text("الفئة"), name: text("اسم الأصل", 200), name_ar: optText("الاسم بالعربي", 200).optional(), cost: money("التكلفة"), acquisition_date: dateField("تاريخ الشراء"),
    cash_account_id: text("الخزينة / البنك"), in_service_date: dateField("تاريخ التشغيل").optional(), reference: optText("المرجع", 100).optional(), ...placementFields,
    idempotency_key: idempotencyKeyField,
  }), input);
  return inTx(async (tx) => {
    // A retried or double-tapped submit returns the asset the first one registered.
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.assetEvent.findFirst({ where: { type: "acquisition", details: { path: ["idempotencyKey"], equals: v.idempotency_key } }, select: { assetId: true } });
      if (prev) return tx.fixedAsset.findUniqueOrThrow({ where: { id: prev.assetId } });
    }
    const category = await tx.assetCategory.findUnique({ where: { id: v.category_id } });
    if (!category?.active) throw new ApiError(400, "الفئة مش موجودة أو موقوفة");
    if (v.cost.lessThan(category.capitalizationThreshold)) throw new ApiError(400, `التكلفة أقل من حد الرسملة للفئة (${category.capitalizationThreshold.toFixed(2)}) — تتسجل كمصروف`);
    if (v.in_service_date && v.in_service_date < v.acquisition_date) throw new ApiError(400, "تاريخ التشغيل قبل تاريخ الشراء");
    const cash = await tx.cashAccount.findUnique({ where: { id: v.cash_account_id } });
    if (!cash?.active) throw new ApiError(400, "الخزينة / الحساب البنكي مش موجود أو موقوف");
    if (cash.type === "cash") {
      await advisoryXactLock(tx, `accounting:cash-account:${cash.id}`);
      const b = await tx.journalLine.aggregate({ where: { accountId: cash.accountId }, _sum: { debit: true, credit: true } });
      const available = D(b._sum.debit).minus(D(b._sum.credit));
      if (available.lessThan(v.cost)) throw new ApiError(409, `رصيد ${cash.nameAr ?? cash.name} ${available.toFixed(2)} — أقل من ${v.cost.toFixed(2)}`);
    }
    await checkPlacement(tx, v);
    const asset = await insertAsset(tx, { name: v.name, nameAr: v.name_ar ?? null, category, cost: v.cost, acquisitionDate: v.acquisition_date, sourceType: "cash", inServiceDate: v.in_service_date ?? null,
      extra: { warehouseId: v.warehouse_id ?? null, location: v.location ?? null, custodianEmployeeId: v.custodian_employee_id ?? null, vehicleId: v.vehicle_id ?? null, costCenterId: v.cost_center_id ?? null, serialNumber: v.serial_number ?? null, plateNumber: v.plate_number ?? null, notes: v.notes ?? null } }, actor);
    const entry = await postJournal(tx, { date: v.acquisition_date, description: `شراء أصل ${asset.number}: ${asset.name}${v.reference ? ` (${v.reference})` : ""}`, sourceType: "asset_acquisition", sourceId: asset.id,
      lines: [{ accountId: category.assetAccountId, amount: v.cost }, { accountId: cash.accountId, amount: v.cost.negated() }] }, actor);
    await tx.assetEvent.create({ data: { assetId: asset.id, type: "acquisition", date: v.acquisition_date, costDelta: v.cost, cashAccountId: cash.id, entryId: entry!.id, details: { ...(v.reference ? { reference: v.reference } : {}), ...(v.idempotency_key ? { idempotencyKey: v.idempotency_key } : {}) }, createdById: actor.id, createdBy: actor.name } });
    if (v.in_service_date) await tx.assetEvent.create({ data: { assetId: asset.id, type: "placed_in_service", date: v.in_service_date, createdById: actor.id, createdBy: actor.name } });
    await audit(tx, actor, "fixed_asset", asset.id, "fixed_asset_created", `${asset.number} · ${asset.name} · ${v.cost.toFixed(2)} · ${cash.code}`);
    return asset;
  });
}

/** Draft → in service: depreciation starts from here (this month or next, per the category). */
export async function placeInService(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.assets.manage");
  const v = parse(z.object({ in_service_date: dateField("تاريخ التشغيل"), useful_life_months: z.number().int().min(1).max(1200).optional(), residual_value: money("القيمة المتبقية", true).optional(), version: z.number().int().optional(), ...placementFields }), input);
  return inTx(async (tx) => {
    const a = await tx.fixedAsset.findUnique({ where: { id } });
    if (!a) throw new ApiError(404, "الأصل مش موجود");
    if (v.version !== undefined && v.version !== a.version) throw new ApiError(409, "الأصل اتعدّل من واحد تاني — حدّث الشاشة");
    if (a.status !== "draft") throw new ApiError(409, "الأصل في الخدمة بالفعل أو اتستبعد");
    if (v.in_service_date < a.acquisitionDate) throw new ApiError(400, "تاريخ التشغيل قبل تاريخ الشراء");
    if (v.residual_value && v.residual_value.greaterThan(a.cost)) throw new ApiError(400, "القيمة المتبقية أكبر من التكلفة");
    await checkPlacement(tx, v);
    const updated = await tx.fixedAsset.update({
      where: { id, version: a.version },
      data: {
        status: "in_service", inServiceDate: v.in_service_date, ...(v.useful_life_months ? { usefulLifeMonths: v.useful_life_months } : {}), ...(v.residual_value ? { residualValue: v.residual_value } : {}),
        ...(v.warehouse_id !== undefined ? { warehouseId: v.warehouse_id } : {}), ...(v.location !== undefined ? { location: v.location } : {}), ...(v.custodian_employee_id !== undefined ? { custodianEmployeeId: v.custodian_employee_id } : {}),
        ...(v.vehicle_id !== undefined ? { vehicleId: v.vehicle_id } : {}), ...(v.cost_center_id !== undefined ? { costCenterId: v.cost_center_id } : {}), ...(v.serial_number !== undefined ? { serialNumber: v.serial_number } : {}), ...(v.plate_number !== undefined ? { plateNumber: v.plate_number } : {}), ...(v.notes !== undefined ? { notes: v.notes } : {}),
        version: { increment: 1 },
      },
    });
    await tx.assetEvent.create({ data: { assetId: a.id, type: "placed_in_service", date: v.in_service_date, createdById: actor.id, createdBy: actor.name } });
    await audit(tx, actor, "fixed_asset", a.id, "fixed_asset_placed_in_service", `${a.number} · ${v.in_service_date}`);
    return updated;
  });
}

/** A change of estimate (life, residual) — prospective: what is left is spread over what is left. */
export async function changeEstimate(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.assets.manage");
  const v = parse(z.object({ useful_life_months: z.number().int().min(1).max(1200).optional(), residual_value: money("القيمة المتبقية", true).optional(), reason: text("السبب", 500), version: z.number().int().optional() }), input);
  return inTx(async (tx) => {
    const a = await tx.fixedAsset.findUnique({ where: { id }, include: { _count: { select: { depreciationLines: true } } } });
    if (!a) throw new ApiError(404, "الأصل مش موجود");
    if (v.version !== undefined && v.version !== a.version) throw new ApiError(409, "الأصل اتعدّل من واحد تاني — حدّث الشاشة");
    if (a.status === "disposed") throw new ApiError(409, "الأصل اتستبعد");
    const used = a.openingMonthsUsed + a._count.depreciationLines;
    if (v.useful_life_months !== undefined && v.useful_life_months < used) throw new ApiError(400, `العمر الجديد أقل من الشهور اللي اتهلكت بالفعل (${used})`);
    if (v.residual_value && v.residual_value.greaterThan(a.cost.minus(a.accumulated))) throw new ApiError(400, "القيمة المتبقية أكبر من القيمة الدفترية الحالية");
    const updated = await tx.fixedAsset.update({ where: { id, version: a.version }, data: { ...(v.useful_life_months ? { usefulLifeMonths: v.useful_life_months } : {}), ...(v.residual_value ? { residualValue: v.residual_value } : {}), version: { increment: 1 } } });
    await tx.assetEvent.create({ data: { assetId: a.id, type: "estimate_change", date: todayLocalISO(), details: { from: { usefulLifeMonths: a.usefulLifeMonths, residualValue: a.residualValue.toFixed(2) }, to: { usefulLifeMonths: updated.usefulLifeMonths, residualValue: updated.residualValue.toFixed(2) } }, reason: v.reason, createdById: actor.id, createdBy: actor.name } });
    await audit(tx, actor, "fixed_asset", a.id, "fixed_asset_updated", `${a.number} · ${a.usefulLifeMonths}→${updated.usefulLifeMonths} شهر · متبقي ${a.residualValue.toFixed(2)}→${updated.residualValue.toFixed(2)}`, v.reason);
    return updated;
  });
}

/** Moves an asset between warehouses, custodians or vehicles. No entry: its accounts do not change. */
export async function transferAsset(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.assets.manage");
  const v = parse(z.object({ date: dateField("التاريخ").optional(), reason: text("السبب", 500), version: z.number().int().optional(), warehouse_id: placementFields.warehouse_id, location: placementFields.location, custodian_employee_id: placementFields.custodian_employee_id, vehicle_id: placementFields.vehicle_id, cost_center_id: placementFields.cost_center_id }), input);
  return inTx(async (tx) => {
    const a = await tx.fixedAsset.findUnique({ where: { id } });
    if (!a) throw new ApiError(404, "الأصل مش موجود");
    if (v.version !== undefined && v.version !== a.version) throw new ApiError(409, "الأصل اتعدّل من واحد تاني — حدّث الشاشة");
    if (a.status === "disposed") throw new ApiError(409, "الأصل اتستبعد");
    await checkPlacement(tx, v);
    const from = { warehouseId: a.warehouseId, location: a.location, custodianEmployeeId: a.custodianEmployeeId, vehicleId: a.vehicleId, costCenterId: a.costCenterId };
    const to = { warehouseId: v.warehouse_id !== undefined ? v.warehouse_id : a.warehouseId, location: v.location !== undefined ? v.location : a.location, custodianEmployeeId: v.custodian_employee_id !== undefined ? v.custodian_employee_id : a.custodianEmployeeId, vehicleId: v.vehicle_id !== undefined ? v.vehicle_id : a.vehicleId, costCenterId: v.cost_center_id !== undefined ? v.cost_center_id : a.costCenterId };
    if (JSON.stringify(from) === JSON.stringify(to)) throw new ApiError(400, "مفيش تغيير في المكان أو المسؤول");
    const updated = await tx.fixedAsset.update({ where: { id, version: a.version }, data: { ...to, version: { increment: 1 } } });
    await tx.assetEvent.create({ data: { assetId: a.id, type: "transfer", date: v.date ?? todayLocalISO(), details: { from, to }, reason: v.reason, createdById: actor.id, createdBy: actor.name } });
    await audit(tx, actor, "fixed_asset", a.id, "fixed_asset_transferred", a.number, v.reason);
    return updated;
  });
}

/** Improvement paid directly: Dr cost / Cr cash; the remaining life carries the new cost. */
export async function improveAsset(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.assets.manage");
  const v = parse(z.object({ amount: money("المبلغ"), date: dateField("التاريخ"), cash_account_id: text("الخزينة / البنك"), description: text("البيان", 300), idempotency_key: idempotencyKeyField }), input);
  return inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.assetEvent.findFirst({ where: { assetId: id, type: "improvement", details: { path: ["idempotencyKey"], equals: v.idempotency_key } }, select: { id: true } });
      if (prev) return tx.fixedAsset.findUniqueOrThrow({ where: { id } });
    }
    const a = await tx.fixedAsset.findUnique({ where: { id }, include: { category: true } });
    if (!a) throw new ApiError(404, "الأصل مش موجود");
    if (a.status === "disposed") throw new ApiError(409, "الأصل اتستبعد");
    const cash = await tx.cashAccount.findUnique({ where: { id: v.cash_account_id } });
    if (!cash?.active) throw new ApiError(400, "الخزينة / الحساب البنكي مش موجود أو موقوف");
    const entry = await postJournal(tx, { date: v.date, description: `تحسين أصل ${a.number}: ${v.description}`, sourceType: "asset_improvement", sourceId: `${a.id}:${Date.now()}`, lines: [{ accountId: a.category.assetAccountId, amount: v.amount }, { accountId: cash.accountId, amount: v.amount.negated() }] }, actor);
    const updated = await tx.fixedAsset.update({ where: { id, version: a.version }, data: { cost: { increment: v.amount }, version: { increment: 1 } } });
    await tx.assetEvent.create({ data: { assetId: a.id, type: "improvement", date: v.date, costDelta: v.amount, cashAccountId: cash.id, entryId: entry!.id, reason: v.description, ...(v.idempotency_key ? { details: { idempotencyKey: v.idempotency_key } } : {}), createdById: actor.id, createdBy: actor.name } });
    await audit(tx, actor, "fixed_asset", a.id, "fixed_asset_improved", `${a.number} · +${v.amount.toFixed(2)}`);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

type DepAsset = Prisma.FixedAssetGetPayload<{ include: { category: true; _count: { select: { depreciationLines: true } } } }>;

/** The first month an asset is depreciated for (from its in-service date and the start rule). */
function firstMonth(a: { inServiceDate: string | null; depreciationStart: string }) {
  return a.inServiceDate ? (a.depreciationStart === "next_month" ? addMonths(monthOf(a.inServiceDate), 1) : monthOf(a.inServiceDate)) : null;
}

/** One month's charge for an asset in the state given (pure — the schedule and the run share it). */
export function monthlyCharge(a: { cost: Prisma.Decimal; residualValue: Prisma.Decimal; accumulated: Prisma.Decimal; usefulLifeMonths: number; method: string; decliningRate: Prisma.Decimal | null }, monthsUsed: number) {
  const remaining = a.usefulLifeMonths - monthsUsed;
  const depreciable = a.cost.minus(a.residualValue).minus(a.accumulated);
  if (remaining <= 0 || !depreciable.gt(0)) return D(0);
  const straight = remaining === 1 ? depreciable : r2(depreciable.dividedBy(remaining));
  if (a.method !== "declining_balance" || !a.decliningRate) return Prisma.Decimal.min(straight, depreciable);
  const declining = r2(a.cost.minus(a.accumulated).times(a.decliningRate).dividedBy(1200));
  return Prisma.Decimal.min(Prisma.Decimal.max(declining, straight), depreciable);
}

/** The months due for an asset up to `through` (inclusive) that have no line yet, with their amounts. */
async function dueLines(tx: Tx, a: DepAsset, through: string) {
  if (!a.category.depreciable || a.status !== "in_service") return [];
  const start = firstMonth(a);
  if (!start || start > through) return [];
  const done = new Set((await tx.assetDepreciationLine.findMany({ where: { assetId: a.id }, select: { period: true } })).map((l) => l.period));
  const out: { period: string; amount: Prisma.Decimal; accumulatedAfter: Prisma.Decimal }[] = [];
  let accumulated = a.accumulated;
  let used = a.openingMonthsUsed + a._count.depreciationLines;
  // Months before go-live are covered by the opening accumulated depreciation.
  for (let p = start; p <= through; p = addMonths(p, 1)) {
    if (done.has(p)) continue;
    if (a.sourceType === "opening" && a.openingMonthsUsed > 0 && monthsBetween(start, p) < a.openingMonthsUsed) continue;
    const amount = monthlyCharge({ ...a, accumulated }, used);
    if (!amount.gt(0)) break;
    accumulated = accumulated.plus(amount);
    used += 1;
    out.push({ period: p, amount, accumulatedAfter: accumulated });
  }
  return out;
}

/** What a run for the month would post, per asset (the screen's preview). */
export async function previewDepreciation(period: string) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new ApiError(400, "الشهر لازم يكون YYYY-MM");
  return inTx(async (tx) => {
    const assets = await tx.fixedAsset.findMany({ where: { status: "in_service", category: { depreciable: true } }, include: { category: true, _count: { select: { depreciationLines: true } } }, orderBy: { number: "asc" } });
    const rows = [];
    for (const a of assets) {
      const due = await dueLines(tx, a, period);
      if (due.length) rows.push({ assetId: a.id, number: a.number, name: a.name, nameAr: a.nameAr, months: due.map((d) => d.period), amount: due.reduce((s, d) => s.plus(d.amount), D(0)).toFixed(2) });
    }
    const runs = await tx.depreciationRun.findMany({ where: { period }, select: { number: true } });
    return { period, runs: runs.map((r) => r.number), rows, total: rows.reduce((s, r) => s.plus(r.amount), D(0)).toFixed(2) };
  });
}

/**
 * Posts the month's depreciation (and any month missed before it) for every asset in
 * service: one entry dated the month's last day, Dr each category's expense / Cr its
 * accumulated depreciation, and one line per asset and month. Running a month again posts
 * only what became due since (never an asset-month twice); with nothing due, nothing is
 * posted and no run is recorded.
 */
export async function runDepreciationTx(tx: Tx, period: string, actor: Actorish) {
  await advisoryXactLock(tx, "accounting:depreciation");
  const assets = await tx.fixedAsset.findMany({ where: { status: "in_service", category: { depreciable: true } }, include: { category: true, _count: { select: { depreciationLines: true } } } });
  const plan: { asset: DepAsset; lines: Awaited<ReturnType<typeof dueLines>> }[] = [];
  for (const a of assets) {
    const lines = await dueLines(tx, a, period);
    if (lines.length) plan.push({ asset: a, lines });
  }
  if (!plan.length) return null;
  // One pair of lines per category and cost center: the expense carries the asset's cost center.
  const byAccounts = new Map<string, { expense: string; accum: string; costCenterId: string | null; amount: Prisma.Decimal }>();
  for (const { asset, lines } of plan) {
    const k = `${asset.category.expenseAccountId}|${asset.category.accumulatedAccountId}|${asset.costCenterId ?? ""}`;
    const cur = byAccounts.get(k) ?? { expense: asset.category.expenseAccountId!, accum: asset.category.accumulatedAccountId!, costCenterId: asset.costCenterId, amount: D(0) };
    cur.amount = cur.amount.plus(lines.reduce((s, l) => s.plus(l.amount), D(0)));
    byAccounts.set(k, cur);
  }
  const total = [...byAccounts.values()].reduce((s, x) => s.plus(x.amount), D(0));
  const id = randomUUID();
  const number = await nextDocumentNumber(tx, "accounting.depreciation_run", monthEnd(period));
  const postLines: PostLine[] = [...byAccounts.values()].flatMap((x) => [{ accountId: x.expense, amount: x.amount, costCenterId: x.costCenterId, description: `إهلاك ${period}` }, { accountId: x.accum, amount: x.amount.negated(), description: `إهلاك ${period}` }]);
  const entry = await postJournal(tx, { date: monthEnd(period), description: `إهلاك الأصول الثابتة ${period} (${number})`, sourceType: "asset_depreciation", sourceId: id, lines: postLines }, actor);
  const run = await tx.depreciationRun.create({ data: { id, number, period, date: monthEnd(period), total, lineCount: plan.reduce((s, p) => s + p.lines.length, 0), entryId: entry!.id, createdById: actor.id, createdBy: actor.name } });
  for (const { asset, lines } of plan) {
    await tx.assetDepreciationLine.createMany({ data: lines.map((l) => ({ assetId: asset.id, period: l.period, runId: run.id, amount: l.amount, accumulatedAfter: l.accumulatedAfter, entryId: entry!.id })) });
    await tx.fixedAsset.update({ where: { id: asset.id, version: asset.version }, data: { accumulated: lines[lines.length - 1].accumulatedAfter, version: { increment: 1 } } });
  }
  await audit(tx, actor, "depreciation_run", run.id, "depreciation_run", `${number} · ${period} · ${total.toFixed(2)} · ${run.lineCount} سطر`);
  return run;
}

export async function runDepreciation(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.assets.manage");
  const v = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/, "الشهر لازم يكون YYYY-MM") }), input);
  if (monthEnd(v.period) > monthEnd(monthOf(todayLocalISO()))) throw new ApiError(400, "مينفعش تهلك شهر لسه مجاش");
  const run = await inTx((tx) => runDepreciationTx(tx, v.period, actor));
  if (!run) throw new ApiError(409, `مفيش إهلاك مستحق عن ${v.period}`);
  return run;
}

/** For the month close: run the month's depreciation if anything is due and it has not run. */
export async function depreciationForClose(tx: Tx, period: string, actor: Actorish) {
  if (period > monthOf(todayLocalISO())) return null;
  return runDepreciationTx(tx, period, actor);
}

export async function listRuns() {
  const rows = await prisma.depreciationRun.findMany({ orderBy: { period: "desc" }, take: 60, include: { entry: { select: { number: true } } } });
  return rows.map((r) => ({ ...r, total: r.total.toFixed(2) }));
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

/**
 * Sale or scrap. Depreciation is charged up to the month before the disposal (the
 * disposal month itself is not depreciated), then the asset leaves the books.
 */
export async function disposeAsset(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.assets.manage");
  const v = parse(z.object({ kind: z.enum(["sale", "scrap"], { errorMap: () => ({ message: "نوع الاستبعاد: بيع أو تخريد" }) }), date: dateField("تاريخ الاستبعاد"), proceeds: money("قيمة البيع", true).optional(), cash_account_id: z.string().optional(), tax_code: z.string().optional(), reason: text("السبب", 500), version: z.number().int().optional() }), input);
  const proceeds = v.kind === "sale" ? v.proceeds ?? D(0) : D(0);
  if (v.kind === "sale" && !proceeds.gt(0)) throw new ApiError(400, "حدد قيمة البيع (أو اختار تخريد)");
  if (v.kind === "sale" && !v.cash_account_id) throw new ApiError(400, "حدد الخزينة أو البنك اللي استلم الثمن");
  if (v.date > todayLocalISO()) throw new ApiError(400, "مينفعش الاستبعاد يكون بتاريخ في المستقبل");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, "accounting:depreciation");
    const a = await tx.fixedAsset.findUnique({ where: { id }, include: { category: true, _count: { select: { depreciationLines: true } } } });
    if (!a) throw new ApiError(404, "الأصل مش موجود");
    if (v.version !== undefined && v.version !== a.version) throw new ApiError(409, "الأصل اتعدّل من واحد تاني — حدّث الشاشة");
    if (a.status === "disposed") throw new ApiError(409, "الأصل اتستبعد قبل كده");
    if (v.date < a.acquisitionDate) throw new ApiError(400, "تاريخ الاستبعاد قبل تاريخ الشراء");
    const later = await tx.assetDepreciationLine.findFirst({ where: { assetId: a.id, period: { gte: monthOf(v.date) } }, select: { period: true } });
    if (later) throw new ApiError(409, `الأصل اتهلك عن ${later.period} — تاريخ الاستبعاد لازم يكون بعده`);
    let taxRate = D(0), taxCode: string | null = null;
    if (v.kind === "sale" && v.tax_code) {
      const t = await tx.taxRate.findFirst({ where: { code: v.tax_code, active: true } });
      if (!t) throw new ApiError(400, `كود ضريبة غير معروف: ${v.tax_code}`);
      taxRate = D(t.rate); taxCode = t.code;
    }
    const tax = r2(proceeds.times(taxRate).dividedBy(100));
    const cash = v.kind === "sale" ? await tx.cashAccount.findUnique({ where: { id: v.cash_account_id! } }) : null;
    if (v.kind === "sale" && !cash?.active) throw new ApiError(400, "الخزينة / الحساب البنكي مش موجود أو موقوف");
    // Catch-up depreciation to the month before the disposal.
    const catchUp = a.status === "in_service" ? await dueLines(tx, a, addMonths(monthOf(v.date), -1)) : [];
    const catchUpTotal = catchUp.reduce((s, l) => s.plus(l.amount), D(0));
    const accumulated = a.accumulated.plus(catchUpTotal);
    const bookValue = a.cost.minus(accumulated);
    const gain = proceeds.minus(bookValue);
    const eventId = randomUUID();
    const lines: PostLine[] = [];
    if (catchUpTotal.gt(0)) lines.push({ accountId: a.category.expenseAccountId!, amount: catchUpTotal, costCenterId: a.costCenterId, description: "إهلاك حتى الاستبعاد" }, { accountId: a.category.accumulatedAccountId!, amount: catchUpTotal.negated(), description: "إهلاك حتى الاستبعاد" });
    if (cash) lines.push({ accountId: cash.accountId, amount: proceeds.plus(tax) });
    if (accumulated.gt(0)) lines.push({ accountId: a.category.accumulatedAccountId!, amount: accumulated });
    lines.push({ accountId: a.category.assetAccountId, amount: a.cost.negated() });
    if (tax.gt(0)) lines.push({ key: "vat_output", amount: tax.negated() });
    if (gain.gt(0)) lines.push({ key: "fa_disposal_gain", amount: gain.negated(), costCenterId: a.costCenterId });
    if (gain.lt(0)) lines.push({ key: "fa_disposal_loss", amount: gain.negated(), costCenterId: a.costCenterId });
    const entry = await postJournal(tx, { date: v.date, description: `${v.kind === "sale" ? "بيع" : "تخريد"} أصل ${a.number}: ${a.name}`, sourceType: "asset_disposal", sourceId: eventId, lines }, actor);
    await tx.assetEvent.create({
      data: { id: eventId, assetId: a.id, type: "disposal", date: v.date, costDelta: a.cost.negated(), accumulatedDelta: accumulated.negated(), proceeds, taxCode, taxRate: taxCode ? taxRate : null, tax: taxCode ? tax : null, gainLoss: gain, cashAccountId: cash?.id ?? null, entryId: entry?.id ?? null, details: { kind: v.kind, bookValue: bookValue.toFixed(2), catchUp: catchUpTotal.toFixed(2) }, reason: v.reason, createdById: actor.id, createdBy: actor.name },
    });
    if (catchUp.length) await tx.assetDepreciationLine.createMany({ data: catchUp.map((l) => ({ assetId: a.id, period: l.period, disposalEventId: eventId, amount: l.amount, accumulatedAfter: l.accumulatedAfter, entryId: entry!.id })) });
    const updated = await tx.fixedAsset.update({ where: { id, version: a.version }, data: { status: "disposed", disposedDate: v.date, accumulated, version: { increment: 1 } } });
    await audit(tx, actor, "fixed_asset", a.id, "fixed_asset_disposed", `${a.number} · ${v.kind} · ${proceeds.toFixed(2)} · ${gain.gte(0) ? "ربح" : "خسارة"} ${gain.abs().toFixed(2)}`, v.reason);
    return { asset: updated, gainLoss: gain.toFixed(2), bookValue: bookValue.toFixed(2), catchUp: catchUpTotal.toFixed(2) };
  });
}

// ---------------------------------------------------------------------------
// Opening (from the opening-balance batch)
// ---------------------------------------------------------------------------

/**
 * Brings an asset over at go-live with its history: original cost, in-service date, life,
 * and the depreciation already charged. Posts Dr cost / Cr opening equity and Dr opening
 * equity / Cr accumulated depreciation, so the register and the GL agree from day one.
 */
export async function createOpeningAsset(tx: Tx, a: { categoryId: string; name: string; nameAr?: string | null; cost: Prisma.Decimal; accumulated: Prisma.Decimal; acquisitionDate: string; inServiceDate: string; usefulLifeMonths?: number | null; residualValue?: Prisma.Decimal | null; monthsUsed?: number | null; cutoverDate: string; sourceId: string; serialNumber?: string | null; plateNumber?: string | null; location?: string | null }, actor: Actorish) {
  const category = await tx.assetCategory.findUnique({ where: { id: a.categoryId } });
  if (!category) throw new ApiError(400, "فئة الأصل مش موجودة");
  if (a.accumulated.greaterThan(a.cost)) throw new ApiError(400, `${a.name}: مجمع الإهلاك أكبر من التكلفة`);
  if (a.accumulated.gt(0) && !category.depreciable) throw new ApiError(400, `${a.name}: فئة ${category.nameAr} مش بتتهلك`);
  const start = category.depreciationStart === "next_month" ? addMonths(monthOf(a.inServiceDate), 1) : monthOf(a.inServiceDate);
  const monthsUsed = a.monthsUsed ?? Math.max(0, monthsBetween(start, addMonths(monthOf(a.cutoverDate), 1)));
  const asset = await insertAsset(tx, { name: a.name, nameAr: a.nameAr ?? null, category, cost: a.cost, acquisitionDate: a.acquisitionDate, sourceType: "opening", sourceId: a.sourceId, inServiceDate: a.inServiceDate, usefulLifeMonths: a.usefulLifeMonths ?? undefined, residualValue: a.residualValue ?? undefined, openingAccumulated: a.accumulated, openingMonthsUsed: monthsUsed, extra: { serialNumber: a.serialNumber ?? null, plateNumber: a.plateNumber ?? null, location: a.location ?? null } }, actor);
  await tx.assetEvent.create({ data: { assetId: asset.id, type: "opening", date: a.cutoverDate, costDelta: a.cost, accumulatedDelta: a.accumulated, details: { monthsUsed, inServiceDate: a.inServiceDate }, createdById: actor.id, createdBy: actor.name } });
  return { asset, category };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const ASSET_INCLUDE = { category: { select: { id: true, code: true, name: true, nameAr: true, depreciable: true } }, warehouse: { select: { id: true, code: true, name: true, nameAr: true } }, custodian: { select: { id: true, code: true, name: true, nameAr: true } }, vehicle: { select: { id: true, code: true, plate: true } } } as const;

function presentAsset(a: Prisma.FixedAssetGetPayload<{ include: typeof ASSET_INCLUDE }>) {
  return { ...a, cost: a.cost.toFixed(2), residualValue: a.residualValue.toFixed(2), accumulated: a.accumulated.toFixed(2), openingAccumulated: a.openingAccumulated.toFixed(2), bookValue: a.cost.minus(a.accumulated).toFixed(2), decliningRate: a.decliningRate?.toFixed(2) ?? null, fullyDepreciated: a.status === "in_service" && !a.cost.minus(a.residualValue).minus(a.accumulated).gt(0) };
}

export async function listAssets(filters: { status?: string; categoryId?: string; q?: string }) {
  const where: Prisma.FixedAssetWhereInput = {
    ...(filters.status ? { status: filters.status } : {}), ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.q ? { OR: [{ name: { contains: filters.q, mode: "insensitive" } }, { nameAr: { contains: filters.q } }, { number: { contains: filters.q, mode: "insensitive" } }, { plateNumber: { contains: filters.q } }, { serialNumber: { contains: filters.q } }] } : {}),
  };
  const rows = await prisma.fixedAsset.findMany({ where, include: ASSET_INCLUDE, orderBy: { number: "asc" }, take: 500 });
  const assets = rows.map(presentAsset);
  const live = rows.filter((r) => r.status !== "disposed");
  return { assets, totals: { cost: live.reduce((s, a) => s.plus(a.cost), D(0)).toFixed(2), accumulated: live.reduce((s, a) => s.plus(a.accumulated), D(0)).toFixed(2), bookValue: live.reduce((s, a) => s.plus(a.cost.minus(a.accumulated)), D(0)).toFixed(2), count: live.length } };
}

/** One asset with its events, depreciation so far and the schedule still to come. */
export async function getAsset(id: string) {
  const a = await prisma.fixedAsset.findUnique({ where: { id }, include: { ...ASSET_INCLUDE, events: { orderBy: { createdAt: "asc" }, include: { entry: { select: { id: true, number: true } } } }, depreciationLines: { orderBy: { period: "asc" } } } });
  if (!a) throw new ApiError(404, "الأصل مش موجود");
  // The schedule ahead, from the current state (same rule as the run).
  const schedule: { period: string; amount: string; bookValue: string }[] = [];
  if (a.status === "in_service" && a.category.depreciable) {
    let accumulated = a.accumulated;
    let used = a.openingMonthsUsed + a.depreciationLines.length;
    const last = a.depreciationLines[a.depreciationLines.length - 1]?.period;
    let p = last ? addMonths(last, 1) : firstMonth(a)!;
    if (a.sourceType === "opening" && !last) p = addMonths(firstMonth(a)!, a.openingMonthsUsed);
    for (let i = 0; i < 600; i++, p = addMonths(p, 1)) {
      const amt = monthlyCharge({ ...a, accumulated }, used);
      if (!amt.gt(0)) break;
      accumulated = accumulated.plus(amt); used += 1;
      schedule.push({ period: p, amount: amt.toFixed(2), bookValue: a.cost.minus(accumulated).toFixed(2) });
    }
  }
  return {
    ...presentAsset(a),
    events: a.events.map((e) => ({ ...e, costDelta: e.costDelta.toFixed(2), accumulatedDelta: e.accumulatedDelta.toFixed(2), proceeds: e.proceeds?.toFixed(2) ?? null, tax: e.tax?.toFixed(2) ?? null, gainLoss: e.gainLoss?.toFixed(2) ?? null, taxRate: e.taxRate?.toFixed(2) ?? null })),
    depreciation: a.depreciationLines.map((l) => ({ period: l.period, amount: l.amount.toFixed(2), accumulatedAfter: l.accumulatedAfter.toFixed(2) })),
    schedule,
  };
}

/** Roll-forward per category: opening book value + additions − depreciation − disposals = closing. */
export async function rollForward(from: string, to: string) {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "الفترة غير صالحة");
  const cats = await prisma.assetCategory.findMany({ orderBy: { code: "asc" } });
  const glAt = async (accountId: string | null, date: string, before: boolean) => {
    if (!accountId) return D(0);
    const r = await prisma.journalLine.aggregate({ where: { accountId, entry: { date: before ? { lt: date } : { lte: date } } }, _sum: { debit: true, credit: true } });
    return D(r._sum.debit).minus(D(r._sum.credit));
  };
  const rows = [];
  for (const c of cats) {
    const [costOpen, costClose, accOpen, accClose, events, dep] = await Promise.all([
      glAt(c.assetAccountId, from, true), glAt(c.assetAccountId, to, false), glAt(c.accumulatedAccountId, from, true), glAt(c.accumulatedAccountId, to, false),
      prisma.assetEvent.findMany({ where: { asset: { categoryId: c.id }, date: { gte: from, lte: to }, type: { in: ["acquisition", "improvement", "cost_adjustment", "opening", "disposal"] } } }),
      prisma.assetDepreciationLine.aggregate({ where: { asset: { categoryId: c.id }, entry: { date: { gte: from, lte: to } } }, _sum: { amount: true } }),
    ]);
    const additions = events.filter((e) => e.type !== "disposal").reduce((s, e) => s.plus(e.costDelta), D(0));
    const disposalsCost = events.filter((e) => e.type === "disposal").reduce((s, e) => s.minus(e.costDelta), D(0));
    const disposalsAcc = events.filter((e) => e.type === "disposal").reduce((s, e) => s.minus(e.accumulatedDelta), D(0));
    const openingAcc = events.filter((e) => e.type === "opening").reduce((s, e) => s.plus(e.accumulatedDelta), D(0));
    const depreciation = D(dep._sum.amount);
    const openNbv = costOpen.plus(accOpen);
    const closeNbv = costClose.plus(accClose);
    const computed = openNbv.plus(additions).minus(openingAcc).minus(depreciation).minus(disposalsCost.minus(disposalsAcc));
    rows.push({ categoryId: c.id, code: c.code, name: c.name, nameAr: c.nameAr, openingBookValue: openNbv.toFixed(2), additions: additions.toFixed(2), openingDepreciation: openingAcc.toFixed(2), depreciation: depreciation.toFixed(2), disposals: disposalsCost.minus(disposalsAcc).toFixed(2), closingBookValue: closeNbv.toFixed(2), ties: computed.equals(closeNbv) });
  }
  return { from, to, rows };
}

/** Integrity: per category, the register's cost and accumulated depreciation equal their GL accounts. */
export async function registerVsLedger() {
  const cats = await prisma.assetCategory.findMany();
  const out = [];
  for (const c of cats) {
    const [reg, cost, acc] = await Promise.all([
      prisma.fixedAsset.aggregate({ where: { categoryId: c.id, status: { not: "disposed" } }, _sum: { cost: true, accumulated: true } }),
      prisma.journalLine.aggregate({ where: { accountId: c.assetAccountId }, _sum: { debit: true, credit: true } }),
      c.accumulatedAccountId ? prisma.journalLine.aggregate({ where: { accountId: c.accumulatedAccountId }, _sum: { debit: true, credit: true } }) : null,
    ]);
    const glCost = D(cost._sum.debit).minus(D(cost._sum.credit));
    const glAcc = acc ? D(acc._sum.credit).minus(D(acc._sum.debit)) : D(0);
    out.push({ code: c.code, nameAr: c.nameAr, registerCost: D(reg._sum.cost).toFixed(2), glCost: glCost.toFixed(2), registerAccumulated: D(reg._sum.accumulated).toFixed(2), glAccumulated: glAcc.toFixed(2), ok: D(reg._sum.cost).equals(glCost) && D(reg._sum.accumulated).equals(glAcc) });
  }
  return out;
}
