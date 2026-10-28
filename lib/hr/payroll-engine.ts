import { createHash } from "crypto";
import { Prisma, type PayComponent } from "@prisma/client";
import type { Tx } from "@/lib/tx";
import { datesBetween } from "@/lib/hr/attendance-calc";
import { loadContext } from "@/lib/hr/attendance";
import { verifiedRuleFor, type RuleCode, type RuleParams } from "@/lib/hr/statutory";

/**
 * The payroll calculation (docs/erp/HR_PAYROLL_GAP_AUDIT.md §4.5).
 *
 * Pure arithmetic over inputs people entered and approved: packages, the attendance register,
 * approved leave, adjustments, advances, and verified rule sets. There is no default rate,
 * divisor, bracket or multiplier in this file — when a rule a payslip needs is not verified for
 * the whole period, the payslip gets a blocking exception instead of a guessed figure.
 *
 * Every line records where it came from (source and, for rule-based lines, the rule set id and
 * version) and a short formula, so an approver can follow each number.
 */

export const ENGINE_VERSION = "hr-payroll-engine/1";
const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);
const ZERO = D(0);
const r2 = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
type Rounding = { step: number; mode: "nearest" | "down" | "up" } | undefined;
function roundBy(v: Prisma.Decimal, rounding: Rounding) {
  if (!rounding) return r2(v);
  const q = v.div(rounding.step);
  const n = rounding.mode === "down" ? q.floor() : rounding.mode === "up" ? q.ceil() : q.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  return r2(n.mul(rounding.step));
}
const fmt = (v: Prisma.Decimal | number) => D(v).toFixed(2);

export type Exception = { severity: "error" | "warning"; code: string; params?: Record<string, string | number> };
export type Line = {
  payComponentId: string | null; code: string; nameAr: string; nameEn: string | null;
  kind: "earning" | "deduction" | "employer_contribution" | "recovery";
  quantity: Prisma.Decimal | null; rate: Prisma.Decimal | null; base: Prisma.Decimal | null; amount: Prisma.Decimal;
  sourceType: "compensation" | "attendance" | "leave" | "adjustment" | "advance_recovery" | "statutory";
  sourceId: string | null; ruleSetId: string | null; ruleSetVersion: number | null; explanation: string; sortOrder: number;
};
export type Payslip = {
  runEmployeeId: string; employeeId: string; inclusion: string; lines: Line[]; exceptions: Exception[];
  gross: Prisma.Decimal; employeeDeductions: Prisma.Decimal; employerContributions: Prisma.Decimal; netEntitlement: Prisma.Decimal;
  advanceRecovery: Prisma.Decimal; netPayable: Prisma.Decimal; compensationIds: string[]; adjustmentIds: string[];
  employmentSnapshot: Prisma.InputJsonValue; inputsSnapshot: Prisma.InputJsonValue; inputsHash: string;
};
export type Calculation = {
  payslips: Payslip[]; exceptions: (Exception & { employees: number })[];
  totals: { gross: Prisma.Decimal; employeeDeductions: Prisma.Decimal; employerContributions: Prisma.Decimal; advanceRecovery: Prisma.Decimal; netPayable: Prisma.Decimal; headcount: number };
  hash: string; rulesUsed: { code: string; id: string; version: number }[];
};

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function monthBounds(period: string) {
  const [y, m] = period.split("-").map(Number);
  const from = `${period}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from, to, days: Number(to.slice(8)) };
}

type Rule<C extends RuleCode> = { id: string; version: number; code: C; params: RuleParams<C> } | null;

/**
 * Calculates every payslip of a run inside the caller's transaction. Writes nothing: the
 * caller stores the result (calculate) or compares its hash (submit, approve).
 */
export async function calculatePayroll(tx: Tx, run: { id: string; period: string }): Promise<Calculation> {
  const { from, to, days: monthDays } = monthBounds(run.period);
  const dates = datesBetween(from, to);
  const slips = await tx.payrollRunEmployee.findMany({ where: { runId: run.id }, orderBy: { employeeId: "asc" } });
  const ids = slips.map((s) => s.employeeId);

  const [ctx, packages, attendance, adjustments, components, onAccount, advanceBalances, otherRecoveries, employees] = await Promise.all([
    loadContext(tx, from, to, ids),
    tx.employeeCompensation.findMany({
      where: { employeeId: { in: ids }, status: "approved", effectiveFrom: { lte: to }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }] },
      include: { lines: { include: { payComponent: true } } },
      orderBy: { effectiveFrom: "asc" },
    }),
    tx.attendanceDay.findMany({ where: { employeeId: { in: ids }, date: { gte: from, lte: to } }, include: { leaveRequest: { include: { leaveType: true } } } }),
    tx.payrollAdjustment.findMany({
      where: { employeeId: { in: ids }, targetPeriod: run.period, OR: [{ status: "open" }, { status: "reserved", reservedOn: { runId: run.id } }] },
      include: { payComponent: true },
      orderBy: { createdAt: "asc" },
    }),
    tx.payComponent.findMany({ where: { active: true, systemRole: { not: null } } }),
    tx.employeeTransaction.groupBy({ by: ["employeeId"], where: { employeeId: { in: ids }, type: "salary_on_account", payrollPeriod: run.period }, _sum: { amount: true } }),
    tx.journalLine.groupBy({ by: ["partyId"], where: { partyType: "employee", partyId: { in: ids }, account: { systemKey: "employee_advances" } }, _sum: { debit: true, credit: true } }),
    // Recoveries already counted by other live runs (nothing is posted yet, so the journal does not show them).
    tx.payrollRunEmployee.groupBy({ by: ["employeeId"], where: { employeeId: { in: ids }, runId: { not: run.id }, inclusion: "included", run: { status: { not: "cancelled" } } }, _sum: { advanceRecovery: true } }),
    tx.employee.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, jobTitle: true, department: { select: { name: true } } } }),
  ]);

  const rules = {
    proration: (await verifiedRuleFor(tx, "pay_proration", from, to)) as Rule<"pay_proration">,
    overtime: (await verifiedRuleFor(tx, "eg_overtime", from, to)) as Rule<"eg_overtime">,
    insurance: (await verifiedRuleFor(tx, "eg_social_insurance", from, to)) as Rule<"eg_social_insurance">,
    tax: (await verifiedRuleFor(tx, "eg_salary_income_tax", from, to)) as Rule<"eg_salary_income_tax">,
    levies: (await verifiedRuleFor(tx, "eg_other_levies", from, to)) as Rule<"eg_other_levies">,
  };
  const byRole = new Map(components.map((c) => [c.systemRole!, c]));
  const onAccountBy = new Map(onAccount.map((o) => [o.employeeId, o._sum.amount ?? ZERO]));
  const advanceBy = new Map(advanceBalances.map((b) => [b.partyId!, D(b._sum.debit ?? 0).minus(b._sum.credit ?? 0)]));
  const otherRecoveryBy = new Map(otherRecoveries.map((o) => [o.employeeId, o._sum.advanceRecovery ?? ZERO]));
  const empBy = new Map(employees.map((e) => [e.id, e]));

  const payslips: Payslip[] = [];
  for (const slip of slips) {
    const ex: Exception[] = [];
    const lines: Line[] = [];
    const empId = slip.employeeId;
    const myPackages = packages.filter((p) => p.employeeId === empId);
    const myDays = new Map(attendance.filter((a) => a.employeeId === empId).map((a) => [a.date, a]));
    const myAdjustments = adjustments.filter((a) => a.employeeId === empId);
    const employment = dates.map((d) => ({ date: d, row: ctx.employmentOn(empId, d) }));
    const employed = employment.filter((e) => e.row && e.row.status !== "terminated").map((e) => e.date);
    const packageOn = (d: string) => myPackages.find((p) => p.effectiveFrom <= d && (!p.effectiveTo || p.effectiveTo >= d)) ?? null;
    const component = (role: string) => {
      const c = byRole.get(role);
      if (!c) ex.push({ severity: "error", code: "component_missing", params: { role } });
      return c ?? null;
    };
    const push = (c: PayComponent | null, l: Omit<Line, "payComponentId" | "code" | "nameAr" | "nameEn"> & { code?: string; nameAr?: string; nameEn?: string | null }) => {
      if (l.amount.lte(0)) return;
      lines.push({ payComponentId: c?.id ?? null, code: c?.code ?? l.code ?? "", nameAr: c?.nameAr ?? l.nameAr ?? "", nameEn: c?.nameEn ?? l.nameEn ?? null, ...l });
    };
    const needRule = <T,>(rule: T | null, code: string): rule is T => {
      if (!rule) ex.push({ severity: "error", code: "rule_missing", params: { rule: code } });
      return !!rule;
    };

    if (slip.inclusion === "on_hold") {
      payslips.push(finish(slip.id, empId, slip.inclusion, [], [], [], [], ZERO, slip.advanceRecoveryRequested));
      continue;
    }
    if (!employed.length) ex.push({ severity: "warning", code: "no_employed_days" });
    const suspended = employment.filter((e) => e.row?.status === "suspended").length;
    if (suspended) ex.push({ severity: "warning", code: "suspended_days", params: { n: suspended } });
    if (employment.some((e) => e.row?.status === "terminated") && employed.length) ex.push({ severity: "warning", code: "terminated_in_period" });

    // ── Fixed pay, prorated by package segment when the month is not whole ──
    const noPackage = employed.filter((d) => !packageOn(d));
    if (noPackage.length) ex.push({ severity: "error", code: "no_compensation", params: { n: noPackage.length } });
    const segments: { pkg: (typeof myPackages)[number]; days: number }[] = [];
    for (const d of employed) {
      const p = packageOn(d);
      if (!p) continue;
      const last = segments[segments.length - 1];
      if (last && last.pkg.id === p.id) last.days++;
      else segments.push({ pkg: p, days: 1 });
    }
    const wholeMonth = segments.length === 1 && segments[0].days === monthDays;
    // A part month (joiner, leaver, package change) is split by the agreed proration rule only.
    if (!wholeMonth && segments.length) needRule(rules.proration, "pay_proration");
    for (const seg of segments) {
      for (const pl of seg.pkg.lines) {
        const c = pl.payComponent;
        if (c.kind === "information") continue;
        const kind = c.kind as Line["kind"];
        if (wholeMonth) {
          push(c, { kind, quantity: null, rate: null, base: pl.amount, amount: r2(pl.amount), sourceType: "compensation", sourceId: seg.pkg.id, ruleSetId: null, ruleSetVersion: null, explanation: `${fmt(pl.amount)}`, sortOrder: c.payslipOrder });
        } else if (rules.proration) {
          const p = rules.proration.params;
          const amount = p.method === "calendar_days"
            ? pl.amount.mul(seg.days).div(monthDays)
            : Prisma.Decimal.min(pl.amount, pl.amount.div(p.divisor_days!).mul(seg.days));
          push(c, {
            kind, quantity: D(seg.days), rate: null, base: pl.amount, amount: roundBy(amount, p.rounding), sourceType: "compensation", sourceId: seg.pkg.id,
            ruleSetId: rules.proration.id, ruleSetVersion: rules.proration.version,
            explanation: p.method === "calendar_days" ? `${fmt(pl.amount)} × ${seg.days}/${monthDays}` : `${fmt(pl.amount)} ÷ ${p.divisor_days} × ${seg.days}`, sortOrder: c.payslipOrder,
          });
        }
      }
    }

    // ── Unpaid and partially paid days ──
    const dailyBase = (d: string, codes: string[]) => {
      const p = packageOn(d);
      return p ? p.lines.filter((l) => codes.includes(l.payComponent.code)).reduce((a, l) => a.plus(l.amount), ZERO) : ZERO;
    };
    let unpaidDays = ZERO, unpaidAmount = ZERO, partialDays = ZERO, partialAmount = ZERO, absentDays = 0, missing = 0, drafts = 0, unruled = false;
    for (const d of employed) {
      const a = myDays.get(d);
      if (!a) { missing++; continue; }
      if (a.state === "draft") drafts++;
      let share = ZERO;
      let partial = false;
      if (a.status === "absent_unpaid") share = D(1);
      else if (a.status === "absent") absentDays++;
      else if (a.status === "leave" && a.leaveRequest) {
        const lt = a.leaveRequest.leaveType;
        if (lt.payMode === "unpaid") share = D(1);
        else if (lt.payMode === "partially_paid" && lt.paidPercent) { share = D(100).minus(lt.paidPercent).div(100); partial = true; }
      }
      if (share.isZero()) continue;
      if (!rules.proration) { unruled = true; continue; }
      const p = rules.proration.params;
      const rate = dailyBase(d, p.base_components).div(p.method === "calendar_days" ? monthDays : p.divisor_days!);
      if (partial) { partialDays = partialDays.plus(share); partialAmount = partialAmount.plus(rate.mul(share)); }
      else { unpaidDays = unpaidDays.plus(share); unpaidAmount = unpaidAmount.plus(rate.mul(share)); }
    }
    if (unruled && (wholeMonth || !segments.length)) needRule(rules.proration, "pay_proration");
    if (missing) ex.push({ severity: "warning", code: "attendance_missing", params: { n: missing } });
    if (drafts) ex.push({ severity: "error", code: "attendance_draft", params: { n: drafts } });
    if (absentDays) ex.push({ severity: "warning", code: "absent_not_deducted", params: { n: absentDays } });
    if (rules.proration && unpaidDays.gt(0)) {
      push(component("unpaid_absence"), { kind: "deduction", quantity: unpaidDays, rate: null, base: null, amount: roundBy(unpaidAmount, rules.proration.params.rounding), sourceType: "attendance", sourceId: null, ruleSetId: rules.proration.id, ruleSetVersion: rules.proration.version, explanation: `${unpaidDays.toString()} × daily rate`, sortOrder: 500 });
    }
    if (rules.proration && partialDays.gt(0)) {
      push(component("partial_leave"), { kind: "deduction", quantity: partialDays, rate: null, base: null, amount: roundBy(partialAmount, rules.proration.params.rounding), sourceType: "leave", sourceId: null, ruleSetId: rules.proration.id, ruleSetVersion: rules.proration.version, explanation: `${partialDays.toString()} × daily rate`, sortOrder: 501 });
    }

    // ── Overtime ──
    const classes = [["overtimeDayMinutes", "overtime_day", "day_multiplier"], ["overtimeNightMinutes", "overtime_night", "night_multiplier"], ["overtimeRestDayMinutes", "overtime_rest_day", "rest_day_multiplier"], ["overtimeHolidayMinutes", "overtime_holiday", "holiday_multiplier"]] as const;
    const otMinutes = employed.reduce((a, d) => { const x = myDays.get(d); return x ? a + x.overtimeDayMinutes + x.overtimeNightMinutes + x.overtimeRestDayMinutes + x.overtimeHolidayMinutes : a; }, 0);
    if (otMinutes > 0 && !rules.overtime) ex.push({ severity: "warning", code: "overtime_not_paid", params: { minutes: otMinutes } });
    if (otMinutes > 0 && rules.overtime) {
      const p = rules.overtime.params;
      for (const [field, role, mult] of classes) {
        let minutes = 0, amount = ZERO;
        for (const d of employed) {
          const x = myDays.get(d);
          if (!x || x.state === "draft") continue;
          const dayTotal = x.overtimeDayMinutes + x.overtimeNightMinutes + x.overtimeRestDayMinutes + x.overtimeHolidayMinutes;
          if (dayTotal < p.minimum_minutes_per_day || !x[field]) continue;
          const hourly = dailyBase(d, p.base_components).div(p.monthly_divisor_days).div(p.hours_per_day);
          minutes += x[field];
          amount = amount.plus(hourly.mul(x[field]).div(60).mul(p[mult]));
        }
        if (minutes) {
          const hours = D(minutes).div(60).toDecimalPlaces(4);
          push(component(role), { kind: "earning", quantity: hours, rate: D(p[mult]), base: null, amount: roundBy(amount, p.rounding), sourceType: "attendance", sourceId: null, ruleSetId: rules.overtime.id, ruleSetVersion: rules.overtime.version, explanation: `${hours.toString()} h × hourly × ${p[mult]}`, sortOrder: 200 });
        }
      }
    }

    // ── One-off adjustments ──
    const adjustmentIds: string[] = [];
    for (const a of myAdjustments) {
      if (a.payComponent.kind === "information") continue;
      adjustmentIds.push(a.id);
      push(a.payComponent, { kind: a.payComponent.kind as Line["kind"], quantity: null, rate: null, base: null, amount: r2(a.amount), sourceType: "adjustment", sourceId: a.id, ruleSetId: null, ruleSetVersion: null, explanation: `${a.number}: ${a.reason}`.slice(0, 300), sortOrder: a.payComponent.payslipOrder });
    }

    // ── Statutory ──
    const sum = (k: Line["kind"], pred: (l: Line) => boolean = () => true) => lines.filter((l) => l.kind === k && pred(l)).reduce((a, l) => a.plus(l.amount), ZERO);
    const compFlag = (l: Line, flag: "taxable" | "insurable") => (l.payComponentId ? componentsById(l.payComponentId, myPackages, myAdjustments, components)?.[flag] === true : false);
    const gross = sum("earning");
    const taxableGross = Prisma.Decimal.max(ZERO, sum("earning", (l) => compFlag(l, "taxable")).minus(sum("deduction", (l) => l.sourceType !== "statutory" && compFlag(l, "taxable"))));
    const lastPackage = segments.length ? segments[segments.length - 1].pkg : null;
    let siEmployee = ZERO, siBase = ZERO;
    if (lastPackage) {
      if (lastPackage.insurableWage === null) ex.push({ severity: "error", code: "insurable_wage_missing" });
      else if (lastPackage.insurableWage.gt(0) && needRule(rules.insurance, "eg_social_insurance")) {
        const p = rules.insurance.params;
        siBase = Prisma.Decimal.min(D(p.max_insurable_wage), Prisma.Decimal.max(D(p.min_insurable_wage), lastPackage.insurableWage));
        siEmployee = roundBy(siBase.mul(p.employee_rate).div(100), p.rounding);
        const siEmployer = roundBy(siBase.mul(p.employer_rate).div(100), p.rounding);
        push(component("social_insurance_employee"), { kind: "deduction", quantity: null, rate: D(p.employee_rate), base: siBase, amount: siEmployee, sourceType: "statutory", sourceId: null, ruleSetId: rules.insurance.id, ruleSetVersion: rules.insurance.version, explanation: `${fmt(siBase)} × ${p.employee_rate}%`, sortOrder: 800 });
        push(component("social_insurance_employer"), { kind: "employer_contribution", quantity: null, rate: D(p.employer_rate), base: siBase, amount: siEmployer, sourceType: "statutory", sourceId: null, ruleSetId: rules.insurance.id, ruleSetVersion: rules.insurance.version, explanation: `${fmt(siBase)} × ${p.employer_rate}%`, sortOrder: 900 });
        if (employed.length < monthDays) ex.push({ severity: "warning", code: "insurance_partial_month" });
      }
    }
    if (taxableGross.gt(0) && needRule(rules.tax, "eg_salary_income_tax")) {
      const p = rules.tax.params;
      const base = p.taxable_base === "taxable_gross_minus_employee_insurance" ? Prisma.Decimal.max(ZERO, taxableGross.minus(siEmployee)) : taxableGross;
      const annual = Prisma.Decimal.max(ZERO, base.mul(12).minus(p.annual_exemption));
      const table = [...(p.high_income_tables ?? [])].sort((a, b) => b.above - a.above).find((t) => annual.gt(t.above))?.brackets ?? p.brackets;
      let left = annual, lower = ZERO, annualTax = ZERO;
      for (const b of table) {
        const upper = b.up_to === null ? null : D(b.up_to);
        const width = upper === null ? left : Prisma.Decimal.min(left, upper.minus(lower));
        if (width.lte(0)) { if (upper) lower = upper; continue; }
        annualTax = annualTax.plus(width.mul(b.rate).div(100));
        left = left.minus(width);
        if (upper) lower = upper;
        if (left.lte(0)) break;
      }
      const monthly = roundBy(annualTax.div(12), p.rounding);
      push(component("income_tax"), { kind: "deduction", quantity: null, rate: null, base, amount: monthly, sourceType: "statutory", sourceId: null, ruleSetId: rules.tax.id, ruleSetVersion: rules.tax.version, explanation: `(${fmt(base)} × 12 − ${fmt(p.annual_exemption)}) → ${fmt(annualTax)} ÷ 12`, sortOrder: 810 });
    }
    if (rules.levies) {
      const p = rules.levies.params;
      const deductionsSoFar = sum("deduction");
      for (const lv of p.levies) {
        const base = lv.base === "gross" ? gross : lv.base === "taxable_gross" ? taxableGross : lv.base === "insurable_wage" ? siBase : gross.minus(deductionsSoFar);
        const amount = roundBy(Prisma.Decimal.max(ZERO, base).mul(lv.rate).div(100), p.rounding);
        const c = component(lv.payer === "employee" ? "other_levy_employee" : "other_levy_employer");
        push(c, { kind: lv.payer === "employee" ? "deduction" : "employer_contribution", quantity: null, rate: D(lv.rate), base, amount, sourceType: "statutory", sourceId: lv.code, ruleSetId: rules.levies.id, ruleSetVersion: rules.levies.version, explanation: `${lv.name_ar}: ${fmt(base)} × ${lv.rate}%`, sortOrder: 820 });
      }
    }

    // ── Net, and recovery of what was paid ahead ──
    const employeeDeductions = sum("deduction");
    const netEntitlement = gross.minus(employeeDeductions);
    const onAcc = onAccountBy.get(empId) ?? ZERO;
    const recovery = onAcc.plus(slip.advanceRecoveryRequested);
    const openAdvance = (advanceBy.get(empId) ?? ZERO).minus(otherRecoveryBy.get(empId) ?? ZERO);
    let applied = ZERO;
    if (netEntitlement.lt(0)) ex.push({ severity: "error", code: "negative_net", params: { amount: fmt(netEntitlement) } });
    if (recovery.gt(0)) {
      if (recovery.gt(openAdvance)) ex.push({ severity: "error", code: "recovery_exceeds_open", params: { recovery: fmt(recovery), open: fmt(openAdvance) } });
      else if (recovery.gt(Prisma.Decimal.max(ZERO, netEntitlement))) ex.push({ severity: "error", code: "recovery_exceeds_net", params: { recovery: fmt(recovery), net: fmt(netEntitlement) } });
      else {
        applied = recovery;
        push(component("advance_recovery"), { kind: "recovery", quantity: null, rate: null, base: null, amount: r2(recovery), sourceType: "advance_recovery", sourceId: null, ruleSetId: null, ruleSetVersion: null, explanation: `on account ${fmt(onAcc)} + advance ${fmt(slip.advanceRecoveryRequested)}`, sortOrder: 950 });
      }
    }
    const emp = empBy.get(empId);
    payslips.push(finish(slip.id, empId, slip.inclusion, lines, ex, myPackages.map((p) => p.id), adjustmentIds, applied, slip.advanceRecoveryRequested, {
      employment: { employee: emp, rows: employment.filter((e) => e.row).length, employedDays: employed.length, monthDays, suspendedDays: suspended },
      inputs: {
        packages: myPackages.map((p) => ({ id: p.id, number: p.number, from: p.effectiveFrom, to: p.effectiveTo, insurableWage: p.insurableWage?.toString() ?? null, lines: p.lines.map((l) => [l.payComponent.code, l.amount.toString()]) })),
        // What pays, not how it is filed: locking a day for this run (state, version) must not
        // change the hash the approver compares; a corrected value must.
        attendance: [...myDays.values()].map((a) => [a.date, a.status, a.state === "draft", a.overtimeDayMinutes, a.overtimeNightMinutes, a.overtimeRestDayMinutes, a.overtimeHolidayMinutes, a.leaveRequestId]).sort(),
        adjustments: myAdjustments.map((a) => [a.id, a.amount.toString()]),
        onAccount: onAcc.toString(), openAdvance: openAdvance.toString(), recoveryRequested: slip.advanceRecoveryRequested.toString(),
        rules: Object.values(rules).filter(Boolean).map((r) => [r!.code, r!.id, r!.version]),
      },
    }));
  }

  const included = payslips.filter((p) => p.inclusion === "included");
  const tot = (k: "gross" | "employeeDeductions" | "employerContributions" | "advanceRecovery" | "netPayable") => included.reduce((a, p) => a.plus(p[k]), ZERO);
  const totals = { gross: tot("gross"), employeeDeductions: tot("employeeDeductions"), employerContributions: tot("employerContributions"), advanceRecovery: tot("advanceRecovery"), netPayable: tot("netPayable"), headcount: included.length };
  const agg = new Map<string, Exception & { employees: number }>();
  for (const p of included) for (const e of p.exceptions) {
    const k = `${e.severity}|${e.code}|${e.code === "rule_missing" || e.code === "component_missing" ? JSON.stringify(e.params) : ""}`;
    const cur = agg.get(k);
    const keyed = e.code === "rule_missing" || e.code === "component_missing";
    // Counts (days, minutes) add up across payslips; amounts and names stay on the payslip.
    const counts = Object.fromEntries(Object.entries(e.params ?? {}).filter(([, v]) => typeof v === "number"));
    if (cur) {
      cur.employees++;
      if (!keyed) for (const [pk, pv] of Object.entries(counts)) cur.params = { ...cur.params, [pk]: Number(cur.params?.[pk] ?? 0) + (pv as number) };
    } else agg.set(k, { ...e, params: keyed ? e.params : Object.keys(counts).length ? counts : undefined, employees: 1 });
  }
  const rulesUsed = Object.values(rules).filter(Boolean).map((r) => ({ code: r!.code, id: r!.id, version: r!.version }));
  const hash = sha({
    engine: ENGINE_VERSION, period: run.period, rules: rulesUsed,
    payslips: payslips.map((p) => ({ e: p.employeeId, i: p.inclusion, h: p.inputsHash, l: p.lines.map(lineKey), n: p.netPayable.toFixed(2) })),
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toString()])),
  });
  return { payslips, exceptions: [...agg.values()], totals, hash, rulesUsed };
}

function lineKey(l: Line) {
  return [l.code, l.kind, l.amount.toFixed(2), l.quantity?.toString() ?? null, l.rate?.toString() ?? null, l.sourceType, l.sourceId, l.ruleSetId, l.ruleSetVersion];
}

function componentsById(id: string, packages: { lines: { payComponent: PayComponent }[] }[], adjustments: { payComponent: PayComponent }[], system: PayComponent[]) {
  for (const p of packages) for (const l of p.lines) if (l.payComponent.id === id) return l.payComponent;
  for (const a of adjustments) if (a.payComponent.id === id) return a.payComponent;
  return system.find((c) => c.id === id) ?? null;
}

function finish(
  runEmployeeId: string, employeeId: string, inclusion: string, lines: Line[], exceptions: Exception[], compensationIds: string[], adjustmentIds: string[],
  advanceRecovery: Prisma.Decimal, requested: Prisma.Decimal, snapshot?: { employment: unknown; inputs: unknown }
): Payslip {
  const sum = (k: Line["kind"]) => lines.filter((l) => l.kind === k).reduce((a, l) => a.plus(l.amount), ZERO);
  const gross = sum("earning");
  const employeeDeductions = sum("deduction");
  const employerContributions = sum("employer_contribution");
  const netEntitlement = gross.minus(employeeDeductions);
  const blocked = exceptions.some((e) => e.severity === "error");
  // A blocked payslip keeps its exact figures for review (a run with one cannot be submitted);
  // it never carries a recovery.
  const recovery = blocked ? ZERO : advanceRecovery;
  const inputs = snapshot?.inputs ?? { onHold: true, requested: requested.toString() };
  return {
    runEmployeeId, employeeId, inclusion, lines: lines.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)), exceptions,
    gross, employeeDeductions, employerContributions, netEntitlement, advanceRecovery: recovery,
    netPayable: netEntitlement.minus(recovery), compensationIds, adjustmentIds,
    employmentSnapshot: (snapshot?.employment ?? {}) as Prisma.InputJsonValue, inputsSnapshot: inputs as Prisma.InputJsonValue, inputsHash: sha(inputs),
  };
}
