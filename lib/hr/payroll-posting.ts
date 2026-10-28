import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { optText, parse, text } from "@/lib/core/validation";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { idempotencyKeyField, lockKey, replayRequest, requestFingerprint } from "@/lib/core/idempotency";
import { getSetting } from "@/lib/core/settings-service";
import { controlAccountMovedBy, postJournal, type PostLine } from "@/lib/accounting/ledger";
import type { ServiceActor } from "@/lib/core/actor";
import type { Permission } from "@/lib/permissions";
import { unlockAttendance } from "@/lib/hr/payroll";

/**
 * Payroll after approval (docs/erp/COMPLETION_PROGRAM.md D-1..D-4).
 *
 *   approved ──post──▶ posted ──reverse (nothing paid)──▶ reversed
 *
 * Posting writes one journal entry per run, dated the period's last day, from the approved
 * payslips of included employees:
 *
 *   earning                Dr the component's expense account
 *   deduction              Cr the component's liability account (withheld for a third party),
 *                          or its expense account when it only reduces the cost (an unpaid day)
 *   employer contribution  Dr its expense account, Cr its liability account
 *   advance recovery       Cr employee advances, per employee (the advance was debited per employee)
 *   net payable            Cr the net-salaries account (setting hr.payroll_net_pay_account)
 *
 * Every account is the accountant's choice. Posting is refused, with the list of what is
 * missing, while any is not set; nothing here names or defaults an account. Net pay is one
 * line, not one per employee, so the journal (read by everyone with accounting.view) shows
 * no individual salary; per-employee amounts stay in payroll, behind payroll permissions.
 *
 * Payments (hr.payroll.pay) settle payslips of a posted run, partially or in full, never above
 * a payslip's net payable (DB trigger): Dr net-salaries, Cr the cash/bank account. A mistaken
 * payment is reversed, never edited. A run with live payments cannot be reversed.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const ZERO = D(0);
const READ: Permission[] = ["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"];
function assertCanRead(actor: ServiceActor) {
  if (!READ.some((p) => actorCan(actor, p))) assertPermission(actor, "hr.payroll.view");
}

function periodEnd(p: string) {
  const [y, m] = p.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

async function lockRun(tx: Tx, id: string) {
  await advisoryXactLock(tx, `payroll-run:${id}`);
  const run = await tx.payrollRun.findUnique({ where: { id } });
  if (!run) throw new ApiError(404, "مسير المرتبات مش موجود");
  return run;
}

// ---------------------------------------------------------------------------
// The entry a run would post
// ---------------------------------------------------------------------------

type Db = Tx | typeof prisma;
type AccountRow = { id: string; code: string; name: string; nameAr: string | null; type: string; active: boolean; postable: boolean; systemKey: string | null };
export type PostingProblem = { code: "net_pay_account_missing" | "net_pay_account_invalid" | "expense_account_missing" | "liability_account_missing" | "deduction_account_missing" | "account_invalid" | "line_without_component"; params: Record<string, string> };
export type PreviewLine = { side: "debit" | "credit"; role: "component" | "recovery" | "net"; accountId: string | null; accountCode: string | null; accountName: string | null; accountNameAr: string | null; amount: string; label: string; component: string | null };

/** An account a payroll line may post to: active, postable, of the wanted type, not a control account and not a cash/bank account. */
async function usable(db: Db, a: AccountRow | null | undefined, types: string[]) {
  if (!a || !a.active || !a.postable || !types.includes(a.type) || controlAccountMovedBy(a.systemKey)) return false;
  return !(await db.cashAccount.findFirst({ where: { accountId: a.id }, select: { id: true } }));
}

async function buildPosting(db: Db, run: { id: string; period: string; number: string; netPayable: Prisma.Decimal }) {
  const problems: PostingProblem[] = [];
  const preview: PreviewLine[] = [];
  const post: PostLine[] = [];

  const code = String(await getSetting("hr.payroll_net_pay_account")).trim();
  const netAccount = code ? await db.account.findUnique({ where: { code } }) : null;
  if (!code) problems.push({ code: "net_pay_account_missing", params: {} });
  else if (!(await usable(db, netAccount, ["liability"]))) problems.push({ code: "net_pay_account_invalid", params: { account: code } });

  const lines = await db.payrollRunLine.findMany({
    where: { runEmployee: { runId: run.id, inclusion: "included" }, amount: { gt: 0 } },
    select: { kind: true, code: true, nameAr: true, amount: true, payComponentId: true, runEmployee: { select: { employeeId: true } } },
  });
  const componentIds = [...new Set(lines.map((l) => l.payComponentId).filter((x): x is string => !!x))];
  const components = new Map((await db.payComponent.findMany({ where: { id: { in: componentIds } }, include: { expenseAccount: true, liabilityAccount: true } })).map((c) => [c.id, c]));
  const advances = await db.account.findFirst({ where: { systemKey: "employee_advances" } });

  const push = (side: "debit" | "credit", account: AccountRow | null | undefined, amount: Prisma.Decimal, label: string, component: string | null, party?: { type: "employee"; id: string }) => {
    preview.push({ side, role: component ? "component" : "net", accountId: account?.id ?? null, accountCode: account?.code ?? null, accountName: account?.name ?? null, accountNameAr: account?.nameAr ?? null, amount: amount.toFixed(2), label, component });
    if (account) post.push({ accountId: account.id, amount: side === "debit" ? amount : amount.negated(), description: label, party });
  };

  // Component lines, summed per component and kind; recovery stays per employee.
  const groups = new Map<string, { kind: string; code: string; nameAr: string; componentId: string | null; amount: Prisma.Decimal }>();
  const recoveries = new Map<string, Prisma.Decimal>();
  for (const l of lines) {
    if (l.kind === "recovery") {
      recoveries.set(l.runEmployee.employeeId, (recoveries.get(l.runEmployee.employeeId) ?? ZERO).plus(l.amount));
      continue;
    }
    const key = `${l.kind}:${l.payComponentId ?? l.code}`;
    const g = groups.get(key) ?? { kind: l.kind, code: l.code, nameAr: l.nameAr, componentId: l.payComponentId, amount: ZERO };
    g.amount = g.amount.plus(l.amount);
    groups.set(key, g);
  }
  const ORDER: Record<string, number> = { earning: 0, employer_contribution: 1, deduction: 2 };
  for (const g of [...groups.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.code.localeCompare(b.code))) {
    const c = g.componentId ? components.get(g.componentId) : undefined;
    const label = `${g.code} · ${g.nameAr}`;
    if (!c) {
      problems.push({ code: "line_without_component", params: { component: g.code } });
      continue;
    }
    const check = async (a: AccountRow | null, types: string[]) => {
      if (a && !(await usable(db, a, types))) problems.push({ code: "account_invalid", params: { component: c.code, account: a.code } });
    };
    if (g.kind === "earning") {
      if (!c.expenseAccount) problems.push({ code: "expense_account_missing", params: { component: c.code } });
      await check(c.expenseAccount, ["expense"]);
      push("debit", c.expenseAccount, g.amount, label, c.code);
    } else if (g.kind === "deduction") {
      const target = c.liabilityAccount ?? c.expenseAccount;
      if (!target) problems.push({ code: "deduction_account_missing", params: { component: c.code } });
      await check(target, c.liabilityAccount ? ["liability"] : ["expense"]);
      push("credit", target, g.amount, label, c.code);
    } else if (g.kind === "employer_contribution") {
      if (!c.expenseAccount) problems.push({ code: "expense_account_missing", params: { component: c.code } });
      if (!c.liabilityAccount) problems.push({ code: "liability_account_missing", params: { component: c.code } });
      await check(c.expenseAccount, ["expense"]);
      await check(c.liabilityAccount, ["liability"]);
      push("debit", c.expenseAccount, g.amount, label, c.code);
      push("credit", c.liabilityAccount, g.amount, label, c.code);
    }
  }
  const recoveryTotal = [...recoveries.values()].reduce((s, v) => s.plus(v), ZERO);
  if (recoveryTotal.gt(0)) {
    // One preview line; one posted line per employee so each advance balance moves.
    preview.push({ side: "credit", role: "recovery", accountId: advances?.id ?? null, accountCode: advances?.code ?? null, accountName: advances?.name ?? null, accountNameAr: advances?.nameAr ?? null, amount: recoveryTotal.toFixed(2), label: "استرداد سلف وصرف تحت الحساب", component: null });
    if (advances) for (const [employeeId, amount] of recoveries) post.push({ accountId: advances.id, amount: amount.negated(), description: `استرداد سلف ${run.number}`, party: { type: "employee", id: employeeId } });
  }
  push("credit", netAccount && problems.every((p) => !p.code.startsWith("net_pay")) ? netAccount : null, run.netPayable, `صافي مرتبات ${run.period}`, null);

  const debit = preview.filter((l) => l.side === "debit").reduce((s, l) => s.plus(l.amount), ZERO);
  const credit = preview.filter((l) => l.side === "credit").reduce((s, l) => s.plus(l.amount), ZERO);
  return { date: periodEnd(run.period), lines: preview, post, problems, totals: { debit: debit.toFixed(2), credit: credit.toFixed(2) }, balanced: debit.equals(credit), netAccount };
}

const PROBLEM_TEXT: Record<PostingProblem["code"], (p: Record<string, string>) => string> = {
  net_pay_account_missing: () => "حساب صافي المرتبات مش متحدد في الإعدادات",
  net_pay_account_invalid: (p) => `حساب صافي المرتبات (${p.account}) مش حساب خصوم صالح للترحيل`,
  expense_account_missing: (p) => `البند ${p.component} مالوش حساب مصروف`,
  liability_account_missing: (p) => `البند ${p.component} مالوش حساب التزام`,
  deduction_account_missing: (p) => `الخصم ${p.component} مالوش حساب`,
  account_invalid: (p) => `حساب البند ${p.component} (${p.account}) مش مناسب للترحيل`,
  line_without_component: (p) => `سطر ${p.component} مش مربوط ببند مرتب`,
};

/** GET /api/hr/payroll/runs/:id/journal — what posting would write, and what blocks it. */
export async function journalPreview(id: string, actor: ServiceActor) {
  assertCanRead(actor);
  const run = await prisma.payrollRun.findUnique({ where: { id } });
  if (!run) throw new ApiError(404, "مسير المرتبات مش موجود");
  if (["posted", "reversed"].includes(run.status) && run.journalEntryId) {
    const entry = await prisma.journalEntry.findUnique({ where: { id: run.journalEntryId }, include: { lines: { include: { account: { select: { code: true, name: true, nameAr: true } } } } } });
    return { posted: true, entry: entry && { id: entry.id, number: entry.number, date: entry.date, total: entry.total.toFixed(2) }, lines: [], problems: [], totals: null, balanced: true, date: run.postingDate };
  }
  const b = await buildPosting(prisma, run);
  return { posted: false, entry: null, date: b.date, lines: b.lines, totals: b.totals, balanced: b.balanced, problems: b.problems.map((p) => ({ ...p, message: PROBLEM_TEXT[p.code](p.params) })) };
}

// ---------------------------------------------------------------------------
// Post, reverse
// ---------------------------------------------------------------------------

/** POST /api/hr/payroll/runs/:id/post — an approved run, once. */
export async function postRun(id: string, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.post");
  return inTx(async (tx) => {
    const run = await lockRun(tx, id);
    if (run.status !== "approved") throw new ApiError(409, "المسير لازم يكون معتمد عشان يترحّل");
    const b = await buildPosting(tx, run);
    // Each problem is listed (localized) by the preview; the refusal carries their count.
    if (b.problems.length) throw new ApiError(409, `مينفعش الترحيل: فيه ${b.problems.length} حساب ناقص أو مش مناسب — راجع قيد المرتبات`);
    if (!b.balanced) throw new Error(`payroll posting for ${run.number} does not balance: ${b.totals.debit} ≠ ${b.totals.credit}`);
    const entry = await postJournal(tx, { date: b.date, description: `مسير مرتبات ${run.number} · ${run.period} · ${run.headcount} موظف`, sourceType: "payroll_run", sourceId: run.id, lines: b.post }, actor);
    if (!entry) throw new ApiError(409, "المسير مفيهوش مبالغ تترحّل");
    await tx.payrollAdjustment.updateMany({ where: { status: "reserved", reservedOn: { runId: id, inclusion: "included" } }, data: { status: "applied", version: { increment: 1 } } });
    const row = await tx.payrollRun.update({
      where: { id },
      data: { status: "posted", postedAt: new Date(), postedById: actor.id, postedBy: actor.name, postingDate: b.date, journalEntryId: entry.id, netPayAccountId: b.netAccount!.id, version: { increment: 1 } },
    });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_run_posted", entityType: "payroll_run", entityId: id, fieldChanged: run.period, newValue: `${entry.number} · ${b.totals.debit}`, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

const reverseInput = z.object({ reason: text("السبب", 300), date: z.string().optional() });

/** POST /api/hr/payroll/runs/:id/reverse — a posted run with nothing paid: reversing entry, month freed. */
export async function reverseRun(id: string, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.post");
  const v = parse(reverseInput, body);
  const date = v.date ?? todayLocalISO();
  if (!isValidISODate(date)) throw new ApiError(400, "تاريخ العكس لازم يكون YYYY-MM-DD");
  return inTx(async (tx) => {
    const run = await lockRun(tx, id);
    if (run.status !== "posted") throw new ApiError(409, "المسير مش مترحّل");
    if (date < run.postingDate!) throw new ApiError(400, "تاريخ العكس قبل تاريخ الترحيل");
    if (await tx.payrollPayment.count({ where: { runId: id, reversedAt: null } })) throw new ApiError(409, "فيه صرف متسجل على المسير — اعكس الصرف الأول");
    const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: run.journalEntryId! }, include: { lines: true } });
    const rev = await postJournal(tx, {
      date, description: `عكس مسير مرتبات ${run.number}: ${v.reason}`, sourceType: "reversal", sourceId: entry.id, reversalOfId: entry.id,
      lines: entry.lines.map((l) => ({ accountId: l.accountId, amount: l.credit.minus(l.debit), party: l.partyType ? { type: l.partyType as "employee", id: l.partyId! } : undefined, description: l.description ?? undefined })),
    }, actor);
    const row = await tx.payrollRun.update({ where: { id }, data: { status: "reversed", reversedAt: new Date(), reversedById: actor.id, reversedBy: actor.name, reversalReason: v.reason, reversalEntryId: rev!.id, version: { increment: 1 } } });
    // The month can be paid again by a new run: its adjustments and attendance go back.
    await tx.payrollAdjustment.updateMany({ where: { status: { in: ["applied", "reserved"] }, reservedOn: { runId: id } }, data: { status: "open", reservedRunEmployeeId: null, version: { increment: 1 } } });
    await unlockAttendance(tx, id, actor);
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_run_reversed", entityType: "payroll_run", entityId: id, fieldChanged: run.period, oldValue: entry.number, newValue: rev!.number, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const money = (label: string) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} لازم يكون أكبر من صفر بحد أقصى خانتين عشريتين` });
      return z.NEVER;
    }
    return D(s);
  });
const paymentInput = z.object({
  date: z.string(),
  cash_account_id: text("الخزينة / البنك"),
  method: z.enum(["cash", "bank_transfer", "cheque", "wallet", "other"], { errorMap: () => ({ message: "طريقة الصرف غير معروفة" }) }),
  reference: optText("المرجع", 100).optional(),
  /** Explicit payslips, or every unpaid remainder of the run. */
  lines: z.array(z.object({ employee_id: text("الموظف"), amount: money("مبلغ الصرف") })).max(1000).optional(),
  all_remaining: z.boolean().optional(),
  idempotency_key: idempotencyKeyField,
});

/** What is still unpaid on each included payslip of a run (reversed payments do not count). */
async function remaining(db: Db, runId: string) {
  const slips = await db.payrollRunEmployee.findMany({ where: { runId, inclusion: "included" }, select: { id: true, employeeId: true, netPayable: true } });
  const paid = await db.payrollPaymentLine.groupBy({ by: ["runEmployeeId"], where: { runEmployee: { runId }, payment: { reversedAt: null } }, _sum: { amount: true } });
  const paidBy = new Map(paid.map((p) => [p.runEmployeeId, D(p._sum.amount)]));
  return slips.map((s) => ({ ...s, paid: paidBy.get(s.id) ?? ZERO, remaining: s.netPayable.minus(paidBy.get(s.id) ?? ZERO) }));
}

/** POST /api/hr/payroll/runs/:id/payments — salary paid out of a cash or bank account. */
export async function createPayment(runId: string, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.pay");
  const v = parse(paymentInput, body);
  if (!isValidISODate(v.date)) throw new ApiError(400, "تاريخ الصرف لازم يكون YYYY-MM-DD");
  if (v.date > todayLocalISO()) throw new ApiError(400, "مينفعش تسجل صرف بتاريخ لسه مجاش");
  if (!!v.lines?.length === !!v.all_remaining) throw new ApiError(400, "حدد الموظفين والمبالغ، أو اختار صرف كل المتبقي");
  const requestHash = requestFingerprint({ runId, date: v.date, cash: v.cash_account_id, method: v.method, reference: v.reference ?? null, lines: v.lines?.map((l) => [l.employee_id, l.amount.toString()]) ?? null, all: !!v.all_remaining });
  return inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.payrollPayment.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) return replayRequest(prev, requestHash, false);
    }
    const run = await lockRun(tx, runId);
    if (run.status !== "posted") throw new ApiError(409, "الصرف بيكون على مسير مترحّل بس");
    if (v.date < run.attendanceFrom) throw new ApiError(400, "تاريخ الصرف قبل شهر المسير");
    const cash = await tx.cashAccount.findUnique({ where: { id: v.cash_account_id } });
    if (!cash?.active) throw new ApiError(400, "الخزينة / الحساب البنكي مش موجود أو موقوف");
    const open = await remaining(tx, runId);
    const byEmployee = new Map(open.map((s) => [s.employeeId, s]));
    let lines: { runEmployeeId: string; amount: Prisma.Decimal }[];
    if (v.all_remaining) {
      lines = open.filter((s) => s.remaining.gt(0)).map((s) => ({ runEmployeeId: s.id, amount: s.remaining }));
      if (!lines.length) throw new ApiError(409, "المسير متصرف بالكامل");
    } else {
      const seen = new Set<string>();
      lines = v.lines!.map((l) => {
        const s = byEmployee.get(l.employee_id);
        if (!s) throw new ApiError(400, "الموظف مش في المسير أو قسيمته موقوفة");
        if (seen.has(l.employee_id)) throw new ApiError(400, "الموظف متكرر في نفس الصرف");
        seen.add(l.employee_id);
        if (l.amount.gt(s.remaining)) throw new ApiError(400, `المبلغ ${l.amount.toFixed(2)} أكبر من المتبقي ${s.remaining.toFixed(2)}`);
        return { runEmployeeId: s.id, amount: l.amount };
      });
    }
    const total = lines.reduce((s, l) => s.plus(l.amount), ZERO);
    const number = await nextDocumentNumber(tx, "hr.payroll_payment", v.date);
    const payment = await tx.payrollPayment.create({
      data: { number, runId, date: v.date, cashAccountId: cash.id, method: v.method, reference: v.reference ?? null, amount: total, idempotencyKey: v.idempotency_key ?? null, requestHash, createdById: actor.id, createdBy: actor.name },
    });
    await tx.payrollPaymentLine.createMany({ data: lines.map((l) => ({ paymentId: payment.id, ...l })) });
    const entry = await postJournal(tx, {
      date: v.date, description: `صرف مرتبات ${run.number} · ${number} · ${lines.length} موظف`, sourceType: "payroll_payment", sourceId: payment.id,
      lines: [{ accountId: run.netPayAccountId!, amount: total, description: `صرف مرتبات ${run.period}` }, { accountId: cash.accountId, amount: total.negated() }],
    }, actor);
    const row = await tx.payrollPayment.update({ where: { id: payment.id }, data: { journalEntryId: entry!.id } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_payment_recorded", entityType: "payroll_payment", entityId: payment.id, fieldChanged: run.number, newValue: `${number} · ${lines.length} · ${total.toFixed(2)} · ${cash.code}`, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

/** POST /api/hr/payroll/payments/:id/reverse — a mistaken payment: reversing entry, payslips unpaid again. */
export async function reversePayment(id: string, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.pay");
  const v = parse(reverseInput, body);
  const date = v.date ?? todayLocalISO();
  if (!isValidISODate(date)) throw new ApiError(400, "تاريخ العكس لازم يكون YYYY-MM-DD");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `payroll-payment:${id}`);
    const p = await tx.payrollPayment.findUnique({ where: { id } });
    if (!p) throw new ApiError(404, "الصرف مش موجود");
    await lockRun(tx, p.runId);
    if (p.reversedAt) throw new ApiError(409, "الصرف ده اتعكس بالفعل");
    if (date < p.date) throw new ApiError(400, "تاريخ العكس قبل تاريخ الصرف");
    const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: p.journalEntryId! }, include: { lines: true } });
    const rev = await postJournal(tx, {
      date, description: `عكس صرف مرتبات ${p.number}: ${v.reason}`, sourceType: "reversal", sourceId: entry.id, reversalOfId: entry.id,
      lines: entry.lines.map((l) => ({ accountId: l.accountId, amount: l.credit.minus(l.debit), description: l.description ?? undefined })),
    }, actor);
    const row = await tx.payrollPayment.update({ where: { id }, data: { reversedAt: new Date(), reversedById: actor.id, reversedBy: actor.name, reversalReason: v.reason, reversalEntryId: rev!.id } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_payment_reversed", entityType: "payroll_payment", entityId: id, fieldChanged: p.number, oldValue: entry.number, newValue: rev!.number, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

/** Payments of a run with their payslips, and what is still unpaid per payslip. */
export async function runPayments(runId: string, actor: ServiceActor) {
  assertCanRead(actor);
  const run = await prisma.payrollRun.findUnique({ where: { id: runId }, select: { id: true } });
  if (!run) throw new ApiError(404, "مسير المرتبات مش موجود");
  const [payments, open] = await Promise.all([
    prisma.payrollPayment.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
      include: { cashAccount: { select: { code: true, name: true } }, journalEntry: { select: { number: true } }, reversalEntry: { select: { number: true } }, lines: { select: { amount: true, runEmployee: { select: { employeeId: true } } } } },
    }),
    remaining(prisma, runId),
  ]);
  return {
    payments: payments.map((p) => ({ ...p, amount: p.amount.toFixed(2), lines: p.lines.map((l) => ({ employeeId: l.runEmployee.employeeId, amount: l.amount.toFixed(2) })) })),
    slips: open.map((s) => ({ employeeId: s.employeeId, netPayable: s.netPayable.toFixed(2), paid: s.paid.toFixed(2), remaining: s.remaining.toFixed(2) })),
    totals: { netPayable: open.reduce((a, s) => a.plus(s.netPayable), ZERO).toFixed(2), paid: open.reduce((a, s) => a.plus(s.paid), ZERO).toFixed(2), remaining: open.reduce((a, s) => a.plus(s.remaining), ZERO).toFixed(2) },
  };
}

// ---------------------------------------------------------------------------
// Exports: payroll register, bank payment file
// ---------------------------------------------------------------------------

/** One row per included payslip, a column per component (CSV rows; the route writes the file). */
export async function payrollRegister(runId: string, actor: ServiceActor) {
  assertCanRead(actor);
  const run = await prisma.payrollRun.findUnique({
    where: { id: runId },
    include: { employees: { where: { inclusion: "included" }, orderBy: { employee: { code: "asc" } }, include: { employee: { select: { code: true, name: true, jobTitle: true, department: { select: { name: true } } } }, lines: true } } },
  });
  if (!run) throw new ApiError(404, "مسير المرتبات مش موجود");
  const open = new Map((await remaining(prisma, runId)).map((s) => [s.id, s]));
  const columns = new Map<string, { kind: string; nameAr: string }>();
  for (const e of run.employees) for (const l of e.lines) if (!columns.has(l.code)) columns.set(l.code, { kind: l.kind, nameAr: l.nameAr });
  const ORDER: Record<string, number> = { earning: 0, deduction: 1, recovery: 2, employer_contribution: 3 };
  const cols = [...columns.entries()].sort((a, b) => ORDER[a[1].kind] - ORDER[b[1].kind] || a[0].localeCompare(b[0]));
  const rows = run.employees.map((e) => {
    const by = new Map<string, Prisma.Decimal>();
    for (const l of e.lines) by.set(l.code, (by.get(l.code) ?? ZERO).plus(l.amount));
    const pay = open.get(e.id);
    return {
      "كود الموظف / Code": e.employee.code, "الاسم / Name": e.employee.name, "القسم / Department": e.employee.department?.name ?? "", "الوظيفة / Job": e.employee.jobTitle ?? "",
      ...Object.fromEntries(cols.map(([code, c]) => [`${c.nameAr} (${code})`, (by.get(code) ?? ZERO).toFixed(2)])),
      "الإجمالي / Gross": e.gross.toFixed(2), "الاستقطاعات / Deductions": e.employeeDeductions.toFixed(2), "الاسترداد / Recovery": e.advanceRecovery.toFixed(2),
      "الصافي / Net": e.netPayable.toFixed(2), "حصة صاحب العمل / Employer": e.employerContributions.toFixed(2),
      "المصروف / Paid": (pay?.paid ?? ZERO).toFixed(2), "المتبقي / Unpaid": (pay?.remaining ?? e.netPayable).toFixed(2),
    };
  });
  await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_register_exported", entityType: "payroll_run", entityId: runId, fieldChanged: run.number, newValue: `${rows.length} payslips`, source: "user", deviceId: actor.deviceId }, prisma);
  return { run, rows };
}

/**
 * A generic payment list for the bank: one row per payslip with something unpaid, with the
 * employee's verified primary salary account. It is not any bank's upload format (none is
 * specified); unverified or missing accounts are flagged and carry no account number.
 */
export async function bankPaymentFile(runId: string, actor: ServiceActor) {
  assertPermission(actor, "hr.payroll.pay");
  assertPermission(actor, "hr.private.view");
  const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
  if (!run) throw new ApiError(404, "مسير المرتبات مش موجود");
  if (run.status !== "posted") throw new ApiError(409, "ملف البنك بيطلع لمسير مترحّل بس");
  const open = (await remaining(prisma, runId)).filter((s) => s.remaining.gt(0));
  const employees = await prisma.employee.findMany({ where: { id: { in: open.map((s) => s.employeeId) } }, select: { id: true, code: true, name: true } });
  const accounts = await prisma.employeeBankAccount.findMany({ where: { employeeId: { in: open.map((s) => s.employeeId) }, active: true, isPrimary: true }, orderBy: { createdAt: "desc" } });
  const emp = new Map(employees.map((e) => [e.id, e]));
  const acc = new Map<string, (typeof accounts)[number]>();
  for (const a of accounts) if (!acc.has(a.employeeId)) acc.set(a.employeeId, a);
  const rows = open
    .map((s) => {
      const a = acc.get(s.employeeId);
      const status = !a ? "no_account" : !a.verifiedAt ? "not_verified" : "ready";
      return {
        employee_code: emp.get(s.employeeId)?.code ?? "", employee_name: emp.get(s.employeeId)?.name ?? "",
        holder_name: status === "ready" ? a!.holderName : "", bank_name: status === "ready" ? a!.bankName : "",
        account_number: status === "ready" ? a!.accountNumber : "", iban: status === "ready" ? a!.iban ?? "" : "",
        amount: s.remaining.toFixed(2), currency: "EGP", reference: `${run.number} ${run.period}`, status,
      };
    })
    .sort((a, b) => a.employee_code.localeCompare(b.employee_code));
  await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_bank_file_exported", entityType: "payroll_run", entityId: runId, fieldChanged: run.number, newValue: `${rows.length} rows · ${rows.filter((r) => r.status === "ready").length} ready`, source: "user", deviceId: actor.deviceId }, prisma);
  return { run, rows };
}
