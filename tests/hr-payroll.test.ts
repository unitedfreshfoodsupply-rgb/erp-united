/* HR phases 4–5 and Phase D — compensation, statutory rule sets, payroll runs up to approval,
   then posting, payments, exports and reversal
   (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.6–3.10, §4.1–4.5).
   Every rate, limit and bracket below is a TEST VALUE chosen to make the arithmetic checkable by
   hand — none is a statutory figure. The suite checks that payroll refuses to calculate without
   verified rules, that the figures follow the entered rules exactly, that nobody approves their
   own package / rule / run, that submission freezes the figures and the attendance, and that an
   approval is refused when anything changed after submission.
   WS5 (November 2026, docs/erp/REMEDIATION_PLAN_2026-11.md): a statutory levy rule is now
   required like insurance and tax (HR-03), whoever prepares a run neither posts nor pays it
   (HR-22), and salary cost is split across departments by days (HR-14) — the sections below
   assert those rules; sections 13+ cover settlements, corrections, plans and the rest. */
import { call, login, makeChecker, page } from "./_harness";
import { Prisma, PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./_guard";
import { verifiedRuleFor } from "../lib/hr/statutory";
import { fundCash } from "./_stock";

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
  // L2: cash and bank never go negative. The on-account payment (cash) and the salary
  // payments (bank) of month P are funded by the owner on its first day.
  await fundCash("cash_main", 1000, { date: first });
  await fundCash("bank_main", 50000, { date: first });

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
    ["other_levy_employee", "deduction", false], ["other_levy_employer", "employer_contribution", false], ["leave_encashment", "earning", true],
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
  // CTL-01 (replaces "cannot approve it (403)"): the SUPER_ADMIN is the only holder of the
  // approving permission, so self-approval is the audited emergency path — refused
  // without a written reason of at least 10 characters.
  const selfPkg = await call("admin", "POST", `/api/approvals/${r.body.package.approvalRequestId}/decide`, { decision: "approve" });
  check("whoever proposed a package cannot approve it without an emergency reason (400: sole approver, reason ≥10 chars required)", selfPkg.status === 400 && /10/.test(selfPkg.body?.error ?? ""), selfPkg.body);
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
  check("…and no verified levy rule (Martyrs' Fund) is blocking too — never silently left out (HR-03)", (detail.exceptions ?? []).some((e: any) => e.code === "rule_missing" && e.params?.rule === "eg_other_levies" && e.severity === "error"), detail.exceptions);
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
    ["eg_other_levies", { levies: [{ code: "test_levy", name_ar: "رسم اختبار", base: "gross", rate: 1, payer: "employee" }] }],
  ] as const) {
    r = await rule(code, parameters);
    ids.push(r.body.ruleSet?.id);
  }
  check("finance enters five draft rule sets (the levy among them)", ids.every(Boolean) && ids.length === 5 && r.status === 201);
  check("the author cannot verify them (403)", (await call("karim", "POST", `/api/hr/statutory/${ids[0]}/verify`, {})).status === 403);
  for (const id of ids) r = await call("admin", "POST", `/api/hr/statutory/${id}/verify`, {});
  check("a second person verifies them", r.status === 200 && (await s.statutoryRuleSet.count({ where: { id: { in: ids }, status: "verified" } })) === 5);
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
  check("e1 levy: 1% (test rate) of gross 7075 = 70.75", s1.lines.some((l: any) => l.kind === "deduction" && l.sourceType === "statutory" && l.sourceId === "test_levy" && money(l.amount) === "70.75"), s1.lines);
  check("e1 totals: gross 7075, deductions 857.50 + levy 70.75 = 928.25, net 6146.75", money(s1.gross) === "7075.00" && money(s1.employeeDeductions) === "928.25" && money(s1.netEntitlement) === "6146.75", s1);
  check("e1 on-account 500 is recovered in full: net payable 5646.75", money(s1.advanceRecovery) === "500.00" && money(s1.netPayable) === "5646.75", s1);
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

  // =========================================================================
  section("10. POSTING — only with the accounts the accountant chose");
  async function setting(key: string, value: unknown) {
    const cur = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((x: any) => x.key === key);
    const res = await call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason: TAG, expected_version: cur.version });
    if (res.status !== 200) throw new Error(`setting ${key}: ${JSON.stringify(res.body)}`);
  }
  await setting("hr.payroll_net_pay_account", null);
  let preview = (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}/journal`)).body;
  const problemCodes = (preview.problems ?? []).map((p: any) => `${p.code}:${p.params?.component ?? ""}`);
  check("the preview lists every missing account (net salaries, component expense)", problemCodes.includes("net_pay_account_missing:") && problemCodes.includes(`expense_account_missing:${BASIC.code}`), problemCodes);
  r = await call("admin", "POST", `/api/hr/payroll/runs/${run.id}/post`, {});
  check("posting is refused while accounts are missing (409), nothing posted", r.status === 409 && (await s.journalEntry.count({ where: { sourceType: "payroll_run", sourceId: run.id } })) === 0, r.body);
  check("the supervisor cannot post (403)", (await call("sara", "POST", `/api/hr/payroll/runs/${run.id}/post`, {})).status === 403);
  check("the supervisor cannot read the preview (403)", (await call("sara", "GET", `/api/hr/payroll/runs/${run.id}/journal`)).status === 403);

  const code = () => `9${String(Date.now() + Math.floor(Math.random() * 1000)).slice(-6)}`;
  const account = async (parent_id: string, name: string) => (await call("karim", "POST", "/api/accounting/accounts", { code: code(), name: `${TAG} ${name}`, name_ar: `${TAG} ${name}`, parent_id })).body.account;
  const EXP = await account("acc_6000", "salaries test");
  const LIAB = await account("acc_2000", "withholdings test");
  const NET = await account("acc_2000", "net salaries test");
  check("finance opens test accounts (expense, liability, net salaries)", !!EXP?.id && !!LIAB?.id && !!NET?.id, [EXP, LIAB, NET]);
  r = await call("karim", "PATCH", `/api/hr/payroll/components/${BASIC.id}`, { code: BASIC.code, name_ar: BASIC.nameAr, kind: "earning", method: "fixed", taxable: true, insurable: true, active: true, expense_account_id: EXP.id, expected_version: (await s.payComponent.findUniqueOrThrow({ where: { id: BASIC.id } })).version });
  check("finance maps a component to its expense account", r.status === 200, r.body);
  await s.payComponent.updateMany({ where: { id: { in: [ALLOW.id, BONUS.id] } }, data: { expenseAccountId: EXP.id } });
  for (const role of ["overtime_day", "overtime_night", "overtime_rest_day", "overtime_holiday", "unpaid_absence", "partial_leave"]) await s.payComponent.updateMany({ where: { systemRole: role }, data: { expenseAccountId: EXP.id, liabilityAccountId: null } });
  for (const role of ["social_insurance_employee", "income_tax", "other_levy_employee"]) await s.payComponent.updateMany({ where: { systemRole: role }, data: { liabilityAccountId: LIAB.id, expenseAccountId: null } });
  await s.payComponent.updateMany({ where: { systemRole: "leave_encashment" }, data: { expenseAccountId: EXP.id, liabilityAccountId: null } });
  await s.payComponent.updateMany({ where: { systemRole: "social_insurance_employer" }, data: { expenseAccountId: EXP.id, liabilityAccountId: LIAB.id } });
  await setting("hr.payroll_net_pay_account", EXP.code);
  preview = (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}/journal`)).body;
  check("an expense account as net salaries is refused (must be a liability)", (preview.problems ?? []).some((p: any) => p.code === "net_pay_account_invalid"), preview.problems);
  await setting("hr.payroll_net_pay_account", NET.code);
  preview = (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}/journal`)).body;
  const runNow = await s.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
  const slipLines = await s.payrollRunLine.findMany({ where: { runEmployee: { runId: run.id, inclusion: "included" } } });
  const sumKind = (k: string) => slipLines.filter((l) => l.kind === k).reduce((a, l) => a + Number(l.amount), 0);
  const expectedDebit = money(sumKind("earning") + sumKind("employer_contribution"));
  check("with every account set: no problem, balanced", (preview.problems ?? []).length === 0 && preview.balanced === true, preview.problems);
  check(`the entry debits earnings + employer contributions (${expectedDebit})`, money(preview.totals?.debit) === expectedDebit && money(preview.totals?.credit) === expectedDebit, preview.totals);
  check("net salaries credited in one line equal to the run's net", preview.lines.filter((l: any) => l.role === "net").length === 1 && money(preview.lines.find((l: any) => l.role === "net").amount) === money(runNow.netPayable), preview.lines);
  check("the preview is dated the month's last day", preview.date === last, preview.date);

  // Cost centers: e1's department is linked to a cost center, so e1's salary cost carries it;
  // everyone else's carries none (nothing is allocated without that explicit link).
  const ccDep = (await call("karim", "POST", "/api/hr/departments", { code: `${TAG}CC`.slice(-12), name: `${TAG} قسم بمركز` })).body.department;
  const ccOfDep = (await call("karim", "POST", "/api/accounting/cost-centers", { code: `PCC${Date.now() % 1_000_000}`, name: `${TAG} payroll cc`, name_ar: `${TAG} مركز الرواتب`, kind: "department", department_id: ccDep.id })).body.costCenter;
  // HR-14: e1 is transferred on the 16th; the month's cost follows the days in each department
  // (days 1–15 in a department with no center, the rest in the linked one).
  const mv = await call("karim", "POST", `/api/hr/employees/${e1.id}/employment`, { event: "transfer", effective_from: mid, department_id: ccDep.id, reason: "نقل لقسم بمركز تكلفة" });
  check("e1 transferred on the 16th to a department linked to a cost center", mv.status === 201 && !!ccOfDep?.id, [mv.status, mv.body, ccOfDep]);
  const e1Slip = await s.payrollRunEmployee.findFirstOrThrow({ where: { runId: run.id, employeeId: e1.id } });
  // Each line: the first 15 days' share rounded, the later department takes the remainder.
  const e1Cost = money(slipLines.filter((l) => l.runEmployeeId === e1Slip.id && (l.kind === "earning" || l.kind === "employer_contribution"))
    .reduce((a, l) => a.plus(l.amount.minus(l.amount.mul(15).div(monthDays).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP))), new Prisma.Decimal(0)));

  check("whoever prepared the run cannot post it (403, HR-22)", (await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/post`, {})).status === 403);
  check("…and the run screen does not offer it to them", (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}`)).body.can?.post === false);
  // Two posts at the same time: one entry, the other refused.
  const both = await Promise.all([1, 2].map(() => call("admin", "POST", `/api/hr/payroll/runs/${run.id}/post`, {})));
  check("two parallel posts: exactly one succeeds, one journal entry", both.filter((x) => x.status === 200).length === 1 && both.filter((x) => x.status === 409).length === 1 && (await s.journalEntry.count({ where: { sourceType: "payroll_run", sourceId: run.id } })) === 1, both.map((x) => x.status));
  r = both.find((x) => x.status === 200)!;
  const posted = await s.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
  const je = await s.journalEntry.findFirst({ where: { sourceType: "payroll_run", sourceId: run.id }, include: { lines: { include: { account: true } } } });
  check("finance posts the approved run: one entry, status posted", r.status === 200 && posted.status === "posted" && posted.journalEntryId === je?.id && je?.date === last, r.body);
  check("the entry total = earnings + employer contributions", money(je?.total) === expectedDebit, je?.total);
  const ccLines = je!.lines.filter((l) => l.costCenterId === ccOfDep.id);
  check(`e1's salary cost from the 16th (${e1Cost}) carries the department's cost center; no other line does`, money(ccLines.reduce((a, l) => a + Number(l.debit), 0)) === e1Cost && ccLines.every((l) => l.account.type === "expense") && je!.lines.filter((l) => l.costCenterId && l.costCenterId !== ccOfDep.id).length === 0, [e1Cost, ccLines.map((l) => [l.account.code, l.debit])]);
  const advLine = je?.lines.find((l) => l.account.systemKey === "employee_advances");
  check("e1's on-account 500 credits employee advances against e1", money(advLine?.credit) === "500.00" && advLine?.partyType === "employee" && advLine?.partyId === e1.id, advLine);
  check("no journal line carries an individual net salary (net line has no party)", je!.lines.filter((l) => l.accountId === NET.id).every((l) => !l.partyId) && je!.lines.filter((l) => l.accountId === NET.id).length === 1);
  check("posting twice -> 409", (await call("admin", "POST", `/api/hr/payroll/runs/${run.id}/post`, {})).status === 409);
  check("a posted run cannot be reopened (409)", (await call("admin", "POST", `/api/hr/payroll/runs/${run.id}/reopen`, { reason: "x" })).status === 409);
  check("the bonus adjustment is applied", (await s.payrollAdjustment.findUnique({ where: { id: adj.id } }))?.status === "applied");
  check("a new adjustment for a posted month -> 409", (await call("karim", "POST", "/api/hr/payroll/adjustments", { employee_id: e2.id, target_period: P, pay_component_id: BONUS.id, amount: 1, reason: "x" })).status === 409);
  check("DB: a posted run's figures cannot change", await rejects(() => s.payrollRun.update({ where: { id: run.id }, data: { gross: 1, netPayable: 1 } })));
  check("DB: a posted run cannot go back to approved", await rejects(() => s.payrollRun.update({ where: { id: run.id }, data: { status: "approved" } })));
  let health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  const payCheck = () => health.checks.find((c: any) => c.key === "payroll");
  const owedAfterPost = Number(payCheck()?.subledger);
  check("Accounts Health: payroll owed = net salaries account, books balanced", payCheck()?.ok === true && health.checks.find((c: any) => c.key === "trial_balance")?.ok === true && health.checks.find((c: any) => c.key === "traceable")?.ok === true, health.checks);

  // =========================================================================
  section("11. PAYMENTS — partial, capped at each payslip's net, reversible");
  const slipOf = async (emp: string) => s.payrollRunEmployee.findFirstOrThrow({ where: { runId: run.id, employeeId: emp } });
  const net1 = Number((await slipOf(e1.id)).netPayable);
  const net2 = Number((await slipOf(e2.id)).netPayable);
  const payBody = (extra: Record<string, unknown>) => ({ date: last, cash_account_id: "bank_main", method: "bank_transfer", ...extra });
  check("the supervisor cannot pay (403)", (await call("sara", "POST", `/api/hr/payroll/runs/${run.id}/payments`, payBody({ all_remaining: true }))).status === 403);
  check("whoever prepared the run cannot pay it (403, HR-22)", (await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/payments`, payBody({ all_remaining: true }))).status === 403);
  check("more than e1's net -> 400", (await call("admin", "POST", `/api/hr/payroll/runs/${run.id}/payments`, payBody({ lines: [{ employee_id: e1.id, amount: (net1 + 1).toFixed(2) }] }))).status === 400);
  check("an employee on hold cannot be paid (400)", (await call("admin", "POST", `/api/hr/payroll/runs/${run.id}/payments`, payBody({ lines: [{ employee_id: e3.id, amount: "1" }] }))).status === 400);
  const key1 = `${TAG}-pay-1`;
  r = await call("admin", "POST", `/api/hr/payroll/runs/${run.id}/payments`, payBody({ lines: [{ employee_id: e1.id, amount: "1000" }], reference: "TRX-1", idempotency_key: key1 }));
  const pay1 = r.body.payment;
  const pay1je = !pay1 ? null : (await s.journalEntry.findFirst({ where: { sourceType: "payroll_payment", sourceId: pay1.id }, include: { lines: true } }));
  check("someone who did not prepare the run pays e1 1000 (PPY-, its own entry: Dr net salaries, Cr bank)", r.status === 201 && /^PPY-/.test(pay1?.number ?? "") && money(pay1je?.total) === "1000.00" && pay1je!.lines.some((l) => l.accountId === NET.id && money(l.debit) === "1000.00"), r.body);
  check("the same key replays the same payment", (await call("admin", "POST", `/api/hr/payroll/runs/${run.id}/payments`, payBody({ lines: [{ employee_id: e1.id, amount: "1000" }], reference: "TRX-1", idempotency_key: key1 }))).body.payment?.id === pay1?.id);
  check("the same key with another amount -> 409", (await call("admin", "POST", `/api/hr/payroll/runs/${run.id}/payments`, payBody({ lines: [{ employee_id: e1.id, amount: "999" }], reference: "TRX-1", idempotency_key: key1 }))).status === 409);
  let pays = (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}/payments`)).body;
  const remain = (emp: string) => pays.slips.find((x: any) => x.employeeId === emp);
  check("e1 shows 1000 paid and the rest unpaid", money(remain(e1.id)?.paid) === "1000.00" && money(remain(e1.id)?.remaining) === money(net1 - 1000), remain(e1.id));
  const slip2 = await slipOf(e2.id);
  check("DB: a payment line above a payslip's net is refused", await rejects(() => strictTx(async (tx) => { await tx.payrollPaymentLine.create({ data: { paymentId: pay1.id, runEmployeeId: slip2.id, amount: net2 + 1 } }); })));
  const pay1line = await s.payrollPaymentLine.findFirstOrThrow({ where: { paymentId: pay1.id } });
  check("DB: payment lines are append-only", await rejects(() => s.payrollPaymentLine.update({ where: { id: pay1line.id }, data: { amount: 1 } })));
  check("DB: a payment's amount cannot change", await rejects(() => s.payrollPayment.update({ where: { id: pay1.id }, data: { amount: 1 } })));
  check("reversing a run with a live payment -> 409", (await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/reverse`, { reason: "غلط" })).status === 409);
  check("…and the run screen does not offer reversal while a payment is live", (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}`)).body.can?.reverse === false);

  r = await call("karim", "GET", `/api/hr/payroll/runs/${run.id}/register`);
  check("payroll register CSV: a row per included payslip with net and paid", r.status === 200 && typeof r.body === "string" && r.body.includes(e1.code) && r.body.includes(e2.code) && !r.body.includes(e3.code) && r.body.includes("Net"), typeof r.body === "string" ? r.body.slice(0, 300) : r.body);
  check("the supervisor cannot export the register (403)", (await call("sara", "GET", `/api/hr/payroll/runs/${run.id}/register`)).status === 403);
  check("bank file needs private-data access: finance without it -> 403", (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}/bank-file`)).status === 403);
  r = await call("admin", "GET", `/api/hr/payroll/runs/${run.id}/bank-file`);
  const bankRow = typeof r.body === "string" ? r.body.split("\r\n").find((l: string) => l.startsWith(e1.code)) : undefined;
  check("bank file: e1's unpaid remainder, flagged with no verified account (no number printed)", r.status === 200 && !!bankRow && bankRow.includes(money(net1 - 1000)) && bankRow.endsWith("no_account"), bankRow ?? r.body);
  const slipPage = await page("karim", `/hr/payroll/runs/${run.id}/payslips/${e1.id}/print`);
  check("payslip prints for a posted run in Arabic by default (RTL, no English title)", slipPage.status === 200 && /dir="rtl"/.test(slipPage.html) && slipPage.html.includes("قسيمة مرتب") && !slipPage.html.includes("Payslip") && slipPage.html.includes(e1.code), slipPage.status);
  const slipEn = await page("karim", `/hr/payroll/runs/${run.id}/payslips/${e1.id}/print?lang=en`);
  check("the same payslip in English (?lang=en): LTR, no Arabic title", slipEn.status === 200 && /dir="ltr"/.test(slipEn.html) && slipEn.html.includes("Payslip") && !slipEn.html.includes("قسيمة مرتب") && slipEn.html.includes(e1.code), slipEn.status);
  check("the supervisor cannot open a payslip", !(await page("sara", `/hr/payroll/runs/${run.id}/payslips/${e1.id}/print`)).html.includes("data-payslip"));

  check("reversing a payment needs a reason (400)", (await call("karim", "POST", `/api/hr/payroll/payments/${pay1.id}/reverse`, {})).status === 400);
  r = await call("karim", "POST", `/api/hr/payroll/payments/${pay1.id}/reverse`, { reason: "اتحول لحساب غلط" });
  const pay1rev = await s.payrollPayment.findUniqueOrThrow({ where: { id: pay1.id }, include: { reversalEntry: true } });
  check("finance reverses the payment: reversing entry, e1 unpaid again", r.status === 200 && !!pay1rev.reversedAt && pay1rev.reversalEntry?.reversalOfId === pay1je?.id, r.body);
  check("reversing it twice -> 409", (await call("karim", "POST", `/api/hr/payroll/payments/${pay1.id}/reverse`, { reason: "x" })).status === 409);
  const twin = await Promise.all([1, 2].map(() => call("admin", "POST", `/api/hr/payroll/runs/${run.id}/payments`, payBody({ lines: [{ employee_id: e2.id, amount: net2.toFixed(2) }] }))));
  check("two parallel full payments of e2: exactly one is recorded", twin.filter((x) => x.status === 201).length === 1 && twin.filter((x) => x.status === 400 || x.status === 409).length === 1, twin.map((x) => x.status));
  r = await call("admin", "POST", `/api/hr/payroll/runs/${run.id}/payments`, payBody({ all_remaining: true }));
  pays = (await call("karim", "GET", `/api/hr/payroll/runs/${run.id}/payments`)).body;
  check("pay all unpaid: the rest is paid, nothing left", r.status === 201 && money(r.body.payment?.amount) === money(net1) && money(pays.totals.remaining) === "0.00", [r.body, pays.totals]);
  check("nothing left to pay -> 409", (await call("admin", "POST", `/api/hr/payroll/runs/${run.id}/payments`, payBody({ all_remaining: true }))).status === 409);
  health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  // Other posted runs may share the database; this run's share of what is owed must be gone.
  check("Accounts Health after payments: this run owes nothing, ledger agrees", payCheck()?.ok === true && money(payCheck()?.subledger) === money(owedAfterPost - net1 - net2), [payCheck(), owedAfterPost]);

  // =========================================================================
  section("12. REVERSAL — only with nothing paid; the month opens again");
  for (const live of await s.payrollPayment.findMany({ where: { runId: run.id, reversedAt: null } })) await call("karim", "POST", `/api/hr/payroll/payments/${live.id}/reverse`, { reason: "عكس قبل عكس المسير" });
  check("the supervisor cannot reverse a run (403)", (await call("sara", "POST", `/api/hr/payroll/runs/${run.id}/reverse`, { reason: "x" })).status === 403);
  check("reversing needs a reason (400)", (await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/reverse`, {})).status === 400);
  r = await call("karim", "POST", `/api/hr/payroll/runs/${run.id}/reverse`, { reason: "مكافأة اتسجلت غلط" });
  const reversed = await s.payrollRun.findUniqueOrThrow({ where: { id: run.id }, include: { reversalEntry: true } });
  check("finance reverses the run: reversing entry of the posting, status reversed", r.status === 200 && reversed.status === "reversed" && reversed.reversalEntry?.reversalOfId === posted.journalEntryId, r.body);
  check("the bonus is open again for the next run", (await s.payrollAdjustment.findUnique({ where: { id: adj.id } }))?.status === "open");
  check("the month's attendance is unlocked", (await s.attendanceDay.count({ where: { lockedRunId: run.id } })) === 0);
  check("DB: a reversed run cannot change", await rejects(() => s.payrollRun.update({ where: { id: run.id }, data: { status: "posted" } })));
  health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("Accounts Health after reversal: all green", health.ok === true, health.checks.filter((c: any) => !c.ok));
  r = await call("karim", "POST", "/api/hr/payroll/runs", { period: P });
  check("the month accepts a new regular run", r.status === 201, r.body);
  if (r.body.run) await call("karim", "POST", `/api/hr/payroll/runs/${r.body.run.id}/cancel`, { reason: "اختبار — مش هيتحسب" });
  const pAudit = new Set((await s.auditLog.findMany({ where: { OR: [{ entityType: "payroll_run", entityId: run.id }, { entityType: "payroll_payment", fieldChanged: run.number }, { entityType: "payroll_payment", entityId: pay1.id }] }, select: { action: true } })).map((a) => a.action));
  check("posting, payments, exports and reversals are audited", ["payroll_run_posted", "payroll_payment_recorded", "payroll_payment_reversed", "payroll_register_exported", "payroll_bank_file_exported", "payroll_run_reversed"].every((a) => pAudit.has(a)), [...pAudit]);
  // Audit search (E-2): words match the action, the changed field, who did it, and ids.
  const byAction = (await call("admin", "GET", `/api/audit?entity=payroll_run&q=payroll_run_reversed&limit=50`)).body.logs ?? [];
  check("audit search finds an action by its name", byAction.some((l: any) => l.entityId === run.id && l.action === "payroll_run_reversed"), byAction.length);
  const byNumber = (await call("admin", "GET", `/api/audit?entity=payroll_payment&q=${encodeURIComponent(run.number)}&limit=50`)).body.logs ?? [];
  check("audit search finds payments by the run number they name", byNumber.length >= 3 && byNumber.every((l: any) => l.entityType === "payroll_payment"), byNumber.length);
  // The run is posted by someone who did not prepare it (HR-22): admin.
  const byUser = (await call("admin", "GET", `/api/audit?entity=payroll_run&q=${encodeURIComponent((await s.user.findUniqueOrThrow({ where: { username: "admin" } })).name)}%20payroll_run_posted&limit=50`)).body.logs ?? [];
  check("audit search combines who and what (every word must match)", byUser.some((l: any) => l.entityId === run.id) && byUser.every((l: any) => l.action === "payroll_run_posted"), byUser.length);
  const pg1 = (await call("admin", "GET", "/api/audit?limit=1&offset=0")).body, pg2 = (await call("admin", "GET", "/api/audit?limit=1&offset=1")).body;
  check("audit pages: a total and distinct rows per offset", pg1.total > 1 && pg1.logs?.[0]?.id !== pg2.logs?.[0]?.id, [pg1.total, pg1.logs?.[0]?.id, pg2.logs?.[0]?.id]);
  await ws5(s, { P, first, last, mid, monthDays, before, BASIC, ALLOW, BONUS, e1, e2, e3, ids, hire, pkg, setting, NET, EXP, LIAB, schedule });
  await setting("hr.payroll_net_pay_account", null);

  await db?.$disconnect();
  finish("HR PAYROLL");
}

// ===========================================================================
// WS5 HR & payroll remediation (docs/erp/REMEDIATION_PLAN_2026-11.md, audit HR-03..HR-22).
// Every rate below is still a TEST VALUE.
// ===========================================================================
type Ctx = {
  P: string; first: string; last: string; mid: string; monthDays: number; before: string; BASIC: any; ALLOW: any; BONUS: any; e1: any; e2: any; e3: any; ids: string[];
  hire: (name: string, on: string) => Promise<any>; pkg: (employee_id: string, effective_from: string, lines: [string, number][], insurable_wage: number | null) => Promise<any>;
  setting: (key: string, value: unknown) => Promise<void>; NET: any; EXP: any; LIAB: any; schedule: any;
};

async function ws5(s: PrismaClient, c: Ctx) {
  const { P, first, last, before, BASIC, BONUS, e1, e2, ids, hire, pkg } = c;
  const approve = (who: string, requestId: string) => call(who, "POST", `/api/approvals/${requestId}/decide`, { decision: "approve" });
  const runOf = async (id: string) => (await call("karim", "GET", `/api/hr/payroll/runs/${id}`)).body;
  const slipOf = (detail: any, empId: string) => detail.employees.find((x: any) => x.employeeId === empId);
  const has = (sl: any, code: string, severity?: string) => (sl?.exceptions ?? []).some((e: any) => e.code === code && (!severity || e.severity === severity));
  const calc = (id: string) => call("karim", "POST", `/api/hr/payroll/runs/${id}/calculate`, {});
  const hold = (runId: string, empId: string, reason = "خارج اختبار المرتبات") => call("karim", "PATCH", `/api/hr/payroll/runs/${runId}/employees/${empId}`, { inclusion: "on_hold", hold_reason: reason });
  const holdOthers = async (runId: string, keep: string[]) => { for (const x of await s.payrollRunEmployee.findMany({ where: { runId, employeeId: { notIn: keep } } })) await hold(runId, x.employeeId); };
  const submitAndApprove = async (runId: string) => {
    const sub = await call("karim", "POST", `/api/hr/payroll/runs/${runId}/submit`, {});
    const req = (await s.payrollRun.findUniqueOrThrow({ where: { id: runId } })).approvalRequestId;
    const ap = req ? await approve("admin", req) : null;
    return { sub, ap };
  };
  const advanceBalance = async (empId: string) => {
    const a = await s.journalLine.aggregate({ where: { partyType: "employee", partyId: empId, account: { systemKey: "employee_advances" } }, _sum: { debit: true, credit: true } });
    return new Prisma.Decimal(a._sum.debit ?? 0).minus(a._sum.credit ?? 0);
  };
  const shiftMonth = (p: string, n: number) => { const [y, m] = p.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
  const monthEnd = (p: string) => { const [y, m] = p.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

  // -------------------------------------------------------------------------
  section("13. HR-06 / HR-04 — a retired rule still covers its month; an insurable wage of 0 blocks");
  r = await call("karim", "POST", `/api/hr/statutory/${ids[1]}/retire`, { reason: "قيم السنة الجديدة (اختبار)" });
  check("the month's insurance rule set is retired (its end date kept)", r.status === 200 && (await s.statutoryRuleSet.findUnique({ where: { id: ids[1] } }))?.status === "retired", r.body);
  check("a retired set still governs the period it covered (HR-06)", (await verifiedRuleFor(s, "eg_social_insurance", first, last))?.id === ids[1]);
  check("…but never a period after its end", (await verifiedRuleFor(s, "eg_social_insurance", `${shiftMonth(P, 1)}-01`, monthEnd(shiftMonth(P, 1))))?.id !== ids[1]);
  const e4 = await hire("تأمين صفر", before);
  const e5 = await hire("غير مؤمن", before);
  const e7 = await hire("مستقيل", before);
  r = await pkg(e4.id, first, [[BASIC.id, 4000]], 0);
  await approve("admin", r.body.package.approvalRequestId);
  const exempt = (body: Record<string, unknown>) => call("karim", "POST", "/api/hr/compensation", { employee_id: e5.id, effective_from: first, reason: "تعيين", lines: [{ pay_component_id: BASIC.id, amount: 4000 }], ...body });
  check("an insurance exemption needs its reason (400)", (await exempt({ insurance_exempt: true, insurable_wage: 0 })).status === 400);
  check("an exempt package with an insurable wage -> 400", (await exempt({ insurance_exempt: true, insurance_exempt_reason: "x", insurable_wage: 4000 })).status === 400);
  r = await exempt({ insurance_exempt: true, insurance_exempt_reason: "صاحب معاش (اختبار)", insurable_wage: 0 });
  check("a package marked exempt from insurance, with its reason, goes to approval", r.status === 201 && r.body.package.insuranceExempt === true, r.body);
  await approve("admin", r.body.package.approvalRequestId);
  check("DB: an exemption without a reason is refused", await rejects(() => s.employeeCompensation.create({ data: { number: `${TAG}-ex`, employeeId: e5.id, effectiveFrom: "2001-01-01", reason: "x", insuranceExempt: true, createdBy: "t" } })));
  r = await pkg(e7.id, first, [[BASIC.id, 6000]], 6000);
  await approve("admin", r.body.package.approvalRequestId);

  r = await call("karim", "POST", "/api/hr/payroll/runs", { period: P });
  const run2 = r.body.run;
  check("a new regular run for the month after the reversal", r.status === 201, r.body);
  await holdOthers(run2.id, [e1.id, e2.id, e4.id, e5.id, e7.id]);
  await calc(run2.id);
  let d = await runOf(run2.id);
  check("recalculating the month after its insurance rule was retired: no rule is missing", !(d.exceptions ?? []).some((e: any) => e.code === "rule_missing"), d.exceptions);
  check("…e1's insurance lines still name the retired set", slipOf(d, e1.id).lines.filter((l: any) => l.ruleSetId === ids[1]).length === 2, slipOf(d, e1.id).lines);
  check("e4: insurable wage 0 and not exempt -> blocking (HR-04)", has(slipOf(d, e4.id), "insurable_wage_zero", "error"), slipOf(d, e4.id)?.exceptions);
  check("e5: exempt -> no insurance line, a warning with the reason", has(slipOf(d, e5.id), "insurance_exempt", "warning") && !slipOf(d, e5.id).lines.some((l: any) => l.ruleSetId === ids[1]), slipOf(d, e5.id));

  // -------------------------------------------------------------------------
  section("14. HR-12 / HR-11 / HR-20 — a leaver's final settlement");
  const lt = (await call("admin", "POST", "/api/hr/leave/types", { code: `${TAG}EN`, name_ar: `${TAG} اعتيادي`, pay_mode: "paid", counts_days: "calendar", encashable: true })).body.type;
  check("an encashable leave type (HR-11)", lt?.encashable === true, lt);
  r = await call("admin", "POST", "/api/hr/leave/adjustments", { employee_id: e7.id, leave_type_id: lt.id, days: 5, date: first, reason: "رصيد افتتاحي (اختبار)" });
  check("e7 has 5 days of it", r.status === 201, r.body);
  r = await call("karim", "POST", "/api/hr/transactions", { employee_id: e7.id, type: "advance", amount: 1000, cash_account_id: "cash_main" });
  check("e7 took an advance of 1000", r.status === 201, r.body);
  const lastDay = `${P}-10`;
  r = await call("karim", "POST", `/api/hr/employees/${e7.id}/employment`, { event: "termination", effective_from: lastDay, termination_reason: "استقالة", reason: "استقالة (اختبار)" });
  check("e7 resigns: the termination date is the last working day", r.status === 201, r.body);
  await calc(run2.id);
  d = await runOf(run2.id);
  check("the month's run is blocked for a leaver until the final settlement is posted (HR-12)", has(slipOf(d, e7.id), "terminated_in_period", "error"), slipOf(d, e7.id)?.exceptions);
  check("…and cannot be submitted (409)", (await call("karim", "POST", `/api/hr/payroll/runs/${run2.id}/submit`, {})).status === 409);
  check("a settlement for an employee still in service -> 409", (await call("karim", "POST", "/api/hr/payroll/settlements", { employee_id: e1.id, reason: "x" })).status === 409);
  check("the supervisor cannot prepare a settlement (403)", (await call("sara", "POST", "/api/hr/payroll/settlements", { employee_id: e7.id, reason: "x" })).status === 403);
  check("a settlement item must be a one-off component (400)", (await call("karim", "POST", "/api/hr/payroll/settlements", { employee_id: e7.id, reason: "x", items: [{ pay_component_id: BASIC.id, amount: 1, reason: "x" }] })).status === 400);
  check("a settlement item needs its reason (400)", (await call("karim", "POST", "/api/hr/payroll/settlements", { employee_id: e7.id, reason: "x", items: [{ pay_component_id: BONUS.id, amount: 1 }] })).status === 400);
  r = await call("karim", "POST", "/api/hr/payroll/settlements", { employee_id: e7.id, reason: "تسوية نهاية خدمة (اختبار)", items: [{ pay_component_id: BONUS.id, amount: 500, reason: "مقابل مهلة الإخطار (اختبار)" }] });
  const st = r.body.settlement;
  check("finance prepares the settlement: a final-settlement run, last day the 10th", r.status === 201 && st?.lastWorkingDay === lastDay && st?.run?.status === "draft", r.body);
  check("a second settlement for the same termination -> 409", (await call("karim", "POST", "/api/hr/payroll/settlements", { employee_id: e7.id, reason: "x" })).status === 409);
  check("…its recovery defaults to the open advance (1000)", money((await s.payrollRunEmployee.findFirstOrThrow({ where: { runId: st.runId } })).advanceRecoveryRequested) === "1000.00");
  await calc(run2.id);
  d = await runOf(run2.id);
  check("the month's run now waits for the settlement to be posted", has(slipOf(d, e7.id), "settlement_pending", "error"), slipOf(d, e7.id)?.exceptions);
  r = await calc(st.runId);
  const sd = await runOf(st.runId);
  const sl = slipOf(sd, e7.id);
  const ln = (code: string) => sl.lines.find((l: any) => l.code === code);
  check("the settlement run carries only the leaver", sd.runType === "final_settlement" && sd.employees.length === 1 && r.status === 200, [sd.runType, sd.employees?.length, r.body]);
  check("pay to the last working day, inclusive: 6000 ÷ 30 × 10 days = 2000 (HR-20)", Number(ln(BASIC.code)?.quantity) === 10 && money(ln(BASIC.code)?.amount) === "2000.00", sl.lines);
  const enc = sl.lines.find((l: any) => l.sourceType === "settlement" && String(l.sourceId).startsWith("leave:"));
  check("unused leave encashed: 5 days × (6000 ÷ 30) = 1000 (HR-11)", Number(enc?.quantity) === 5 && money(enc?.amount) === "1000.00", sl.lines);
  check("the manual item, with its reason: 500", sl.lines.some((l: any) => l.code === BONUS.code && l.sourceType === "settlement" && money(l.amount) === "500.00" && /مهلة/.test(l.explanation)), sl.lines);
  check("gross 3500; insurance 600 and levy 35 withheld: net 2865", money(sl.gross) === "3500.00" && money(sl.netEntitlement) === "2865.00", sl);
  check("the open advance is recovered (1000, net payable 1865), shown above the cap for the approver", money(sl.advanceRecovery) === "1000.00" && money(sl.netPayable) === "1865.00" && has(sl, "recovery_above_cap_settlement", "warning"), sl);
  check("no blocking issue on the settlement", !(sd.exceptions ?? []).some((e: any) => e.severity === "error"), sd.exceptions);
  const sa = await submitAndApprove(st.runId);
  check("submitted by finance, approved by someone else", sa.sub.status === 200 && sa.ap?.status === 200 && (await s.payrollRun.findUniqueOrThrow({ where: { id: st.runId } })).status === "approved", [sa.sub.body, sa.ap?.body]);
  check("its preparer cannot post it (403)", (await call("karim", "POST", `/api/hr/payroll/runs/${st.runId}/post`, {})).status === 403);
  r = await call("admin", "POST", `/api/hr/payroll/runs/${st.runId}/post`, {});
  check("posted through the payroll posting path (one journal entry)", r.status === 200 && (await s.journalEntry.count({ where: { sourceType: "payroll_run", sourceId: st.runId } })) === 1, r.body);
  const encEntry = await s.leaveLedgerEntry.findFirst({ where: { employeeId: e7.id, leaveTypeId: lt.id, kind: "encashment" } });
  const ltBalance = (await s.leaveLedgerEntry.aggregate({ where: { employeeId: e7.id, leaveTypeId: lt.id }, _sum: { days: true } }))._sum.days;
  check("the encashed days leave the balance (an encashment entry of −5; balance 0)", Number(encEntry?.days) === -5 && Number(ltBalance) === 0, [encEntry, ltBalance]);
  check("e7's advance is fully recovered in the ledger", (await advanceBalance(e7.id)).isZero());
  check("the settlement prints as a payslip", (await page("karim", `/hr/payroll/runs/${st.runId}/payslips/${e7.id}/print`)).html.includes(e7.code));
  r = await call("karim", "GET", `/api/hr/payroll/runs/${st.runId}/register`);
  check("…and exports as a payroll register", r.status === 200 && typeof r.body === "string" && r.body.includes(e7.code));
  const settlePay = { date: last, cash_account_id: "bank_main", method: "bank_transfer", all_remaining: true };
  check("its preparer cannot pay it (403)", (await call("karim", "POST", `/api/hr/payroll/runs/${st.runId}/payments`, settlePay)).status === 403);
  r = await call("admin", "POST", `/api/hr/payroll/runs/${st.runId}/payments`, settlePay);
  check("someone else pays it", r.status === 201 && money(r.body.payment?.amount) === "1865.00", r.body);
  check("DB: settlement items are frozen once the run left draft", await rejects(() => s.employeeFinalSettlementItem.updateMany({ where: { settlementId: st.id }, data: { amount: 1 } })));
  await calc(run2.id);
  d = await runOf(run2.id);
  check("the month's run: the leaver is 'paid by settlement' — an empty payslip, nothing blocking", has(slipOf(d, e7.id), "paid_by_settlement", "warning") && slipOf(d, e7.id).lines.length === 0 && !slipOf(d, e7.id).exceptions.some((e: any) => e.severity === "error"), slipOf(d, e7.id));

  // -------------------------------------------------------------------------
  section("15. HR-07 — correction runs post only the differences");
  await hold(run2.id, e4.id, "أجر التأمين لسه متحددش");
  await calc(run2.id);
  const ra = await submitAndApprove(run2.id);
  r = await call("admin", "POST", `/api/hr/payroll/runs/${run2.id}/post`, {});
  check("the month's run is submitted, approved and posted", ra.sub.status === 200 && ra.ap?.status === 200 && r.status === 200, [ra.sub.body, ra.ap?.body, r.body]);
  check("a correction of a settlement run is refused (409)", (await call("karim", "POST", `/api/hr/payroll/runs/${st.runId}/corrections`, { reason: "x" })).status === 409);
  r = await call("sara", "POST", "/api/hr/attendance/corrections", { employee_id: e1.id, date: `${P}-06`, status: "present", first_in: "09:00", last_out: "17:00", reason: "كان حاضر (اختبار)" });
  await approve("admin", r.body.correction.approvalRequestId);
  const corr1 = await s.attendanceCorrection.findFirst({ where: { employeeId: e1.id, date: `${P}-06`, status: "approved" }, orderBy: { createdAt: "desc" } });
  check("a correction to a day of the posted month waits as a retro item", corr1?.retroStatus === "pending", corr1);
  check("the supervisor cannot open a correction run (403)", (await call("sara", "POST", `/api/hr/payroll/runs/${run2.id}/corrections`, { reason: "x" })).status === 403);
  const cKey = `${TAG}-corr-1`;
  const cBody = { reason: "يوم اتصحح بعد الترحيل (اختبار)", employee_ids: [e1.id], idempotency_key: cKey };
  r = await call("karim", "POST", `/api/hr/payroll/runs/${run2.id}/corrections`, cBody);
  const c1 = r.body.run;
  check("finance opens a correction run linked to the posted run", r.status === 201 && c1?.runType === "correction" && c1?.correctionOfRunId === run2.id && c1?.period === P, r.body);
  check("the same key replays it (idempotent)", (await call("karim", "POST", `/api/hr/payroll/runs/${run2.id}/corrections`, cBody)).body.run?.id === c1.id);
  check("a second open correction of the same run -> 409", (await call("karim", "POST", `/api/hr/payroll/runs/${run2.id}/corrections`, { reason: "x" })).status === 409);
  await calc(c1.id);
  let cd = await runOf(c1.id);
  let cs = slipOf(cd, e1.id);
  check("only the differences: the unpaid day comes back (−233.33) and tax follows (+23.33)", cs.lines.length === 2 && cs.lines.some((l: any) => l.sourceType === "correction" && l.kind === "deduction" && money(l.amount) === "-233.33") && cs.lines.some((l: any) => l.sourceType === "correction" && l.kind === "deduction" && money(l.amount) === "23.33"), cs.lines);
  check("…210.00 more to pay; insurance, fixed pay and the on-account recovery are not repeated", money(cs.netPayable) === "210.00" && money(cs.advanceRecovery) === "0.00", cs);
  const ca = await submitAndApprove(c1.id);
  check("the correction is approved by someone other than its preparer", ca.sub.status === 200 && ca.ap?.status === 200, [ca.sub.body, ca.ap?.body]);
  r = await call("admin", "POST", `/api/hr/payroll/runs/${c1.id}/post`, {});
  const cje = await s.journalEntry.findFirst({ where: { sourceType: "payroll_run", sourceId: c1.id }, include: { lines: true } });
  check("posted: one entry with the differences (net salaries credited 210)", r.status === 200 && !!cje?.lines.some((l) => l.accountId === c.NET.id && money(l.credit) === "210.00"), [r.body, cje?.lines]);
  check("posting it again -> 409 (idempotent)", (await call("admin", "POST", `/api/hr/payroll/runs/${c1.id}/post`, {})).status === 409);
  check("the retro correction is marked applied (HR-08)", (await s.attendanceCorrection.findUnique({ where: { id: corr1!.id } }))?.retroStatus === "applied");
  check("the corrected run cannot be reversed while its correction stands (409)", (await call("karim", "POST", `/api/hr/payroll/runs/${run2.id}/reverse`, { reason: "x" })).status === 409);

  r = await call("sara", "POST", "/api/hr/attendance/corrections", { employee_id: e1.id, date: `${P}-05`, status: "absent_unpaid", reason: "غياب بدون إذن (اختبار)" });
  await approve("admin", r.body.correction.approvalRequestId);
  r = await call("karim", "POST", `/api/hr/payroll/runs/${run2.id}/corrections`, { reason: "غياب اتسجل بعد الترحيل (اختبار)" });
  const c2 = r.body.run;
  check("a second correction once the first is posted (default: everyone the run paid)", r.status === 201 && (await s.payrollRunEmployee.count({ where: { runId: c2.id } })) >= 4, r.body);
  await calc(c2.id);
  cd = await runOf(c2.id);
  check("the settled leaver cannot be corrected here (blocking: reverse and recompute the settlement)", has(slipOf(cd, e7.id), "settled_in_period", "error"), slipOf(cd, e7.id)?.exceptions);
  check("an employee with no change gets no line", slipOf(cd, e2.id).lines.length === 0 && has(slipOf(cd, e2.id), "no_difference"), slipOf(cd, e2.id));
  await hold(c2.id, e7.id, "تسويته النهائية بتتصحح لوحدها");
  await calc(c2.id);
  cd = await runOf(c2.id);
  cs = slipOf(cd, e1.id);
  check("against the run and its first correction: the unpaid day again (233.33), tax back (−23.33)", cs.lines.some((l: any) => l.kind === "deduction" && money(l.amount) === "233.33") && cs.lines.some((l: any) => l.sourceType === "correction" && money(l.amount) === "-23.33"), cs.lines);
  check("e1 was overpaid 210: carried to employee advances, nothing to pay", money(cs.netPayable) === "0.00" && money(cs.advanceRecovery) === "-210.00" && has(cs, "overpayment_to_advances", "warning"), cs);
  const advBefore = await advanceBalance(e1.id);
  const cb = await submitAndApprove(c2.id);
  r = await call("admin", "POST", `/api/hr/payroll/runs/${c2.id}/post`, {});
  check("posted: e1's employee advances are debited 210 (recovered later like an advance)", cb.ap?.status === 200 && r.status === 200 && money((await advanceBalance(e1.id)).minus(advBefore)) === "210.00", [cb.sub.body, cb.ap?.body, r.body]);
  // A settlement posted by mistake is reversed: entry reversed, encashed days back in the balance.
  const e10 = await hire("تسوية معكوسة", before);
  r = await pkg(e10.id, first, [[BASIC.id, 3000]], 3000); await approve("admin", r.body.package.approvalRequestId);
  await call("admin", "POST", "/api/hr/leave/adjustments", { employee_id: e10.id, leave_type_id: lt.id, days: 3, date: first, reason: "رصيد افتتاحي (اختبار)" });
  await call("karim", "POST", `/api/hr/employees/${e10.id}/employment`, { event: "termination", effective_from: `${P}-20`, termination_reason: "انتهاء عقد", reason: "انتهاء عقد (اختبار)" });
  const st10 = (await call("karim", "POST", "/api/hr/payroll/settlements", { employee_id: e10.id, reason: "تسوية (اختبار)" })).body.settlement;
  await calc(st10.runId);
  await submitAndApprove(st10.runId);
  r = await call("admin", "POST", `/api/hr/payroll/runs/${st10.runId}/post`, {});
  const e10Leave = async () => Number((await s.leaveLedgerEntry.aggregate({ where: { employeeId: e10.id, leaveTypeId: lt.id }, _sum: { days: true } }))._sum.days);
  check("a second leaver's settlement is posted (3 days encashed)", r.status === 200 && (await e10Leave()) === 0, r.body);
  r = await call("karim", "POST", `/api/hr/payroll/runs/${st10.runId}/reverse`, { reason: "اتسجلت بالغلط (اختبار)" });
  check("reversing an unpaid settlement: a reversing entry, and the 3 encashed days come back as an adjustment", r.status === 200 && (await s.payrollRun.findUniqueOrThrow({ where: { id: st10.runId } })).status === "reversed" && (await e10Leave()) === 3, r.body);
  check("…the leaver can then get a new settlement", (await call("karim", "POST", "/api/hr/payroll/settlements", { employee_id: e10.id, reason: "تسوية صحيحة (اختبار)" })).status === 201);
  let health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("Accounts Health after settlement and corrections: books balanced, payroll owed = ledger", health.checks.find((x: any) => x.key === "payroll")?.ok === true && health.checks.find((x: any) => x.key === "trial_balance")?.ok === true, health.checks.filter((x: any) => !x.ok));

  // -------------------------------------------------------------------------
  section("16. HR-13 — the month's remittance summary from posted runs");
  check("the supervisor cannot read it (403)", (await call("sara", "GET", `/api/hr/payroll/remittance?period=${P}`)).status === 403);
  r = await call("karim", "GET", `/api/hr/payroll/remittance?period=${P}`);
  const rem = r.body.report;
  const row = (code: string) => rem?.rows.find((x: any) => x.employee_code === code);
  check("per employee across the month's posted runs: e1 insurable 6000, insurance 600 / 1200, tax 16.67, levy 70", r.status === 200 && money(row(e1.code)?.insurable_wage) === "6000.00" && money(row(e1.code)?.si_employee) === "600.00" && money(row(e1.code)?.si_employer) === "1200.00" && money(row(e1.code)?.income_tax) === "16.67" && money(row(e1.code)?.levy_employee) === "70.00", row(e1.code));
  check("…the leaver's settlement is included (insurance 600, levy 35)", money(row(e7.code)?.si_employee) === "600.00" && money(row(e7.code)?.levy_employee) === "35.00", row(e7.code));
  check("finance without private-data access gets no identifiers", rem.identifiers === false && !("national_id" in row(e1.code)), rem.identifiers);
  check("it says it is not an official form", /not an official/.test(rem.notice));
  r = await call("admin", "GET", `/api/hr/payroll/remittance?period=${P}`);
  check("with private-data access: national ID, insurance number and tax registration columns", r.body.report?.identifiers === true && "national_id" in r.body.report.rows[0] && "insurance_number" in r.body.report.rows[0], r.body.report?.rows?.[0]);
  r = await call("karim", "GET", `/api/hr/payroll/remittance?period=${P}&format=csv`);
  check("CSV export", r.status === 200 && typeof r.body === "string" && r.body.includes(e1.code) && r.body.includes("si_employer"), typeof r.body === "string" ? r.body.slice(0, 200) : r.body);

  // -------------------------------------------------------------------------
  section("17. HR-19 / HR-05 / HR-17 — unpaid cap, absences, YTD tax, instalment plans");
  const now = new Date();
  let Q = "";
  for (let back = 14; back < 400 && !Q; back++) {
    const p = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7);
    if (p !== P && !(await s.payrollRun.findFirst({ where: { period: p, runType: "regular", status: { not: "cancelled" } } }))) Q = p;
  }
  const qFirst = `${Q}-01`, qLast = monthEnd(Q);
  const qIds: string[] = [];
  for (const [code, parameters] of [
    ["pay_proration", { method: "fixed_divisor", divisor_days: 1, base_components: [BASIC.code] }],
    ["eg_social_insurance", { employee_rate: 10, employer_rate: 20, min_insurable_wage: 1000, max_insurable_wage: 10000 }],
    ["eg_salary_income_tax", { taxable_base: "taxable_gross_minus_employee_insurance", period_method: "cumulative_ytd", annual_exemption: 0, brackets: [{ up_to: 1000, rate: 0 }, { up_to: null, rate: 10 }] }],
    ["eg_other_levies", { levies: [{ code: "test_levy", name_ar: "رسم اختبار", base: "gross", rate: 1, payer: "employee" }] }],
  ] as const) {
    const x = await call("karim", "POST", "/api/hr/statutory", { code, effective_from: qFirst, effective_to: qLast, parameters, source_reference: `${TAG} TEST VALUES — not a statutory source` });
    qIds.push(x.body.ruleSet?.id);
    await call("admin", "POST", `/api/hr/statutory/${x.body.ruleSet?.id}/verify`, {});
  }
  check("test rule sets for a second month (tax method: cumulative year-to-date)", (await s.statutoryRuleSet.count({ where: { id: { in: qIds }, status: "verified" } })) === 4, qIds);
  const qBefore = `${shiftMonth(Q, -3)}-01`;
  const e8 = await hire("غياب", qBefore);
  const e9 = await hire("سلف", qBefore);
  r = await pkg(e8.id, qFirst, [[BASIC.id, 3000]], 3000); await approve("admin", r.body.package.approvalRequestId);
  r = await pkg(e9.id, qFirst, [[BASIC.id, 5000]], 5000); await approve("admin", r.body.package.approvalRequestId);
  for (const [date, status] of [[`${Q}-05`, "absent"], [`${Q}-06`, "absent_unpaid"]]) {
    await call("sara", "POST", "/api/hr/attendance/days", { date, rows: [{ employee_id: e8.id, status }] });
    await call("sara", "POST", "/api/hr/attendance/confirm", { date });
  }
  // The box must hold the 2,700 paid out below (cash never goes negative, L2).
  await fundCash("cash_main", 3000);
  const advance = async (amount: number) => (await call("karim", "POST", "/api/hr/transactions", { employee_id: e9.id, type: "advance", amount, cash_account_id: "cash_main" })).body.transaction;
  const A1 = await advance(2000), A2 = await advance(600), A3 = await advance(100);
  check("e9 took three advances", !!A1?.id && !!A2?.id && !!A3?.id);
  const plan = (body: Record<string, unknown>, who = "karim") => call(who, "POST", "/api/hr/advance-plans", { start_period: Q, reason: "تقسيط (اختبار)", ...body });
  check("a plan above its advance -> 400", (await plan({ advance_transaction_id: A1.id, instalment_amount: 100, total_amount: 5000 })).status === 400);
  check("a plan for something that is not an advance -> 400", (await plan({ advance_transaction_id: c.e3.id, instalment_amount: 100 })).status === 400);
  check("the supervisor cannot create plans (403)", (await plan({ advance_transaction_id: A1.id, instalment_amount: 800 }, "sara")).status === 403);
  r = await plan({ advance_transaction_id: A1.id, instalment_amount: 800 });
  const plan1 = r.body.plan;
  check("finance proposes an instalment plan (pending: nothing deducted yet)", r.status === 201 && plan1?.status === "pending", r.body);
  check("one plan per advance (409)", (await plan({ advance_transaction_id: A1.id, instalment_amount: 100 })).status === 409);
  const plan3 = (await plan({ advance_transaction_id: A3.id, instalment_amount: 100 }, "admin")).body.plan;
  check("the plan's author cannot approve it (403)", (await call("admin", "POST", `/api/hr/advance-plans/${plan3.id}/approve`, {})).status === 403);
  check("…a plan can be cancelled with a reason", (await call("admin", "POST", `/api/hr/advance-plans/${plan3.id}/cancel`, { reason: "مش محتاجين خطة (اختبار)" })).status === 200);
  check("DB: a plan approved by its author is refused", await rejects(() => s.employeeAdvancePlan.update({ where: { id: plan1.id }, data: { status: "active", approvedById: plan1.createdById, approvedBy: "t", approvedAt: new Date() } })));
  check("someone else approves it", (await call("admin", "POST", `/api/hr/advance-plans/${plan1.id}/approve`, {})).status === 200);
  const plan2 = (await plan({ advance_transaction_id: A2.id, instalment_amount: 600, allow_above_cap: true, reason: "سداد كامل بموافقة (اختبار)" })).body.plan;
  await call("admin", "POST", `/api/hr/advance-plans/${plan2.id}/approve`, {});
  check("DB: an active plan's amounts cannot change", await rejects(() => s.employeeAdvancePlan.update({ where: { id: plan2.id }, data: { instalmentAmount: 1 } })));

  r = await call("karim", "POST", "/api/hr/payroll/runs", { period: Q });
  const runQ = r.body.run;
  await holdOthers(runQ.id, [e8.id, e9.id]);
  await calc(runQ.id);
  d = await runOf(runQ.id);
  const s8 = slipOf(d, e8.id);
  const unpaid8 = s8.lines.find((l: any) => l.sourceType === "attendance" && l.kind === "deduction");
  check("a plain absence is deducted by default and flagged (HR-19)", has(s8, "absent_deducted", "warning") && Number(unpaid8?.quantity) === 2, s8);
  check("the unpaid deduction never exceeds the fixed pay: 2 days × 3000 capped at 3000", money(unpaid8?.amount) === "3000.00" && has(s8, "unpaid_capped", "warning"), s8.lines);
  check("…insurance on the full month still makes the net negative: blocking, never paid", has(s8, "negative_net", "error"), s8.exceptions);
  await c.setting("hr.payroll_absent_policy", "warn");
  await calc(runQ.id);
  const s8w = slipOf(await runOf(runQ.id), e8.id);
  check("with the absence policy set to warn: the plain absence is not deducted, only flagged", has(s8w, "absent_not_deducted", "warning") && Number(s8w.lines.find((l: any) => l.sourceType === "attendance" && l.kind === "deduction")?.quantity) === 1, s8w);
  await c.setting("hr.payroll_absent_policy", "deduct");

  await calc(runQ.id);
  d = await runOf(runQ.id);
  const s9 = slipOf(d, e9.id);
  const m = Number(Q.slice(5));
  const DD = (v: number | string) => new Prisma.Decimal(v);
  const annual = DD(4500).div(m).mul(12);
  const annualTax = Prisma.Decimal.max(DD(0), annual.minus(1000)).mul(10).div(100);
  const ytdTax = annualTax.mul(m).div(12).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const tax9 = s9.lines.find((l: any) => l.kind === "deduction" && l.sourceType === "statutory" && String(l.explanation).startsWith("YTD"));
  check(`cumulative YTD tax (rule-set flag, HR-05): (4500 ÷ ${m} × 12 − 1000) × 10% × ${m}/12 = ${ytdTax.toFixed(2)}`, !!tax9 && money(tax9.amount) === ytdTax.toFixed(2), s9.lines);
  const net9 = DD(5000).minus(500).minus(ytdTax).minus(50);
  const cap9 = net9.mul(10).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const rec = (planId: string) => s9.lines.find((l: any) => l.kind === "recovery" && l.sourceId === planId);
  check(`the plan's instalment (800) is deducted automatically, reduced to the 10% cap (${cap9.toFixed(2)}) with a warning (HR-17)`, money(rec(plan1.id)?.amount) === cap9.toFixed(2) && has(s9, "instalment_reduced_to_cap", "warning"), s9.lines);
  check("a plan approved above the cap is deducted in full (600)", money(rec(plan2.id)?.amount) === "600.00", s9.lines);
  check("no blocking issue on e9", !s9.exceptions.some((e: any) => e.severity === "error"), s9.exceptions);
  await call("karim", "PATCH", `/api/hr/payroll/runs/${runQ.id}/employees/${e9.id}`, { advance_recovery_requested: 1000 });
  await calc(runQ.id);
  check("a manual recovery above the cap is blocking", has(slipOf(await runOf(runQ.id), e9.id), "recovery_exceeds_cap", "error"));
  await call("karim", "PATCH", `/api/hr/payroll/runs/${runQ.id}/employees/${e9.id}`, { advance_recovery_requested: 0 });
  r = await call("karim", "GET", `/api/hr/advance-plans?employee_id=${e9.id}`);
  check("plans list what is recovered and left (nothing posted yet)", r.status === 200 && r.body.plans?.find((x: any) => x.id === plan1.id)?.remaining === "2000.00", r.body);
  // The run stays (calculated, never submitted): a live run keeps this month — and the rule sets
  // entered for it — out of the next suite run's choice of a free month.

  // -------------------------------------------------------------------------
  section("18. HR-22 — segregation the database enforces");
  const posted2 = await s.payrollRun.findUniqueOrThrow({ where: { id: run2.id } });
  check("DB: a posted run recorded as posted by its preparer is refused", await rejects(() => s.payrollRun.update({ where: { id: run2.id }, data: { postedById: posted2.preparedById } })));
  check("DB: an approved run with no known approver is refused", await rejects(() => s.payrollRun.update({ where: { id: run2.id }, data: { approvedById: null } })));
  check("DB: a payment recorded by the run's preparer is refused", await rejects(() => s.payrollPayment.create({ data: { number: `${TAG}-pp1`, runId: run2.id, date: last, cashAccountId: "bank_main", method: "cash", amount: 1, createdById: posted2.preparedById, createdBy: "t" } })));
  check("DB: a payment with no known user is refused", await rejects(() => s.payrollPayment.create({ data: { number: `${TAG}-pp2`, runId: run2.id, date: last, cashAccountId: "bank_main", method: "cash", amount: 1, createdById: null, createdBy: "system" } })));
  const ws5Audit = new Set((await s.auditLog.findMany({ where: { action: { in: ["final_settlement_created", "payroll_correction_created", "advance_plan_created", "advance_plan_approved", "advance_plan_cancelled", "payroll_remittance_exported"] }, timestamp: { gte: new Date(Date.now() - 3600_000) } }, select: { action: true } })).map((a) => a.action));
  check("settlements, corrections, plans and remittance exports are audited", ws5Audit.size === 6, [...ws5Audit]);

  // Unwinding the month in the only order the rules allow (and leaving the books as found).
  for (const p of await s.payrollPayment.findMany({ where: { runId: st.runId, reversedAt: null } })) await call("karim", "POST", `/api/hr/payroll/payments/${p.id}/reverse`, { reason: "تنظيف الاختبار" });
  check("a settlement the month's posted run relies on cannot be reversed (409)", (await call("karim", "POST", `/api/hr/payroll/runs/${st.runId}/reverse`, { reason: "x" })).status === 409);
  const rev = async (id: string) => (await call("karim", "POST", `/api/hr/payroll/runs/${id}/reverse`, { reason: "تنظيف الاختبار" })).status;
  check("corrections are reversed first, then the month's run, then the settlement", (await rev(c2.id)) === 200 && (await rev(c1.id)) === 200 && (await rev(run2.id)) === 200 && (await rev(st.runId)) === 200);
  check("…e7's encashed days are back", Number((await s.leaveLedgerEntry.aggregate({ where: { employeeId: e7.id, leaveTypeId: lt.id }, _sum: { days: true } }))._sum.days) === 5);
  health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("Accounts Health at the end: all green", health.ok === true, health.checks.filter((x: any) => !x.ok));
}

main().catch(async (e) => { console.error(e); await db?.$disconnect(); process.exit(1); });
