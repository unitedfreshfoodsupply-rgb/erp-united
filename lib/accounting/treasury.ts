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
import { idempotencyKeyField, lockKey, replayRequest, requestFingerprint } from "@/lib/core/idempotency";
import { getSetting } from "@/lib/core/settings-service";
import { requestApproval, type Decider } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";
import { controlAccountMovedBy, postJournal } from "@/lib/accounting/ledger";

/**
 * Treasury: the cash boxes and bank accounts themselves, and money moved between them.
 *
 * Each cash box / bank account is backed by its own postable GL account (created with it,
 * under Assets), so its balance is that account's balance and every receipt, payment,
 * refund, expense, payroll payment and transfer that names it moves it.
 *
 *   transfer          Dr destination            Cr source        (amount)
 *   transfer fee      Dr bank charges account    Cr source        (fee, if any)
 *   reversal          the same lines, the other way round, dated the day of the reversal
 *
 * A transfer is income for nobody: it touches only cash accounts (and the fee expense), so
 * the P&L and the cash-flow statement's total are unchanged by it. Above the approval
 * threshold (when approval is switched on) it waits, unposted, for someone else to approve.
 * A cash box never goes below zero; a bank account may (overdraft is the bank's business).
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const money = (label: string, allowZero = false) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim();
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(s) || (!allowZero && Number(s) <= 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} لازم يكون ${allowZero ? "صفر أو أكتر" : "أكبر من صفر"} بحد أقصى خانتين عشريتين` });
      return z.NEVER;
    }
    return D(s);
  });

const audit = (tx: Tx, actor: { id: string | null; name: string; role: string; deviceId?: string }, entityType: "cash_account" | "cash_transfer", id: string, action: string, detail: string, reason?: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType, entityId: id, newValue: detail, reason, source: "user", deviceId: actor.deviceId }, tx);

async function balanceOf(db: Tx | typeof prisma, accountId: string) {
  const a = await db.journalLine.aggregate({ where: { accountId }, _sum: { debit: true, credit: true } });
  return D(a._sum.debit ?? 0).minus(a._sum.credit ?? 0);
}

// ---------------------------------------------------------------------------
// Cash boxes and bank accounts
// ---------------------------------------------------------------------------

export async function listCashAccounts(opts: { includeInactive?: boolean } = {}) {
  const rows = await prisma.cashAccount.findMany({ where: opts.includeInactive ? {} : { active: true }, include: { account: { select: { code: true, name: true, nameAr: true } } }, orderBy: [{ type: "asc" }, { code: "asc" }] });
  const sums = rows.length ? await prisma.journalLine.groupBy({ by: ["accountId"], where: { accountId: { in: rows.map((r) => r.accountId) } }, _sum: { debit: true, credit: true } }) : [];
  const bal = new Map(sums.map((x) => [x.accountId, D(x._sum.debit ?? 0).minus(x._sum.credit ?? 0)]));
  const open = await prisma.bankReconciliation.findMany({ where: { status: "open", cashAccountId: { in: rows.map((r) => r.id) } }, select: { cashAccountId: true } });
  const openSet = new Set(open.map((o) => o.cashAccountId));
  return rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, nameAr: r.nameAr, type: r.type, active: r.active, bankName: r.bankName, accountNumber: r.accountNumber, notes: r.notes, version: r.version,
    glAccount: { id: r.accountId, code: r.account.code, name: r.account.name, nameAr: r.account.nameAr },
    balance: (bal.get(r.accountId) ?? D(0)).toFixed(2), openReconciliation: openSet.has(r.id),
  }));
}

const cashAccountInput = z.object({
  type: z.enum(["cash", "bank"], { errorMap: () => ({ message: "النوع: خزينة أو بنك" }) }),
  name: text("الاسم بالإنجليزي", 100),
  name_ar: text("الاسم بالعربي", 100),
  code: z.string().regex(/^[A-Z0-9_-]{2,20}$/, "الكود حروف إنجليزي كبيرة وأرقام (2–20)").optional(),
  bank_name: optText("اسم البنك", 100).optional(),
  account_number: optText("رقم الحساب / IBAN", 50).optional(),
  notes: optText("ملاحظات", 500).optional(),
});

/**
 * A new cash box or bank account with its own GL account under Assets (1101–1199 for cash,
 * 1201–1299 for banks — the next free code), classified as cash for the cash-flow statement.
 */
export async function createCashAccount(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(cashAccountInput, input);
  if (v.type === "cash" && (v.bank_name || v.account_number)) throw new ApiError(400, "الخزينة مالهاش بنك أو رقم حساب");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, "accounting:cash-account:create");
    const base = v.type === "cash" ? 1100 : 1200;
    const used = new Set((await tx.account.findMany({ where: { code: { gte: String(base + 1), lte: String(base + 99) } }, select: { code: true } })).map((a) => a.code));
    let n = base + 1;
    while (n <= base + 99 && used.has(String(n))) n++;
    if (n > base + 99) throw new ApiError(409, "الأكواد المتاحة للخزائن/البنوك خلصت — كلّم الدعم");
    const count = await tx.cashAccount.count({ where: { type: v.type } });
    const code = v.code ?? `${v.type === "cash" ? "CASH" : "BANK"}-${count + 1}`;
    if (await tx.cashAccount.findUnique({ where: { code } })) throw new ApiError(409, `الكود ${code} مستخدم`);
    const gl = await tx.account.create({ data: { code: String(n), name: v.name, nameAr: v.name_ar, type: "asset", parentId: "acc_1000", postable: true, cashFlowCategory: null } });
    const c = await tx.cashAccount.create({ data: { code, name: v.name, nameAr: v.name_ar, type: v.type, accountId: gl.id, bankName: v.bank_name ?? null, accountNumber: v.account_number ?? null, notes: v.notes ?? null } });
    await audit(tx, actor, "cash_account", c.id, "cash_account_created", `${code} · ${v.name_ar} · ${v.type} · GL ${gl.code}`);
    return c;
  });
}

/**
 * Rename, change the bank details, or (de)activate. Deactivating needs a zero balance and
 * no open reconciliation, and retires the GL account with it, so nothing can post to a
 * closed box; reactivating opens both again.
 */
export async function updateCashAccount(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ name: text("الاسم بالإنجليزي", 100).optional(), name_ar: text("الاسم بالعربي", 100).optional(), bank_name: optText("اسم البنك", 100).optional(), account_number: optText("رقم الحساب / IBAN", 50).optional(), notes: optText("ملاحظات", 500).optional(), active: z.boolean().optional(), version: z.number().int().optional() }), input);
  return inTx(async (tx) => {
    const c = await tx.cashAccount.findUnique({ where: { id } });
    if (!c) throw new ApiError(404, "الخزينة / الحساب البنكي مش موجود");
    await advisoryXactLock(tx, `accounting:cash-account:${c.id}`);
    if (v.version !== undefined && v.version !== c.version) throw new ApiError(409, "اتعدّل من واحد تاني — حدّث الشاشة");
    if (c.type === "cash" && (v.bank_name || v.account_number)) throw new ApiError(400, "الخزينة مالهاش بنك أو رقم حساب");
    if (v.active === false && c.active) {
      const bal = await balanceOf(tx, c.accountId);
      if (!bal.isZero()) throw new ApiError(409, `الرصيد ${bal.toFixed(2)} — حوّله لحساب تاني قبل الإيقاف`);
      if (await tx.bankReconciliation.findFirst({ where: { cashAccountId: c.id, status: "open" } })) throw new ApiError(409, "فيه تسوية بنك مفتوحة — كمّلها الأول");
      if (await tx.cashTransfer.findFirst({ where: { status: "pending_approval", OR: [{ fromCashAccountId: c.id }, { toCashAccountId: c.id }] } })) throw new ApiError(409, "فيه تحويل مستني موافقة على الحساب ده");
    }
    const updated = await tx.cashAccount.update({
      where: { id, version: c.version },
      data: {
        ...(v.name !== undefined ? { name: v.name } : {}), ...(v.name_ar !== undefined ? { nameAr: v.name_ar } : {}),
        ...(v.bank_name !== undefined ? { bankName: v.bank_name } : {}), ...(v.account_number !== undefined ? { accountNumber: v.account_number } : {}),
        ...(v.notes !== undefined ? { notes: v.notes } : {}), ...(v.active !== undefined ? { active: v.active } : {}),
        version: { increment: 1 },
      },
    });
    if (v.active !== undefined || v.name !== undefined || v.name_ar !== undefined) {
      await tx.account.update({ where: { id: c.accountId }, data: { ...(v.active !== undefined ? { active: v.active } : {}), ...(v.name !== undefined ? { name: v.name } : {}), ...(v.name_ar !== undefined ? { nameAr: v.name_ar } : {}), version: { increment: 1 } } });
    }
    const detail = [v.active !== undefined && v.active !== c.active ? (v.active ? "تفعيل" : "إيقاف") : null, v.name_ar && v.name_ar !== c.nameAr ? `الاسم: ${v.name_ar}` : null, v.bank_name !== undefined ? `البنك: ${v.bank_name ?? "—"}` : null, v.account_number !== undefined ? "رقم الحساب اتغيّر" : null].filter(Boolean).join(" · ");
    await audit(tx, actor, "cash_account", c.id, v.active === false ? "cash_account_deactivated" : v.active === true && !c.active ? "cash_account_activated" : "cash_account_updated", detail || "تعديل");
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

const transferInput = z.object({
  from_cash_account_id: text("من حساب"),
  to_cash_account_id: text("إلى حساب"),
  date: z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD").optional(),
  amount: money("المبلغ"),
  fee: money("مصاريف التحويل", true).optional(),
  reference: optText("المرجع", 100).optional(),
  notes: optText("ملاحظات", 500).optional(),
  idempotency_key: idempotencyKeyField,
});

const TRANSFER_INCLUDE = { from: { select: { id: true, code: true, name: true, nameAr: true, type: true } }, to: { select: { id: true, code: true, name: true, nameAr: true, type: true } }, entry: { select: { id: true, number: true } }, reversalEntry: { select: { id: true, number: true } } } as const;

function present(t: Prisma.CashTransferGetPayload<{ include: typeof TRANSFER_INCLUDE }>) {
  return {
    id: t.id, number: t.number, date: t.date, status: t.status, amount: t.amount.toFixed(2), fee: t.fee.toFixed(2), reference: t.reference, notes: t.notes,
    from: t.from, to: t.to, entry: t.entry, createdBy: t.createdBy, createdAt: t.createdAt, decidedBy: t.decidedBy,
    reversal: t.reversedAt ? { at: t.reversedAt, by: t.reversedBy, reason: t.reversalReason, entry: t.reversalEntry } : null,
  };
}

/** Posts a transfer's entry (inside the caller's transaction) after re-checking the accounts and the cash on hand. */
async function postTransfer(tx: Tx, transferId: string, actor: { id: string | null; name: string; role: string; deviceId?: string }) {
  const t = await tx.cashTransfer.findUniqueOrThrow({ where: { id: transferId }, include: { from: true, to: true } });
  await advisoryXactLock(tx, `accounting:cash-account:${t.fromCashAccountId}`);
  if (!t.from.active || !t.to.active) throw new ApiError(409, "واحد من الحسابين اتوقف — التحويل مينفعش يترحّل");
  const out = t.amount.plus(t.fee);
  if (t.from.type === "cash") {
    const available = await balanceOf(tx, t.from.accountId);
    if (available.lessThan(out)) throw new ApiError(409, `رصيد ${t.from.nameAr ?? t.from.name} ${available.toFixed(2)} — أقل من ${out.toFixed(2)}`);
  }
  const lines = [
    { accountId: t.to.accountId, amount: t.amount },
    { accountId: t.from.accountId, amount: out.negated() },
    ...(t.fee.gt(0) ? [{ accountId: t.feeAccountId!, amount: t.fee, description: "مصاريف تحويل" }] : []),
  ];
  const entry = await postJournal(tx, { date: t.date, description: `تحويل ${t.number}: ${t.from.nameAr ?? t.from.name} ← ${t.to.nameAr ?? t.to.name}${t.reference ? ` (${t.reference})` : ""}`, sourceType: "cash_transfer", sourceId: t.id, lines }, actor);
  return tx.cashTransfer.update({ where: { id: t.id, version: t.version }, data: { status: "posted", entryId: entry!.id, version: { increment: 1 } } });
}

export async function createTransfer(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(transferInput, input);
  if (v.from_cash_account_id === v.to_cash_account_id) throw new ApiError(400, "التحويل لازم يكون بين حسابين مختلفين");
  const date = v.date ?? todayLocalISO();
  const fee = v.fee ?? D(0);
  const requestHash = requestFingerprint({ from: v.from_cash_account_id, to: v.to_cash_account_id, date, amount: v.amount, fee, reference: v.reference ?? null, notes: v.notes ?? null });
  const [approvalOn, threshold] = await Promise.all([getSetting("accounting.transfer_approval"), getSetting("accounting.transfer_approval_threshold")]);
  const result = await inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.cashTransfer.findUnique({ where: { idempotencyKey: v.idempotency_key }, include: TRANSFER_INCLUDE });
      if (prev) return { transfer: replayRequest(prev, requestHash, false), replayed: true };
    }
    const [from, to] = await Promise.all([tx.cashAccount.findUnique({ where: { id: v.from_cash_account_id } }), tx.cashAccount.findUnique({ where: { id: v.to_cash_account_id } })]);
    if (!from?.active || !to?.active) throw new ApiError(400, "الخزينة / الحساب البنكي مش موجود أو موقوف");
    let feeAccountId: string | null = null;
    if (fee.gt(0)) {
      if (from.type !== "bank") throw new ApiError(400, "مصاريف التحويل بتتخصم من حساب بنكي بس");
      const code = String(await getSetting("accounting.bank_charges_account")).trim();
      const acc = code ? await tx.account.findUnique({ where: { code } }) : null;
      if (!acc || !acc.active || !acc.postable || acc.type !== "expense" || controlAccountMovedBy(acc.systemKey, acc.controlledBy)) throw new ApiError(400, "حساب مصاريف البنك مش متحدد أو مش مناسب — حدده في إعدادات الحسابات الأول");
      feeAccountId = acc.id;
    }
    const needsApproval = approvalOn && v.amount.greaterThan(D(threshold));
    const t = await tx.cashTransfer.create({
      data: {
        number: await nextDocumentNumber(tx, "accounting.cash_transfer", date), date, fromCashAccountId: from.id, toCashAccountId: to.id, amount: v.amount, fee, feeAccountId,
        reference: v.reference ?? null, notes: v.notes ?? null, status: "pending_approval", idempotencyKey: v.idempotency_key ?? null, requestHash: v.idempotency_key ? requestHash : null,
        createdById: actor.id, createdBy: actor.name,
      },
    });
    await audit(tx, actor, "cash_transfer", t.id, "cash_transfer_created", `${t.number} · ${from.code} → ${to.code} · ${v.amount.toFixed(2)}${fee.gt(0) ? ` + ${fee.toFixed(2)}` : ""}`);
    if (needsApproval) {
      await requestApproval(tx, { type: "accounting.cash_transfer", entityId: t.id, title: `تحويل ${t.number}: ${from.nameAr ?? from.name} ← ${to.nameAr ?? to.name}`, amount: v.amount, requester: actor });
    } else {
      await postTransfer(tx, t.id, actor);
    }
    return { transfer: await tx.cashTransfer.findUniqueOrThrow({ where: { id: t.id }, include: TRANSFER_INCLUDE }), replayed: false };
  });
  return { transfer: present(result.transfer), document: { status: result.transfer.status }, replayed: result.replayed };
}

/** Approval handler: approved → posted (by someone other than the requester); rejected → nothing moves. */
export async function applyTransferDecision(tx: Tx, transferId: string, approved: boolean, decider: Decider) {
  const t = await tx.cashTransfer.findUniqueOrThrow({ where: { id: transferId } });
  if (t.status !== "pending_approval") throw new ApiError(409, "التحويل ده اتقرر قبل كده");
  if (t.createdById && t.createdById === decider.id) throw new ApiError(403, "اللي سجّل التحويل مينفعش يعتمده بنفسه");
  await tx.cashTransfer.update({ where: { id: t.id, version: t.version }, data: { decidedBy: decider.name, decidedAt: new Date(), ...(approved ? {} : { status: "rejected" }), version: { increment: 1 } } });
  if (approved) await postTransfer(tx, t.id, decider);
  await audit(tx, decider, "cash_transfer", t.id, approved ? "cash_transfer_approved" : "cash_transfer_rejected", t.number);
}

/** Undo a posted transfer once: the opposite entry, dated today (or the date given). */
export async function reverseTransfer(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ reason: text("سبب العكس", 500), date: z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD").optional() }), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `accounting:cash-transfer:${id}`);
    const t = await tx.cashTransfer.findUnique({ where: { id }, include: { from: true, to: true, entry: { include: { lines: true } } } });
    if (!t) throw new ApiError(404, "التحويل مش موجود");
    if (t.status !== "posted" || !t.entry) throw new ApiError(409, "التحويل ده مش مترحّل");
    if (t.reversedAt) throw new ApiError(409, "التحويل اتعكس قبل كده");
    const date = v.date ?? todayLocalISO();
    if (date < t.date) throw new ApiError(400, "تاريخ العكس مينفعش يكون قبل تاريخ التحويل");
    // Taking the money back out of the destination must not leave a cash box below zero.
    if (t.to.type === "cash") {
      const available = await balanceOf(tx, t.to.accountId);
      if (available.lessThan(t.amount)) throw new ApiError(409, `رصيد ${t.to.nameAr ?? t.to.name} ${available.toFixed(2)} — أقل من ${t.amount.toFixed(2)}`);
    }
    const entry = await postJournal(tx, {
      date, description: `عكس تحويل ${t.number}: ${v.reason}`, sourceType: "cash_transfer_reversal", sourceId: t.id,
      lines: t.entry.lines.map((l) => ({ accountId: l.accountId, amount: l.credit.minus(l.debit), description: l.description ?? undefined, costCenterId: l.costCenterId })),
    }, actor);
    await tx.cashTransfer.update({ where: { id: t.id, version: t.version }, data: { reversedAt: new Date(), reversedBy: actor.name, reversalReason: v.reason, reversalEntryId: entry!.id, version: { increment: 1 } } });
    await audit(tx, actor, "cash_transfer", t.id, "cash_transfer_reversed", t.number, v.reason);
    return present(await tx.cashTransfer.findUniqueOrThrow({ where: { id: t.id }, include: TRANSFER_INCLUDE }));
  });
}

export async function listTransfers(filters: { cashAccountId?: string; status?: string; limit?: number; offset?: number }) {
  const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const skip = Math.max(filters.offset ?? 0, 0);
  const where: Prisma.CashTransferWhereInput = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.cashAccountId ? { OR: [{ fromCashAccountId: filters.cashAccountId }, { toCashAccountId: filters.cashAccountId }] } : {}),
  };
  const [total, rows] = await Promise.all([prisma.cashTransfer.count({ where }), prisma.cashTransfer.findMany({ where, include: TRANSFER_INCLUDE, orderBy: [{ date: "desc" }, { createdAt: "desc" }], skip, take })]);
  return { transfers: rows.map(present), pagination: { total, limit: take, offset: skip } };
}
