import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { requestApproval, type Decider } from "@/lib/core/approvals";
import { lockKey, requestFingerprint } from "@/lib/core/idempotency";
import type { ServiceActor } from "@/lib/core/actor";
import { postJournal } from "@/lib/accounting/ledger";

/**
 * Purchasing custody (عهدة شراء): company money a buyer holds to pay suppliers at the market.
 *
 * It is NOT a separate ledger. It lives on 1600 employee advances (party = employee), next to
 * the employee's salary advances, and is told apart by the documents that move it:
 *
 *   issue      EmployeeTransaction advance / purchasing_custody   Dr 1600 (employee)  Cr cash-bank
 *              — only once a second person approves the EmployeeCustodyRequest (hr.custody_advance)
 *   spend      SupplierPayment with custodyEmployeeId               Dr AP (supplier)    Cr 1600 (employee)
 *              — through the existing supplier payment request / approval (accounting.supplier_payment)
 *   reversal   SupplierPaymentReversal of such a payment            Dr 1600 (employee)  Cr AP (supplier)
 *   return     EmployeeTransaction advance_return / purchasing_custody  Dr cash-bank    Cr 1600 (employee)
 *
 * The custody balance is read from the journal lines of exactly those documents; the salary-side
 * balance is the employee's whole 1600 balance less custody. Payroll and final settlement recover
 * only the salary side: custody is never deducted from pay automatically (pending owner decision —
 * it is shown for review instead), and an expense "paid from an advance" may not consume custody.
 */

export const CUSTODY = "purchasing_custody" as const;
export const PURCHASING_CATEGORIES = ["vegetable", "fruit", "other"] as const;
export type PurchasingCategory = (typeof PURCHASING_CATEGORIES)[number];
/** Who may override a buyer ↔ supplier category mismatch on a custody payment (with a written reason). */
export const CUSTODY_OVERRIDE_PERMISSION = "accounting.manage" as const;

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);
type Db = Tx | typeof prisma;

const CATEGORY_AR: Record<string, string> = { vegetable: "خضار", fruit: "فاكهة", other: "أخرى" };
export const categoryLabel = (c: string | null | undefined) => (c ? CATEGORY_AR[c] ?? c : "من غير فئة");

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/**
 * Custody held per employee, from the journal: 1600 lines (party = employee) of custody advances
 * and returns, custody supplier payments and their reversals (and any generic reversal of those).
 */
export async function custodyBalances(db: Db, employeeIds?: string[]): Promise<Map<string, Prisma.Decimal>> {
  if (employeeIds && !employeeIds.length) return new Map();
  const only = employeeIds ? Prisma.sql`AND l."partyId" IN (${Prisma.join(employeeIds)})` : Prisma.empty;
  const rows = await db.$queryRaw<{ id: string; v: Prisma.Decimal | null }[]>`
    WITH custody_entries AS (
      SELECT e."id" FROM "JournalEntry" e
      WHERE e."sourceType" IN ('supplier_payment', 'payment_reversal')
         OR (e."sourceType" = 'employee_transaction' AND EXISTS (SELECT 1 FROM "EmployeeTransaction" t WHERE t."id" = e."sourceId" AND t."purpose" = 'purchasing_custody'))
    )
    SELECT l."partyId" AS id, SUM(l."debit" - l."credit") AS v
    FROM "JournalLine" l
    JOIN "Account" a ON a."id" = l."accountId"
    JOIN "JournalEntry" je ON je."id" = l."entryId"
    WHERE a."systemKey" = 'employee_advances' AND l."partyType" = 'employee' ${only}
      AND (je."id" IN (SELECT "id" FROM custody_entries) OR je."reversalOfId" IN (SELECT "id" FROM custody_entries))
    GROUP BY l."partyId"`;
  return new Map(rows.map((r) => [r.id, D(r.v ?? 0)]));
}

export async function custodyBalance(db: Db, employeeId: string) {
  return (await custodyBalances(db, [employeeId])).get(employeeId) ?? ZERO;
}

/** The employee's whole 1600 balance (salary advances + custody). */
export async function advancesBalance(db: Db, employeeId: string) {
  const s = await db.journalLine.aggregate({ where: { partyType: "employee", partyId: employeeId, account: { systemKey: "employee_advances" } }, _sum: { debit: true, credit: true } });
  return D(s._sum.debit ?? 0).minus(s._sum.credit ?? 0);
}

/** The salary side of 1600: what payroll, final settlement and salary returns may act on. */
export async function salaryAdvanceBalance(db: Db, employeeId: string) {
  const [all, custody] = await Promise.all([advancesBalance(db, employeeId), custodyBalance(db, employeeId)]);
  return all.minus(custody);
}

/** What a request's deductions leave as the custody outflow (amount − withholding). */
const outOf = (amount: Prisma.Decimal, request: unknown) => {
  const deds = ((request as { deductions?: { amount: string }[] | null })?.deductions ?? []) as { amount: string }[];
  return deds.reduce((s, d) => s.minus(D(d.amount)), amount);
};

/** Custody already promised to supplier payment requests that wait for approval. */
export async function pendingCustodyPayments(db: Db, employeeId: string) {
  const reqs = await db.supplierPaymentRequest.findMany({ where: { custodyEmployeeId: employeeId, status: "pending_approval" }, select: { amount: true, request: true } });
  return reqs.reduce((s, r) => s.plus(outOf(r.amount, r.request)), ZERO);
}

/** Custody that can still be spent or returned: held, less what pending payment requests already promise. */
export async function custodyAvailable(db: Db, employeeId: string) {
  const [held, pending] = await Promise.all([custodyBalance(db, employeeId), pendingCustodyPayments(db, employeeId)]);
  return { held, pending, available: held.minus(pending) };
}

/** Serialises everything that consumes one employee's custody (payments, returns). */
export const lockCustody = (tx: Tx, employeeId: string) => advisoryXactLock(tx, `hr:custody:${employeeId}`);

/**
 * A custody payment must fit the custody the employee holds. At request time pending requests are
 * reserved too; at posting (approval) only what is posted counts — the request itself is pending.
 */
export async function assertCustodyCovers(tx: Tx, employee: { id: string; name: string; nameAr?: string | null }, out: Prisma.Decimal, phase: "request" | "post") {
  const { held, available } = await custodyAvailable(tx, employee.id);
  const room = phase === "request" ? available : held;
  if (room.lessThan(out)) {
    throw new ApiError(409, `العهدة المتاحة مع ${employee.nameAr ?? employee.name} ${room.toFixed(2)} بس — مش كفاية للسداد ${out.toFixed(2)}`, "custody_insufficient");
  }
}

/**
 * Samah buys vegetables, Youssef buys fruit: a custody payment goes to a supplier of the buyer's
 * own category. Anything else needs CUSTODY_OVERRIDE_PERMISSION and a written reason (audited by
 * the caller). `preApproved` is a request whose override was already authorised when it was made.
 */
export function checkCustodyCategory(
  employee: { name: string; nameAr?: string | null; purchasingCategory: string | null },
  supplier: { name: string; nameAr?: string | null; category: string | null },
  actor: { permissions?: readonly string[] },
  override: { reason?: string | null; preApproved?: boolean }
): { overridden: boolean } {
  if (employee.purchasingCategory && supplier.category && employee.purchasingCategory === supplier.category) return { overridden: false };
  if (override.preApproved) return { overridden: true };
  const reason = override.reason?.trim() ?? "";
  if (!reason) {
    throw new ApiError(
      400,
      employee.purchasingCategory
        ? `${employee.nameAr ?? employee.name} بيشتري ${categoryLabel(employee.purchasingCategory)} والمورد ${supplier.nameAr ?? supplier.name} فئته ${categoryLabel(supplier.category)} — السداد من العهدة لمورد من فئة تانية محتاج استثناء بسبب مكتوب`
        : `${employee.nameAr ?? employee.name} مش متحدد له فئة شراء — حددها في ملف الموظف، أو اعمل استثناء بسبب مكتوب`,
      "custody_category_mismatch"
    );
  }
  if (!actorCan(actor, CUSTODY_OVERRIDE_PERMISSION)) throw new ApiError(403, "استثناء فئة المورد محتاج صلاحية إدارة الحسابات");
  if (reason.length < 5) throw new ApiError(400, "اكتب سبب واضح للاستثناء (5 حروف على الأقل)");
  return { overridden: true };
}

// ---------------------------------------------------------------------------
// Issuing custody: a request, approved by someone else
// ---------------------------------------------------------------------------

export type CustodyAdvanceInput = { employee_id: string; cash_account_id: string; amount: Prisma.Decimal; date: string; reference: string | null; notes: string | null; idempotency_key?: string };

/** Records a custody advance as a request; nothing moves until a second person approves it. */
export async function requestCustodyAdvance(v: CustodyAdvanceInput, actor: ServiceActor) {
  assertPermission(actor, "hr.advances.manage");
  const requestHash = requestFingerprint({ custody: v.employee_id, cash: v.cash_account_id, amount: v.amount, date: v.date, reference: v.reference, notes: v.notes });
  const result = await inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.employeeCustodyRequest.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) {
        if (prev.requestHash !== requestHash) throw new ApiError(409, "مفتاح التكرار ده اتستخدم في عملية تانية");
        return { custodyRequest: prev, replayed: true };
      }
    }
    const emp = await tx.employee.findUnique({ where: { id: v.employee_id } });
    if (!emp || !emp.active) throw new ApiError(400, "الموظف مش موجود أو موقوف");
    const cash = await tx.cashAccount.findFirst({ where: { id: v.cash_account_id, active: true } });
    if (!cash) throw new ApiError(400, "الخزينة مش موجودة");
    const req = await tx.employeeCustodyRequest.create({
      data: {
        number: await nextDocumentNumber(tx, "hr.custody_request", v.date), employeeId: emp.id, cashAccountId: cash.id, date: v.date, amount: v.amount,
        reference: v.reference, notes: v.notes, status: "pending_approval", idempotencyKey: v.idempotency_key ?? null, requestHash, requestedById: actor.id, requestedBy: actor.name,
      },
    });
    await requestApproval(tx, { type: "hr.custody_advance", entityId: req.id, title: `عهدة شراء ${req.number} لـ ${emp.nameAr ?? emp.name} من ${cash.nameAr ?? cash.name}`, summary: `${v.amount.toFixed(2)} ج.م${v.reference ? ` · ${v.reference}` : ""}`, amount: v.amount, requester: actor });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "custody_advance_requested", entityType: "employee_custody_request", entityId: req.id, fieldChanged: emp.code, newValue: `${req.number} · ${v.amount.toFixed(2)} · ${cash.code}${v.reference ? ` · ${v.reference}` : ""}`, source: "user", deviceId: actor.deviceId }, tx);
    return { custodyRequest: req, replayed: false };
  });
  return { ...result, document: { status: "pending_approval" as const } };
}

/**
 * Approval handler (hr.custody_advance). Approved by someone other than the requester: the custody
 * advance is written and posts now (Dr 1600 employee / Cr cash-bank), as the requester's, with the
 * approver as poster. Rejected: nothing moves.
 */
export async function applyCustodyAdvanceDecision(tx: Tx, requestId: string, approved: boolean, decider: Decider, comment?: string) {
  const req = await tx.employeeCustodyRequest.findUnique({ where: { id: requestId }, include: { employee: true, cashAccount: true } });
  if (!req) throw new ApiError(404, "طلب العهدة مش موجود");
  if (req.status !== "pending_approval") throw new ApiError(409, "طلب العهدة ده اتقرر قبل كده");
  if (!decider.id || (req.requestedById && req.requestedById === decider.id)) throw new ApiError(403, "اللي طلب العهدة مينفعش يعتمدها بنفسه");
  const auditDecision = (action: string, detail: string) =>
    writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action, entityType: "employee_custody_request", entityId: req.id, fieldChanged: req.employee.code, newValue: detail, reason: comment ?? undefined, source: "user", deviceId: decider.deviceId }, tx);
  if (!approved) {
    await tx.employeeCustodyRequest.update({ where: { id: req.id, version: req.version }, data: { status: "rejected", decidedById: decider.id, decidedBy: decider.name, decidedAt: new Date(), decisionNote: comment ?? null, version: { increment: 1 } } });
    await auditDecision("custody_advance_rejected", req.number);
    return;
  }
  if (!req.employee.active) throw new ApiError(400, "الموظف مش موجود أو موقوف");
  if (!req.cashAccount.active) throw new ApiError(400, "الخزينة مش موجودة");
  if (!req.cashAccount.allowOverdraft) {
    const bal = await tx.journalLine.aggregate({ where: { accountId: req.cashAccount.accountId }, _sum: { debit: true, credit: true } });
    const available = D(bal._sum.debit ?? 0).minus(bal._sum.credit ?? 0);
    if (available.lessThan(req.amount)) throw new ApiError(409, `رصيد ${req.cashAccount.nameAr ?? req.cashAccount.name} ${available.toFixed(2)} مش كفاية للسداد ${req.amount.toFixed(2)} — الخزينة/البنك مينفعش يبقى بالسالب`, "cash_account_negative");
  }
  const t = await tx.employeeTransaction.create({
    data: { employeeId: req.employeeId, type: "advance", purpose: CUSTODY, date: req.date, amount: req.amount, cashAccountId: req.cashAccountId, reference: req.reference, notes: req.notes, createdById: req.requestedById, createdBy: req.requestedBy },
  });
  await postJournal(tx, {
    date: req.date, description: `عهدة شراء ${req.number} — ${req.employee.name}`, sourceType: "employee_transaction", sourceId: t.id,
    lines: [{ key: "employee_advances", amount: req.amount, party: { type: "employee", id: req.employeeId } }, { accountId: req.cashAccount.accountId, amount: req.amount.negated() }],
  }, decider);
  await tx.employeeCustodyRequest.update({ where: { id: req.id, version: req.version }, data: { status: "posted", transactionId: t.id, decidedById: decider.id, decidedBy: decider.name, decidedAt: new Date(), decisionNote: comment ?? null, version: { increment: 1 } } });
  await auditDecision("custody_advance_approved", `${req.number} · ${req.amount.toFixed(2)} · ${req.cashAccount.code}`);
  await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "employee_advance", entityType: "employee_transaction", entityId: t.id, newValue: `${req.employee.code} · ${req.amount.toFixed(2)} · ${CUSTODY} · ${req.number}`, source: "user", deviceId: decider.deviceId }, tx);
}

// ---------------------------------------------------------------------------
// Reading custody
// ---------------------------------------------------------------------------

/** Custody payments (not reversed) with no attachment — the receipts still to collect. */
async function missingReceiptIds(db: Db, paymentIds: string[]) {
  if (!paymentIds.length) return new Set<string>();
  const filed = await db.attachment.groupBy({ by: ["entityId"], where: { entityType: "supplier_payment", entityId: { in: paymentIds }, deletedAt: null } });
  const has = new Set(filed.map((f) => f.entityId));
  return new Set(paymentIds.filter((id) => !has.has(id)));
}

type Row = { date: string; kind: "advance" | "payment" | "payment_reversal" | "return"; number: string; description: string; supplier?: { id: string; code: string; name: string; nameAr: string | null } | null; bills?: string[]; in: string; out: string; balance: string; missingReceipt?: boolean; by?: string | null; approvedBy?: string | null; reference?: string | null; createdAt: Date };

/** One employee's custody, document by document, kept apart from salary advances. */
export async function custodyStatement(employeeId: string, actor: ServiceActor) {
  assertCanReadCustody(actor);
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, code: true, name: true, nameAr: true, active: true, purchasingCategory: true } });
  if (!emp) throw new ApiError(404, "الموظف مش موجود");
  const [txs, payments, pendingAdvances, pendingPayments, held, all] = await Promise.all([
    prisma.employeeTransaction.findMany({ where: { employeeId, purpose: CUSTODY }, include: { custodyRequest: { select: { number: true, decidedBy: true } } }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] }),
    prisma.supplierPayment.findMany({
      where: { custodyEmployeeId: employeeId },
      include: { supplier: { select: { id: true, code: true, name: true, nameAr: true } }, deductions: true, reversal: true, request: { select: { number: true, decidedBy: true } }, allocations: { include: { bill: { select: { number: true, supplierInvoiceNo: true } } } } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    }),
    prisma.employeeCustodyRequest.findMany({ where: { employeeId, status: "pending_approval" }, include: { cashAccount: { select: { name: true, nameAr: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.supplierPaymentRequest.findMany({ where: { custodyEmployeeId: employeeId, status: "pending_approval" }, include: { supplier: { select: { id: true, code: true, name: true, nameAr: true } } }, orderBy: { createdAt: "asc" } }),
    custodyBalance(prisma, employeeId),
    advancesBalance(prisma, employeeId),
  ]);
  const missing = await missingReceiptIds(prisma, payments.filter((p) => !p.reversal).map((p) => p.id));
  const events: Omit<Row, "balance">[] = [];
  for (const t of txs) {
    events.push(t.type === "advance"
      ? { date: t.date, kind: "advance", number: t.custodyRequest?.number ?? "", description: t.notes ?? "", in: t.amount.toFixed(2), out: "0.00", by: t.createdBy, approvedBy: t.custodyRequest?.decidedBy ?? null, reference: t.reference, createdAt: t.createdAt }
      : { date: t.date, kind: "return", number: "", description: t.notes ?? "", in: "0.00", out: t.amount.toFixed(2), by: t.createdBy, reference: t.reference, createdAt: t.createdAt });
  }
  for (const p of payments) {
    const out = p.amount.minus(p.deductions.reduce((s, d) => s.plus(d.amount), ZERO));
    const bills = p.allocations.map((a) => a.bill?.number).filter((x): x is string => !!x);
    events.push({ date: p.date, kind: "payment", number: p.number, description: p.notes ?? "", supplier: p.supplier, bills, in: "0.00", out: out.toFixed(2), missingReceipt: missing.has(p.id), by: p.createdBy, approvedBy: p.request?.decidedBy ?? null, reference: p.reference, createdAt: p.createdAt });
    if (p.reversal) events.push({ date: p.reversal.date, kind: "payment_reversal", number: p.number, description: p.reversal.reason, supplier: p.supplier, in: out.toFixed(2), out: "0.00", by: p.reversal.createdBy, createdAt: p.reversal.createdAt });
  }
  events.sort((a, b) => (a.date === b.date ? a.createdAt.getTime() - b.createdAt.getTime() : a.date < b.date ? -1 : 1));
  let run = ZERO;
  const rows: Row[] = events.map((e) => {
    run = run.plus(e.in).minus(e.out);
    return { ...e, balance: run.toFixed(2) };
  });
  const sum = (k: Row["kind"], f: "in" | "out") => rows.filter((r) => r.kind === k).reduce((s, r) => s.plus(r[f]), ZERO).toFixed(2);
  const pendingOut = pendingPayments.reduce((s, r) => s.plus(outOf(r.amount, r.request)), ZERO);
  return {
    employee: emp,
    rows: rows.map(({ createdAt: _c, ...r }) => r),
    totals: { issued: sum("advance", "in"), paidToSuppliers: D(sum("payment", "out")).minus(sum("payment_reversal", "in")).toFixed(2), returned: sum("return", "out") },
    /** What the documents add up to and what the journal holds — they must agree. */
    held: held.toFixed(2),
    documents: run.toFixed(2),
    reconciled: run.equals(held),
    /** The rest of 1600 for this employee: salary advances, recovered by payroll. */
    salaryAdvances: all.minus(held).toFixed(2),
    pending: {
      advances: pendingAdvances.map((r) => ({ id: r.id, number: r.number, date: r.date, amount: r.amount.toFixed(2), reference: r.reference, cashAccount: r.cashAccount.name, cashAccountAr: r.cashAccount.nameAr, requestedBy: r.requestedBy })),
      payments: pendingPayments.map((r) => ({ id: r.id, number: r.number, date: r.date, amount: r.amount.toFixed(2), supplier: r.supplier, requestedBy: r.requestedBy })),
      paymentsTotal: pendingOut.toFixed(2),
    },
    available: held.minus(pendingOut).toFixed(2),
    missingReceipts: rows.filter((r) => r.missingReceipt).length,
  };
}

function assertCanReadCustody(actor: ServiceActor) {
  if (!(actorCan(actor, "hr.advances.manage") || actorCan(actor, "hr.employees.manage") || actorCan(actor, "accounting.view") || actorCan(actor, "accounting.payments.manage"))) {
    assertPermission(actor, "hr.advances.manage");
  }
}

/**
 * Every custody holder (anyone with a purchasing category, custody held, or custody pending):
 * held, pending, available, and how many custody payments still have no receipt attached.
 */
export async function listCustody(actor: ServiceActor) {
  assertCanReadCustody(actor);
  const [balances, pendingAdv, pendingPay, payments] = await Promise.all([
    custodyBalances(prisma),
    prisma.employeeCustodyRequest.groupBy({ by: ["employeeId"], where: { status: "pending_approval" }, _sum: { amount: true }, _count: true }),
    prisma.supplierPaymentRequest.findMany({ where: { status: "pending_approval", custodyEmployeeId: { not: null } }, select: { custodyEmployeeId: true, amount: true, request: true } }),
    prisma.supplierPayment.findMany({ where: { custodyEmployeeId: { not: null }, reversal: null }, select: { id: true, custodyEmployeeId: true } }),
  ]);
  const missing = await missingReceiptIds(prisma, payments.map((p) => p.id));
  const missingBy = new Map<string, number>();
  for (const p of payments) if (missing.has(p.id)) missingBy.set(p.custodyEmployeeId!, (missingBy.get(p.custodyEmployeeId!) ?? 0) + 1);
  const pendingPayBy = new Map<string, Prisma.Decimal>();
  for (const r of pendingPay) pendingPayBy.set(r.custodyEmployeeId!, (pendingPayBy.get(r.custodyEmployeeId!) ?? ZERO).plus(outOf(r.amount, r.request)));
  const pendingAdvBy = new Map(pendingAdv.map((r) => [r.employeeId, D(r._sum.amount ?? 0)]));
  const ids = new Set<string>([...balances.keys(), ...pendingAdvBy.keys(), ...pendingPayBy.keys(), ...missingBy.keys()]);
  const emps = await prisma.employee.findMany({ where: { OR: [{ id: { in: [...ids] } }, { purchasingCategory: { not: null } }] }, select: { id: true, code: true, name: true, nameAr: true, active: true, purchasingCategory: true }, orderBy: { code: "asc" } });
  return {
    holders: emps.map((e) => {
      const held = balances.get(e.id) ?? ZERO;
      const pend = pendingPayBy.get(e.id) ?? ZERO;
      return { ...e, held: held.toFixed(2), pendingAdvances: (pendingAdvBy.get(e.id) ?? ZERO).toFixed(2), pendingPayments: pend.toFixed(2), available: held.minus(pend).toFixed(2), missingReceipts: missingBy.get(e.id) ?? 0 };
    }),
  };
}

/** Custody payments with no receipt attached (missing-receipt list), newest first. */
export async function missingCustodyReceipts(actor: ServiceActor, filter: { employeeId?: string } = {}) {
  assertCanReadCustody(actor);
  const payments = await prisma.supplierPayment.findMany({
    where: { custodyEmployeeId: filter.employeeId ?? { not: null }, reversal: null },
    include: { supplier: { select: { id: true, code: true, name: true, nameAr: true } }, custodyEmployee: { select: { id: true, code: true, name: true, nameAr: true } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
  const missing = await missingReceiptIds(prisma, payments.map((p) => p.id));
  return { payments: payments.filter((p) => missing.has(p.id)).map((p) => ({ id: p.id, number: p.number, date: p.date, amount: p.amount.toFixed(2), reference: p.reference, supplier: p.supplier, employee: p.custodyEmployee })) };
}

export const purchasingCategoryField = z.enum(PURCHASING_CATEGORIES, { errorMap: () => ({ message: "فئة الشراء لازم تكون خضار أو فاكهة أو أخرى" }) });
