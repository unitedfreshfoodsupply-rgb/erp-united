import { Prisma } from "@prisma/client";
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
import type { ServiceActor } from "@/lib/core/actor";
import { postJournal } from "@/lib/accounting/ledger";
import { customerReceivable } from "@/lib/sales/invoicing";
import { supplierPayable } from "@/lib/purchasing/bills";

/**
 * Cash and bank: customer receipts and supplier payments (each allocated to invoices /
 * bills, the rest held on account), cash positions, and bank reconciliation.
 *
 * A receipt or payment is permanent and posts its journal entry in the same
 * transaction. Allocation never exceeds what the document has open nor what the
 * receipt/payment has left (the latter also DB-enforced); one party's money moves one
 * at a time (advisory lock), so two receipts cannot both settle the same invoice.
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
  idempotency_key: z.string().min(8, "مفتاح التكرار قصير").max(120, "مفتاح التكرار طويل").optional(),
});

/** A repeat of the same submit returns the first document; the same key on a different submit is refused. */
function sameMoney(prev: { partyId: string; amount: Prisma.Decimal; cashAccountId: string }, v: { party_id: string; amount: Prisma.Decimal; cash_account_id: string }) {
  if (prev.partyId !== v.party_id || !prev.amount.eq(v.amount) || prev.cashAccountId !== v.cash_account_id) throw new ApiError(409, "مفتاح التكرار ده اتستخدم في عملية تانية");
}

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
      const prev = await tx.customerReceipt.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) {
        sameMoney({ partyId: prev.customerId, amount: prev.amount, cashAccountId: prev.cashAccountId }, v);
        return prev;
      }
    }
    const customer = await tx.customer.findUnique({ where: { id: v.party_id } });
    if (!customer) throw new ApiError(404, "العميل مش موجود");
    const cash = await accountOf(tx, v.cash_account_id);
    const allocations = allocate(await openInvoices(tx, customer.id), v.amount, v.allocations, v.auto);
    const receipt = await tx.customerReceipt.create({
      data: {
        number: await nextDocumentNumber(tx, "accounting.receipt", date),
        customerId: customer.id, cashAccountId: cash.id, date, amount: v.amount, method: v.method, reference: v.reference ?? null, notes: v.notes ?? null, idempotencyKey: v.idempotency_key ?? null,
        createdById: actor.id, createdBy: actor.name,
        allocations: { createMany: { data: allocations.map((a) => ({ invoiceId: a.target === "invoice" ? a.id : null, openingBalanceId: a.target === "opening_balance" ? a.id : null, amount: a.amount })) } },
      },
    });
    await postJournal(tx, {
      date, description: `تحصيل ${receipt.number} من ${customer.name}${v.reference ? ` (${v.reference})` : ""}`, sourceType: "customer_receipt", sourceId: receipt.id,
      lines: [{ accountId: cash.accountId, amount: v.amount }, { key: "ar", amount: v.amount.negated(), party: { type: "customer", id: customer.id } }],
    }, actor);
    const applied = allocations.reduce((s, a) => s.plus(a.amount), D(0));
    await audit(tx, actor, "customer_receipt", receipt.id, "receipt_created", `${receipt.number} · ${customer.code} · ${v.amount.toFixed(2)} · مخصص ${applied.toFixed(2)}`);
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
      const prev = await tx.supplierPayment.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) {
        sameMoney({ partyId: prev.supplierId, amount: prev.amount, cashAccountId: prev.cashAccountId }, v);
        return prev;
      }
    }
    const supplier = await tx.supplier.findUnique({ where: { id: v.party_id } });
    if (!supplier) throw new ApiError(404, "المورد مش موجود");
    const cash = await accountOf(tx, v.cash_account_id);
    const allocations = allocate(await openBills(tx, supplier.id), v.amount, v.allocations, v.auto);
    const payment = await tx.supplierPayment.create({
      data: {
        number: await nextDocumentNumber(tx, "accounting.payment", date),
        supplierId: supplier.id, cashAccountId: cash.id, date, amount: v.amount, method: v.method, reference: v.reference ?? null, notes: v.notes ?? null, idempotencyKey: v.idempotency_key ?? null,
        createdById: actor.id, createdBy: actor.name,
        allocations: { createMany: { data: allocations.map((a) => ({ billId: a.target === "bill" ? a.id : null, openingBalanceId: a.target === "opening_balance" ? a.id : null, amount: a.amount })) } },
      },
    });
    await postJournal(tx, {
      date, description: `سداد ${payment.number} لـ ${supplier.name}${v.reference ? ` (${v.reference})` : ""}`, sourceType: "supplier_payment", sourceId: payment.id,
      lines: [{ key: "ap", amount: v.amount, party: { type: "supplier", id: supplier.id } }, { accountId: cash.accountId, amount: v.amount.negated() }],
    }, actor);
    const applied = allocations.reduce((s, a) => s.plus(a.amount), D(0));
    await audit(tx, actor, "supplier_payment", payment.id, "payment_created", `${payment.number} · ${supplier.code} · ${v.amount.toFixed(2)} · مخصص ${applied.toFixed(2)}`);
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
    const r = await tx.customerReceipt.findUniqueOrThrow({ where: { id }, include: { reversal: true, customer: { select: { name: true } }, cashAccount: { select: { accountId: true } } } });
    if (r.reversal) throw new ApiError(409, "الإيصال ده اتعكس قبل كده");
    const date = v.date ?? todayLocalISO();
    if (date < r.date) throw new ApiError(400, "تاريخ العكس قبل تاريخ الإيصال");
    const rev = await tx.customerReceiptReversal.create({ data: { receiptId: r.id, date, reason: v.reason, createdById: actor.id, createdBy: actor.name } });
    await postJournal(tx, {
      date, description: `عكس تحصيل ${r.number} من ${r.customer.name}: ${v.reason}`, sourceType: "receipt_reversal", sourceId: rev.id,
      lines: [{ key: "ar", amount: r.amount, party: { type: "customer", id: r.customerId } }, { accountId: r.cashAccount.accountId, amount: r.amount.negated() }],
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
    const p = await tx.supplierPayment.findUniqueOrThrow({ where: { id }, include: { reversal: true, supplier: { select: { name: true, nameAr: true } }, cashAccount: { select: { accountId: true } } } });
    if (p.reversal) throw new ApiError(409, "السداد ده اتعكس قبل كده");
    const date = v.date ?? todayLocalISO();
    if (date < p.date) throw new ApiError(400, "تاريخ العكس قبل تاريخ السداد");
    const rev = await tx.supplierPaymentReversal.create({ data: { paymentId: p.id, date, reason: v.reason, createdById: actor.id, createdBy: actor.name } });
    await postJournal(tx, {
      date, description: `عكس سداد ${p.number} لـ ${p.supplier.name}: ${v.reason}`, sourceType: "payment_reversal", sourceId: rev.id,
      lines: [{ key: "ap", amount: p.amount.negated(), party: { type: "supplier", id: p.supplierId } }, { accountId: p.cashAccount.accountId, amount: p.amount }],
    }, actor);
    await audit(tx, actor, "supplier_payment", p.id, "payment_reversed", `${p.number} · ${p.amount.toFixed(2)} · ${v.reason}`);
    return rev;
  });
}

const present = (r: { id: string; number: string; date: string; amount: Prisma.Decimal; method: string; reference: string | null; createdBy: string; allocations: { amount: Prisma.Decimal }[]; reversal: { date: string; reason: string; createdBy: string } | null }) => {
  const applied = r.reversal ? D(0) : r.allocations.reduce((s, a) => s.plus(a.amount), D(0));
  return {
    id: r.id, number: r.number, date: r.date, amount: r.amount.toFixed(2), method: r.method, reference: r.reference, createdBy: r.createdBy,
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
    prisma.customerReceipt.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], include: { allocations: true, reversal: true, customer: { select: { id: true, code: true, name: true, nameAr: true } }, cashAccount: { select: { name: true } } }, skip, take }),
  ]);
  return { receipts: rows.map((r) => ({ ...present(r), customer: r.customer, cashAccount: r.cashAccount.name })), pagination: { total, limit: take, offset: skip } };
}

export async function listPayments(filters: { supplierId?: string; limit?: number; offset?: number }) {
  const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const skip = Math.max(filters.offset ?? 0, 0);
  const where = filters.supplierId ? { supplierId: filters.supplierId } : {};
  const [total, rows] = await Promise.all([
    prisma.supplierPayment.count({ where }),
    prisma.supplierPayment.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], include: { allocations: true, reversal: true, supplier: { select: { id: true, code: true, name: true, nameAr: true } }, cashAccount: { select: { name: true } } }, skip, take }),
  ]);
  return { payments: rows.map((r) => ({ ...present(r), supplier: r.supplier, cashAccount: r.cashAccount.name })), pagination: { total, limit: take, offset: skip } };
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

export async function listCustomerRefunds(filters: { customerId?: string }) {
  const rows = await prisma.customerRefund.findMany({ where: filters.customerId ? { customerId: filters.customerId } : {}, orderBy: [{ date: "desc" }, { createdAt: "desc" }], include: { customer: { select: { id: true, code: true, name: true, nameAr: true } }, cashAccount: { select: { name: true } } }, take: 300 });
  return rows.map((r) => ({ id: r.id, number: r.number, date: r.date, amount: r.amount.toFixed(2), method: r.method, reference: r.reference, reason: r.reason, createdBy: r.createdBy, customer: r.customer, cashAccount: r.cashAccount.name }));
}

export async function listSupplierRefunds(filters: { supplierId?: string }) {
  const rows = await prisma.supplierRefund.findMany({ where: filters.supplierId ? { supplierId: filters.supplierId } : {}, orderBy: [{ date: "desc" }, { createdAt: "desc" }], include: { supplier: { select: { id: true, code: true, name: true, nameAr: true } }, cashAccount: { select: { name: true } } }, take: 300 });
  return rows.map((r) => ({ id: r.id, number: r.number, date: r.date, amount: r.amount.toFixed(2), method: r.method, reference: r.reference, reason: r.reason, createdBy: r.createdBy, supplier: r.supplier, cashAccount: r.cashAccount.name }));
}

/** Book balance of every cash / bank account (from the GL). */
export async function cashPosition() {
  const accounts = await prisma.cashAccount.findMany({ where: { active: true }, include: { account: { select: { code: true } } }, orderBy: { code: "asc" } });
  const sums = await prisma.journalLine.groupBy({ by: ["accountId"], where: { accountId: { in: accounts.map((a) => a.accountId) } }, _sum: { debit: true, credit: true } });
  const by = new Map(sums.map((s) => [s.accountId, D(s._sum.debit ?? 0).minus(s._sum.credit ?? 0)]));
  const rows = accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, glCode: a.account.code, balance: (by.get(a.accountId) ?? D(0)).toFixed(2) }));
  return { rows, total: rows.reduce((s, r) => s.plus(r.balance), D(0)).toFixed(2) };
}

// ---------------------------------------------------------------------------
// Bank reconciliation (foundation): tick the book lines that appear on the statement;
// it completes when the cleared book balance equals the statement balance.
// ---------------------------------------------------------------------------

export async function startReconciliation(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ cash_account_id: text("الحساب"), statement_date: z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD"), statement_balance: z.union([z.number(), z.string()]) }), input);
  const balance = D(String(v.statement_balance));
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

export async function getReconciliation(id: string) {
  const rec = await prisma.bankReconciliation.findUnique({ where: { id }, include: { cashAccount: true } });
  if (!rec) throw new ApiError(404, "التسوية مش موجودة");
  const accountId = rec.cashAccount.accountId;
  // Cleared before this reconciliation: lines matched by completed ones.
  const prior = await prisma.journalLine.aggregate({ where: { accountId, reconciliation: { status: "completed", id: { not: id } } }, _sum: { debit: true, credit: true } });
  const lines = await prisma.journalLine.findMany({
    where: { accountId, entry: { date: { lte: rec.statementDate } }, OR: [{ reconciliationId: null }, { reconciliationId: id }] },
    include: { entry: { select: { number: true, date: true, description: true } } },
    orderBy: { entry: { date: "asc" } },
    take: 1000,
  });
  const cleared = D(prior._sum.debit ?? 0).minus(prior._sum.credit ?? 0).plus(lines.filter((l) => l.reconciliationId === id).reduce((s, l) => s.plus(l.debit).minus(l.credit), D(0)));
  return {
    id: rec.id, status: rec.status, cashAccount: { id: rec.cashAccount.id, name: rec.cashAccount.name }, statementDate: rec.statementDate, statementBalance: rec.statementBalance.toFixed(2),
    clearedBalance: cleared.toFixed(2), difference: rec.statementBalance.minus(cleared).toFixed(2),
    lines: lines.map((l) => ({ id: l.id, date: l.entry.date, number: l.entry.number, description: l.description ?? l.entry.description, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2), cleared: l.reconciliationId === id })),
  };
}

export async function markReconciled(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ line_ids: z.array(z.string()).max(1000), cleared: z.boolean() }), input);
  return inTx(async (tx) => {
    const rec = await tx.bankReconciliation.findUnique({ where: { id }, include: { cashAccount: true } });
    if (!rec) throw new ApiError(404, "التسوية مش موجودة");
    await advisoryXactLock(tx, `accounting:reconcile:${rec.cashAccountId}`);
    if (rec.status !== "open") throw new ApiError(409, "التسوية خلصت");
    const res = await tx.journalLine.updateMany({
      where: { id: { in: v.line_ids }, accountId: rec.cashAccount.accountId, ...(v.cleared ? { reconciliationId: null, entry: { date: { lte: rec.statementDate } } } : { reconciliationId: id }) },
      data: { reconciliationId: v.cleared ? id : null },
    });
    return { changed: res.count };
  });
}

export async function completeReconciliation(id: string, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const view = await getReconciliation(id);
  if (view.status !== "open") throw new ApiError(409, "التسوية خلصت بالفعل");
  if (D(view.difference).abs().gt(0)) throw new ApiError(409, `فيه فرق ${view.difference} بين كشف الحساب والدفاتر`);
  return inTx(async (tx) => {
    const updated = await tx.bankReconciliation.update({ where: { id, status: "open" }, data: { status: "completed", completedBy: actor.name, completedAt: new Date() } });
    await audit(tx, actor, "bank_reconciliation", id, "reconciliation_completed", `${view.statementDate} · ${view.statementBalance}`);
    return updated;
  });
}
