import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { optText, parse, text } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { controlAccountMovedBy, postJournal } from "@/lib/accounting/ledger";
import { getSetting } from "@/lib/core/settings-service";
import type { SettingKey } from "@/lib/core/settings-registry";
import { customerReceivable } from "@/lib/sales/invoicing";
import { supplierPayable } from "@/lib/purchasing/bills";
import { listLimit } from "@/lib/core/list-window";

/**
 * Cash and bank: customer receipts and supplier payments (each allocated to invoices /
 * bills, the rest held on account), cash positions, and bank reconciliation.
 *
 * A receipt or payment is permanent and posts its journal entry in the same
 * transaction. Allocation never exceeds what the document has open nor what the
 * receipt/payment has left (the latter also DB-enforced); one party's money moves one
 * at a time (advisory lock), so two receipts cannot both settle the same invoice.
 *
 * Part of a receipt may be settled without cash — tax the customer withheld, a bank
 * charge, a small difference within the configured limit — and a payment may withhold
 * tax from the supplier. The document's amount is still what the party is credited or
 * debited with, so statements, aging and the AR/AP checks read it unchanged; only the
 * cash leg is the amount minus those deductions, each posted to the account the
 * accountant configured for it (a kind with no account configured is refused).
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const amount = (label: string) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} لازم يكون أكبر من صفر بحد أقصى خانتين عشريتين` });
      return z.NEVER;
    }
    return D(s);
  });
const METHODS = ["cash", "bank_transfer", "cheque", "wallet", "other"] as const;
const moneyIn = z.object({
  party_id: text("الطرف"),
  cash_account_id: text("الخزينة / البنك"),
  date: z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD").optional(),
  amount: amount("المبلغ"),
  method: z.enum(METHODS),
  reference: optText("المرجع", 100).optional(),
  notes: optText("ملاحظات", 1000).optional(),
  /** Explicit allocations; or `auto` — oldest due first; or neither — all on account. */
  allocations: z.array(z.object({ document_id: text("المستند"), amount: amount("مبلغ التخصيص") })).max(200).optional(),
  auto: z.boolean().optional(),
  /** Settled without cash; at most one line per kind. */
  deductions: z
    .array(z.object({ kind: z.enum(["withholding", "bank_charge", "write_off"], { errorMap: () => ({ message: "نوع الخصم غير معروف" }) }), amount: amount("مبلغ الخصم"), reference: optText("رقم الشهادة", 100).optional() }))
    .max(3)
    .optional(),
  idempotency_key: z.string().min(8, "مفتاح التكرار قصير").max(120, "مفتاح التكرار طويل").optional(),
});

type DeductionKind = "withholding" | "bank_charge" | "write_off";
type Deduction = { kind: DeductionKind; accountId: string; amount: Prisma.Decimal; reference: string | null };

/** A repeat of the same submit returns the first document; the same key on a different submit is refused. */
function sameMoney(
  prev: { partyId: string; amount: Prisma.Decimal; cashAccountId: string; deductions?: { kind: string; amount: Prisma.Decimal; reference: string | null }[] },
  v: { party_id: string; amount: Prisma.Decimal; cash_account_id: string; deductions?: { kind: string; amount: Prisma.Decimal; reference?: string | null }[] }
) {
  const key = (d: { kind: string; amount: Prisma.Decimal; reference?: string | null }) => `${d.kind}:${d.amount.toFixed(2)}:${d.reference ?? ""}`;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (prev.partyId !== v.party_id || !prev.amount.eq(v.amount) || prev.cashAccountId !== v.cash_account_id || !same((prev.deductions ?? []).map(key).sort(), (v.deductions ?? []).map(key).sort())) {
    throw new ApiError(409, "مفتاح التكرار ده اتستخدم في عملية تانية");
  }
}

const DEDUCTION_LABEL: Record<DeductionKind, string> = { withholding: "الخصم من المنبع", bank_charge: "مصاريف البنك", write_off: "فرق التحصيل" };
const DEDUCTION_ACCOUNT = {
  receipt: { withholding: "accounting.withholding_receivable_account", bank_charge: "accounting.bank_charges_account", write_off: "accounting.write_off_account" },
  payment: { withholding: "accounting.withholding_payable_account" },
} as const;
/** The account type each deduction must post to — a mistyped code is refused, not posted. */
const DEDUCTION_TYPE = { receipt: { withholding: "asset", bank_charge: "expense", write_off: "expense" }, payment: { withholding: "liability" } } as const;

/**
 * Checks the deductions of a receipt or payment against the configured accounts and
 * limits, and returns them with their accounts. Together they stay below the amount:
 * some money must actually move (also DB-enforced).
 */
async function resolveDeductions(
  tx: Tx,
  side: "receipt" | "payment",
  raw: { kind: DeductionKind; amount: Prisma.Decimal; reference?: string | null }[] | undefined,
  total: Prisma.Decimal,
  actor: ServiceActor
): Promise<Deduction[]> {
  if (!raw?.length) return [];
  const out: Deduction[] = [];
  for (const d of raw) {
    if (out.some((x) => x.kind === d.kind)) throw new ApiError(400, `${DEDUCTION_LABEL[d.kind]} متكرر — سطر واحد لكل نوع`);
    const settingKey = (DEDUCTION_ACCOUNT[side] as Partial<Record<DeductionKind, SettingKey>>)[d.kind];
    if (!settingKey) throw new ApiError(400, `${DEDUCTION_LABEL[d.kind]} مش متاح في سداد الموردين`);
    const code = String(await getSetting(settingKey)).trim();
    if (!code) throw new ApiError(400, `${DEDUCTION_LABEL[d.kind]} مش متفعّل — حدد حسابه في إعدادات الحسابات الأول`);
    const account = await tx.account.findUnique({ where: { code } });
    const wanted = (DEDUCTION_TYPE[side] as Record<string, string>)[d.kind];
    if (!account || !account.active || !account.postable) throw new ApiError(400, `حساب ${DEDUCTION_LABEL[d.kind]} (${code}) مش موجود أو موقوف أو حساب رئيسي — راجع الإعدادات`);
    if (account.type !== wanted || controlAccountMovedBy(account.systemKey, account.controlledBy) || (await tx.cashAccount.findFirst({ where: { accountId: account.id } }))) {
      throw new ApiError(400, `حساب ${DEDUCTION_LABEL[d.kind]} (${code}) مش مناسب — راجع الإعدادات`);
    }
    if (d.kind === "write_off") {
      if (!actorCan(actor, "accounting.manage")) throw new ApiError(403, "فرق التحصيل محتاج صلاحية إدارة الحسابات");
      const limit = D(await getSetting("accounting.write_off_limit"));
      if (d.amount.greaterThan(limit)) throw new ApiError(400, `فرق التحصيل ${d.amount.toFixed(2)} أكبر من الحد المسموح ${limit.toFixed(2)}`);
    }
    out.push({ kind: d.kind, accountId: account.id, amount: d.amount, reference: d.reference ?? null });
  }
  const deducted = out.reduce((s, d) => s.plus(d.amount), D(0));
  if (!deducted.lessThan(total)) throw new ApiError(400, `الخصومات ${deducted.toFixed(2)} لازم تكون أقل من المبلغ ${total.toFixed(2)}`);
  return out;
}

const deductedOf = (list: { amount: Prisma.Decimal }[]) => list.reduce((s, d) => s.plus(d.amount), D(0));
const deductionNote = (list: { kind: string; amount: Prisma.Decimal }[]) =>
  list.length ? ` · خصومات ${list.map((d) => `${DEDUCTION_LABEL[d.kind as DeductionKind]} ${d.amount.toFixed(2)}`).join(" + ")}` : "";

const audit = (tx: Tx, actor: ServiceActor, entityType: "customer_receipt" | "supplier_payment" | "bank_reconciliation", id: string, action: string, detail: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType, entityId: id, newValue: detail, source: "user", deviceId: actor.deviceId }, tx);

// ---------------------------------------------------------------------------
// What is open
// ---------------------------------------------------------------------------

/** Issued invoices of a customer with what is still open: total − credit notes − receipts allocated. */
export async function openInvoices(db: Tx | typeof prisma, customerId: string) {
  const invs = await db.salesInvoice.findMany({ where: { customerId, status: "issued" }, orderBy: [{ dueDate: "asc" }, { issuedAt: "asc" }], select: { id: true, number: true, issueDate: true, dueDate: true, total: true } });
  const ids = invs.map((i) => i.id);
  const balances = await db.partyOpeningBalance.findMany({ where: { partyType: "customer", partyId: customerId, amount: { gt: 0 } }, orderBy: [{ dueDate: "asc" }, { date: "asc" }, { id: "asc" }] });
  const balanceIds = balances.map((b) => b.id);
  const [cn, alloc, balanceAlloc] = await Promise.all([
    ids.length ? db.creditNote.groupBy({ by: ["invoiceId"], where: { invoiceId: { in: ids } }, _sum: { total: true } }) : [],
    ids.length ? db.receiptAllocation.groupBy({ by: ["invoiceId"], where: { invoiceId: { in: ids }, receipt: { reversal: { is: null } } }, _sum: { amount: true } }) : [],
    balanceIds.length ? db.receiptAllocation.groupBy({ by: ["openingBalanceId"], where: { openingBalanceId: { in: balanceIds }, receipt: { reversal: { is: null } } }, _sum: { amount: true } }) : [],
  ]);
  const cnBy = new Map(cn.map((c) => [c.invoiceId, D(c._sum.total ?? 0)]));
  const alBy = new Map(alloc.map((a) => [a.invoiceId, D(a._sum.amount ?? 0)]));
  const balanceAlBy = new Map(balanceAlloc.map((a) => [a.openingBalanceId!, D(a._sum.amount ?? 0)]));
  const native = invs.map((i) => ({ id: i.id, number: i.number, total: i.total, dueDate: i.dueDate ?? i.issueDate ?? "", sortDate: i.issueDate ?? "", target: "invoice" as const, open: i.total.minus(cnBy.get(i.id) ?? 0).minus(alBy.get(i.id) ?? 0) })).filter((i) => i.open.gt(0));
  const imported = balances.map((b) => ({ id: b.id, number: b.reference ? `رصيد أودو · ${b.reference}` : `رصيد افتتاحي · ${b.date}`, total: b.amount, dueDate: b.dueDate, sortDate: b.date, target: "opening_balance" as const, open: b.amount.minus(balanceAlBy.get(b.id) ?? 0) })).filter((b) => b.open.gt(0));
  return [...native, ...imported].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.sortDate.localeCompare(b.sortDate) || a.id.localeCompare(b.id));
}

/** Posted bills of a supplier with what is still open: total − debit notes − payments allocated. */
export async function openBills(db: Tx | typeof prisma, supplierId: string) {
  const bills = await db.supplierBill.findMany({ where: { supplierId, status: "posted" }, orderBy: [{ dueDate: "asc" }, { postedAt: "asc" }], select: { id: true, number: true, supplierInvoiceNo: true, billDate: true, dueDate: true, total: true } });
  const ids = bills.map((b) => b.id);
  const balances = await db.partyOpeningBalance.findMany({ where: { partyType: "supplier", partyId: supplierId, amount: { gt: 0 } }, orderBy: [{ dueDate: "asc" }, { date: "asc" }, { id: "asc" }] });
  const balanceIds = balances.map((b) => b.id);
  const [dn, alloc, balanceAlloc] = await Promise.all([
    ids.length ? db.debitNote.groupBy({ by: ["billId"], where: { billId: { in: ids } }, _sum: { total: true } }) : [],
    ids.length ? db.paymentAllocation.groupBy({ by: ["billId"], where: { billId: { in: ids }, payment: { reversal: { is: null } } }, _sum: { amount: true } }) : [],
    balanceIds.length ? db.paymentAllocation.groupBy({ by: ["openingBalanceId"], where: { openingBalanceId: { in: balanceIds }, payment: { reversal: { is: null } } }, _sum: { amount: true } }) : [],
  ]);
  const dnBy = new Map(dn.map((d) => [d.billId, D(d._sum.total ?? 0)]));
  const alBy = new Map(alloc.map((a) => [a.billId, D(a._sum.amount ?? 0)]));
  const balanceAlBy = new Map(balanceAlloc.map((a) => [a.openingBalanceId!, D(a._sum.amount ?? 0)]));
  const native = bills.map((b) => ({ id: b.id, number: b.number, total: b.total, dueDate: b.dueDate, sortDate: b.billDate, target: "bill" as const, open: b.total.minus(dnBy.get(b.id) ?? 0).minus(alBy.get(b.id) ?? 0) })).filter((b) => b.open.gt(0));
  const imported = balances.map((b) => ({ id: b.id, number: b.reference ? `رصيد أودو · ${b.reference}` : `رصيد افتتاحي · ${b.date}`, total: b.amount, dueDate: b.dueDate, sortDate: b.date, target: "opening_balance" as const, open: b.amount.minus(balanceAlBy.get(b.id) ?? 0) })).filter((b) => b.open.gt(0));
  return [...native, ...imported].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.sortDate.localeCompare(b.sortDate) || a.id.localeCompare(b.id));
}

/** Decides allocations against the open documents (explicit, or oldest-due first). */
type OpenMoneyDocument = { id: string; number: string | null; open: Prisma.Decimal; target: "invoice" | "bill" | "opening_balance" };
function allocate(open: OpenMoneyDocument[], available: Prisma.Decimal, explicit?: { document_id: string; amount: Prisma.Decimal }[], auto?: boolean) {
  const out: { id: string; amount: Prisma.Decimal; target: OpenMoneyDocument["target"] }[] = [];
  if (explicit?.length) {
    let total = D(0);
    for (const a of explicit) {
      const doc = open.find((d) => d.id === a.document_id);
      if (!doc) throw new ApiError(400, "المستند مش مفتوح للطرف ده (مدفوع بالكامل أو مش بتاعه)");
      const already = out.filter((o) => o.id === doc.id).reduce((s, o) => s.plus(o.amount), D(0));
      if (already.plus(a.amount).greaterThan(doc.open)) throw new ApiError(400, `${doc.number}: المفتوح ${doc.open.toFixed(2)} بس`);
      total = total.plus(a.amount);
      out.push({ id: doc.id, amount: a.amount, target: doc.target });
    }
    if (total.greaterThan(available)) throw new ApiError(400, `التخصيص ${total.toFixed(2)} أكبر من المبلغ المتاح ${available.toFixed(2)}`);
  } else if (auto) {
    let left = available;
    for (const d of open) {
      if (!left.gt(0)) break;
      const take = Prisma.Decimal.min(left, d.open);
      out.push({ id: d.id, amount: take, target: d.target });
      left = left.minus(take);
    }
  }
  return out;
}

const accountOf = async (tx: Tx, cashAccountId: string) => {
  const c = await tx.cashAccount.findUnique({ where: { id: cashAccountId } });
  if (!c?.active) throw new ApiError(400, "الخزينة / الحساب البنكي مش موجود أو موقوف");
  return c;
};

// ---------------------------------------------------------------------------
// Customer receipts
// ---------------------------------------------------------------------------

export async function createReceipt(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.receipts.manage");
  const v = parse(moneyIn, input);
  const date = v.date ?? todayLocalISO();
  return inTx(async (tx) => {
    if (v.idempotency_key) await advisoryXactLock(tx, `accounting:money-key:${v.idempotency_key}`);
    await advisoryXactLock(tx, `accounting:customer:${v.party_id}`);
    if (v.idempotency_key) {
      const prev = await tx.customerReceipt.findUnique({ where: { idempotencyKey: v.idempotency_key }, include: { deductions: true } });
      if (prev) {
        sameMoney({ partyId: prev.customerId, amount: prev.amount, cashAccountId: prev.cashAccountId, deductions: prev.deductions }, v);
        return prev;
      }
    }
    const customer = await tx.customer.findUnique({ where: { id: v.party_id } });
    if (!customer) throw new ApiError(404, "العميل مش موجود");
    const cash = await accountOf(tx, v.cash_account_id);
    const deductions = await resolveDeductions(tx, "receipt", v.deductions, v.amount, actor);
    const allocations = allocate(await openInvoices(tx, customer.id), v.amount, v.allocations, v.auto);
    const receipt = await tx.customerReceipt.create({
      data: {
        number: await nextDocumentNumber(tx, "accounting.receipt", date),
        customerId: customer.id, cashAccountId: cash.id, date, amount: v.amount, method: v.method, reference: v.reference ?? null, notes: v.notes ?? null, idempotencyKey: v.idempotency_key ?? null,
        createdById: actor.id, createdBy: actor.name,
        allocations: { createMany: { data: allocations.map((a) => ({ invoiceId: a.target === "invoice" ? a.id : null, openingBalanceId: a.target === "opening_balance" ? a.id : null, amount: a.amount })) } },
        ...(deductions.length ? { deductions: { createMany: { data: deductions } } } : {}),
      },
    });
    await postJournal(tx, {
      date, description: `تحصيل ${receipt.number} من ${customer.name}${v.reference ? ` (${v.reference})` : ""}`, sourceType: "customer_receipt", sourceId: receipt.id,
      lines: [
        { accountId: cash.accountId, amount: v.amount.minus(deductedOf(deductions)) },
        ...deductions.map((d) => ({ accountId: d.accountId, amount: d.amount, description: DEDUCTION_LABEL[d.kind] + (d.reference ? ` (${d.reference})` : "") })),
        { key: "ar", amount: v.amount.negated(), party: { type: "customer", id: customer.id } },
      ],
    }, actor);
    const applied = allocations.reduce((s, a) => s.plus(a.amount), D(0));
    await audit(tx, actor, "customer_receipt", receipt.id, "receipt_created", `${receipt.number} · ${customer.code} · ${v.amount.toFixed(2)} · مخصص ${applied.toFixed(2)}${deductionNote(deductions)}`);
    return receipt;
  });
}

/** Applies money a customer already paid on account to invoices. */
export async function allocateReceipt(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.receipts.manage");
  const v = parse(z.object({ allocations: moneyIn.shape.allocations, auto: z.boolean().optional() }), input);
  return inTx(async (tx) => {
    const head = await tx.customerReceipt.findUnique({ where: { id }, select: { customerId: true } });
    if (!head) throw new ApiError(404, "الإيصال مش موجود");
    await advisoryXactLock(tx, `accounting:customer:${head.customerId}`);
    const r = await tx.customerReceipt.findUniqueOrThrow({ where: { id }, include: { allocations: true, reversal: true } });
    if (r.reversal) throw new ApiError(409, "الإيصال ده اتعكس — مينفعش يتخصص");
    const left = r.amount.minus(r.allocations.reduce((s, a) => s.plus(a.amount), D(0)));
    if (!left.gt(0)) throw new ApiError(409, "الإيصال متخصص بالكامل");
    const allocations = allocate(await openInvoices(tx, r.customerId), left, v.allocations, v.auto ?? !v.allocations?.length);
    if (!allocations.length) throw new ApiError(409, "مفيش فواتير مفتوحة للعميل");
    await tx.receiptAllocation.createMany({ data: allocations.map((a) => ({ receiptId: id, invoiceId: a.target === "invoice" ? a.id : null, openingBalanceId: a.target === "opening_balance" ? a.id : null, amount: a.amount })) });
    await audit(tx, actor, "customer_receipt", id, "receipt_allocated", allocations.map((a) => a.amount.toFixed(2)).join(" + "));
    return tx.customerReceipt.findUniqueOrThrow({ where: { id }, include: { allocations: true } });
  });
}

// ---------------------------------------------------------------------------
// Supplier payments
// ---------------------------------------------------------------------------

export async function createPayment(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.payments.manage");
  const v = parse(moneyIn, input);
  const date = v.date ?? todayLocalISO();
  return inTx(async (tx) => {
    if (v.idempotency_key) await advisoryXactLock(tx, `accounting:money-key:${v.idempotency_key}`);
    await advisoryXactLock(tx, `accounting:supplier:${v.party_id}`);
    if (v.idempotency_key) {
      const prev = await tx.supplierPayment.findUnique({ where: { idempotencyKey: v.idempotency_key }, include: { deductions: true } });
      if (prev) {
        sameMoney({ partyId: prev.supplierId, amount: prev.amount, cashAccountId: prev.cashAccountId, deductions: prev.deductions }, v);
        return prev;
      }
    }
    const supplier = await tx.supplier.findUnique({ where: { id: v.party_id } });
    if (!supplier) throw new ApiError(404, "المورد مش موجود");
    const cash = await accountOf(tx, v.cash_account_id);
    const deductions = await resolveDeductions(tx, "payment", v.deductions, v.amount, actor);
    const allocations = allocate(await openBills(tx, supplier.id), v.amount, v.allocations, v.auto);
    const payment = await tx.supplierPayment.create({
      data: {
        number: await nextDocumentNumber(tx, "accounting.payment", date),
        supplierId: supplier.id, cashAccountId: cash.id, date, amount: v.amount, method: v.method, reference: v.reference ?? null, notes: v.notes ?? null, idempotencyKey: v.idempotency_key ?? null,
        createdById: actor.id, createdBy: actor.name,
        allocations: { createMany: { data: allocations.map((a) => ({ billId: a.target === "bill" ? a.id : null, openingBalanceId: a.target === "opening_balance" ? a.id : null, amount: a.amount })) } },
        ...(deductions.length ? { deductions: { createMany: { data: deductions } } } : {}),
      },
    });
    await postJournal(tx, {
      date, description: `سداد ${payment.number} لـ ${supplier.name}${v.reference ? ` (${v.reference})` : ""}`, sourceType: "supplier_payment", sourceId: payment.id,
      lines: [
        { key: "ap", amount: v.amount, party: { type: "supplier", id: supplier.id } },
        { accountId: cash.accountId, amount: v.amount.minus(deductedOf(deductions)).negated() },
        ...deductions.map((d) => ({ accountId: d.accountId, amount: d.amount.negated(), description: DEDUCTION_LABEL[d.kind] + (d.reference ? ` (${d.reference})` : "") })),
      ],
    }, actor);
    const applied = allocations.reduce((s, a) => s.plus(a.amount), D(0));
    await audit(tx, actor, "supplier_payment", payment.id, "payment_created", `${payment.number} · ${supplier.code} · ${v.amount.toFixed(2)} · مخصص ${applied.toFixed(2)}${deductionNote(deductions)}`);
    return payment;
  });
}

export async function allocatePayment(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.payments.manage");
  const v = parse(z.object({ allocations: moneyIn.shape.allocations, auto: z.boolean().optional() }), input);
  return inTx(async (tx) => {
    const head = await tx.supplierPayment.findUnique({ where: { id }, select: { supplierId: true } });
    if (!head) throw new ApiError(404, "السداد مش موجود");
    await advisoryXactLock(tx, `accounting:supplier:${head.supplierId}`);
    const p = await tx.supplierPayment.findUniqueOrThrow({ where: { id }, include: { allocations: true, reversal: true } });
    if (p.reversal) throw new ApiError(409, "السداد ده اتعكس — مينفعش يتخصص");
    const left = p.amount.minus(p.allocations.reduce((s, a) => s.plus(a.amount), D(0)));
    if (!left.gt(0)) throw new ApiError(409, "السداد متخصص بالكامل");
    const allocations = allocate(await openBills(tx, p.supplierId), left, v.allocations, v.auto ?? !v.allocations?.length);
    if (!allocations.length) throw new ApiError(409, "مفيش فواتير مفتوحة للمورد");
    await tx.paymentAllocation.createMany({ data: allocations.map((a) => ({ paymentId: id, billId: a.target === "bill" ? a.id : null, openingBalanceId: a.target === "opening_balance" ? a.id : null, amount: a.amount })) });
    await audit(tx, actor, "supplier_payment", id, "payment_allocated", allocations.map((a) => a.amount.toFixed(2)).join(" + "));
    return tx.supplierPayment.findUniqueOrThrow({ where: { id }, include: { allocations: true } });
  });
}

// ---------------------------------------------------------------------------
// Taking money back: a bounced cheque, a payment recorded on the wrong party
// ---------------------------------------------------------------------------

const reversalInput = z.object({
  reason: text("سبب العكس", 500),
  date: z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD").optional(),
});

/**
 * Cancels a customer receipt by a reversal document: the receipt stays as recorded, its
 * allocations stop counting (the invoices reopen), and the reversal posts Dr AR / Cr cash
 * on its own date. Senior finance only — reversing money is how cash would be hidden.
 */
export async function reverseReceipt(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(reversalInput, input);
  return inTx(async (tx) => {
    const head = await tx.customerReceipt.findUnique({ where: { id }, select: { customerId: true } });
    if (!head) throw new ApiError(404, "الإيصال مش موجود");
    await advisoryXactLock(tx, `accounting:customer:${head.customerId}`);
    const r = await tx.customerReceipt.findUniqueOrThrow({ where: { id }, include: { reversal: true, deductions: true, customer: { select: { name: true } }, cashAccount: { select: { accountId: true } } } });
    if (r.reversal) throw new ApiError(409, "الإيصال ده اتعكس قبل كده");
    const date = v.date ?? todayLocalISO();
    if (date < r.date) throw new ApiError(400, "تاريخ العكس قبل تاريخ الإيصال");
    const rev = await tx.customerReceiptReversal.create({ data: { receiptId: r.id, date, reason: v.reason, createdById: actor.id, createdBy: actor.name } });
    await postJournal(tx, {
      date, description: `عكس تحصيل ${r.number} من ${r.customer.name}: ${v.reason}`, sourceType: "receipt_reversal", sourceId: rev.id,
      // Every leg of the original comes back: the cash, and each deduction.
      lines: [
        { key: "ar", amount: r.amount, party: { type: "customer", id: r.customerId } },
        { accountId: r.cashAccount.accountId, amount: r.amount.minus(deductedOf(r.deductions)).negated() },
        ...r.deductions.map((d) => ({ accountId: d.accountId, amount: d.amount.negated(), description: DEDUCTION_LABEL[d.kind as DeductionKind] })),
      ],
    }, actor);
    await audit(tx, actor, "customer_receipt", r.id, "receipt_reversed", `${r.number} · ${r.amount.toFixed(2)} · ${v.reason}`);
    return rev;
  });
}

/** The supplier-side mirror: Dr cash / Cr AP; the bills it paid reopen. */
export async function reversePayment(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(reversalInput, input);
  return inTx(async (tx) => {
    const head = await tx.supplierPayment.findUnique({ where: { id }, select: { supplierId: true } });
    if (!head) throw new ApiError(404, "السداد مش موجود");
    await advisoryXactLock(tx, `accounting:supplier:${head.supplierId}`);
    const p = await tx.supplierPayment.findUniqueOrThrow({ where: { id }, include: { reversal: true, deductions: true, supplier: { select: { name: true, nameAr: true } }, cashAccount: { select: { accountId: true } } } });
    if (p.reversal) throw new ApiError(409, "السداد ده اتعكس قبل كده");
    const date = v.date ?? todayLocalISO();
    if (date < p.date) throw new ApiError(400, "تاريخ العكس قبل تاريخ السداد");
    const rev = await tx.supplierPaymentReversal.create({ data: { paymentId: p.id, date, reason: v.reason, createdById: actor.id, createdBy: actor.name } });
    await postJournal(tx, {
      date, description: `عكس سداد ${p.number} لـ ${p.supplier.name}: ${v.reason}`, sourceType: "payment_reversal", sourceId: rev.id,
      lines: [
        { key: "ap", amount: p.amount.negated(), party: { type: "supplier", id: p.supplierId } },
        { accountId: p.cashAccount.accountId, amount: p.amount.minus(deductedOf(p.deductions)) },
        ...p.deductions.map((d) => ({ accountId: d.accountId, amount: d.amount, description: DEDUCTION_LABEL[d.kind as DeductionKind] })),
      ],
    }, actor);
    await audit(tx, actor, "supplier_payment", p.id, "payment_reversed", `${p.number} · ${p.amount.toFixed(2)} · ${v.reason}`);
    return rev;
  });
}

type PresentedDeduction = { kind: string; amount: Prisma.Decimal; reference: string | null; account: { code: string } };
const present = (r: { id: string; number: string; date: string; amount: Prisma.Decimal; method: string; reference: string | null; createdBy: string; allocations: { amount: Prisma.Decimal }[]; deductions: PresentedDeduction[]; reversal: { date: string; reason: string; createdBy: string } | null }) => {
  const applied = r.reversal ? D(0) : r.allocations.reduce((s, a) => s.plus(a.amount), D(0));
  return {
    id: r.id, number: r.number, date: r.date, amount: r.amount.toFixed(2), method: r.method, reference: r.reference, createdBy: r.createdBy,
    /** What moved in cash or bank: the amount less what was settled without cash. */
    cashAmount: r.amount.minus(deductedOf(r.deductions)).toFixed(2),
    deductions: r.deductions.map((d) => ({ kind: d.kind, amount: d.amount.toFixed(2), reference: d.reference, accountCode: d.account.code })),
    allocated: applied.toFixed(2), unallocated: r.reversal ? "0.00" : r.amount.minus(applied).toFixed(2),
    reversal: r.reversal ? { date: r.reversal.date, reason: r.reversal.reason, by: r.reversal.createdBy } : null,
  };
};

export async function listReceipts(filters: { customerId?: string; limit?: number; offset?: number }) {
  const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const skip = Math.max(filters.offset ?? 0, 0);
  const where = filters.customerId ? { customerId: filters.customerId } : {};
  const [total, rows] = await Promise.all([
    prisma.customerReceipt.count({ where }),
    prisma.customerReceipt.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], include: { allocations: true, deductions: { include: { account: { select: { code: true } } } }, reversal: true, customer: { select: { id: true, code: true, name: true, nameAr: true } }, cashAccount: { select: { name: true, nameAr: true } } }, skip, take }),
  ]);
  return { receipts: rows.map((r) => ({ ...present(r), customer: r.customer, cashAccount: r.cashAccount.name, cashAccountAr: r.cashAccount.nameAr })), pagination: { total, limit: take, offset: skip } };
}

export async function listPayments(filters: { supplierId?: string; limit?: number; offset?: number }) {
  const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const skip = Math.max(filters.offset ?? 0, 0);
  const where = filters.supplierId ? { supplierId: filters.supplierId } : {};
  const [total, rows] = await Promise.all([
    prisma.supplierPayment.count({ where }),
    prisma.supplierPayment.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], include: { allocations: true, deductions: { include: { account: { select: { code: true } } } }, reversal: true, supplier: { select: { id: true, code: true, name: true, nameAr: true } }, cashAccount: { select: { name: true, nameAr: true } } }, skip, take }),
  ]);
  return { payments: rows.map((r) => ({ ...present(r), supplier: r.supplier, cashAccount: r.cashAccount.name, cashAccountAr: r.cashAccount.nameAr })), pagination: { total, limit: take, offset: skip } };
}

/**
 * Tax withheld in a period, one row per document: what customers withheld from
 * their payments to us (receivable — reconciled against their certificates), or what we
 * withheld from suppliers (payable — remitted to the tax authority). Reversed receipts
 * and payments are left out: their withholding was reversed with them.
 */
export async function withholdingReport(side: "receivable" | "payable", from: string, to: string) {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "الفترة غير صالحة");
  const party = { select: { id: true, code: true, name: true, nameAr: true } } as const;
  const rows =
    side === "receivable"
      ? (await prisma.receiptDeduction.findMany({
          where: { kind: "withholding", receipt: { date: { gte: from, lte: to }, reversal: { is: null } } },
          include: { account: { select: { code: true } }, receipt: { select: { number: true, date: true, amount: true, customer: party } } },
          orderBy: [{ receipt: { date: "asc" } }, { receipt: { number: "asc" } }],
        })).map((d) => ({ date: d.receipt.date, document: d.receipt.number, party: d.receipt.customer, documentAmount: d.receipt.amount.toFixed(2), amount: d.amount.toFixed(2), reference: d.reference, accountCode: d.account.code }))
      : (await prisma.paymentDeduction.findMany({
          where: { kind: "withholding", payment: { date: { gte: from, lte: to }, reversal: { is: null } } },
          include: { account: { select: { code: true } }, payment: { select: { number: true, date: true, amount: true, supplier: party } } },
          orderBy: [{ payment: { date: "asc" } }, { payment: { number: "asc" } }],
        })).map((d) => ({ date: d.payment.date, document: d.payment.number, party: d.payment.supplier, documentAmount: d.payment.amount.toFixed(2), amount: d.amount.toFixed(2), reference: d.reference, accountCode: d.account.code }));
  return { side, from, to, rows, total: rows.reduce((s, r) => s.plus(r.amount), D(0)).toFixed(2), missingReference: rows.filter((r) => !r.reference).length };
}

// ---------------------------------------------------------------------------
// Refunds: credit a party holds, paid out in money
// ---------------------------------------------------------------------------

const refundInput = z.object({
  party_id: text("الطرف"),
  cash_account_id: text("الخزينة / البنك"),
  date: z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD").optional(),
  amount: amount("المبلغ"),
  method: z.enum(METHODS, { errorMap: () => ({ message: "طريقة الدفع غير معروفة" }) }),
  reference: optText("المرجع", 100).optional(),
  reason: text("سبب الرد", 500),
  idempotency_key: z.string().min(8, "مفتاح التكرار قصير").max(120, "مفتاح التكرار طويل").optional(),
});

function refundDate(raw: string | undefined) {
  const today = todayLocalISO();
  const date = raw ?? today;
  if (date > today) throw new ApiError(400, "مينفعش تسجّل فلوس اتدفعت بتاريخ في المستقبل");
  return date;
}

/**
 * Pays a customer back out of the credit they hold with us — goods returned after they
 * had paid, or money paid twice. Never more than that credit (a refund is not a loan),
 * under the same per-customer lock as receipts. Dr AR / Cr cash. Inactive customers can
 * be refunded: closing an account is exactly when the last credit goes back.
 */
export async function createCustomerRefund(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.payments.manage");
  const v = parse(refundInput, input);
  const date = refundDate(v.date);
  return inTx(async (tx) => {
    if (v.idempotency_key) await advisoryXactLock(tx, `accounting:money-key:${v.idempotency_key}`);
    await advisoryXactLock(tx, `accounting:customer:${v.party_id}`);
    if (v.idempotency_key) {
      const prev = await tx.customerRefund.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) {
        sameMoney({ partyId: prev.customerId, amount: prev.amount, cashAccountId: prev.cashAccountId }, v);
        return { refund: prev, replayed: true };
      }
    }
    const customer = await tx.customer.findUnique({ where: { id: v.party_id } });
    if (!customer) throw new ApiError(404, "العميل مش موجود");
    const balance = await customerReceivable(tx, customer.id);
    if (!balance.lt(0)) throw new ApiError(409, `العميل ${customer.code} مالوش رصيد دائن عندنا يترد (رصيده ${balance.toFixed(2)})`);
    if (v.amount.greaterThan(balance.negated())) throw new ApiError(400, `أقصى مبلغ يترد للعميل ${customer.code} هو ${balance.negated().toFixed(2)}`);
    const cash = await accountOf(tx, v.cash_account_id);
    const refund = await tx.customerRefund.create({
      data: {
        number: await nextDocumentNumber(tx, "accounting.customer_refund", date),
        customerId: customer.id, cashAccountId: cash.id, date, amount: v.amount, method: v.method, reference: v.reference ?? null, reason: v.reason,
        idempotencyKey: v.idempotency_key ?? null, createdById: actor.id, createdBy: actor.name,
      },
    });
    await postJournal(tx, {
      date, description: `رد مبلغ ${refund.number} لـ ${customer.name}: ${v.reason}`, sourceType: "customer_refund", sourceId: refund.id,
      lines: [{ key: "ar", amount: v.amount, party: { type: "customer", id: customer.id } }, { accountId: cash.accountId, amount: v.amount.negated() }],
    }, actor);
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "customer_refund_created", entityType: "customer_refund", entityId: refund.id, newValue: `${refund.number} · ${customer.code} · ${v.amount.toFixed(2)}`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return { refund, replayed: false };
  });
}

/** The supplier-side mirror: a supplier pays back credit we hold with them. Dr cash / Cr AP. */
export async function createSupplierRefund(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.receipts.manage");
  const v = parse(refundInput, input);
  const date = refundDate(v.date);
  return inTx(async (tx) => {
    if (v.idempotency_key) await advisoryXactLock(tx, `accounting:money-key:${v.idempotency_key}`);
    await advisoryXactLock(tx, `accounting:supplier:${v.party_id}`);
    if (v.idempotency_key) {
      const prev = await tx.supplierRefund.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) {
        sameMoney({ partyId: prev.supplierId, amount: prev.amount, cashAccountId: prev.cashAccountId }, v);
        return { refund: prev, replayed: true };
      }
    }
    const supplier = await tx.supplier.findUnique({ where: { id: v.party_id } });
    if (!supplier) throw new ApiError(404, "المورد مش موجود");
    const payable = await supplierPayable(tx, supplier.id);
    if (!payable.lt(0)) throw new ApiError(409, `المورد ${supplier.code} مالناش عنده رصيد يسترد (رصيده ${payable.toFixed(2)})`);
    if (v.amount.greaterThan(payable.negated())) throw new ApiError(400, `أقصى مبلغ يسترد من المورد ${supplier.code} هو ${payable.negated().toFixed(2)}`);
    const cash = await accountOf(tx, v.cash_account_id);
    const refund = await tx.supplierRefund.create({
      data: {
        number: await nextDocumentNumber(tx, "accounting.supplier_refund", date),
        supplierId: supplier.id, cashAccountId: cash.id, date, amount: v.amount, method: v.method, reference: v.reference ?? null, reason: v.reason,
        idempotencyKey: v.idempotency_key ?? null, createdById: actor.id, createdBy: actor.name,
      },
    });
    await postJournal(tx, {
      date, description: `استرداد ${refund.number} من ${supplier.name}: ${v.reason}`, sourceType: "supplier_refund", sourceId: refund.id,
      lines: [{ accountId: cash.accountId, amount: v.amount }, { key: "ap", amount: v.amount.negated(), party: { type: "supplier", id: supplier.id } }],
    }, actor);
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "supplier_refund_created", entityType: "supplier_refund", entityId: refund.id, newValue: `${refund.number} · ${supplier.code} · ${v.amount.toFixed(2)}`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return { refund, replayed: false };
  });
}

export async function listCustomerRefunds(filters: { customerId?: string; limit?: number }) {
  const where = filters.customerId ? { customerId: filters.customerId } : {};
  const [total, rows] = await Promise.all([prisma.customerRefund.count({ where }), prisma.customerRefund.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], include: { customer: { select: { id: true, code: true, name: true, nameAr: true } }, cashAccount: { select: { name: true, nameAr: true } } }, take: listLimit(filters.limit) })]);
  return { total, items: rows.map((r) => ({ id: r.id, number: r.number, date: r.date, amount: r.amount.toFixed(2), method: r.method, reference: r.reference, reason: r.reason, createdBy: r.createdBy, customer: r.customer, cashAccount: r.cashAccount.name, cashAccountAr: r.cashAccount.nameAr })) };
}

export async function listSupplierRefunds(filters: { supplierId?: string; limit?: number }) {
  const where = filters.supplierId ? { supplierId: filters.supplierId } : {};
  const [total, rows] = await Promise.all([prisma.supplierRefund.count({ where }), prisma.supplierRefund.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], include: { supplier: { select: { id: true, code: true, name: true, nameAr: true } }, cashAccount: { select: { name: true, nameAr: true } } }, take: listLimit(filters.limit) })]);
  return { total, items: rows.map((r) => ({ id: r.id, number: r.number, date: r.date, amount: r.amount.toFixed(2), method: r.method, reference: r.reference, reason: r.reason, createdBy: r.createdBy, supplier: r.supplier, cashAccount: r.cashAccount.name, cashAccountAr: r.cashAccount.nameAr })) };
}

/** Book balance of every cash / bank account (from the GL). */
export async function cashPosition() {
  const accounts = await prisma.cashAccount.findMany({ where: { active: true }, include: { account: { select: { code: true } } }, orderBy: { code: "asc" } });
  const sums = await prisma.journalLine.groupBy({ by: ["accountId"], where: { accountId: { in: accounts.map((a) => a.accountId) } }, _sum: { debit: true, credit: true } });
  const by = new Map(sums.map((s) => [s.accountId, D(s._sum.debit ?? 0).minus(s._sum.credit ?? 0)]));
  const rows = accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, glCode: a.account.code, balance: (by.get(a.accountId) ?? D(0)).toFixed(2) }));
  return { rows, total: rows.reduce((s, r) => s.plus(r.balance), D(0)).toFixed(2) };
}

// ---------------------------------------------------------------------------
// Bank reconciliation (foundation): tick the book lines that appear on the statement;
// it completes when the cleared book balance equals the statement balance.
// ---------------------------------------------------------------------------

export async function startReconciliation(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({
    cash_account_id: text("الحساب"),
    statement_date: z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD"),
    statement_balance: z.union([z.number(), z.string()]).transform((x) => String(x).trim().replace(/,/g, "")).refine((x) => /^-?\d{1,13}(\.\d{1,2})?$/.test(x), "رصيد كشف الحساب رقم بحد أقصى خانتين عشريتين"),
  }), input);
  const balance = D(v.statement_balance);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `accounting:reconcile:${v.cash_account_id}`);
    await accountOf(tx, v.cash_account_id);
    const open = await tx.bankReconciliation.findFirst({ where: { cashAccountId: v.cash_account_id, status: "open" } });
    if (open) throw new ApiError(409, "فيه تسوية مفتوحة للحساب ده — كمّلها الأول");
    const rec = await tx.bankReconciliation.create({ data: { cashAccountId: v.cash_account_id, statementDate: v.statement_date, statementBalance: balance, createdBy: actor.name } });
    await audit(tx, actor, "bank_reconciliation", rec.id, "reconciliation_started", `${v.statement_date} · ${balance.toFixed(2)}`);
    return rec;
  });
}

/** Open reconciliations (to resume after a reload) and the latest completed ones. */
export async function listReconciliations() {
  const rows = await prisma.bankReconciliation.findMany({ orderBy: [{ status: "desc" }, { statementDate: "desc" }], take: 30, include: { cashAccount: { select: { id: true, code: true, name: true, nameAr: true } } } });
  return rows.map((r) => ({ id: r.id, status: r.status, statementDate: r.statementDate, statementBalance: r.statementBalance.toFixed(2), cashAccount: r.cashAccount, createdBy: r.createdBy, completedAt: r.completedAt, completedBy: r.completedBy }));
}

export async function getReconciliation(id: string, db: Tx | typeof prisma = prisma) {
  const rec = await db.bankReconciliation.findUnique({ where: { id }, include: { cashAccount: true } });
  if (!rec) throw new ApiError(404, "التسوية مش موجودة");
  const accountId = rec.cashAccount.accountId;
  // Cleared = every line matched by a completed reconciliation + the lines ticked in this
  // one (summed in the database, never from the displayed page of lines).
  const [prior, mine] = await Promise.all([
    db.journalLine.aggregate({ where: { accountId, reconciliation: { status: "completed", id: { not: id } } }, _sum: { debit: true, credit: true } }),
    db.journalLine.aggregate({ where: { accountId, reconciliationId: id }, _sum: { debit: true, credit: true } }),
  ]);
  const lines = await db.journalLine.findMany({
    where: { accountId, entry: { date: { lte: rec.statementDate } }, OR: [{ reconciliationId: null }, { reconciliationId: id }] },
    include: { entry: { select: { number: true, date: true, description: true } } },
    orderBy: { entry: { date: "asc" } },
    take: 2000,
  });
  const cleared = D(prior._sum.debit ?? 0).minus(prior._sum.credit ?? 0).plus(D(mine._sum.debit ?? 0).minus(mine._sum.credit ?? 0));
  return {
    id: rec.id, status: rec.status, cashAccount: { id: rec.cashAccount.id, name: rec.cashAccount.name, nameAr: rec.cashAccount.nameAr }, statementDate: rec.statementDate, statementBalance: rec.statementBalance.toFixed(2),
    clearedBalance: cleared.toFixed(2), difference: rec.statementBalance.minus(cleared).toFixed(2),
    lines: lines.map((l) => ({ id: l.id, date: l.entry.date, number: l.entry.number, description: l.description ?? l.entry.description, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2), cleared: l.reconciliationId === id })),
  };
}

export async function markReconciled(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ line_ids: z.array(z.string()).max(2000), cleared: z.boolean() }), input);
  return inTx(async (tx) => {
    const rec = await tx.bankReconciliation.findUnique({ where: { id }, include: { cashAccount: true } });
    if (!rec) throw new ApiError(404, "التسوية مش موجودة");
    await advisoryXactLock(tx, `accounting:reconcile:${rec.cashAccountId}`);
    return { changed: await markLines(tx, rec, v.line_ids, v.cleared) };
  });
}

async function markLines(tx: Tx, rec: { id: string; status: string; statementDate: string; cashAccount: { accountId: string } }, lineIds: string[], cleared: boolean) {
  const now = await tx.bankReconciliation.findUniqueOrThrow({ where: { id: rec.id }, select: { status: true } });
  if (now.status !== "open") throw new ApiError(409, "التسوية خلصت");
  const res = await tx.journalLine.updateMany({
    where: { id: { in: lineIds }, accountId: rec.cashAccount.accountId, ...(cleared ? { reconciliationId: null, entry: { date: { lte: rec.statementDate } } } : { reconciliationId: rec.id }) },
    data: { reconciliationId: cleared ? rec.id : null },
  });
  return res.count;
}

/**
 * Bank statement import: the statement's lines (pasted CSV or JSON) are matched against the
 * account's uncleared book lines — same signed amount (deposit +, withdrawal −), date within
 * the tolerance, the closest date first, a reference found in the entry number or text breaks
 * a tie. A statement line with exactly one best candidate is matched; two equally good
 * candidates are left for the accountant ("ambiguous"); nothing is guessed. With `apply`
 * the matched book lines are ticked in the same transaction. The statement itself is not
 * stored: the reconciliation keeps only which book lines cleared.
 */
const statementLine = z.object({
  date: z.string().refine(isValidISODate, "تاريخ سطر الكشف لازم يكون YYYY-MM-DD"),
  amount: z.union([z.number(), z.string()]).transform((x) => String(x).trim().replace(/,/g, "")).refine((x) => /^-?\d{1,13}(\.\d{1,2})?$/.test(x) && Number(x) !== 0, "مبلغ سطر الكشف رقم غير صفري بحد أقصى خانتين عشريتين"),
  reference: z.string().max(200).optional().nullable(),
});
type StatementLine = z.infer<typeof statementLine>;

/** "date,amount[,reference]" per row; a header row and blank rows are skipped. */
export function parseStatementCsv(csv: string): { lines: StatementLine[]; errors: { row: number; message: string }[] } {
  const lines: StatementLine[] = [], errors: { row: number; message: string }[] = [];
  csv.split(/\r?\n/).forEach((raw, i) => {
    const row = raw.trim();
    if (!row) return;
    const cells = row.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (i === 0 && !/^\d{4}-\d{2}-\d{2}$/.test(cells[0])) return; // header
    const r = statementLine.safeParse({ date: cells[0], amount: cells[1], reference: cells.slice(2).join(" ").trim() || null });
    if (r.success) lines.push(r.data); else errors.push({ row: i + 1, message: r.error.issues[0]?.message ?? "سطر غير صالح" });
  });
  return { lines, errors };
}

export async function matchStatement(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({
    lines: z.array(statementLine).max(2000).optional(),
    csv: z.string().max(500_000).optional(),
    tolerance_days: z.number().int().min(0).max(15).optional(),
    apply: z.boolean().optional(),
  }), input);
  const parsed = v.csv ? parseStatementCsv(v.csv) : { lines: v.lines ?? [], errors: [] };
  if (!parsed.lines.length) throw new ApiError(400, parsed.errors.length ? `كل سطور الكشف فيها أخطاء (أول خطأ سطر ${parsed.errors[0].row}: ${parsed.errors[0].message})` : "مفيش سطور في الكشف");
  if (parsed.lines.length > 2000) throw new ApiError(400, "أقصى 2000 سطر في الكشف");
  const tol = v.tolerance_days ?? 3;
  return inTx(async (tx) => {
    const rec = await tx.bankReconciliation.findUnique({ where: { id }, include: { cashAccount: true } });
    if (!rec) throw new ApiError(404, "التسوية مش موجودة");
    await advisoryXactLock(tx, `accounting:reconcile:${rec.cashAccountId}`);
    if (rec.status !== "open") throw new ApiError(409, "التسوية خلصت");
    // The pool holds the uncleared lines AND the lines already ticked in this reconciliation:
    // the statement is not stored, so a line matched (or ticked by hand) before must still
    // claim its statement line — otherwise importing the same statement twice would tick a
    // second, different book line for it.
    const book = await tx.journalLine.findMany({
      where: { accountId: rec.cashAccount.accountId, entry: { date: { lte: rec.statementDate } }, OR: [{ reconciliationId: null }, { reconciliationId: rec.id }] },
      include: { entry: { select: { number: true, date: true, description: true } } },
    });
    const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
    const used = new Set<string>();
    const matched: { statementRow: number; lineId: string; number: string; date: string; amount: string }[] = [];
    const alreadyCleared: { statementRow: number; lineId: string; number: string }[] = [];
    const ambiguous: { statementRow: number; candidates: string[] }[] = [];
    const unmatched: { statementRow: number; date: string; amount: string; reference: string | null }[] = [];
    const order = parsed.lines.map((l, i) => ({ l, i })).sort((a, b) => a.l.date.localeCompare(b.l.date));
    for (const { l, i } of order) {
      const amt = D(l.amount);
      const ref = (l.reference ?? "").toLowerCase();
      const cands = book
        .filter((b) => !used.has(b.id) && b.debit.minus(b.credit).equals(amt) && Math.abs(day(b.entry.date) - day(l.date)) <= tol)
        .map((b) => ({ b, gap: Math.abs(day(b.entry.date) - day(l.date)), refHit: !!ref && (`${b.entry.number} ${b.description ?? ""} ${b.entry.description}`).toLowerCase().includes(ref) ? 0 : 1, cleared: b.reconciliationId === rec.id ? 0 : 1 }))
        .sort((x, y) => x.refHit - y.refHit || x.gap - y.gap || x.cleared - y.cleared);
      if (!cands.length) { unmatched.push({ statementRow: i + 1, date: l.date, amount: amt.toFixed(2), reference: l.reference ?? null }); continue; }
      const best = cands[0];
      if (best.cleared === 0) { used.add(best.b.id); alreadyCleared.push({ statementRow: i + 1, lineId: best.b.id, number: best.b.entry.number }); continue; }
      if (cands.length > 1 && cands[1].refHit === best.refHit && cands[1].gap === best.gap) { ambiguous.push({ statementRow: i + 1, candidates: cands.filter((c) => c.refHit === best.refHit && c.gap === best.gap).map((c) => c.b.id) }); continue; }
      used.add(best.b.id);
      matched.push({ statementRow: i + 1, lineId: best.b.id, number: best.b.entry.number, date: best.b.entry.date, amount: amt.toFixed(2) });
    }
    let applied = 0;
    if (v.apply && matched.length) {
      applied = await markLines(tx, rec, matched.map((m) => m.lineId), true);
      await audit(tx, actor, "bank_reconciliation", rec.id, "reconciliation_statement_matched", `${parsed.lines.length} سطر كشف · ${applied} اتطابق`);
    }
    const statementTotal = parsed.lines.reduce((s, l) => s.plus(D(l.amount)), D(0));
    return {
      statementLines: parsed.lines.length, statementTotal: statementTotal.toFixed(2), parseErrors: parsed.errors,
      matched, alreadyCleared, ambiguous, unmatchedStatement: unmatched,
      unmatchedBook: book.filter((b) => !used.has(b.id) && b.reconciliationId !== rec.id).map((b) => ({ id: b.id, date: b.entry.date, number: b.entry.number, amount: b.debit.minus(b.credit).toFixed(2) })).slice(0, 500),
      applied, toleranceDays: tol,
    };
  });
}

export async function completeReconciliation(id: string, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  return inTx(async (tx) => {
    const head = await tx.bankReconciliation.findUnique({ where: { id }, select: { cashAccountId: true } });
    if (!head) throw new ApiError(404, "التسوية مش موجودة");
    // Under the account's reconciliation lock: no tick can change the balance between the
    // check and the completion.
    await advisoryXactLock(tx, `accounting:reconcile:${head.cashAccountId}`);
    const view = await getReconciliation(id, tx);
    if (view.status !== "open") throw new ApiError(409, "التسوية خلصت بالفعل");
    if (D(view.difference).abs().gt(0)) throw new ApiError(409, `فيه فرق ${view.difference} بين كشف الحساب والدفاتر`);
    const updated = await tx.bankReconciliation.update({ where: { id, status: "open" }, data: { status: "completed", completedBy: actor.name, completedAt: new Date() } });
    await audit(tx, actor, "bank_reconciliation", id, "reconciliation_completed", `${view.statementDate} · ${view.statementBalance}`);
    return updated;
  });
}
