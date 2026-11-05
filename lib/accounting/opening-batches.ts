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
 *
 * Phased opening migration (Nov 2026, lib/accounting/opening-migration.ts). When the complete
 * legacy trial balance is not known at go-live, the opening position is entered in phases instead
 * of one initial batch: a "phase" batch per segment — suppliers, customers, other (GL balances,
 * stock, assets, and the transfer of opening-balance equity) — each approved by a second person
 * and posted against the provisional clearing account 3900 (opening_clearing). A phase batch
 * need not balance on its own: what it leaves is its movement on the clearing account, traced to
 * it. The migration closes only when the clearing account is back to zero (opening-migration.ts).
 * Lines carry their source evidence (file, row, name, amount); a source row is posted once.
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

/** Where a line came from (the legacy file, its row, the name and figure written there): evidence, never used to identify a record. */
const source = {
  source_file: optText("ملف المصدر", 200).optional(),
  source_row: optText("صف المصدر", 50).optional(),
  source_name: optText("الاسم في المصدر", 200).optional(),
  source_amount: num("المبلغ في المصدر", { signed: true, allowZero: true }).optional(),
};

const lineInput = z.discriminatedUnion("kind", [
  // Each record can be named by its id or by the code people know it by (account code,
  // customer/supplier code, SKU) — addLines resolves a code to the id that is stored.
  z.object({ kind: z.literal("gl"), account_id: z.string().min(1).optional(), account_code: optText("كود الحساب", 50).optional(), debit: num("مدين", { allowZero: true }).optional(), credit: num("دائن", { allowZero: true }).optional(), description: optText("البيان", 200).optional(), ...source }),
  z.object({ kind: z.literal("customer"), party_id: z.string().min(1).optional(), party_code: optText("كود العميل", 50).optional(), amount: num("المبلغ", { signed: true }), due_date: isoDate("تاريخ الاستحقاق").optional(), reference: optText("المرجع", 100).optional(), ...source }),
  z.object({ kind: z.literal("supplier"), party_id: z.string().min(1).optional(), party_code: optText("كود المورد", 50).optional(), amount: num("المبلغ", { signed: true }), due_date: isoDate("تاريخ الاستحقاق").optional(), reference: optText("المرجع", 100).optional(), ...source }),
  // Phased migration, segment "other": moves the balance of opening-balance equity (3300) —
  // e.g. the opening stock posted directly before batches existed — into the clearing account,
  // so it takes part in the migration's reconciliation. Its amount is the signed effect on 3300
  // (positive = debit) and must zero it; filled in from the ledger when left out.
  z.object({ kind: z.literal("equity_transfer"), amount: num("المبلغ", { signed: true }).optional(), description: optText("البيان", 200).optional() }),
  z.object({ kind: z.literal("stock"), product_id: z.string().min(1).optional(), sku: optText("كود الصنف", 50).optional(), quantity: num("الكمية", { dp: 3 }), unit_cost: num("تكلفة الوحدة", { dp: 4 }), location_id: z.string().optional(), expiry_date: isoDate("تاريخ الانتهاء").optional() }),
  z.object({
    kind: z.literal("asset"), category_id: z.string().min(1, "فئة الأصل مطلوبة"), name: z.string().min(1, "اسم الأصل مطلوب").max(200), cost: num("التكلفة الأصلية"), accumulated: num("مجمع الإهلاك", { allowZero: true }),
    acquisition_date: isoDate("تاريخ الشراء"), in_service_date: isoDate("تاريخ التشغيل"), useful_life_months: z.number().int().min(1).max(1200).optional(), residual_value: num("القيمة المتبقية", { allowZero: true }).optional(),
    months_used: z.number().int().min(0).max(1200).optional(), serial_number: optText("الرقم التسلسلي", 100).optional(), plate_number: optText("رقم اللوحة", 50).optional(), location: optText("المكان", 200).optional(),
  }),
]);
export type LineInput = z.infer<typeof lineInput>;

type Effect = { debit: Prisma.Decimal; credit: Prisma.Decimal; accounts: { accountId: string; amount: Prisma.Decimal }[] };
type BatchShape = { kind: string; cutoverDate: string; segment?: string | null };

/** What each segment of the phased migration holds. */
export const SEGMENT_KINDS: Record<string, readonly string[]> = {
  suppliers: ["supplier"],
  customers: ["customer"],
  other: ["gl", "stock", "asset", "equity_transfer"],
};
const SEGMENT_REFUSAL: Record<string, string> = {
  suppliers: "دفعة الموردين فيها أرصدة موردين بس",
  customers: "دفعة العملاء فيها أرصدة عملاء بس",
  other: "دفعة الأرصدة الأخرى فيها حسابات ومخزون وأصول وتحويل الأرصدة الافتتاحية بس — العملاء والموردين في دفعاتهم",
};

/** The balance of an account by system key (signed: debit positive). */
async function keyBalance(db: Tx | typeof prisma, systemKey: string) {
  const r = await db.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT sum(l."debit" - l."credit") AS v FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = ${systemKey}`;
  return D(r[0]?.v);
}

/**
 * The records a batch's lines name, read once for the whole batch instead of once per line
 * (Nov 2026: a 120-line customers batch spent two round trips per line here, inside the
 * approval's transaction). Same reads, same answers: a party or GL account preloaded is what
 * findUnique would have returned at that point of the transaction; anything not preloaded is
 * read on first use and kept for the rest of the call. Lives for one call, never across calls.
 */
type GlAccount = { id: string; code: string; nameAr: string; postable: boolean; active: boolean; systemKey: string | null; controlledBy: string | null };
type Lookups = {
  account(systemKey: string): Promise<{ id: string }>;
  glAccount(id: string): Promise<GlAccount | null>;
  partyExists(kind: "customer" | "supplier", id: string): Promise<boolean>;
  /** The id a code names (account code, customer/supplier code), or null. */
  byCode(kind: "gl" | "customer" | "supplier", code: string): Promise<string | null>;
};

const glSelect = { id: true, code: true, nameAr: true, postable: true, active: true, systemKey: true, controlledBy: true } as const;

async function lookups(db: Tx | typeof prisma, lines: LineInput[] = []): Promise<Lookups> {
  const bySystemKey = new Map<string, { id: string }>();
  const gl = new Map<string, GlAccount | null>();
  const parties = new Map<string, boolean>();
  const codes = new Map<string, string | null>();
  const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  const of = (kind: "customer" | "supplier", field: "party_id" | "party_code") => uniq(lines.map((l) => (l.kind === kind ? l[field] : null)));
  for (const kind of ["customer", "supplier"] as const) {
    const ids = of(kind, "party_id"), byCode = of(kind, "party_code");
    if (!ids.length && !byCode.length) continue;
    const where = { OR: [...(ids.length ? [{ id: { in: ids } }] : []), ...(byCode.length ? [{ code: { in: byCode } }] : [])] };
    const found = kind === "customer" ? await db.customer.findMany({ where, select: { id: true, code: true } }) : await db.supplier.findMany({ where, select: { id: true, code: true } });
    for (const id of ids) parties.set(`${kind}:${id}`, found.some((p) => p.id === id));
    for (const code of byCode) codes.set(`${kind}:${code}`, found.find((p) => p.code === code)?.id ?? null);
    for (const p of found) parties.set(`${kind}:${p.id}`, true);
  }
  const glIds = uniq(lines.map((l) => (l.kind === "gl" ? l.account_id : null))), glCodes = uniq(lines.map((l) => (l.kind === "gl" ? l.account_code : null)));
  if (glIds.length || glCodes.length) {
    const found = await db.account.findMany({ where: { OR: [...(glIds.length ? [{ id: { in: glIds } }] : []), ...(glCodes.length ? [{ code: { in: glCodes } }] : [])] }, select: glSelect });
    for (const id of glIds) gl.set(id, found.find((a) => a.id === id) ?? null);
    for (const code of glCodes) codes.set(`gl:${code}`, found.find((a) => a.code === code)?.id ?? null);
    for (const a of found) gl.set(a.id, a);
  }
  if (lines.some((l) => l.kind === "customer" || l.kind === "supplier")) {
    for (const a of await db.account.findMany({ where: { systemKey: { in: ["ar", "ap"] } }, select: { id: true, systemKey: true } })) bySystemKey.set(a.systemKey!, { id: a.id });
  }
  return {
    async byCode(kind, code) {
      const k = `${kind}:${code}`;
      if (!codes.has(k)) {
        const r = kind === "gl" ? await db.account.findUnique({ where: { code }, select: { id: true } }) : kind === "customer" ? await db.customer.findUnique({ where: { code }, select: { id: true } }) : await db.supplier.findUnique({ where: { code }, select: { id: true } });
        codes.set(k, r?.id ?? null);
      }
      return codes.get(k)!;
    },
    async account(systemKey) {
      let a = bySystemKey.get(systemKey);
      if (!a) { a = await db.account.findUniqueOrThrow({ where: { systemKey }, select: { id: true } }); bySystemKey.set(systemKey, a); }
      return a;
    },
    async glAccount(id) {
      if (!gl.has(id)) gl.set(id, await db.account.findUnique({ where: { id }, select: glSelect }));
      return gl.get(id)!;
    },
    async partyExists(kind, id) {
      const k = `${kind}:${id}`;
      if (!parties.has(k)) parties.set(k, !!(kind === "customer" ? await db.customer.findUnique({ where: { id }, select: { id: true } }) : await db.supplier.findUnique({ where: { id }, select: { id: true } })));
      return parties.get(k)!;
    },
  };
}

/** One line checked on its own; returns its effect on the opening trial balance (signed per account). */
async function lineEffect(db: Tx | typeof prisma, l: LineInput, batch: BatchShape, look: Lookups): Promise<Effect> {
  if (batch.kind === "phase" && !(SEGMENT_KINDS[batch.segment ?? ""] ?? []).includes(l.kind)) throw new ApiError(400, SEGMENT_REFUSAL[batch.segment ?? ""] ?? "قسم الدفعة مش معروف");
  if (batch.kind !== "phase" && l.kind === "equity_transfer") throw new ApiError(400, "تحويل الأرصدة الافتتاحية للحساب الوسيط بيتعمل في دفعة \"أرصدة أخرى\" من الترحيل الافتتاحي المرحلي بس");
  if (batch.kind === "correction" && (l.kind === "stock" || l.kind === "asset")) throw new ApiError(400, "دفعة التصحيح فيها أرصدة حسابات وعملاء وموردين بس — المخزون بتسوية مخزون والأصول من سجل الأصول");
  if (l.kind === "equity_transfer") {
    // It must leave opening-balance equity at zero: the amount is what 3300 holds now, reversed.
    const due = (await keyBalance(db, "opening_equity")).negated();
    if (due.isZero()) throw new ApiError(400, "حساب الأرصدة الافتتاحية (3300) رصيده صفر — مفيش حاجة تتحوّل");
    if (!l.amount || !l.amount.equals(due)) throw new ApiError(400, `مبلغ التحويل لازم يصفّر حساب الأرصدة الافتتاحية (3300): ${due.toFixed(2)} — الرصيد اتغيّر، امسح السطر وضيفه تاني`);
    const acc = await look.account("opening_equity");
    return { debit: due.gt(0) ? due : D(0), credit: due.lt(0) ? due.negated() : D(0), accounts: [{ accountId: acc.id, amount: due }] };
  }
  if (l.kind === "gl") {
    const debit = l.debit ?? D(0), credit = l.credit ?? D(0);
    if (debit.gt(0) === credit.gt(0)) throw new ApiError(400, "سطر الحساب يا مدين يا دائن (مش الاتنين ولا صفر)");
    if (!l.account_id) throw new ApiError(400, "الحساب مطلوب");
    const a = await look.glAccount(l.account_id);
    if (!a) throw new ApiError(404, "الحساب مش موجود");
    if (!a.postable || !a.active) throw new ApiError(400, `الحساب ${a.code} رئيسي أو موقوف`);
    if (a.systemKey === "opening_equity") throw new ApiError(400, "حساب الأرصدة الافتتاحية بيتقفل لوحده — حدد رأس المال والأرباح المحتجزة بدل منه");
    const via = controlAccountMovedBy(a.systemKey, a.controlledBy);
    if (via) throw new ApiError(400, `الحساب ${a.code} (${a.nameAr}) بيجي من سطور العملاء/الموردين/المخزون/الأصول مش رصيد مباشر`);
    return { debit, credit, accounts: [{ accountId: a.id, amount: debit.minus(credit) }] };
  }
  if (l.kind === "customer" || l.kind === "supplier") {
    if (!l.party_id) throw new ApiError(400, l.kind === "customer" ? "العميل مطلوب" : "المورد مطلوب");
    if (!(await look.partyExists(l.kind, l.party_id))) throw new ApiError(404, l.kind === "customer" ? "العميل مش موجود" : "المورد مش موجود");
    const acc = await look.account(l.kind === "customer" ? "ar" : "ap");
    // Customer: positive = they owe us (debit AR). Supplier: positive = we owe them (credit AP).
    const signed = l.kind === "customer" ? l.amount : l.amount.negated();
    return { debit: signed.gt(0) ? signed : D(0), credit: signed.lt(0) ? signed.negated() : D(0), accounts: [{ accountId: acc.id, amount: signed }] };
  }
  if (l.kind === "stock") {
    if (!l.product_id) throw new ApiError(400, "الصنف مطلوب");
    const p = await db.stockProduct.findUnique({ where: { id: l.product_id }, select: { id: true, active: true, name: true, costingMethod: true, standardCost: true } });
    if (!p?.active) throw new ApiError(404, "الصنف مش موجود أو موقوف");
    // ACC-20: what the approver signs must be what posts (a standard product posts at its standard).
    const { assertOpeningCostIsStandard } = await import("@/lib/inventory/documents");
    assertOpeningCostIsStandard(p, l.unit_cost);
    if (l.expiry_date && l.expiry_date < batch.cutoverDate) throw new ApiError(400, `"${p.name}": دفعة منتهية الصلاحية قبل تاريخ الافتتاح — مش رصيد`);
    // Valued as the stock ledger values it (4 places per movement); the batch total is rounded
    // once to cents, the way the inventory posting rounds the document's value.
    const value = q4(l.quantity.times(l.unit_cost));
    const inv = await look.account("inventory");
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

/** A line named by code gets the id it stands for; an unknown code refuses the line. */
async function resolveCodes(db: Tx, l: LineInput, look: Lookups): Promise<LineInput> {
  if (l.kind === "gl" && !l.account_id && l.account_code) {
    const id = await look.byCode("gl", l.account_code);
    if (!id) throw new ApiError(404, `مفيش حساب بالكود ${l.account_code}`);
    return { ...l, account_id: id };
  }
  if ((l.kind === "customer" || l.kind === "supplier") && !l.party_id && l.party_code) {
    const id = await look.byCode(l.kind, l.party_code);
    if (!id) throw new ApiError(404, l.kind === "customer" ? `مفيش عميل بالكود ${l.party_code}` : `مفيش مورد بالكود ${l.party_code}`);
    return { ...l, party_id: id };
  }
  if (l.kind === "stock" && !l.product_id && l.sku) {
    const p = await db.stockProduct.findUnique({ where: { sku: l.sku }, select: { id: true } });
    if (!p) throw new ApiError(404, `مفيش صنف بالكود ${l.sku}`);
    return { ...l, product_id: p.id };
  }
  // The transfer's amount is read from the ledger when not given (lineEffect checks it either way).
  if (l.kind === "equity_transfer" && !l.amount) {
    const due = (await keyBalance(db, "opening_equity")).negated();
    return due.isZero() ? l : { ...l, amount: due };
  }
  return l;
}

/** What makes two lines the same entry: the same record and the same figures. */
function lineIdentity(l: LineInput): { party: string | null; same: string } {
  const s = (v: unknown) => (v == null ? "" : String(v));
  if (l.kind === "customer" || l.kind === "supplier") return { party: `${l.kind}:${l.party_id}`, same: [l.kind, l.party_id, s(l.amount), s(l.due_date), s(l.reference)].join("|") };
  // Two transfers of the same balance would move it twice: refused like a repeated party line.
  if (l.kind === "equity_transfer") return { party: "equity_transfer", same: ["equity_transfer", s(l.amount)].join("|") };
  if (l.kind === "gl") return { party: null, same: ["gl", l.account_id, s(l.debit), s(l.credit), s(l.description)].join("|") };
  if (l.kind === "stock") return { party: null, same: ["stock", l.product_id, s(l.quantity), s(l.unit_cost), s(l.location_id), s(l.expiry_date)].join("|") };
  return { party: null, same: ["asset", l.category_id, l.name, s(l.cost), s(l.accumulated), s(l.serial_number), s(l.plate_number)].join("|") };
}

async function initialPosted(db: Tx | typeof prisma) {
  return db.openingBatch.findFirst({ where: { kind: "initial", status: "posted" }, select: { id: true, number: true, cutoverDate: true } });
}

/** The direct opening forms (customer/supplier balance, opening stock) close once the initial batch has posted, or once the phased migration has started (its balances go through its batches). */
export async function assertNoOpeningBatchPosted(db: Tx | typeof prisma) {
  const b = await initialPosted(db);
  if (b) throw new ApiError(409, `الأرصدة الافتتاحية اتقفلت بدفعة ${b.number} — أي تعديل بدفعة تصحيح معتمدة`);
  const m = await db.openingMigration.findUnique({ where: { key: "opening" }, select: { status: true } });
  if (m) throw new ApiError(409, "الترحيل الافتتاحي المرحلي شغال — الأرصدة الافتتاحية بتدخل بدفعاته المعتمدة بس (المحاسبة ← الأرصدة الافتتاحية)");
}

const SEGMENTS = ["suppliers", "customers", "other"] as const;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i, "بصمة الملف (SHA-256) لازم 64 حرف hex").transform((x) => x.toLowerCase());

const audit = (tx: Tx, actor: { id: string | null; name: string; role: string; deviceId?: string }, id: string, action: string, detail: string, reason?: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType: "opening_batch", entityId: id, newValue: detail, reason, source: "user", deviceId: actor.deviceId }, tx);

export async function createBatch(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({
    kind: z.enum(["initial", "correction", "phase"]).default("initial"), cutover_date: isoDate("تاريخ الافتتاح").optional(), notes: optText("ملاحظات", 1000).optional(), idempotency_key: idempotencyKeyField,
    segment: z.enum(SEGMENTS, { errorMap: () => ({ message: "حدد قسم الدفعة: موردين أو عملاء أو أرصدة أخرى" }) }).optional(),
    source_file: optText("ملف المصدر", 200).optional(), source_sha256: sha256.optional(),
  }), input);
  return inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.openingBatch.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) return prev;
    }
    await advisoryXactLock(tx, "accounting:opening-batch");
    const initial = await initialPosted(tx);
    const migration = await tx.openingMigration.findUnique({ where: { key: "opening" } });
    if (v.kind !== "phase" && (v.segment || v.source_file || v.source_sha256)) throw new ApiError(400, "القسم وملف المصدر لدفعات الترحيل الافتتاحي المرحلي بس");
    let cutover: string;
    if (v.kind === "initial") {
      if (migration) throw new ApiError(409, "الترحيل الافتتاحي المرحلي بدأ — الأرصدة بتدخل بدفعات مرحلية (موردين، عملاء، أرصدة أخرى) مش بدفعة افتتاحية واحدة");
      if (initial) throw new ApiError(409, `الأرصدة الافتتاحية اترحّلت بالفعل (${initial.number}) — اعمل دفعة تصحيح`);
      if (!v.cutover_date) throw new ApiError(400, "حدد تاريخ الافتتاح (آخر يوم قبل التشغيل على النظام)");
      const open = await tx.openingBatch.findFirst({ where: { kind: "initial", status: { in: ["draft", "pending_approval"] } }, select: { number: true } });
      if (open) throw new ApiError(409, `فيه دفعة افتتاحية لسه مفتوحة (${open.number}) — كمّلها أو الغيها`);
      cutover = v.cutover_date;
    } else if (v.kind === "phase") {
      if (!migration) throw new ApiError(409, "ابدأ الترحيل الافتتاحي المرحلي الأول (تاريخ القطع)");
      if (migration.status !== "open") throw new ApiError(409, migration.status === "closed" ? "الترحيل الافتتاحي اتقفل — أي تعديل بدفعة تصحيح معتمدة" : "طلب قفل الترحيل الافتتاحي مستني الاعتماد — اسحبه الأول لو فيه دفعة لسه");
      if (!v.segment) throw new ApiError(400, "حدد قسم الدفعة: موردين أو عملاء أو أرصدة أخرى");
      if (v.cutover_date && v.cutover_date !== migration.cutoverDate) throw new ApiError(400, `تاريخ الدفعة هو تاريخ القطع بتاع الترحيل (${migration.cutoverDate})`);
      cutover = migration.cutoverDate;
    } else {
      if (!initial && migration?.status !== "closed") throw new ApiError(409, "مفيش دفعة افتتاحية مترحّلة ولا ترحيل افتتاحي مقفول لسه — دفعة التصحيح بتيجي بعدهم");
      cutover = initial?.cutoverDate ?? migration!.cutoverDate;
    }
    const b = await tx.openingBatch.create({
      data: {
        number: await nextDocumentNumber(tx, "accounting.opening_batch", cutover), kind: v.kind, cutoverDate: cutover, notes: v.notes ?? null, idempotencyKey: v.idempotency_key ?? null, createdById: actor.id, createdBy: actor.name,
        ...(v.kind === "phase" ? { migrationId: migration!.id, segment: v.segment, sourceFile: v.source_file ?? null, sourceSha256: v.source_sha256 ?? null } : {}),
      },
    });
    await audit(tx, actor, b.id, "opening_batch_created", `${b.number} · ${v.kind}${b.segment ? `/${b.segment}` : ""} · ${cutover}${b.sourceFile ? ` · ${b.sourceFile}` : ""}`);
    return b;
  });
}

/** Adds lines to a draft batch (each validated; a bad line refuses the whole call). */
export async function addLines(batchId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ lines: z.array(lineInput).min(1, "مفيش سطور").max(2000, "أقصى 2000 سطر في المرة") }), input);
  return inTx((tx) => addLinesInTx(tx, batchId, v.lines, actor));
}

/** A line's source row as one key ("file · row"), or null when it names none. */
export function sourceKey(d: { source_file?: string | null; source_row?: string | null }, batchFile?: string | null): string | null {
  const file = d.source_file ?? batchFile ?? null;
  return file && d.source_row ? `${file} · ${d.source_row}` : null;
}

/** The source rows already taken by the migration's other live batches (draft, pending or posted). */
async function sourceRowsElsewhere(db: Tx | typeof prisma, b: { id: string; migrationId: string | null }) {
  if (!b.migrationId) return new Map<string, string>();
  const lines = await db.openingBatchLine.findMany({ where: { batch: { migrationId: b.migrationId, id: { not: b.id }, status: { not: "cancelled" } } }, select: { data: true, lineNo: true, batch: { select: { number: true, sourceFile: true } } } });
  const taken = new Map<string, string>();
  for (const l of lines) {
    const k = sourceKey(l.data as Record<string, string>, l.batch.sourceFile);
    if (k) taken.set(k, `${l.batch.number}#${l.lineNo}`);
  }
  return taken;
}

/** addLines inside the caller's transaction (the import adds its matched rows through it). */
export async function addLinesInTx(tx: Tx, batchId: string, input: LineInput[], actor: ServiceActor) {
  await advisoryXactLock(tx, `accounting:opening-batch:${batchId}`);
  const b = await tx.openingBatch.findUnique({ where: { id: batchId }, include: { migration: { select: { status: true } } } });
  if (!b) throw new ApiError(404, "الدفعة مش موجودة");
  if (b.status !== "draft") throw new ApiError(409, "الدفعة اتبعتت للاعتماد — السطور مقفولة");
  if (b.kind === "phase" && b.migration?.status !== "open") throw new ApiError(409, "الترحيل الافتتاحي مش مفتوح للإضافة");
  // Two batches of the migration adding the same source row at once must not both pass the check below.
  if (b.migrationId) await advisoryXactLock(tx, "accounting:opening-migration:lines");
  const last = await tx.openingBatchLine.aggregate({ where: { batchId }, _max: { lineNo: true } });
  let lineNo = last._max.lineNo ?? 0;
  // A source row is posted once across the whole migration (two pastes of the same sheet, or the
  // same row in two batches, would count the balance twice).
  const taken = await sourceRowsElsewhere(tx, b);
  const mine = new Map<string, number>();
  for (const l of await tx.openingBatchLine.findMany({ where: { batchId }, select: { data: true, lineNo: true } })) {
    const k = sourceKey(l.data as Record<string, string>, b.sourceFile);
    if (k) mine.set(k, l.lineNo);
  }
  const rows: Prisma.OpeningBatchLineCreateManyInput[] = [];
  const look = await lookups(tx, input);
  for (const [i, l] of input.entries()) {
    let e: Effect, line: LineInput;
    try {
      line = await resolveCodes(tx, l, look);
      e = await lineEffect(tx, line, b, look);
      const k = sourceKey(line as { source_file?: string; source_row?: string }, b.sourceFile);
      if (k && (taken.has(k) || mine.has(k))) throw new ApiError(409, `صف المصدر ${k} اتضاف قبل كده (${taken.get(k) ?? `${b.number}#${mine.get(k)}`})`);
      if (k) mine.set(k, lineNo + 1);
    } catch (err) { if (err instanceof ApiError) throw new ApiError(err.status, `سطر ${i + 1}: ${err.message}`); throw err; }
    rows.push({ batchId, lineNo: ++lineNo, kind: line.kind, data: JSON.parse(JSON.stringify(line)) as Prisma.InputJsonValue, debit: e.debit, credit: e.credit });
  }
  await tx.openingBatchLine.createMany({ data: rows });
  await audit(tx, actor, b.id, "opening_batch_lines_added", `${b.number} · ${rows.length} سطر`);
  return { added: rows.length };
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
  const b = await db.openingBatch.findUnique({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } }, migration: { select: { status: true } } } });
  if (!b) throw new ApiError(404, "الدفعة مش موجودة");
  const byAccount = new Map<string, Prisma.Decimal>();
  const lineProblems: { lineNo: number; message: string }[] = [];
  const subledgers = { customers: D(0), suppliers: D(0), stock: D(0), assetsCost: D(0), assetsAccumulated: D(0), gl: D(0), equityTransfer: D(0) };
  // A customer or supplier line entered twice (a paste repeated, a row copied) would count the
  // balance twice, and two such lines cannot be told apart: refused. Identical account, stock or
  // asset lines can be real (two lots alike) and are only shown. A party on more than one line
  // with different figures is allowed (open items) but shown, since one total per party is the
  // usual way.
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  const alike: string[] = [];
  const partyLines = new Map<string, number>();
  // Phase batches: evidence checks across the migration.
  const taken = b.kind === "phase" ? await sourceRowsElsewhere(db, b) : new Map<string, string>();
  const elsewhere: string[] = [];
  const differs: number[] = [];
  const supplierIds = new Set<string>();
  // Lines that do not parse are reported below, line by line; the rest are looked up at once.
  const look = await lookups(db, b.lines.flatMap((l) => { const p = lineInput.safeParse(l.data); return p.success ? [p.data] : []; }));
  for (const l of b.lines) {
    try {
      const input = lineInput.parse(l.data);
      const id = lineIdentity(input);
      const k = sourceKey(input as { source_file?: string; source_row?: string }, b.sourceFile);
      if (k && taken.has(k)) elsewhere.push(`${l.lineNo}=${taken.get(k)}`);
      if ((input.kind === "customer" || input.kind === "supplier") && input.source_amount && !input.source_amount.equals(input.amount)) differs.push(l.lineNo);
      if (input.kind === "supplier" && input.party_id) supplierIds.add(input.party_id);
      const first = seen.get(id.same);
      if (first !== undefined) (id.party ? duplicates : alike).push(`${first}=${l.lineNo}`); else seen.set(id.same, l.lineNo);
      if (id.party) partyLines.set(id.party, (partyLines.get(id.party) ?? 0) + 1);
      const e = await lineEffect(db, input, b, look);
      for (const a of e.accounts) byAccount.set(a.accountId, (byAccount.get(a.accountId) ?? D(0)).plus(a.amount));
      if (input.kind === "customer") subledgers.customers = subledgers.customers.plus(input.amount);
      else if (input.kind === "supplier") subledgers.suppliers = subledgers.suppliers.plus(input.amount);
      else if (input.kind === "stock") subledgers.stock = subledgers.stock.plus(e.debit);
      else if (input.kind === "asset") { subledgers.assetsCost = subledgers.assetsCost.plus(input.cost); subledgers.assetsAccumulated = subledgers.assetsAccumulated.plus(input.accumulated); }
      else if (input.kind === "equity_transfer") subledgers.equityTransfer = subledgers.equityTransfer.plus(e.debit).minus(e.credit);
      else subledgers.gl = subledgers.gl.plus(e.debit).minus(e.credit);
    } catch (err) {
      lineProblems.push({ lineNo: l.lineNo, message: err instanceof ApiError ? err.message : String(err) });
    }
  }
  // A phase batch's other side is the provisional clearing account: what its lines leave over.
  let clearing = D(0);
  if (b.kind === "phase") {
    const net = [...byAccount.values()].reduce((s, v) => s.plus(r2(v)), D(0));
    clearing = net.negated();
    if (!clearing.isZero()) {
      const acc = await db.account.findUniqueOrThrow({ where: { systemKey: "opening_clearing" }, select: { id: true } });
      byAccount.set(acc.id, (byAccount.get(acc.id) ?? D(0)).plus(clearing));
    }
  }
  const accounts = await db.account.findMany({ where: { id: { in: [...byAccount.keys()] } }, select: { id: true, code: true, name: true, nameAr: true, type: true, systemKey: true } });
  const tb = accounts.map((a) => { const v = r2(byAccount.get(a.id)!); return { account: a, debit: v.gt(0) ? v.toFixed(2) : "0.00", credit: v.lt(0) ? v.negated().toFixed(2) : "0.00", provisional: a.systemKey === "opening_clearing" }; }).sort((x, y) => x.account.code.localeCompare(y.account.code));
  const debit = tb.reduce((s, r) => s.plus(r.debit), D(0));
  const credit = tb.reduce((s, r) => s.plus(r.credit), D(0));
  const residual = debit.minus(credit);
  const problems: { code: string; params?: Record<string, string> }[] = [];
  if (!b.lines.length) problems.push({ code: "empty" });
  if (lineProblems.length) problems.push({ code: "bad_lines", params: { n: String(lineProblems.length) } });
  if (!residual.isZero()) problems.push({ code: "unbalanced", params: { difference: residual.toFixed(2) } });
  if (b.kind === "phase" && b.migration?.status !== "open") problems.push({ code: "migration_not_open" });
  if (elsewhere.length) problems.push({ code: "source_row_elsewhere", params: { n: String(elsewhere.length), lines: elsewhere.join(", ") } });
  if (duplicates.length) problems.push({ code: "duplicate_lines", params: { n: String(duplicates.length), lines: duplicates.join(", ") } });
  const period = await db.accountingPeriod.findUnique({ where: { code: b.cutoverDate.slice(0, 7) }, select: { status: true } });
  if (period?.status === "closed") problems.push({ code: "period_closed", params: { period: b.cutoverDate.slice(0, 7) } });
  if (b.kind === "initial" && (await initialPosted(db))) problems.push({ code: "initial_posted" });
  // Opening stock already posted directly (before batches existed) must not be posted
  // again through the batch: the same stock and equity would count twice.
  if (b.lines.some((l) => l.kind === "stock")) {
    const directStock = await db.inventoryDocument.count({ where: { type: "adjustment", sourceType: "opening_balance", status: "posted", reversalOfId: null } });
    if (directStock) problems.push({ code: "direct_opening_stock_exists", params: { n: String(directStock) } });
  }
  const warnings: { code: string; params?: Record<string, string> }[] = [];
  const direct = await db.partyOpeningBalance.count();
  if (b.kind === "initial" && direct) warnings.push({ code: "direct_openings_exist", params: { n: String(direct) } });
  const repeated = [...partyLines.values()].filter((k) => k > 1).length;
  if (repeated) warnings.push({ code: "party_repeated", params: { n: String(repeated) } });
  if (alike.length) warnings.push({ code: "identical_lines", params: { n: String(alike.length), lines: alike.join(", ") } });
  if (differs.length) warnings.push({ code: "differs_from_source", params: { n: String(differs.length), lines: differs.join(", ") } });
  if (b.kind === "phase" && b.migrationId && partyLines.size) {
    // The same customer or supplier already carried by another live batch of the migration.
    const others = await db.openingBatchLine.findMany({ where: { kind: { in: ["customer", "supplier"] }, batch: { migrationId: b.migrationId, id: { not: b.id }, status: { not: "cancelled" } } }, select: { kind: true, data: true } });
    const there = new Set(others.map((o) => `${o.kind}:${(o.data as { party_id?: string }).party_id}`));
    const both = [...partyLines.keys()].filter((k) => there.has(k)).length;
    if (both) warnings.push({ code: "party_in_other_batch", params: { n: String(both) } });
  }
  if (supplierIds.size) {
    // The supplier category is the business's segment (a vegetable sheet belongs to vegetable suppliers).
    const cats = await db.supplier.groupBy({ by: ["category"], where: { id: { in: [...supplierIds] } }, _count: { _all: true } });
    const unclassified = cats.find((c) => c.category === null)?._count._all ?? 0;
    if (unclassified) warnings.push({ code: "unclassified_suppliers", params: { n: String(unclassified) } });
    const named = cats.filter((c) => c.category !== null);
    if (named.length > 1) warnings.push({ code: "mixed_categories", params: { categories: named.map((c) => `${c.category} ${c._count._all}`).join(", ") } });
  }
  return {
    id: b.id, number: b.number, kind: b.kind, segment: b.segment, cutoverDate: b.cutoverDate, status: b.status,
    trialBalance: tb, totals: { debit: debit.toFixed(2), credit: credit.toFixed(2), residual: residual.toFixed(2) },
    /** Phase batches: the movement this batch leaves on the clearing account (signed, debit positive). */
    clearing: r2(clearing).toFixed(2),
    subledgers: Object.fromEntries(Object.entries(subledgers).map(([k, v]) => [k, v.toFixed(2)])),
    lineProblems, problems, warnings, lineCount: b.lines.length,
  };
}

const problemText = (p: { code: string; params?: Record<string, string> }) =>
  p.code === "unbalanced" ? `الميزان مش متوازن (فرق ${p.params!.difference})`
  : p.code === "bad_lines" ? `${p.params!.n} سطر فيه خطأ`
  : p.code === "empty" ? "مفيش سطور"
  : p.code === "period_closed" ? `الفترة ${p.params!.period} مقفولة`
  : p.code === "duplicate_lines" ? `سطور متكررة (${p.params!.lines}) — امسح المكرر`
  : p.code === "direct_opening_stock_exists" ? `رصيد المخزون الافتتاحي اترحّل مباشرة قبل كده (${p.params!.n} مستند)`
  : p.code === "migration_not_open" ? "الترحيل الافتتاحي مش مفتوح (قفله مطلوب أو اتقفل)"
  : p.code === "source_row_elsewhere" ? `صفوف مصدر موجودة في دفعة تانية (${p.params!.lines})`
  : "الأرصدة الافتتاحية اترحّلت بالفعل";

export async function submitBatch(id: string, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `accounting:opening-batch:${id}`);
    const b = await tx.openingBatch.findUnique({ where: { id } });
    if (!b) throw new ApiError(404, "الدفعة مش موجودة");
    if (b.status !== "draft") throw new ApiError(409, "الدفعة مش مسودة");
    const v = await validateBatch(id, tx);
    if (v.problems.length) throw new ApiError(409, `الدفعة مش جاهزة: ${v.problems.map(problemText).join("، ")}`);
    await tx.openingBatch.update({ where: { id, version: b.version }, data: { status: "pending_approval", submittedById: actor.id, submittedBy: actor.name, submittedAt: new Date(), version: { increment: 1 } } });
    const segment = b.segment === "suppliers" ? "موردين" : b.segment === "customers" ? "عملاء" : b.segment === "other" ? "أرصدة أخرى" : null;
    await requestApproval(tx, {
      type: "accounting.opening_batch", entityId: id, title: `أرصدة افتتاحية ${b.number}${segment ? ` — ${segment}` : ""} (${b.cutoverDate})`,
      summary: `${v.lineCount} سطر · مدين ${v.totals.debit} = دائن ${v.totals.credit}${b.kind === "phase" ? ` · منها على الحساب الوسيط (مؤقت) ${v.clearing}` : ""}${b.sourceFile ? ` · ${b.sourceFile}` : ""}`,
      amount: v.totals.debit, requester: actor,
    });
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
  const b = await tx.openingBatch.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } }, migration: { select: { status: true } } } });
  if (b.status !== "pending_approval") throw new ApiError(409, "الدفعة مش مستنية اعتماد");
  if ((b.submittedById && b.submittedById === decider.id) || (b.createdById && b.createdById === decider.id)) throw new ApiError(403, "اللي جهّز الدفعة أو بعتها مينفعش يعتمدها");
  if (!approved) {
    await tx.openingBatch.update({ where: { id, version: b.version }, data: { status: "draft", decidedBy: decider.name, decidedAt: new Date(), decisionNote: comment ?? null, version: { increment: 1 } } });
    await audit(tx, decider, id, "opening_batch_rejected", b.number, comment);
    return;
  }
  const v = await validateBatch(id, tx);
  if (v.problems.length) throw new ApiError(409, "الدفعة اتغيّر عليها حاجة من وقت ما اتبعتت (حسابات أو أصناف موقوفة، فترة مقفولة، ترحيل مقفول، رصيد اتغيّر) — ارفضها وراجعها");
  const actor = { id: decider.id, name: decider.name, role: decider.role, deviceId: decider.deviceId, permissions: decider.permissions } as ServiceActor;
  const date = b.cutoverDate;
  const entryIds: string[] = [];
  const parsed = b.lines.map((l) => ({ line: l, input: lineInput.parse(l.data) }));
  // The other side: opening equity for the one-batch opening (it nets to zero across the batch),
  // the provisional clearing account for a phase of the phased migration.
  const counter: "opening_equity" | "opening_clearing" = b.kind === "phase" ? "opening_clearing" : "opening_equity";
  const tag = b.kind === "phase" ? " (مرحلي — الحساب الوسيط)" : "";
  // 1. GL balances: one entry against the counter account.
  const glLines: PostLine[] = [];
  for (const { input } of parsed) if (input.kind === "gl") glLines.push({ accountId: input.account_id!, amount: (input.debit ?? D(0)).minus(input.credit ?? D(0)), description: input.description ?? undefined });
  if (glLines.length) {
    const net = glLines.reduce((s, l) => s.plus(l.amount), D(0));
    const e = await postJournal(tx, { date, description: `أرصدة افتتاحية ${b.number} — الحسابات${tag}`, sourceType: "opening_batch", sourceId: `${b.id}:gl`, lines: [...glLines, { key: counter, amount: net.negated() }] }, actor);
    if (e) entryIds.push(e.id);
  }
  // 2. Customers' and suppliers' open items (statements and aging read them), each naming this
  //    batch, in line order. Posted together — the same rows, entries and audit as one by one,
  //    in a fixed number of statements, so a large batch posts within the transaction limit on
  //    production latency (Nov 2026: a 50-line batch needed ~800 round trips one by one).
  const { postPartyOpeningsInTx } = await import("@/lib/accounting/integrity");
  await postPartyOpeningsInTx(tx, parsed.flatMap(({ input, line }) => (input.kind === "customer" || input.kind === "supplier")
    ? [{ partyType: input.kind, partyId: input.party_id!, date, dueDate: input.due_date ?? date, amount: input.amount, reference: input.reference ?? `${b.number}#${line.lineNo}`, counterKey: counter, openingBatchId: b.id }]
    : []), actor);
  // 3. Stock, through the stock ledger (lots at the given cost; valued against opening equity).
  const stock = parsed.filter((p) => p.input.kind === "stock").map((p) => p.input as Extract<LineInput, { kind: "stock" }>);
  if (stock.length) {
    const { postOpeningStockInTx } = await import("@/lib/inventory/documents");
    // Tagged with its batch (metadata only), so the cut-over report can tell it from a direct entry.
    const doc = await postOpeningStockInTx(tx, { date, sourceId: `${b.id}:stock`, lines: stock.map((s) => ({ product_id: s.product_id!, quantity: s.quantity.toString(), unit_cost: s.unit_cost.toString(), ...(s.location_id ? { location_id: s.location_id } : {}), ...(s.expiry_date ? { expiry_date: s.expiry_date } : {}) })) }, actor);
    if (b.kind === "phase") {
      // The stock ledger values opening stock against opening equity; a phase moves exactly what
      // that valuation put on 3300 into the clearing account, so 3300 is left as it was.
      const [moved] = await tx.$queryRaw<{ v: Prisma.Decimal | null }[]>`
        SELECT sum(l."debit" - l."credit") AS v FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId"
        WHERE a."systemKey" = 'opening_equity' AND l."entryId" IN (
          SELECT p."entryId" FROM "StockValuationPosting" p JOIN "StockMovement" m ON m."id" = p."movementId" WHERE m."documentId" = ${doc.id} AND p."entryId" IS NOT NULL)`;
      const onEquity = D(moved?.v);
      const e = await postJournal(tx, { date, description: `أرصدة افتتاحية ${b.number} — المخزون${tag}`, sourceType: "opening_batch", sourceId: `${b.id}:stock`, lines: [{ key: "opening_equity", amount: onEquity.negated() }, { key: "opening_clearing", amount: onEquity }] }, actor);
      if (e) entryIds.push(e.id);
    }
  }
  // 3b. Opening-balance equity moved into the clearing account (phased migration, "other" segment).
  const transfers = parsed.filter((p) => p.input.kind === "equity_transfer").map((p) => p.input as Extract<LineInput, { kind: "equity_transfer" }>);
  if (transfers.length) {
    const amount = transfers.reduce((s, t) => s.plus(t.amount!), D(0));
    const e = await postJournal(tx, { date, description: `أرصدة افتتاحية ${b.number} — تحويل حساب الأرصدة الافتتاحية (3300) للحساب الوسيط${transfers[0].description ? ` · ${transfers[0].description}` : ""}`, sourceType: "opening_batch", sourceId: `${b.id}:equity`, lines: [{ key: "opening_equity", amount }, { key: "opening_clearing", amount: amount.negated() }] }, actor);
    if (e) entryIds.push(e.id);
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
    const e = await postJournal(tx, { date, description: `أرصدة افتتاحية ${b.number} — الأصول الثابتة${tag}`, sourceType: "opening_batch", sourceId: `${b.id}:assets`, lines: [...lines, { key: counter, amount: net.negated() }] }, actor);
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
