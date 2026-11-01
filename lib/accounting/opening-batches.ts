import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { isValidISODate } from "@/lib/dates";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { optText, parse } from "@/lib/core/validation";
import { idempotencyKeyField, lockKey } from "@/lib/core/idempotency";
import { cancelPendingApproval, requestApproval, type Decider } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";
import { controlAccountMovedBy } from "@/lib/accounting/control-accounts";
import { postJournal, type PostLine } from "@/lib/accounting/ledger";

/**
 * Opening balances at go-live, as one controlled batch.
 *
 *   1. Prepare: a draft batch with a cut-over date; lines are added (by form or pasted from
 *      the old system): GL balances (cash, banks, loans, capital, retained earnings, other
 *      accounts), customers' and suppliers' open items, stock (quantity × unit cost) and
 *      fixed assets with their original cost and the depreciation already charged.
 *   2. Validate: every line on its own, then the whole batch as an opening trial balance —
 *      debits must equal credits with nothing left over in opening equity (so capital and
 *      retained earnings are stated, not plugged).
 *   3. Submit: the lines freeze (DB); someone else with accounting.opening.approve decides.
 *   4. Post on approval, in one transaction, dated the cut-over day:
 *        GL lines           one entry, against opening equity
 *        customers          Dr AR (party) / Cr opening equity — an open item each (statements, aging)
 *        suppliers          Dr opening equity / Cr AP (party)
 *        stock              Dr inventory / Cr opening equity — through the stock ledger (lots at cost)
 *        fixed assets       Dr cost / Cr opening equity and Dr opening equity / Cr accumulated depreciation
 *      Opening equity nets to zero across the batch. The integrity check is green after it.
 *
 * Once the initial batch has posted, the direct opening forms are closed (assertNoOpeningBatchPosted)
 * and opening figures change only through a correction batch (GL and party lines), approved the
 * same way. A batch posts once (status, lock, unique index on the posted initial batch).
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const r2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const q4 = (d: Prisma.Decimal) => d.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
const isoDate = (label: string) => z.string().refine(isValidISODate, `${label} لازم يكون YYYY-MM-DD`);
const num = (label: string, opts: { signed?: boolean; allowZero?: boolean; dp?: number } = {}) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim().replace(/,/g, "");
    const re = new RegExp(`^${opts.signed ? "-?" : ""}\\d+(\\.\\d{1,${opts.dp ?? 2}})?$`);
    if (!re.test(s) || (!opts.allowZero && Number(s) === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: opts.signed ? `${label}: رقم بحد أقصى ${opts.dp ?? 2} خانات عشرية` : `${label}: رقم موجب بحد أقصى ${opts.dp ?? 2} خانات عشرية` });
      return z.NEVER;
    }
    return D(s);
  });

const lineInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gl"), account_id: z.string().min(1, "الحساب مطلوب"), debit: num("مدين", { allowZero: true }).optional(), credit: num("دائن", { allowZero: true }).optional(), description: optText("البيان", 200).optional() }),
  z.object({ kind: z.literal("customer"), party_id: z.string().min(1, "العميل مطلوب"), amount: num("المبلغ", { signed: true }), due_date: isoDate("تاريخ الاستحقاق").optional(), reference: optText("المرجع", 100).optional() }),
  z.object({ kind: z.literal("supplier"), party_id: z.string().min(1, "المورد مطلوب"), amount: num("المبلغ", { signed: true }), due_date: isoDate("تاريخ الاستحقاق").optional(), reference: optText("المرجع", 100).optional() }),
  z.object({ kind: z.literal("stock"), product_id: z.string().min(1, "الصنف مطلوب"), quantity: num("الكمية", { dp: 3 }), unit_cost: num("تكلفة الوحدة", { dp: 4 }), location_id: z.string().optional(), expiry_date: isoDate("تاريخ الانتهاء").optional() }),
  z.object({
    kind: z.literal("asset"), category_id: z.string().min(1, "فئة الأصل مطلوبة"), name: z.string().min(1, "اسم الأصل مطلوب").max(200), cost: num("التكلفة الأصلية"), accumulated: num("مجمع الإهلاك", { allowZero: true }),
    acquisition_date: isoDate("تاريخ الشراء"), in_service_date: isoDate("تاريخ التشغيل"), useful_life_months: z.number().int().min(1).max(1200).optional(), residual_value: num("القيمة المتبقية", { allowZero: true }).optional(),
    months_used: z.number().int().min(0).max(1200).optional(), serial_number: optText("الرقم التسلسلي", 100).optional(), plate_number: optText("رقم اللوحة", 50).optional(), location: optText("المكان", 200).optional(),
  }),
]);
type LineInput = z.infer<typeof lineInput>;

type Effect = { debit: Prisma.Decimal; credit: Prisma.Decimal; accounts: { accountId: string; amount: Prisma.Decimal }[] };

/** One line checked on its own; returns its effect on the opening trial balance (signed per account). */
async function lineEffect(db: Tx | typeof prisma, l: LineInput, batch: { kind: string; cutoverDate: string }): Promise<Effect> {
  if (batch.kind === "correction" && (l.kind === "stock" || l.kind === "asset")) throw new ApiError(400, "دفعة التصحيح فيها أرصدة حسابات وعملاء وموردين بس — المخزون بتسوية مخزون والأصول من سجل الأصول");
  if (l.kind === "gl") {
    const debit = l.debit ?? D(0), credit = l.credit ?? D(0);
    if (debit.gt(0) === credit.gt(0)) throw new ApiError(400, "سطر الحساب يا مدين يا دائن (مش الاتنين ولا صفر)");
    const a = await db.account.findUnique({ where: { id: l.account_id } });
    if (!a) throw new ApiError(404, "الحساب مش موجود");
    if (!a.postable || !a.active) throw new ApiError(400, `الحساب ${a.code} رئيسي أو موقوف`);
    if (a.systemKey === "opening_equity") throw new ApiError(400, "حساب الأرصدة الافتتاحية بيتقفل لوحده — حدد رأس المال والأرباح المحتجزة بدل منه");
    const via = controlAccountMovedBy(a.systemKey, a.controlledBy);
    if (via) throw new ApiError(400, `الحساب ${a.code} (${a.nameAr}) بيجي من سطور العملاء/الموردين/المخزون/الأصول مش رصيد مباشر`);
    return { debit, credit, accounts: [{ accountId: a.id, amount: debit.minus(credit) }] };
  }
  if (l.kind === "customer" || l.kind === "supplier") {
    const party = l.kind === "customer" ? await db.customer.findUnique({ where: { id: l.party_id }, select: { id: true } }) : await db.supplier.findUnique({ where: { id: l.party_id }, select: { id: true } });
    if (!party) throw new ApiError(404, l.kind === "customer" ? "العميل مش موجود" : "المورد مش موجود");
    const key = l.kind === "customer" ? "ar" : "ap";
    const acc = await db.account.findUniqueOrThrow({ where: { systemKey: key } });
    // Customer: positive = they owe us (debit AR). Supplier: positive = we owe them (credit AP).
    const signed = l.kind === "customer" ? l.amount : l.amount.negated();
    return { debit: signed.gt(0) ? signed : D(0), credit: signed.lt(0) ? signed.negated() : D(0), accounts: [{ accountId: acc.id, amount: signed }] };
  }
  if (l.kind === "stock") {
    const p = await db.stockProduct.findUnique({ where: { id: l.product_id }, select: { id: true, active: true, name: true } });
    if (!p?.active) throw new ApiError(404, "الصنف مش موجود أو موقوف");
    if (l.expiry_date && l.expiry_date < batch.cutoverDate) throw new ApiError(400, `"${p.name}": دفعة منتهية الصلاحية قبل تاريخ الافتتاح — مش رصيد`);
    // Valued as the stock ledger values it (4 places per movement); the batch total is rounded
    // once to cents, the way the inventory posting rounds the document's value.
    const value = q4(l.quantity.times(l.unit_cost));
    const inv = await db.account.findUniqueOrThrow({ where: { systemKey: "inventory" } });
    return { debit: value, credit: D(0), accounts: [{ accountId: inv.id, amount: value }] };
  }
  const c = await db.assetCategory.findUnique({ where: { id: l.category_id } });
  if (!c?.active) throw new ApiError(404, "فئة الأصل مش موجودة أو موقوفة");
  if (l.accumulated.greaterThan(l.cost)) throw new ApiError(400, `${l.name}: مجمع الإهلاك أكبر من التكلفة`);
  if (l.accumulated.gt(0) && !c.depreciable) throw new ApiError(400, `${l.name}: فئة ${c.nameAr} مش بتتهلك`);
  if (l.in_service_date < l.acquisition_date) throw new ApiError(400, `${l.name}: تاريخ التشغيل قبل تاريخ الشراء`);
  if (l.in_service_date > batch.cutoverDate) throw new ApiError(400, `${l.name}: تاريخ التشغيل بعد تاريخ الافتتاح — يتسجل كأصل جديد مش رصيد`);
  if (l.residual_value && l.residual_value.greaterThan(l.cost.minus(l.accumulated))) throw new ApiError(400, `${l.name}: القيمة المتبقية أكبر من القيمة الدفترية`);
  return {
    debit: l.cost, credit: l.accumulated,
    accounts: [{ accountId: c.assetAccountId, amount: l.cost }, ...(l.accumulated.gt(0) ? [{ accountId: c.accumulatedAccountId!, amount: l.accumulated.negated() }] : [])],
  };
}

async function initialPosted(db: Tx | typeof prisma) {
  return db.openingBatch.findFirst({ where: { kind: "initial", status: "posted" }, select: { id: true, number: true, cutoverDate: true } });
}

/** The direct opening forms (customer/supplier balance, opening stock) close once the initial batch has posted. */
export async function assertNoOpeningBatchPosted(db: Tx | typeof prisma) {
  const b = await initialPosted(db);
  if (b) throw new ApiError(409, `الأرصدة الافتتاحية اتقفلت بدفعة ${b.number} — أي تعديل بدفعة تصحيح معتمدة`);
}

const audit = (tx: Tx, actor: { id: string | null; name: string; role: string; deviceId?: string }, id: string, action: string, detail: string, reason?: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType: "opening_batch", entityId: id, newValue: detail, reason, source: "user", deviceId: actor.deviceId }, tx);

export async function createBatch(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ kind: z.enum(["initial", "correction"]).default("initial"), cutover_date: isoDate("تاريخ الافتتاح").optional(), notes: optText("ملاحظات", 1000).optional(), idempotency_key: idempotencyKeyField }), input);
  return inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.openingBatch.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) return prev;
    }
    await advisoryXactLock(tx, "accounting:opening-batch");
    const initial = await initialPosted(tx);
    let cutover: string;
    if (v.kind === "initial") {
      if (initial) throw new ApiError(409, `الأرصدة الافتتاحية اترحّلت بالفعل (${initial.number}) — اعمل دفعة تصحيح`);
      if (!v.cutover_date) throw new ApiError(400, "حدد تاريخ الافتتاح (آخر يوم قبل التشغيل على النظام)");
      const open = await tx.openingBatch.findFirst({ where: { kind: "initial", status: { in: ["draft", "pending_approval"] } }, select: { number: true } });
      if (open) throw new ApiError(409, `فيه دفعة افتتاحية لسه مفتوحة (${open.number}) — كمّلها أو الغيها`);
      cutover = v.cutover_date;
    } else {
      if (!initial) throw new ApiError(409, "مفيش دفعة افتتاحية مترحّلة لسه — دفعة التصحيح بتيجي بعدها");
      cutover = initial.cutoverDate;
    }
    const b = await tx.openingBatch.create({ data: { number: await nextDocumentNumber(tx, "accounting.opening_batch", cutover), kind: v.kind, cutoverDate: cutover, notes: v.notes ?? null, idempotencyKey: v.idempotency_key ?? null, createdById: actor.id, createdBy: actor.name } });
    await audit(tx, actor, b.id, "opening_batch_created", `${b.number} · ${v.kind} · ${cutover}`);
    return b;
  });
}

/** Adds lines to a draft batch (each validated; a bad line refuses the whole call). */
export async function addLines(batchId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ lines: z.array(lineInput).min(1, "مفيش سطور").max(2000, "أقصى 2000 سطر في المرة") }), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `accounting:opening-batch:${batchId}`);
    const b = await tx.openingBatch.findUnique({ where: { id: batchId } });
    if (!b) throw new ApiError(404, "الدفعة مش موجودة");
    if (b.status !== "draft") throw new ApiError(409, "الدفعة اتبعتت للاعتماد — السطور مقفولة");
    const last = await tx.openingBatchLine.aggregate({ where: { batchId }, _max: { lineNo: true } });
    let lineNo = last._max.lineNo ?? 0;
    const rows: Prisma.OpeningBatchLineCreateManyInput[] = [];
    for (const [i, l] of v.lines.entries()) {
      let e: Effect;
      try { e = await lineEffect(tx, l, b); } catch (err) { if (err instanceof ApiError) throw new ApiError(err.status, `سطر ${i + 1}: ${err.message}`); throw err; }
      rows.push({ batchId, lineNo: ++lineNo, kind: l.kind, data: JSON.parse(JSON.stringify(l)) as Prisma.InputJsonValue, debit: e.debit, credit: e.credit });
    }
    await tx.openingBatchLine.createMany({ data: rows });
    await audit(tx, actor, b.id, "opening_batch_lines_added", `${b.number} · ${rows.length} سطر`);
    return { added: rows.length };
  });
}

export async function removeLine(batchId: string, lineId: string, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  return inTx(async (tx) => {
    const l = await tx.openingBatchLine.findUnique({ where: { id: lineId }, include: { batch: true } });
    if (!l || l.batchId !== batchId) throw new ApiError(404, "السطر مش موجود");
    if (l.batch.status !== "draft") throw new ApiError(409, "الدفعة اتبعتت للاعتماد — السطور مقفولة");
    await tx.openingBatchLine.delete({ where: { id: lineId } });
    await audit(tx, actor, batchId, "opening_batch_line_removed", `${l.batch.number} · سطر ${l.lineNo}`);
    return { removed: 1 };
  });
}

/** The batch as an opening trial balance: per account, totals, what is left in opening equity, and what blocks it. */
export async function validateBatch(id: string, db: Tx | typeof prisma = prisma) {
  const b = await db.openingBatch.findUnique({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!b) throw new ApiError(404, "الدفعة مش موجودة");
  const byAccount = new Map<string, Prisma.Decimal>();
  const lineProblems: { lineNo: number; message: string }[] = [];
  const subledgers = { customers: D(0), suppliers: D(0), stock: D(0), assetsCost: D(0), assetsAccumulated: D(0), gl: D(0) };
  for (const l of b.lines) {
    try {
      const input = lineInput.parse(l.data);
      const e = await lineEffect(db, input, b);
      for (const a of e.accounts) byAccount.set(a.accountId, (byAccount.get(a.accountId) ?? D(0)).plus(a.amount));
      if (input.kind === "customer") subledgers.customers = subledgers.customers.plus(input.amount);
      else if (input.kind === "supplier") subledgers.suppliers = subledgers.suppliers.plus(input.amount);
      else if (input.kind === "stock") subledgers.stock = subledgers.stock.plus(e.debit);
      else if (input.kind === "asset") { subledgers.assetsCost = subledgers.assetsCost.plus(input.cost); subledgers.assetsAccumulated = subledgers.assetsAccumulated.plus(input.accumulated); }
      else subledgers.gl = subledgers.gl.plus(e.debit).minus(e.credit);
    } catch (err) {
      lineProblems.push({ lineNo: l.lineNo, message: err instanceof ApiError ? err.message : String(err) });
    }
  }
  const accounts = await db.account.findMany({ where: { id: { in: [...byAccount.keys()] } }, select: { id: true, code: true, name: true, nameAr: true, type: true } });
  const tb = accounts.map((a) => { const v = r2(byAccount.get(a.id)!); return { account: a, debit: v.gt(0) ? v.toFixed(2) : "0.00", credit: v.lt(0) ? v.negated().toFixed(2) : "0.00" }; }).sort((x, y) => x.account.code.localeCompare(y.account.code));
  const debit = tb.reduce((s, r) => s.plus(r.debit), D(0));
  const credit = tb.reduce((s, r) => s.plus(r.credit), D(0));
  const residual = debit.minus(credit);
  const problems: { code: string; params?: Record<string, string> }[] = [];
  if (!b.lines.length) problems.push({ code: "empty" });
  if (lineProblems.length) problems.push({ code: "bad_lines", params: { n: String(lineProblems.length) } });
  if (!residual.isZero()) problems.push({ code: "unbalanced", params: { difference: residual.toFixed(2) } });
  const period = await db.accountingPeriod.findUnique({ where: { code: b.cutoverDate.slice(0, 7) }, select: { status: true } });
  if (period?.status === "closed") problems.push({ code: "period_closed", params: { period: b.cutoverDate.slice(0, 7) } });
  if (b.kind === "initial" && (await initialPosted(db))) problems.push({ code: "initial_posted" });
  const warnings: { code: string; params?: Record<string, string> }[] = [];
  const direct = await db.partyOpeningBalance.count();
  if (b.kind === "initial" && direct) warnings.push({ code: "direct_openings_exist", params: { n: String(direct) } });
  return {
    id: b.id, number: b.number, kind: b.kind, cutoverDate: b.cutoverDate, status: b.status,
    trialBalance: tb, totals: { debit: debit.toFixed(2), credit: credit.toFixed(2), residual: residual.toFixed(2) },
    subledgers: Object.fromEntries(Object.entries(subledgers).map(([k, v]) => [k, v.toFixed(2)])),
    lineProblems, problems, warnings, lineCount: b.lines.length,
  };
}

export async function submitBatch(id: string, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `accounting:opening-batch:${id}`);
    const b = await tx.openingBatch.findUnique({ where: { id } });
    if (!b) throw new ApiError(404, "الدفعة مش موجودة");
    if (b.status !== "draft") throw new ApiError(409, "الدفعة مش مسودة");
    const v = await validateBatch(id, tx);
    if (v.problems.length) throw new ApiError(409, `الدفعة مش جاهزة: ${v.problems.map((p) => p.code === "unbalanced" ? `الميزان مش متوازن (فرق ${p.params!.difference})` : p.code === "bad_lines" ? `${p.params!.n} سطر فيه خطأ` : p.code === "empty" ? "مفيش سطور" : p.code === "period_closed" ? `الفترة ${p.params!.period} مقفولة` : "الأرصدة الافتتاحية اترحّلت بالفعل").join("، ")}`);
    await tx.openingBatch.update({ where: { id, version: b.version }, data: { status: "pending_approval", submittedById: actor.id, submittedBy: actor.name, submittedAt: new Date(), version: { increment: 1 } } });
    await requestApproval(tx, { type: "accounting.opening_batch", entityId: id, title: `أرصدة افتتاحية ${b.number} (${b.cutoverDate})`, summary: `${v.lineCount} سطر · مدين ${v.totals.debit} = دائن ${v.totals.credit}`, amount: v.totals.debit, requester: actor });
    await audit(tx, actor, id, "opening_batch_submitted", `${b.number} · ${v.lineCount} سطر · ${v.totals.debit}`);
    return tx.openingBatch.findUniqueOrThrow({ where: { id } });
  });
}

export async function cancelBatch(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ reason: z.string().min(3, "اكتب السبب").max(500) }), input);
  return inTx(async (tx) => {
    const b = await tx.openingBatch.findUnique({ where: { id } });
    if (!b) throw new ApiError(404, "الدفعة مش موجودة");
    if (b.status === "posted" || b.status === "cancelled") throw new ApiError(409, "الدفعة مترحّلة أو ملغية");
    if (b.status === "pending_approval") await cancelPendingApproval(tx, { type: "accounting.opening_batch", entityId: id, reason: v.reason, actor });
    const updated = await tx.openingBatch.update({ where: { id, version: b.version }, data: { status: "cancelled", decisionNote: v.reason, version: { increment: 1 } } });
    await audit(tx, actor, id, "opening_batch_cancelled", b.number, v.reason);
    return updated;
  });
}

/** Approval handler: posts the whole batch once (approved by neither its preparer nor its submitter), or returns it to draft. */
export async function applyOpeningBatchDecision(tx: Tx, id: string, approved: boolean, decider: Decider, comment?: string) {
  await advisoryXactLock(tx, `accounting:opening-batch:${id}`);
  await advisoryXactLock(tx, "accounting:opening-batch");
  const b = await tx.openingBatch.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (b.status !== "pending_approval") throw new ApiError(409, "الدفعة مش مستنية اعتماد");
  if ((b.submittedById && b.submittedById === decider.id) || (b.createdById && b.createdById === decider.id)) throw new ApiError(403, "اللي جهّز الدفعة أو بعتها مينفعش يعتمدها");
  if (!approved) {
    await tx.openingBatch.update({ where: { id, version: b.version }, data: { status: "draft", decidedBy: decider.name, decidedAt: new Date(), decisionNote: comment ?? null, version: { increment: 1 } } });
    await audit(tx, decider, id, "opening_batch_rejected", b.number, comment);
    return;
  }
  const v = await validateBatch(id, tx);
  if (v.problems.length) throw new ApiError(409, "الدفعة اتغيّر عليها حاجة من وقت ما اتبعتت (حسابات أو أصناف موقوفة، فترة مقفولة) — ارفضها وراجعها");
  const actor = { id: decider.id, name: decider.name, role: decider.role, deviceId: decider.deviceId, permissions: decider.permissions } as ServiceActor;
  const date = b.cutoverDate;
  const entryIds: string[] = [];
  const parsed = b.lines.map((l) => ({ line: l, input: lineInput.parse(l.data) }));
  // 1. GL balances: one entry against opening equity.
  const glLines: PostLine[] = [];
  for (const { input } of parsed) if (input.kind === "gl") glLines.push({ accountId: input.account_id, amount: (input.debit ?? D(0)).minus(input.credit ?? D(0)), description: input.description ?? undefined });
  if (glLines.length) {
    const net = glLines.reduce((s, l) => s.plus(l.amount), D(0));
    const e = await postJournal(tx, { date, description: `أرصدة افتتاحية ${b.number} — الحسابات`, sourceType: "opening_batch", sourceId: `${b.id}:gl`, lines: [...glLines, { key: "opening_equity", amount: net.negated() }] }, actor);
    if (e) entryIds.push(e.id);
  }
  // 2. Customers' and suppliers' open items (statements and aging read them).
  const { postPartyOpeningInTx } = await import("@/lib/accounting/integrity");
  for (const { input, line } of parsed) {
    if (input.kind !== "customer" && input.kind !== "supplier") continue;
    await postPartyOpeningInTx(tx, { partyType: input.kind, partyId: input.party_id, date, dueDate: input.due_date ?? date, amount: input.amount, reference: input.reference ?? `${b.number}#${line.lineNo}` }, actor);
  }
  // 3. Stock, through the stock ledger (lots at the given cost; valued against opening equity).
  const stock = parsed.filter((p) => p.input.kind === "stock").map((p) => p.input as Extract<LineInput, { kind: "stock" }>);
  if (stock.length) {
    const { postOpeningStockInTx } = await import("@/lib/inventory/documents");
    await postOpeningStockInTx(tx, { date, lines: stock.map((s) => ({ product_id: s.product_id, quantity: s.quantity.toString(), unit_cost: s.unit_cost.toString(), ...(s.location_id ? { location_id: s.location_id } : {}), ...(s.expiry_date ? { expiry_date: s.expiry_date } : {}) })) }, actor);
  }
  // 4. Fixed assets with their history; one entry for the batch.
  const assets = parsed.filter((p) => p.input.kind === "asset");
  if (assets.length) {
    const { createOpeningAsset } = await import("@/lib/accounting/fixed-assets");
    const byAccount = new Map<string, Prisma.Decimal>();
    for (const { input, line } of assets) {
      const a = input as Extract<LineInput, { kind: "asset" }>;
      const { category } = await createOpeningAsset(tx, { categoryId: a.category_id, name: a.name, cost: a.cost, accumulated: a.accumulated, acquisitionDate: a.acquisition_date, inServiceDate: a.in_service_date, usefulLifeMonths: a.useful_life_months ?? null, residualValue: a.residual_value ?? null, monthsUsed: a.months_used ?? null, cutoverDate: date, sourceId: line.id, serialNumber: a.serial_number ?? null, plateNumber: a.plate_number ?? null, location: a.location ?? null }, actor);
      byAccount.set(category.assetAccountId, (byAccount.get(category.assetAccountId) ?? D(0)).plus(a.cost));
      if (a.accumulated.gt(0)) byAccount.set(category.accumulatedAccountId!, (byAccount.get(category.accumulatedAccountId!) ?? D(0)).minus(a.accumulated));
    }
    const lines: PostLine[] = [...byAccount].map(([accountId, amount]) => ({ accountId, amount }));
    const net = lines.reduce((s, l) => s.plus(l.amount), D(0));
    const e = await postJournal(tx, { date, description: `أرصدة افتتاحية ${b.number} — الأصول الثابتة`, sourceType: "opening_batch", sourceId: `${b.id}:assets`, lines: [...lines, { key: "opening_equity", amount: net.negated() }] }, actor);
    if (e) entryIds.push(e.id);
  }
  await tx.openingBatch.update({ where: { id, version: b.version }, data: { status: "posted", postedAt: new Date(), decidedBy: decider.name, decidedAt: new Date(), decisionNote: comment ?? null, entryIds, version: { increment: 1 } } });
  await audit(tx, decider, id, "opening_batch_posted", `${b.number} · ${b.lines.length} سطر · ${v.totals.debit}`);
}

export async function listBatches() {
  const rows = await prisma.openingBatch.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { _count: { select: { lines: true } } } });
  return rows;
}

export async function getBatch(id: string) {
  const b = await prisma.openingBatch.findUnique({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!b) throw new ApiError(404, "الدفعة مش موجودة");
  const validation = await validateBatch(id);
  return { ...b, lines: b.lines.map((l) => ({ ...l, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2) })), validation };
}
