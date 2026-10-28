/* HR phases 4–5 — compensation, statutory rule sets and payroll runs up to approval
   (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.6–3.10, §4.1–4.5).
   Every rate, limit and bracket below is a TEST VALUE chosen to make the arithmetic checkable by
   hand — none is a statutory figure. The suite checks that payroll refuses to calculate without
   verified rules, that the figures follow the entered rules exactly, that nobody approves their
   own package / rule / run, that submission freezes the figures and the attendance, and that an
   approval is refused when anything changed after submission. */
import { call, login, makeChecker } from "./_harness";
import { Prisma, PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./_guard";

const { check, section, finish } = makeChecker();
const TAG = `ZP${Date.now() % 1_000_000_000}`;
let r: any;

let db: PrismaClient | null = null;
function sql() {
  if (!db) { assertTestDatabase(); db = new PrismaClient(); }
  return db;
}
const rejects = async (q: () => Promise<unknown>) => { try { await q(); return false; } catch { return true; } };
const strictTx = (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
  sql().$transaction(async (tx) => { await fn(tx); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; });
const money = (v: unknown) => Number(v).toFixed(2);

async function main() {
  for (const u of ["admin", "karim", "sara", "ahmed"]) await login(u);
  const s = sql();

  // A month at least 14 months back that no live regular run uses (each run of this suite takes a new one).
  const now = new Date();
  let P = "";
  for (let back = 14; back < 400 && !P; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const p = d.toISOString().slice(0, 7);
    if (!(await s.payrollRun.findFirst({ where: { period: p, runType: "regular", status: { not: "cancelled" } } }))) P = p;
  }
  const [py, pm] = P.split("-").map(Number);
  const monthDays = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const first = `${P}-01`, last = `${P}-${String(monthDays).padStart(2, "0")}`;
  const before = new Date(Date.UTC(py, pm - 3, 1)).toISOString().slice(0, 10);
  const mid = `${P}-16`;

  section("1. PAY COMPONENTS — inactive until tax and insurance treatment is decided");
  check("finance cannot activate a component without its tax treatment (400)", (await call("karim", "POST", "/api/hr/payroll/components", { code: `${TAG}X`, name_ar: "x", kind: "earning", method: "fixed", active: true })).status === 400);
  check("a computed component needs a role (400)", (await call("karim", "POST", "/api/hr/payroll/components", { code: `${TAG}Y`, name_ar: "x", kind: "deduction", method: "system", taxable: false, insurable: false })).status === 400);
  check("the supervisor cannot define components (403)", (await call("sara", "POST", "/api/hr/payroll/components", { code: `${TAG}Z`, name_ar: "x", kind: "earning", method: "fixed" })).status === 403);
  const mk = async (code: string, name: string, kind: string, method: string, taxable: boolean, insurable: boolean, system_role?: string) =>
    (await call("karim", "POST", "/api/hr/payroll/components", { code, name_ar: name, kind, method, taxable, insurable, active: true, ...(system_role ? { system_role } : {}) })).body.component;
  const BASIC = await mk(`${TAG}BASIC`, "أساسي (اختبار)", "earning", "fixed", true, true);
  const ALLOW = await mk(`${TAG}ALLOW`, "بدل (اختبار)", "earning", "fixed", true, false);
  const BONUS = await mk(`${TAG}BONUS`, "مكافأة (اختبار)", "earning", "input", true, false);
  check("finance defines fixed and one-off components", !!BASIC?.id && !!ALLOW?.id && !!BONUS?.id);
  const roles: [string, string, boolean][] = [
    ["social_insurance_employee", "deduction", false], ["social_insurance_employer", "employer_contribution", false], ["income_tax", "deduction", false],
    ["unpaid_absence", "deduction", true], ["partial_leave", "deduction", true], ["overtime_day", "earning", true], ["overtime_night", "earning", true],
    ["overtime_rest_day", "earning", true], ["overtime_holiday", "earning", true], ["advance_recovery", "deduction", false],
  ];
  for (const [role, kind, taxable] of roles) {
    if (!(await s.payComponent.findFirst({ where: { systemRole: role } }))) await mk(`ZZ_${role.toUpperCase()}`.slice(0, 30), `${role} (test)`, kind, "system", taxable, false, role);
    await s.payComponent.updateMany({ where: { systemRole: role }, data: { active: true, taxable, insurable: false } });
  }
  check("the computed components exist once each (role is unique)", (await s.payComponent.count({ where: { systemRole: { in: roles.map((x) => x[0]) } } })) === roles.length);
  check("DB: an active component must have its tax treatment", await rejects(() => s.payComponent.update({ where: { id: BASIC.id }, data: { taxable: null } })));

  section("2. EMPLOYEES, SCHEDULE, PACKAGES — proposed by one person, approved by another");
  const days = [0, 1, 2, 3, 4, 5, 6].map((w) => ({ weekday: w, is_working_day: true, start: "09:00", end: "17:00", break_minutes: 0 }));
  const schedule = (await call("karim", "POST", "/api/hr/schedules", { code: `${TAG}W`, name_ar: `${TAG} دوام`, days })).body.schedule;
  const hire = async (name: string, on: string) => {
    const e = (await call("karim", "POST", "/api/hr/employees", { name: `${TAG} ${name}`, hire_date: on })).body.employee;
    await call("karim", "POST", `/api/hr/employees/${e.id}/employment`, { event: "contract_change", effective_from: on, work_schedule_id: schedule.id, reason: "جدول" });
    return e;
  };
  const e1 = await hire("كامل", before);
  const e2 = await hire("نص شهر", mid);
  const e3 = await hire("من غير مرتب", before);

  const pkg = (employee_id: string, effective_from: string, lines: [string, number][], insurable_wage: number | null) =>
    call("karim", "POST", "/api/hr/compensation", { employee_id, effective_from, insurable_wage, reason: "تعيين", lines: lines.map(([pay_component_id, amount]) => ({ pay_component_id, amount })) });
  check("a package with a one-off component is refused (400)", (await pkg(e1.id, first, [[BONUS.id, 100]], 0)).status === 400);
  r = await pkg(e1.id, first, [[BASIC.id, 6000], [ALLOW.id, 1000]], 6000);
  check("finance proposes a package (201, CMP- number, pending, approval opened)", r.status === 201 && /^CMP-/.test(r.body.package.number) && r.body.package.status === "pending" && r.body.package.approvalRequestId, r.body);
  const p1 = r.body.package;
  check("a second pending proposal for the same employee -> 409", (await pkg(e1.id, first, [[BASIC.id, 1]], 0)).status === 409);
  check("the proposer cannot approve it (403)", (await call("karim", "POST", `/api/approvals/${p1.approvalRequestId}/decide`, { decision: "approve" })).status === 403);
  r = await call("admin", "POST", `/api/approvals/${p1.approvalRequestId}/decide`, { decision: "approve" });
  check("an approver approves it", r.status === 200 && (await s.employeeCompensation.findUnique({ where: { id: p1.id } }))?.status === "approved", r.body);
  const p2 = (await pkg(e2.id, mid, [[BASIC.id, 3000]], 3000)).body.package;
  await call("admin", "POST", `/api/approvals/${p2.approvalRequestId}/decide`, { decision: "approve" });
  r = await call("admin", "POST", "/api/hr/compensation", { employee_id: e3.id, effective_from: first, insurable_wage: 0, reason: "x", lines: [{ pay_component_id: BASIC.id, amount: 100 }] });
  check("whoever proposed a package cannot approve it, even with the permission (403)", (await call("admin", "POST", `/api/approvals/${r.body.package.approvalRequestId}/decide`, { decision: "approve" })).status === 403);
  check("…the proposer withdraws it", (await call("admin", "POST", `/api/hr/compensation/${r.body.package.id}/cancel`, {})).status === 200);
  check("a package starting before the one in force -> 400", (await pkg(e1.id, before, [[BASIC.id, 1]], 0)).status === 400);
  check("the supervisor cannot read salaries (403)", (await call("sara", "GET", "/api/hr/compensation")).status === 403);
  const directory = JSON.stringify((await call("karim", "GET", "/api/hr/employees")).body);
  check("the employee directory never carries packages or salary lines", !directory.includes(p1.id) && !directory.includes(p1.number) && !directory.includes("insurableWage"));
  check("DB: an approved package cannot change", await rejects(() => s.employeeCompensation.update({ where: { id: p1.id }, data: { insurableWage: 1 } })));
  check("DB: its lines cannot change", await rejects(() => s.employeeCompensationLine.updateMany({ where: { compensationId: p1.id }, data: { amount: 1 } })));
  check("DB: two approved packages never overlap", await rejects(() => strictTx((tx) => tx.employeeCompensation.create({ data: { number: `${TAG}-c`, employeeId: e1.id, effectiveFrom: last, reason: "x", status: "approved", createdBy: "t", decidedBy: "t", decidedAt: new Date() } }))));

  section("3. ATTENDANCE AND ON-ACCOUNT PAY FOR THE MONTH");
  const D1 = `${P}-05`, D2 = `${P}-06`;
  r = await call("sara", "POST", "/api/hr/attendance/days", { date: D1, rows: [{ employee_id: e1.id, status: "present", first_in: "09:00", last_out: "19:00" }] });
  await call("sara", "POST", "/api/hr/attendance/days", { date: D2, rows: [{ employee_id: e1.id, status: "absent_unpaid" }] });
  await call("sara", "POST", "/api/hr/attendance/confirm", { date: D1 });
  await call("sara", "POST", "/api/hr/attendance/confirm", { date: D2 });
  check("e1: 2 hours after the schedule on one day, one unpaid absence (confirmed)", (await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: D1 } } }))?.overtimeDayMinutes === 120);
  check("an on-account payment needs its payroll month (400)", (await call("karim", "POST", "/api/hr/transactions", { employee_id: e1.id, type: "salary_on_account", amount: "500", cash_account_id: "cash_main", date: D1 })).status === 400);
  r = await call("karim", "POST", "/api/hr/transactions", { employee_id: e1.id, type: "salary_on_account", amount: "500", cash_account_id: "cash_main", date: D1, payroll_period: P });
  check("finance pays 500 on account of the month (posted like an advance)", r.status === 201 && r.body.transaction?.payrollPeriod === P && (await s.journalEntry.count({ where: { sourceType: "employee_transaction", sourceId: r.body.transaction.id } })) === 1, r.body);

  section("4. A RUN REFUSES TO CALCULATE WHAT NO VERIFIED RULE COVERS");
  check("the supervisor cannot create runs (403)", (await call("sara", "POST", "/api/hr/payroll/runs", { period: P })).status === 403);
  check("a future month -> 400", (await call("karim", "POST", "/api/hr/payroll/runs", { period: "2999-01" })).status === 400);
  r = await call("karim", "POST", "/api/hr/payroll/runs", { period: P });
  check("finance creates the month's run (PRL-, draft, a payslip per employee of the month)", r.status === 201 && /^PRL-/.test(r.body.run.number) && r.body.run.status === "draft", r.body);
  const run = r.body.run;
  check("one regular run per month (409)", (await call("karim", "POST", "/api/hr/payroll/runs", { period: P })).status === 409);
  const slips = await s.payrollRunEmployee.findMany({ where: { runId: run.id } });
  check("…our three employees are on it", [e1.id, e2.id, e3.id].every((id) => slips.some((x) => x.employeeId === id)));
  for (const x of slips.filter((x) => ![e1.id, e2.id, e3.id].includes(x.employeeId))) {
    await call("karim", "PATCH", `/api/hr/payroll/runs/${run.id}/employees/${x.employeeId}`, { inclusion: "on_hold", hold_reason: "خارج اختبار المرتبات" });
  }
  check("holding a payslip needs a reason (400)", (await call("karim", "PATCH", `/api/hr/payroll/runs/${run.id}/employees/${e3.id}`, { inclusion: "on_hold" })).status === 400);
  r = await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/calculate`, {});
  check("calculating without verified rules works but reports them", r.status === 200 && r.body.run.status === "calculated", r.body);
  let detail = (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}`)).body;
  const codes = (detail.exceptions ?? []).map((e: any) => `${e.code}:${e.params?.rule ?? ""}`);
  check("…blocking: no verified insurance, tax and proration rules; no package for e3", ["rule_missing:eg_social_insurance", "rule_missing:eg_salary_income_tax", "rule_missing:pay_proration", "no_compensation:"].every((c) => codes.includes(c)), codes);
  check("…overtime with no verified rule is reported as not paid (warning)", (detail.exceptions ?? []).some((e: any) => e.code === "overtime_not_paid" && e.severity === "warning"));
  check("…and submission is refused (409)", (await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/submit`, {})).status === 409);

  section("5. STATUTORY RULE SETS — entered with a source, verified by someone else");
  const rule = (code: string, parameters: unknown) => call("karim", "POST", "/api/hr/statutory", { code, effective_from: first, effective_to: last, parameters, source_reference: `${TAG} TEST VALUES — not a statutory source` });
  check("an unknown rule kind -> 400", (await rule("eg_made_up", {})).status === 400);
  check("a rate above 100% -> 400", (await rule("eg_social_insurance", { employee_rate: 150, employer_rate: 20, min_insurable_wage: 1000, max_insurable_wage: 10000 })).status === 400);
  check("brackets that are not ascending -> 400", (await rule("eg_salary_income_tax", { taxable_base: "taxable_gross", period_method: "annualised_monthly", annual_exemption: 0, brackets: [{ up_to: 10, rate: 1 }, { up_to: 5, rate: 2 }, { up_to: null, rate: 3 }] })).status === 400);
  check("a source reference is required (400)", (await call("karim", "POST", "/api/hr/statutory", { code: "pay_proration", effective_from: first, parameters: { method: "calendar_days", base_components: ["x"] } })).status === 400);
  const ids: string[] = [];
  for (const [code, parameters] of [
    ["pay_proration", { method: "fixed_divisor", divisor_days: 30, base_components: [BASIC.code, ALLOW.code] }],
    ["eg_social_insurance", { employee_rate: 10, employer_rate: 20, min_insurable_wage: 1000, max_insurable_wage: 10000 }],
    ["eg_salary_income_tax", { taxable_base: "taxable_gross_minus_employee_insurance", period_method: "annualised_monthly", annual_exemption: 12000, brackets: [{ up_to: 60000, rate: 0 }, { up_to: null, rate: 10 }] }],
    ["eg_overtime", { day_multiplier: 1.5, night_multiplier: 2, rest_day_multiplier: 2, holiday_multiplier: 2, monthly_divisor_days: 30, hours_per_day: 8, base_components: [BASIC.code], minimum_minutes_per_day: 0 }],
  ] as const) {
    r = await rule(code, parameters);
    ids.push(r.body.ruleSet?.id);
  }
  check("finance enters four draft rule sets", ids.every(Boolean) && r.status === 201);
  check("the author cannot verify them (403)", (await call("karim", "POST", `/api/hr/statutory/${ids[0]}/verify`, {})).status === 403);
  for (const id of ids) r = await call("admin", "POST", `/api/hr/statutory/${id}/verify`, {});
  check("a second person verifies them", r.status === 200 && (await s.statutoryRuleSet.count({ where: { id: { in: ids }, status: "verified" } })) === 4);
  check("a verified rule set cannot be edited (409)", (await call("karim", "PATCH", `/api/hr/statutory/${ids[1]}`, { code: "eg_social_insurance", effective_from: first, effective_to: last, parameters: { employee_rate: 1, employer_rate: 1, min_insurable_wage: 0, max_insurable_wage: 1 }, source_reference: "x" })).status === 409);
  check("DB: a verified rule set's values cannot change", await rejects(() => s.statutoryRuleSet.update({ where: { id: ids[1] }, data: { parameters: { employee_rate: 1 } } })));
  const dupe = (await rule("eg_social_insurance", { employee_rate: 1, employer_rate: 1, min_insurable_wage: 0, max_insurable_wage: 1 })).body.ruleSet;
  check("a second verified set over the same month is refused (409)", (await call("admin", "POST", `/api/hr/statutory/${dupe.id}/verify`, {})).status === 409);
  await call("karim", "POST", `/api/hr/statutory/${dupe.id}/retire`, { reason: "مكرر" });

  section("6. THE FIGURES FOLLOW THE ENTERED RULES EXACTLY");
  await call("karim", "PATCH", `/api/hr/payroll/runs/${run.id}/employees/${e3.id}`, { inclusion: "on_hold", hold_reason: "مرتبه لسه متقرّش" });
  const adj = (await call("karim", "POST", "/api/hr/payroll/adjustments", { employee_id: e2.id, target_period: P, pay_component_id: BONUS.id, amount: 200, reason: "مكافأة اختبار" })).body.adjustment;
  check("a one-off bonus for e2 (PAD-)", /^PAD-/.test(adj?.number ?? ""), adj);
  r = await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/calculate`, {});
  detail = (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}`)).body;
  const slip = (id: string) => detail.employees.find((x: any) => x.employeeId === id);
  const line = (sl: any, code: string) => sl.lines.find((l: any) => l.code === code);
  const s1 = slip(e1.id);
  check("no blocking issue is left", !(detail.exceptions ?? []).some((e: any) => e.severity === "error"), detail.exceptions);
  check("e1 fixed pay, whole month: 6000 + 1000", money(line(s1, BASIC.code)?.amount) === "6000.00" && money(line(s1, ALLOW.code)?.amount) === "1000.00", s1.lines);
  check("e1 overtime: 2 h × (6000 ÷ 30 ÷ 8 = 25) × 1.5 = 75.00", money(s1.lines.find((l: any) => l.sourceType === "attendance" && l.kind === "earning")?.amount) === "75.00", s1.lines);
  check("e1 unpaid day: 7000 ÷ 30 = 233.33", money(s1.lines.find((l: any) => l.sourceType === "attendance" && l.kind === "deduction")?.amount) === "233.33", s1.lines);
  check("e1 insurance on 6000: 10% employee = 600, 20% employer = 1200", s1.lines.some((l: any) => l.kind === "deduction" && money(l.amount) === "600.00" && l.ruleSetVersion) && s1.lines.some((l: any) => l.kind === "employer_contribution" && money(l.amount) === "1200.00"), s1.lines);
  check("e1 tax: ((7075 − 233.33 − 600) × 12 − 12000 − 60000) × 10% ÷ 12 = 24.17", s1.lines.some((l: any) => l.kind === "deduction" && l.sourceType === "statutory" && money(l.amount) === "24.17"), s1.lines);
  check("e1 totals: gross 7075, deductions 857.50, net 6217.50", money(s1.gross) === "7075.00" && money(s1.employeeDeductions) === "857.50" && money(s1.netEntitlement) === "6217.50", s1);
  check("e1 on-account 500 is recovered in full: net payable 5717.50", money(s1.advanceRecovery) === "500.00" && money(s1.netPayable) === "5717.50", s1);
  const s2 = slip(e2.id);
  const e2days = monthDays - 15;
  check(`e2 joined on the 16th: 3000 ÷ 30 × ${e2days} = ${money(Math.min(3000, 100 * e2days))}`, money(line(s2, BASIC.code)?.amount) === money(Math.min(3000, 100 * e2days)), s2.lines);
  check("e2 bonus appears as its own line; insurance on a full month with a warning", money(line(s2, BONUS.code)?.amount) === "200.00" && s2.exceptions.some((e: any) => e.code === "insurance_partial_month"), s2);
  check("the bonus is reserved on e2's payslip", (await s.payrollAdjustment.findUnique({ where: { id: adj.id } }))?.status === "reserved");
  check("run totals are the sum of the included payslips", money(detail.netPayable) === money(Number(s1.netPayable) + Number(s2.netPayable)) && detail.headcount === 2, detail);
  r = await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/calculate`, {});
  const again = (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}`)).body;
  check("recalculating unchanged inputs gives the same hash; every calculation is kept", again.calculationHash === detail.calculationHash && again.snapshots.length >= 3, again.snapshots?.length);

  section("7. SUBMIT — figures and attendance freeze");
  check("the supervisor cannot submit (403)", (await call("sara", "POST", `/api/hr/payroll/runs/${run.id}/submit`, {})).status === 403);
  r = await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/submit`, {});
  check("finance submits", r.status === 200 && r.body.run.status === "pending_approval", r.body);
  check("…e1's days of the month are locked to the run", (await s.attendanceDay.count({ where: { employeeId: e1.id, date: { gte: first, lte: last }, state: "locked", lockedRunId: run.id } })) === 2);
  check("recalculating a submitted run -> 409", (await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/calculate`, {})).status === 409);
  check("holding a payslip of a submitted run -> 409", (await call("karim", "PATCH", `/api/hr/payroll/runs/${run.id}/employees/${e2.id}`, { inclusion: "on_hold", hold_reason: "x" })).status === 409);
  check("a new adjustment for a submitted month -> 409", (await call("karim", "POST", "/api/hr/payroll/adjustments", { employee_id: e2.id, target_period: P, pay_component_id: BONUS.id, amount: 1, reason: "x" })).status === 409);
  const anyLine = await s.payrollRunLine.findFirstOrThrow({ where: { runEmployee: { runId: run.id } } });
  check("DB: lines of a submitted run cannot change", await rejects(() => s.payrollRunLine.update({ where: { id: anyLine.id }, data: { amount: 1 } })));
  check("DB: a submitted run's figures cannot change", await rejects(() => s.payrollRun.update({ where: { id: run.id }, data: { netPayable: 1, gross: 1 } })));
  check("DB: a payslip's net must equal entitlement − recovery", await rejects(() => strictTx((tx) => tx.payrollRunEmployee.updateMany({ where: { runId: run.id, employeeId: e1.id }, data: { netPayable: 1 } }))));

  section("8. APPROVAL — never by the preparer or submitter, never on stale figures");
  const req1 = (await s.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).approvalRequestId!;
  r = await call("admin", "POST", `/api/approvals/${req1}/decide`, { decision: "reject", comment: "راجع المكافأة" });
  check("an approver returns it to the preparer; attendance unlocks", r.status === 200 && (await s.payrollRun.findUnique({ where: { id: run.id } }))?.status === "calculated" && (await s.attendanceDay.count({ where: { lockedRunId: run.id } })) === 0, r.body);
  await call("admin", "POST", `/api/hr/payroll/runs/${run.id}/calculate`, {});
  await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/submit`, {});
  const req2 = (await s.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).approvalRequestId!;
  check("whoever calculated a run cannot approve it (403)", (await call("admin", "POST", `/api/approvals/${req2}/decide`, { decision: "approve" })).status === 403);
  check("the preparer cannot approve (no permission, 403)", (await call("karim", "POST", `/api/approvals/${req2}/decide`, { decision: "approve" })).status === 403);
  check("withdrawing needs a reason (400)", (await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/withdraw`, {})).status === 400);
  check("finance withdraws the submission", (await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/withdraw`, { reason: "حسبه المعتمد" })).status === 200);
  await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/calculate`, {});
  await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/submit`, {});
  const req3 = (await s.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).approvalRequestId!;
  r = await call("sara", "POST", "/api/hr/attendance/corrections", { employee_id: e1.id, date: D1, status: "present", first_in: "09:00", last_out: "17:00", reason: "مكانش في إضافي" });
  check("a correction to a locked day can be requested", r.status === 201, r.body);
  await call("admin", "POST", `/api/approvals/${r.body.correction.approvalRequestId}/decide`, { decision: "approve" });
  check("…and approved (the day changes, still locked)", (await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: D1 } } }))?.overtimeDayMinutes === 0);
  r = await call("admin", "POST", `/api/approvals/${req3}/decide`, { decision: "approve" });
  check("approving a run whose inputs changed after submission is refused (409)", r.status === 409, r.body);
  await call("admin", "POST", `/api/approvals/${req3}/decide`, { decision: "reject", comment: "الحضور اتصحح" });
  check("returning the run absorbs the correction (no retro needed for an unposted run)", (await s.attendanceCorrection.findFirst({ where: { employeeId: e1.id, date: D1, status: "approved" } }))?.retroStatus === "none");
  await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/calculate`, {});
  detail = (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}`)).body;
  check("the recalculation drops the overtime line", !slip(e1.id).lines.some((l: any) => l.sourceType === "attendance" && l.kind === "earning"));
  await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/submit`, {});
  const req4 = (await s.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).approvalRequestId!;
  r = await call("admin", "POST", `/api/approvals/${req4}/decide`, { decision: "approve", comment: "تمام" });
  const approved = await s.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
  check("an approver who neither prepared nor submitted approves it", r.status === 200 && approved.status === "approved" && !!approved.approvedBy && approved.preparedBy !== approved.approvedBy, approved);
  check("DB: an approver equal to the preparer is refused", await rejects(() => s.payrollRun.update({ where: { id: run.id }, data: { approvedById: approved.preparedById } })));
  check("an approved run cannot be recalculated (409)", (await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/calculate`, {})).status === 409);
  check("an on-account payment for an approved month -> 409", (await call("karim", "POST", "/api/hr/transactions", { employee_id: e1.id, type: "salary_on_account", amount: "1", cash_account_id: "cash_main", payroll_period: P })).status === 409);
  check("the finance role cannot withdraw an approval (403)", (await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/reopen`, { reason: "x" })).status === 403);
  check("DB: two live regular runs for one month are refused", await rejects(() => s.payrollRun.create({ data: { number: `${TAG}-dup`, period: P, attendanceFrom: first, attendanceTo: last, preparedBy: "t" } })));
  const snap = await s.payrollCalculationSnapshot.findFirstOrThrow({ where: { runId: run.id } });
  check("DB: calculation snapshots are append-only", await rejects(() => s.payrollCalculationSnapshot.update({ where: { id: snap.id }, data: { calculatedBy: "x" } })));
  check("DB: runs are never deleted", await rejects(() => s.payrollRun.delete({ where: { id: run.id } })));

  section("9. WHO SEES PAYROLL");
  check("the supervisor cannot read runs (403)", (await call("sara", "GET", `/api/hr/payroll/runs/${run.id}`)).status === 403);
  check("the preparer role cannot read statutory rules (403)", (await call("ahmed", "GET", "/api/hr/statutory")).status === 403);
  const saraAudit = (await call("sara", "GET", `/api/audit?limit=200&q=${TAG}`)).body.logs ?? [];
  check("payroll and salary audit rows are hidden from the supervisor", saraAudit.every((l: any) => !["payroll_run", "payroll_adjustment", "employee_compensation", "pay_component", "statutory_rule_set"].includes(l.entityType)));
  const audited = new Set((await s.auditLog.findMany({ where: { OR: [{ entityType: "payroll_run", entityId: run.id }, { action: { in: ["compensation_proposed", "compensation_approved", "rule_set_verified", "payroll_adjustment_created"] } }], timestamp: { gte: new Date(Date.now() - 3600_000) } }, select: { action: true } })).map((a) => a.action));
  check("every step is audited", ["payroll_run_created", "payroll_run_calculated", "payroll_run_submitted", "payroll_run_returned", "payroll_run_withdrawn", "payroll_run_approved", "compensation_proposed", "compensation_approved", "rule_set_verified", "payroll_adjustment_created"].every((a) => audited.has(a)), [...audited]);

  await db?.$disconnect();
  finish("HR PAYROLL");
}

main().catch(async (e) => { console.error(e); await db?.$disconnect(); process.exit(1); });
