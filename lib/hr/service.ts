import { Prisma } from "@prisma/client";
import { idempotencyKeyField, lockKey, replayRequest, requestFingerprint } from "@/lib/core/idempotency";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { getSetting } from "@/lib/core/settings-service";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { requestApproval } from "@/lib/core/approvals";
import { active, optText, parse, text } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { postJournal, type PostLine } from "@/lib/accounting/ledger";

/**
 * HR and expenses — the minimum UNITED needs: who works where, what they spend, and
 * the cash between them and the company.
 *
 *  - An expense is approved through the approval engine (`hr.expense`, decided by
 *    hr.expenses.approve) unless it is under the configured threshold; once approved
 *    it posts:  Dr expense account  Cr cash/bank (paid now) | employee payable
 *    (reimburse later) | employee advance (spent from an advance).
 *  - Advances, reimbursements and advance returns post at once:
 *      advance        Dr Employee advances (employee)   Cr cash/bank
 *      reimbursement  Dr Employee payable (employee)    Cr cash/bank
 *      advance_return Dr cash/bank                      Cr Employee advances (employee)
 *  - An employee's balance is read from the journal (party = employee), never stored.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const amount = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const s = typeof v === "number" ? String(v) : v.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "المبلغ لازم يكون أكبر من صفر بحد أقصى خانتين عشريتين" });
    return z.NEVER;
  }
  return D(s);
});
const date = z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD").optional();
type Actorish = { id: string | null; name: string; role: string; deviceId?: string };
const audit = (tx: Tx, actor: Actorish, entityType: "employee" | "expense" | "employee_transaction", id: string, action: string, detail: string | null, reason?: string | null) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType, entityId: id, newValue: detail, reason: reason ?? undefined, source: "user", deviceId: actor.deviceId }, tx);

// ---------------------------------------------------------------------------
// Departments and employees
// ---------------------------------------------------------------------------

export async function saveDepartment(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.employees.manage");
  const v = parse(z.object({ code: text("الكود", 20), name: text("الاسم", 100), active: active().optional() }), input);
  const code = v.code.toUpperCase();
  return inTx(async (tx) => {
    if (v.active === false) {
      // A department still holding active employees cannot be closed — move them first.
      const dep = await tx.department.findUnique({ where: { code }, select: { id: true } });
      if (dep && (await tx.employee.count({ where: { departmentId: dep.id, active: true } })) > 0) throw new ApiError(409, "القسم فيه موظفين نشطين — انقلهم الأول");
    }
    const before = await tx.department.findUnique({ where: { code } });
    const d = await tx.department.upsert({ where: { code }, update: { name: v.name, ...(v.active !== undefined ? { active: v.active } : {}) }, create: { code, name: v.name, ...(v.active !== undefined ? { active: v.active } : {}) } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: before ? "department_updated" : "department_created", entityType: "department", entityId: d.id, oldValue: before ? `${before.name}${before.active ? "" : " · موقوف"}` : undefined, newValue: `${d.code} · ${d.name}${d.active ? "" : " · موقوف"}`, source: "user", deviceId: actor.deviceId }, tx);
    return d;
  });
}

const employeeInput = z.object({
  name: text("الاسم", 100),
  department_id: z.string().nullable().optional(),
  job_title: optText("الوظيفة", 100).optional(),
  phone: optText("التليفون", 30).optional(),
  user_id: z.string().nullable().optional(),
  hire_date: date,
  active: active().optional(),
  expected_version: z.number().int().positive().optional(),
});

export async function saveEmployee(id: string | null, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.employees.manage");
  const v = parse(employeeInput, input);
  return inTx(async (tx) => {
    // On an edit, a field left out of the request keeps its value — an edit form that does
    // not show the linked user must not unlink it. `null` clears a field explicitly.
    const data: Prisma.EmployeeUncheckedUpdateInput & { name: string } = { name: v.name };
    if (v.department_id !== undefined) data.departmentId = v.department_id ?? null;
    if (v.job_title !== undefined) data.jobTitle = v.job_title ?? null;
    if (v.phone !== undefined) data.phone = v.phone ?? null;
    if (v.user_id !== undefined) data.userId = v.user_id ?? null;
    if (v.hire_date !== undefined) data.hireDate = v.hire_date ?? null;
    if (v.active !== undefined) data.active = v.active;
    if (typeof data.departmentId === "string") {
      // Moving someone into a department needs it to be open; keeping their current one does not.
      const current = id ? (await tx.employee.findUnique({ where: { id }, select: { departmentId: true } }))?.departmentId : null;
      if (data.departmentId !== current && !(await tx.department.findFirst({ where: { id: data.departmentId, active: true } }))) throw new ApiError(400, "القسم مش موجود أو مقفول");
    }
    let e;
    try {
      if (id && v.expected_version !== undefined) {
        const cur = await tx.employee.findUnique({ where: { id }, select: { version: true } });
        if (!cur) throw new ApiError(404, "الموظف مش موجود");
        if (cur.version !== v.expected_version) throw new ApiError(409, "حد تاني عدّل بيانات الموظف — حدّث الصفحة وحاول تاني");
      }
      e = id ? await tx.employee.update({ where: { id }, data: { ...data, version: { increment: 1 } } }) : await tx.employee.create({ data: { ...(data as Prisma.EmployeeUncheckedCreateInput), code: await nextDocumentNumber(tx, "hr.employee", todayLocalISO()) } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ApiError(409, "المستخدم ده مربوط بموظف تاني");
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") throw new ApiError(404, "الموظف مش موجود");
      throw err;
    }
    await audit(tx, actor, "employee", e.id, id ? "employee_updated" : "employee_created", `${e.code} · ${e.name}${e.active ? "" : " · موقوف"}`);
    return e;
  });
}

/** Who may see an employee's money (advance/payable balance) and contact details. Anyone who
 * only records expenses (e.g. the supervisor) gets names to pick from — nothing else. */
export function canSeeEmployeeFinance(actor: ServiceActor) {
  return actorCan(actor, "hr.employees.manage") || actorCan(actor, "hr.advances.manage") || actorCan(actor, "accounting.view");
}

/** Employees with their balance on the journal: advances they hold (+) and what the company owes them (−).
 * Balances, phones and user links are returned only to HR/finance (see canSeeEmployeeFinance). */
export async function listEmployees(actor: ServiceActor) {
  const full = canSeeEmployeeFinance(actor);
  const [emps, deps, bal] = await Promise.all([
    prisma.employee.findMany({ orderBy: [{ active: "desc" }, { code: "asc" }], include: { department: { select: { id: true, name: true } } } }),
    prisma.department.findMany({ orderBy: { code: "asc" } }),
    full ? prisma.journalLine.groupBy({ by: ["partyId"], where: { partyType: "employee" }, _sum: { debit: true, credit: true } }) : Promise.resolve([]),
  ]);
  if (!full) {
    return {
      departments: deps.filter((d) => d.active).map((d) => ({ id: d.id, code: d.code, name: d.name, active: d.active })),
      employees: emps.filter((e) => e.active).map((e) => ({ id: e.id, code: e.code, name: e.name, active: e.active, department: e.department })),
    };
  }
  const by = new Map(bal.map((b) => [b.partyId!, D(b._sum.debit ?? 0).minus(b._sum.credit ?? 0)]));
  const counts = new Map<string, number>();
  for (const e of emps) if (e.active && e.departmentId) counts.set(e.departmentId, (counts.get(e.departmentId) ?? 0) + 1);
  return {
    departments: deps.map((d) => ({ ...d, activeEmployees: counts.get(d.id) ?? 0 })),
    employees: emps.map((e) => ({ ...e, balance: (by.get(e.id) ?? D(0)).toFixed(2) })),
  };
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

const expenseInput = z.object({
  date,
  employee_id: z.string().optional(),
  account_id: text("بند المصروف"),
  amount,
  description: text("البيان", 500),
  payment_mode: z.enum(["cash", "reimburse", "advance"]),
  cash_account_id: z.string().optional(),
  idempotency_key: idempotencyKeyField,
});

async function postExpense(tx: Tx, expenseId: string, actor: Actorish) {
  const e = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
  const credit: PostLine =
    e.paymentMode === "cash"
      ? { accountId: (await tx.cashAccount.findUniqueOrThrow({ where: { id: e.cashAccountId! } })).accountId, amount: e.amount.negated() }
      : { key: e.paymentMode === "reimburse" ? "employee_payable" : "employee_advances", amount: e.amount.negated(), party: { type: "employee", id: e.employeeId! } };
  return postJournal(tx, { date: e.date, description: `مصروف ${e.number}: ${e.description}`, sourceType: "expense", sourceId: e.id, lines: [{ accountId: e.accountId, amount: e.amount }, credit] }, actor);
}

export async function createExpense(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.expenses.submit");
  const v = parse(expenseInput, input);
  const d = v.date ?? todayLocalISO();
  if (v.payment_mode === "cash" && !v.cash_account_id) throw new ApiError(400, "اختار الخزينة اللي اتدفع منها");
  if (v.payment_mode !== "cash" && !v.employee_id) throw new ApiError(400, "اختار الموظف");
  const threshold = await getSetting("hr.expense_approval_threshold");
  const requestHash = requestFingerprint({ date: d, employeeId: v.employee_id ?? null, accountId: v.account_id, amount: v.amount, description: v.description, paymentMode: v.payment_mode, cashAccountId: v.payment_mode === "cash" ? v.cash_account_id ?? null : null });
  return inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.expense.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) return replayRequest(prev, requestHash, prev.accountId === v.account_id && D(prev.amount).equals(v.amount) && prev.paymentMode === v.payment_mode && prev.date === d && prev.employeeId === (v.employee_id ?? null) && prev.description === v.description && prev.cashAccountId === (v.payment_mode === "cash" ? v.cash_account_id ?? null : null));
    }
    const account = await tx.account.findUnique({ where: { id: v.account_id } });
    if (!account || account.type !== "expense" || !account.postable || !account.active) throw new ApiError(400, "بند المصروف لازم يكون حساب مصروفات");
    if (v.employee_id && !(await tx.employee.findFirst({ where: { id: v.employee_id, active: true } }))) throw new ApiError(400, "الموظف مش موجود أو موقوف");
    if (v.cash_account_id && !(await tx.cashAccount.findFirst({ where: { id: v.cash_account_id, active: true } }))) throw new ApiError(400, "الخزينة مش موجودة");
    const auto = v.amount.lessThanOrEqualTo(threshold);
    const e = await tx.expense.create({
      data: {
        number: await nextDocumentNumber(tx, "hr.expense", d), date: d, employeeId: v.employee_id ?? null, accountId: account.id, amount: v.amount, description: v.description,
        paymentMode: v.payment_mode, cashAccountId: v.payment_mode === "cash" ? v.cash_account_id! : null, idempotencyKey: v.idempotency_key ?? null, requestHash,
        status: auto ? "approved" : "pending_approval", ...(auto ? { decidedBy: "قاعدة الحد", decidedAt: new Date() } : {}),
        createdById: actor.id, createdBy: actor.name,
      },
    });
    await audit(tx, actor, "expense", e.id, "expense_recorded", `${e.number} · ${account.code} · ${v.amount.toFixed(2)} · ${auto ? "معتمد تلقائي" : "مستني اعتماد"}`);
    if (auto) await postExpense(tx, e.id, actor);
    else await requestApproval(tx, { type: "hr.expense", entityId: e.id, title: `مصروف ${e.number}: ${v.description}`, summary: `${v.amount.toFixed(2)} ج.م — ${account.nameAr}`, amount: v.amount, requester: actor });
    return e;
  });
}

/** Called by the approval engine when the expense is decided. */
export async function applyExpenseDecision(tx: Tx, id: string, approved: boolean, decider: Actorish, comment?: string) {
  const e = await tx.expense.findUnique({ where: { id } });
  if (!e) throw new ApiError(404, "المصروف مش موجود");
  if (e.status !== "pending_approval") throw new ApiError(409, "المصروف مش مستني اعتماد");
  await tx.expense.update({ where: { id, version: e.version }, data: { status: approved ? "approved" : "rejected", decidedBy: decider.name, decidedAt: new Date(), version: { increment: 1 } } });
  await audit(tx, decider, "expense", id, approved ? "expense_approved" : "expense_rejected", e.number, comment);
  if (approved) await postExpense(tx, id, decider);
}

export async function listExpenses(actor: ServiceActor, filters: { status?: string }) {
  // Whoever may approve or keeps the books sees all; a submitter sees their own.
  const all = actorCan(actor, "hr.expenses.approve") || actorCan(actor, "accounting.view");
  const rows = await prisma.expense.findMany({
    where: { ...(filters.status ? { status: filters.status } : {}), ...(all ? {} : { createdById: actor.id ?? "-" }) },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    include: { employee: { select: { code: true, name: true } } },
    take: 300,
  });
  const accounts = new Map((await prisma.account.findMany({ where: { type: "expense" }, select: { id: true, code: true, name: true, nameAr: true } })).map((a) => [a.id, a]));
  return rows.map((e) => ({ ...e, amount: e.amount.toFixed(2), account: accounts.get(e.accountId) ?? null }));
}

// ---------------------------------------------------------------------------
// Advances, reimbursements, advance returns
// ---------------------------------------------------------------------------

export async function createEmployeeTransaction(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.advances.manage");
  const v = parse(z.object({ employee_id: text("الموظف"), type: z.enum(["advance", "reimbursement", "advance_return"]), amount, cash_account_id: text("الخزينة"), date, notes: optText("ملاحظات", 500).optional(), idempotency_key: idempotencyKeyField }), input);
  const d = v.date ?? todayLocalISO();
  const requestHash = requestFingerprint({ employeeId: v.employee_id, type: v.type, amount: v.amount, cashAccountId: v.cash_account_id, date: d, notes: v.notes ?? null });
  return inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.employeeTransaction.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) return replayRequest(prev, requestHash, prev.employeeId === v.employee_id && prev.type === v.type && D(prev.amount).equals(v.amount) && prev.cashAccountId === v.cash_account_id && prev.date === d && prev.notes === (v.notes ?? null));
    }
    const emp = await tx.employee.findUnique({ where: { id: v.employee_id } });
    if (!emp) throw new ApiError(404, "الموظف مش موجود");
    // A deactivated employee can still be settled with (paid what is owed, return an
    // advance) but cannot be given new money — the same rule expenses already apply.
    if (v.type === "advance" && !emp.active) throw new ApiError(400, "الموظف مش موجود أو موقوف");
    const cash = await tx.cashAccount.findFirst({ where: { id: v.cash_account_id, active: true } });
    if (!cash) throw new ApiError(400, "الخزينة مش موجودة");
    const party = { type: "employee" as const, id: emp.id };
    if (v.type === "reimbursement") {
      const owed = await tx.journalLine.aggregate({ where: { partyType: "employee", partyId: emp.id, account: { systemKey: "employee_payable" } }, _sum: { debit: true, credit: true } });
      const due = D(owed._sum.credit ?? 0).minus(owed._sum.debit ?? 0);
      if (v.amount.greaterThan(due)) throw new ApiError(400, `المستحق للموظف ${due.toFixed(2)} بس`);
    }
    if (v.type === "advance_return") {
      const held = await tx.journalLine.aggregate({ where: { partyType: "employee", partyId: emp.id, account: { systemKey: "employee_advances" } }, _sum: { debit: true, credit: true } });
      const open = D(held._sum.debit ?? 0).minus(held._sum.credit ?? 0);
      if (v.amount.greaterThan(open)) throw new ApiError(400, `السلفة المفتوحة ${open.toFixed(2)} بس`);
    }
    const t = await tx.employeeTransaction.create({ data: { employeeId: emp.id, type: v.type, date: d, amount: v.amount, cashAccountId: cash.id, notes: v.notes ?? null, idempotencyKey: v.idempotency_key ?? null, requestHash, createdById: actor.id, createdBy: actor.name } });
    const label = { advance: "سلفة", reimbursement: "صرف مستحقات", advance_return: "رد سلفة" }[v.type];
    const lines: PostLine[] =
      v.type === "advance" ? [{ key: "employee_advances", amount: v.amount, party }, { accountId: cash.accountId, amount: v.amount.negated() }]
      : v.type === "reimbursement" ? [{ key: "employee_payable", amount: v.amount, party }, { accountId: cash.accountId, amount: v.amount.negated() }]
      : [{ accountId: cash.accountId, amount: v.amount }, { key: "employee_advances", amount: v.amount.negated(), party }];
    await postJournal(tx, { date: d, description: `${label} — ${emp.name}`, sourceType: "employee_transaction", sourceId: t.id, lines }, actor);
    await audit(tx, actor, "employee_transaction", t.id, `employee_${v.type}`, `${emp.code} · ${v.amount.toFixed(2)}`);
    return t;
  });
}

/** One employee's advances and payable, line by line, from the journal. */
export async function employeeStatement(id: string) {
  const emp = await prisma.employee.findUnique({ where: { id } });
  if (!emp) throw new ApiError(404, "الموظف مش موجود");
  const lines = await prisma.journalLine.findMany({ where: { partyType: "employee", partyId: id }, include: { entry: { select: { number: true, date: true, description: true, createdAt: true } }, account: { select: { systemKey: true } } }, orderBy: [{ entry: { date: "asc" } }, { entry: { createdAt: "asc" } }] });
  let advances = D(0), payable = D(0);
  const rows = lines.map((l) => {
    if (l.account.systemKey === "employee_advances") advances = advances.plus(l.debit).minus(l.credit);
    else payable = payable.plus(l.credit).minus(l.debit);
    return { date: l.entry.date, number: l.entry.number, description: l.entry.description, account: l.account.systemKey, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2) };
  });
  return { employee: { id: emp.id, code: emp.code, name: emp.name }, rows, advancesHeld: advances.toFixed(2), owedToEmployee: payable.toFixed(2) };
}
