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
import { onPayroll } from "@/lib/hr/attendance";
import { datesBetween } from "@/lib/hr/attendance-calc";

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

/** A regular or settlement run is booked on its month's last day; a correction (HR-07) on the
 * day it is posted — the month it corrects may already be closed. */
function postingDateOf(run: { period: string; runType: string }) {
  return run.runType === "correction" ? todayLocalISO() : periodEnd(run.period);
}

/**
 * HR-22: whoever prepared or submitted a run neither posts nor pays it, and an actor with no
 * id (a system or integration actor) cannot prove it is someone else — refused too.
 */
function assertNotPreparer(run: { preparedById: string | null; submittedById: string | null }, actor: ServiceActor, what: "post" | "pay") {
  if (!actor.id || !run.preparedById || !run.submittedById) throw new ApiError(403, "العملية دي محتاجة مستخدم معروف، والمسير لازم يكون معروف مين حسبه وبعته");
  if (actor.id === run.preparedById || actor.id === run.submittedById) {
    throw new ApiError(403, what === "post" ? "مينفعش ترحّل مسير انت اللي حسبته أو بعته" : "مينفعش تصرف مسير انت اللي حسبته أو بعته");
  }
}

/**
 * HR-14: each employee's share of the month per cost center, by the days spent in each
 * department (employment history), in the order the departments occur. A department with no
 * linked cost center is the "" bucket (no center).
 */
async function costCenterShares(db: Db, period: string, empIds: string[]) {
  const from = `${period}-01`, to = periodEnd(period);
  const [rows, current] = await Promise.all([
    empIds.length ? db.employeeEmployment.findMany({ where: { employeeId: { in: empIds }, effectiveFrom: { lte: to }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }] }, select: { employeeId: true, effectiveFrom: true, effectiveTo: true, status: true, departmentId: true } }) : [],
    empIds.length ? db.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, departmentId: true } }) : [],
  ]);
  const deptIds = [...new Set([...rows.map((r) => r.departmentId), ...current.map((e) => e.departmentId)].filter((x): x is string => !!x))];
  const centers = deptIds.length ? await db.costCenter.findMany({ where: { departmentId: { in: deptIds }, active: true }, orderBy: { code: "asc" }, select: { id: true, departmentId: true } }) : [];
  const ccOfDept = new Map<string, string>();
  for (const c of centers) if (c.departmentId && !ccOfDept.has(c.departmentId)) ccOfDept.set(c.departmentId, c.id);
  const cc = (dept: string | null) => (dept ? ccOfDept.get(dept) ?? "" : "");
  const dates = datesBetween(from, to);
  const shares = new Map<string, [string, number][]>();
  for (const e of current) {
    const mine = rows.filter((r) => r.employeeId === e.id && !(r.effectiveTo && r.effectiveTo < r.effectiveFrom));
    const days = new Map<string, number>();
    for (const d of dates) {
      const row = mine.find((r) => r.effectiveFrom <= d && (!r.effectiveTo || r.effectiveTo >= d));
      if (!row || !onPayroll(row, d)) continue;
      const k = cc(row.departmentId);
      days.set(k, (days.get(k) ?? 0) + 1);
    }
    shares.set(e.id, days.size ? [...days] : [[cc(e.departmentId), 1]]);
  }
  return shares;
}

/** Splits an amount by day shares; the last share takes the rounding remainder. */
function split(amount: Prisma.Decimal, shares: [string, number][]) {
  const total = shares.reduce((a, [, n]) => a + n, 0);
  const out: [string, Prisma.Decimal][] = [];
  let left = amount;
  shares.forEach(([k, n], i) => {
    const part = i === shares.length - 1 ? left : amount.mul(n).div(total).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    left = left.minus(part);
    out.push([k, part]);
  });
  return out;
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
type AccountRow = { id: string; code: string; name: string; nameAr: string | null; type: string; active: boolean; postable: boolean; systemKey: string | null; controlledBy?: string | null };
export type PostingProblem = { code: "net_pay_account_missing" | "net_pay_account_invalid" | "expense_account_missing" | "liability_account_missing" | "deduction_account_missing" | "account_invalid" | "line_without_component"; params: Record<string, string> };
export type PreviewLine = { side: "debit" | "credit"; role: "component" | "recovery" | "net"; accountId: string | null; accountCode: string | null; accountName: string | null; accountNameAr: string | null; amount: string; label: string; component: string | null };

/** An account a payroll line may post to: active, postable, of the wanted type, not a control account and not a cash/bank account. */
async function usable(db: Db, a: AccountRow | null | undefined, types: string[]) {
  if (!a || !a.active || !a.postable || !types.includes(a.type) || controlAccountMovedBy(a.systemKey, a.controlledBy)) return false;
  return !(await db.cashAccount.findFirst({ where: { accountId: a.id }, select: { id: true } }));
}

async function buildPosting(db: Db, run: { id: string; period: string; number: string; netPayable: Prisma.Decimal; runType: string }) {
  const problems: PostingProblem[] = [];
  const preview: PreviewLine[] = [];
  const post: PostLine[] = [];

  const code = String(await getSetting("hr.payroll_net_pay_account")).trim();
  const netAccount = code ? await db.account.findUnique({ where: { code } }) : null;
  if (!code) problems.push({ code: "net_pay_account_missing", params: {} });
  else if (!(await usable(db, netAccount, ["liability"]))) problems.push({ code: "net_pay_account_invalid", params: { account: code } });

  const lines = await db.payrollRunLine.findMany({
    where: { runEmployee: { runId: run.id, inclusion: "included" }, amount: { not: 0 } },
    select: { kind: true, code: true, nameAr: true, amount: true, payComponentId: true, runEmployee: { select: { employeeId: true } } },
  });
  const componentIds = [...new Set(lines.map((l) => l.payComponentId).filter((x): x is string => !!x))];
  const components = new Map((await db.payComponent.findMany({ where: { id: { in: componentIds } }, include: { expenseAccount: true, liabilityAccount: true } })).map((c) => [c.id, c]));
  const advances = await db.account.findFirst({ where: { systemKey: "employee_advances" } });
  // Cost centers: an employee's salary cost goes to the active cost center linked to the
  // department they were in, split by the days of the month spent in each department (HR-14);
  // a department with no linked center carries none. Nothing is allocated unless an
  // accountant linked a center to the department.
  const empIds = [...new Set(lines.map((l) => l.runEmployee.employeeId))];
  const ccShares = await costCenterShares(db, run.period, empIds);

  const push = (side: "debit" | "credit", account: AccountRow | null | undefined, amount: Prisma.Decimal, label: string, component: string | null, party?: { type: "employee"; id: string }) => {
    preview.push({ side, role: component ? "component" : "net", accountId: account?.id ?? null, accountCode: account?.code ?? null, accountName: account?.name ?? null, accountNameAr: account?.nameAr ?? null, amount: amount.toFixed(2), label, component });
    if (account) post.push({ accountId: account.id, amount: side === "debit" ? amount : amount.negated(), description: label, party });
  };

  // Component lines, summed per component and kind; recovery stays per employee.
  const groups = new Map<string, { kind: string; code: string; nameAr: string; componentId: string | null; amount: Prisma.Decimal; byCenter: Map<string, Prisma.Decimal> }>();
  const recoveries = new Map<string, Prisma.Decimal>();
  for (const l of lines) {
    if (l.kind === "recovery") {
      recoveries.set(l.runEmployee.employeeId, (recoveries.get(l.runEmployee.employeeId) ?? ZERO).plus(l.amount));
      continue;
    }
    const key = `${l.kind}:${l.payComponentId ?? l.code}`;
    const g = groups.get(key) ?? { kind: l.kind, code: l.code, nameAr: l.nameAr, componentId: l.payComponentId, amount: ZERO, byCenter: new Map() };
    g.amount = g.amount.plus(l.amount);
    for (const [cc, part] of split(l.amount, ccShares.get(l.runEmployee.employeeId) ?? [["", 1]])) g.byCenter.set(cc, (g.byCenter.get(cc) ?? ZERO).plus(part));
    groups.set(key, g);
  }
  // An expense debit: one preview line, one posted line per cost center.
  const pushExpense = (account: AccountRow | null | undefined, g: { amount: Prisma.Decimal; byCenter: Map<string, Prisma.Decimal> }, label: string, component: string) => {
    preview.push({ side: "debit", role: "component", accountId: account?.id ?? null, accountCode: account?.code ?? null, accountName: account?.name ?? null, accountNameAr: account?.nameAr ?? null, amount: g.amount.toFixed(2), label, component });
    if (!account) return;
    for (const [cc, amount] of [...g.byCenter].sort(([a], [b]) => a.localeCompare(b))) if (!amount.isZero()) post.push({ accountId: account.id, amount, description: label, costCenterId: cc || null });
  };
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
      pushExpense(c.expenseAccount, g, label, c.code);
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
      pushExpense(c.expenseAccount, g, label, c.code);
      push("credit", c.liabilityAccount, g.amount, label, c.code);
    }
  }
  const recoveryTotal = [...recoveries.values()].reduce((s, v) => s.plus(v), ZERO);
  if (recoveryTotal.gt(0)) {
    // One preview line; one posted line per employee so each advance balance moves.
    preview.push({ side: "credit", role: "recovery", accountId: advances?.id ?? null, accountCode: advances?.code ?? null, accountName: advances?.name ?? null, accountNameAr: advances?.nameAr ?? null, amount: recoveryTotal.toFixed(2), label: "استرداد سلف وصرف تحت الحساب", component: null });
    if (advances) for (const [employeeId, amount] of recoveries) if (!amount.isZero()) post.push({ accountId: advances.id, amount: amount.negated(), description: `استرداد سلف ${run.number}`, party: { type: "employee", id: employeeId } });
  } else if ([...recoveries.values()].some((v) => !v.isZero())) {
    // A correction or settlement carries what was overpaid to employee advances (a debit per employee).
    preview.push({ side: "credit", role: "recovery", accountId: advances?.id ?? null, accountCode: advances?.code ?? null, accountName: advances?.name ?? null, accountNameAr: advances?.nameAr ?? null, amount: recoveryTotal.toFixed(2), label: "فروق مدفوعة زيادة على حساب سلف الموظفين", component: null });
    if (advances) for (const [employeeId, amount] of recoveries) if (!amount.isZero()) post.push({ accountId: advances.id, amount: amount.negated(), description: `فرق مسير ${run.number}`, party: { type: "employee", id: employeeId } });
  }
  push("credit", netAccount && problems.every((p) => !p.code.startsWith("net_pay")) ? netAccount : null, run.netPayable, `صافي مرتبات ${run.period}`, null);

  const debit = preview.filter((l) => l.side === "debit").reduce((s, l) => s.plus(l.amount), ZERO);
  const credit = preview.filter((l) => l.side === "credit").reduce((s, l) => s.plus(l.amount), ZERO);
  return { date: postingDateOf(run), lines: preview, post, problems, totals: { debit: debit.toFixed(2), credit: credit.toFixed(2) }, balanced: debit.equals(credit), netAccount };
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
    assertNotPreparer(run, actor, "post");
    const b = await buildPosting(tx, run);
    // Each problem is listed (localized) by the preview; the refusal carries their count.
    if (b.problems.length) throw new ApiError(409, `مينفعش الترحيل: فيه ${b.problems.length} حساب ناقص أو مش مناسب — راجع قيد المرتبات`);
    if (!b.balanced) throw new Error(`payroll posting for ${run.number} does not balance: ${b.totals.debit} ≠ ${b.totals.credit}`);
    const entry = await postJournal(tx, { date: b.date, description: `مسير مرتبات ${run.number} · ${run.period} · ${run.headcount} موظف`, sourceType: "payroll_run", sourceId: run.id, lines: b.post }, actor);
    if (!entry) throw new ApiError(409, "المسير مفيهوش مبالغ تترحّل");
    await tx.payrollAdjustment.updateMany({ where: { status: "reserved", reservedOn: { runId: id, inclusion: "included" } }, data: { status: "applied", version: { increment: 1 } } });
    if (run.runType === "final_settlement") await writeEncashment(tx, run, actor);
    if (run.runType === "correction") {
      // HR-08: approved corrections of locked days of the month are now paid by this run.
      const emps = (await tx.payrollRunEmployee.findMany({ where: { runId: id, inclusion: "included" }, select: { employeeId: true } })).map((e) => e.employeeId);
      await tx.attendanceCorrection.updateMany({ where: { employeeId: { in: emps }, date: { gte: run.attendanceFrom, lte: run.attendanceTo }, status: "approved", retroStatus: "pending" }, data: { retroStatus: "applied" } });
    }
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
    // HR-07: the posted differences of a correction depend on the run they correct.
    if (await tx.payrollRun.count({ where: { correctionOfRunId: id, status: { notIn: ["cancelled", "reversed"] } } })) throw new ApiError(409, "فيه مسير تصحيح على المسير ده — اعكس أو الغي التصحيح الأول");
    if (run.runType === "final_settlement") {
      // The month's regular run relies on a posted settlement for the leaver.
      const s = await tx.employeeFinalSettlement.findUniqueOrThrow({ where: { runId: id } });
      const regular = await tx.payrollRunEmployee.count({ where: { employeeId: s.employeeId, inclusion: "included", run: { runType: "regular", period: run.period, status: { in: ["pending_approval", "approved", "posted"] } } } });
      if (regular) throw new ApiError(409, "مسير الشهر العادي معتمد على التسوية دي — رجّعه أو اعكسه الأول");
    }
    const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: run.journalEntryId! }, include: { lines: true } });
    const rev = await postJournal(tx, {
      date, description: `عكس مسير مرتبات ${run.number}: ${v.reason}`, sourceType: "reversal", sourceId: entry.id, reversalOfId: entry.id,
      lines: entry.lines.map((l) => ({ accountId: l.accountId, amount: l.credit.minus(l.debit), party: l.partyType ? { type: l.partyType as "employee", id: l.partyId! } : undefined, description: l.description ?? undefined, costCenterId: l.costCenterId })),
    }, actor);
    const row = await tx.payrollRun.update({ where: { id }, data: { status: "reversed", reversedAt: new Date(), reversedById: actor.id, reversedBy: actor.name, reversalReason: v.reason, reversalEntryId: rev!.id, version: { increment: 1 } } });
    // The month can be paid again by a new run: its adjustments and attendance go back.
    await tx.payrollAdjustment.updateMany({ where: { status: { in: ["applied", "reserved"] }, reservedOn: { runId: id } }, data: { status: "open", reservedRunEmployeeId: null, version: { increment: 1 } } });
    await unlockAttendance(tx, id, actor);
    if (run.runType === "final_settlement") await restoreEncashment(tx, run, v.reason, actor);
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_run_reversed", entityType: "payroll_run", entityId: id, fieldChanged: run.period, oldValue: entry.number, newValue: rev!.number, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Final settlement: the leave it pays out leaves the balance (HR-11)
// ---------------------------------------------------------------------------

/** On posting: an `encashment` ledger entry per encashed leave type; refused if the balance
 * no longer covers the days the approver saw. */
async function writeEncashment(tx: Tx, run: { id: string; number: string }, actor: ServiceActor) {
  const s = await tx.employeeFinalSettlement.findUniqueOrThrow({ where: { runId: run.id } });
  const lines = await tx.payrollRunLine.findMany({ where: { runEmployee: { runId: run.id, employeeId: s.employeeId, inclusion: "included" }, sourceType: "settlement", sourceId: { startsWith: "leave:" } } });
  if (lines.length) await advisoryXactLock(tx, `hr-leave-employee:${s.employeeId}`);
  for (const l of lines) {
    const leaveTypeId = l.sourceId!.slice("leave:".length);
    const days = l.quantity ?? ZERO;
    if (days.lte(0)) continue;
    const bal = (await tx.leaveLedgerEntry.aggregate({ where: { employeeId: s.employeeId, leaveTypeId }, _sum: { days: true } }))._sum.days ?? ZERO;
    if (bal.lt(days)) throw new ApiError(409, `رصيد الإجازة اتغير من وقت الحساب (${bal.toString()} يوم بدل ${days.toString()}) — رجّع التسوية واحسبها تاني`);
    await tx.leaveLedgerEntry.create({ data: { employeeId: s.employeeId, leaveTypeId, date: s.lastWorkingDay, kind: "encashment", days: days.negated(), sourceType: "final_settlement", sourceId: `${run.id}:${leaveTypeId}`, note: run.number, createdById: actor.id, createdBy: actor.name } });
  }
}

/** On reversing a settlement: the encashed days come back, as an adjustment with the reason. */
async function restoreEncashment(tx: Tx, run: { id: string; number: string }, reason: string, actor: ServiceActor) {
  const taken = await tx.leaveLedgerEntry.findMany({ where: { sourceType: "final_settlement", sourceId: { startsWith: `${run.id}:` }, kind: "encashment" } });
  for (const e of taken) {
    await tx.leaveLedgerEntry.create({ data: { employeeId: e.employeeId, leaveTypeId: e.leaveTypeId, date: todayLocalISO(), kind: "adjustment", days: e.days.negated(), sourceType: "final_settlement_reversal", sourceId: e.sourceId, note: `عكس ${run.number}: ${reason}`.slice(0, 300), createdById: actor.id, createdBy: actor.name } });
  }
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
    assertNotPreparer(run, actor, "pay");
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
      lines: entry.lines.map((l) => ({ accountId: l.accountId, amount: l.credit.minus(l.debit), party: l.partyType ? { type: l.partyType as "employee", id: l.partyId! } : undefined, description: l.description ?? undefined, costCenterId: l.costCenterId })),
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
      include: { cashAccount: { select: { code: true, name: true, nameAr: true } }, journalEntry: { select: { number: true } }, reversalEntry: { select: { number: true } }, lines: { select: { amount: true, runEmployee: { select: { employeeId: true } } } } },
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
    include: { employees: { where: { inclusion: "included" }, orderBy: { employee: { code: "asc" } }, include: { employee: { select: { code: true, name: true, nameAr: true, jobTitle: true, department: { select: { name: true, nameAr: true } } } }, lines: true } } },
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
