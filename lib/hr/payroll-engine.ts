import { createHash } from "crypto";
import { Prisma, type PayComponent } from "@prisma/client";
import type { Tx } from "@/lib/tx";
import { getSetting } from "@/lib/core/settings-service";
import { datesBetween } from "@/lib/hr/attendance-calc";
import { loadContext, onPayroll } from "@/lib/hr/attendance";
import { verifiedRuleFor, type RuleCode, type RuleParams } from "@/lib/hr/statutory";
import { custodyBalances } from "@/lib/hr/custody";

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
 *
 * Run types (WS5, docs/erp/REMEDIATION_PLAN_2026-11.md):
 *  - regular: the month. A leaver (termination in the month) blocks the run until their final
 *    settlement is posted; from then on their regular payslip is empty ("paid by settlement").
 *  - final_settlement (HR-12): one leaver's month up to the last working day (inclusive, HR-20),
 *    plus manual settlement items, encashment of unused encashable leave (HR-11) and recovery of
 *    open advances.
 *  - correction (HR-07): the month recalculated for chosen employees of a posted run.
 *  Settlement and correction runs post DIFFERENCES: each payslip's lines are the recalculated
 *  month minus what posted runs of the month already carry for the employee (a line whose
 *  component was never posted keeps its own source; a changed one becomes a signed
 *  'correction' line). A negative difference in what the employee is owed is carried to
 *  employee advances (a negative recovery), so it is recovered like an advance, never paid.
 */

export const ENGINE_VERSION = "hr-payroll-engine/2";
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
  sourceType: "compensation" | "attendance" | "leave" | "adjustment" | "advance_recovery" | "statutory" | "settlement" | "correction";
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
type RunInput = { id: string; period: string; runType?: string | null; correctionOfRunId?: string | null };

/** The tax of an annual taxable income under the default brackets or the high-income table it falls in. */
export function annualTaxOf(annualIncome: Prisma.Decimal, p: RuleParams<"eg_salary_income_tax">) {
  // PAY-01: the law rounds the annual income down (to the nearest lower 10 EGP) before the brackets.
  const step = p.annual_income_round_down_to;
  const annual = step ? annualIncome.div(step).floor().mul(step) : annualIncome;
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
  return annualTax;
}

/**
 * Calculates every payslip of a run inside the caller's transaction. Writes nothing: the
 * caller stores the result (calculate) or compares its hash (submit, approve).
 */
export async function calculatePayroll(tx: Tx, run: RunInput): Promise<Calculation> {
  const { from, to, days: monthDays } = monthBounds(run.period);
  const runType = run.runType ?? "regular";
  const signedRun = runType === "correction" || runType === "final_settlement";
  const dates = datesBetween(from, to);
  const slips = await tx.payrollRunEmployee.findMany({ where: { runId: run.id }, orderBy: { employeeId: "asc" } });
  const ids = slips.map((s) => s.employeeId);
  const year = run.period.slice(0, 4);
  const taxComponentIds = (await tx.payComponent.findMany({ where: { systemRole: "income_tax" }, select: { id: true } })).map((c) => c.id);

  const [ctx, packages, attendance, adjustments, components, onAccount, advanceBalances, otherRecoveries, employees, postedLines, settlements, plans, planRecoveries, priorTax, absentPolicy, capPct] = await Promise.all([
    loadContext(tx, from, to, ids),
    tx.employeeCompensation.findMany({
      where: { employeeId: { in: ids }, status: "approved", effectiveFrom: { lte: to }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }] },
      include: { lines: { include: { payComponent: true } } },
      orderBy: { effectiveFrom: "asc" },
    }),
    tx.attendanceDay.findMany({ where: { employeeId: { in: ids }, date: { gte: from, lte: to } }, include: { leaveRequest: { include: { leaveType: true } } } }),
    tx.payrollAdjustment.findMany({
      where: {
        employeeId: { in: ids }, targetPeriod: run.period,
        OR: [
          { status: "open" }, { status: "reserved", reservedOn: { runId: run.id } },
          // A recalculation of a posted month (settlement, correction) keeps what that month applied.
          ...(signedRun ? [{ status: "applied", reservedOn: { run: { status: "posted", period: run.period } } }] : []),
        ],
      },
      include: { payComponent: true },
      orderBy: { createdAt: "asc" },
    }),
    tx.payComponent.findMany({ where: { active: true, systemRole: { not: null } } }),
    tx.employeeTransaction.groupBy({ by: ["employeeId"], where: { employeeId: { in: ids }, type: "salary_on_account", payrollPeriod: run.period }, _sum: { amount: true } }),
    tx.journalLine.groupBy({ by: ["partyId"], where: { partyType: "employee", partyId: { in: ids }, account: { systemKey: "employee_advances" } }, _sum: { debit: true, credit: true } }),
    // Recoveries counted by other runs not yet posted (a posted run's recovery is already in the
    // journal balance above; a reversed one's was reversed there).
    tx.payrollRunEmployee.groupBy({ by: ["employeeId"], where: { employeeId: { in: ids }, runId: { not: run.id }, inclusion: "included", run: { status: { notIn: ["cancelled", "posted", "reversed"] } } }, _sum: { advanceRecovery: true } }),
    tx.employee.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, nameAr: true, jobTitle: true, department: { select: { name: true, nameAr: true } } } }),
    // What posted runs of this month already carry per employee (the baseline of differences,
    // and the on-account salary already recovered).
    tx.payrollRunLine.findMany({
      where: { runEmployee: { employeeId: { in: ids }, inclusion: "included", runId: { not: run.id }, run: { status: "posted", period: run.period } } },
      select: { kind: true, code: true, nameAr: true, nameEn: true, payComponentId: true, amount: true, base: true, sourceType: true, sourceId: true, runEmployee: { select: { employeeId: true, run: { select: { runType: true } } } } },
    }),
    // Final settlements of this month's leavers that are alive (not cancelled or reversed).
    tx.employeeFinalSettlement.findMany({
      where: { employeeId: { in: ids }, run: { period: run.period, status: { notIn: ["cancelled", "reversed"] } } },
      include: { run: { select: { id: true, status: true, number: true } }, items: { include: { payComponent: true }, orderBy: { id: "asc" } } },
    }),
    tx.employeeAdvancePlan.findMany({ where: { employeeId: { in: ids }, status: "active", startPeriod: { lte: run.period } }, orderBy: [{ startPeriod: "asc" }, { createdAt: "asc" }] }),
    tx.payrollRunLine.groupBy({
      by: ["sourceId"],
      where: { sourceType: "advance_recovery", runEmployee: { employeeId: { in: ids }, inclusion: "included", runId: { not: run.id }, run: { status: { notIn: ["cancelled", "reversed"] } } } },
      _sum: { amount: true },
    }),
    // HR-05 (cumulative_ytd): tax and taxable base already withheld this calendar year.
    tx.payrollRunLine.findMany({
      where: { kind: "deduction", payComponentId: { in: taxComponentIds }, runEmployee: { employeeId: { in: ids }, inclusion: "included", run: { status: "posted", period: { gte: `${year}-01`, lt: run.period } } } },
      select: { amount: true, base: true, runEmployee: { select: { employeeId: true } } },
    }),
    getSetting("hr.payroll_absent_policy"),
    getSetting("hr.advance_recovery_max_pct"),
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
  // Purchasing custody shares 1600 but is never recovered from pay automatically (safe default,
  // pending owner decision): only the salary side of the balance is open to recovery here.
  const custodyBy = await custodyBalances(tx, ids);
  const advanceBy = new Map(advanceBalances.map((b) => [b.partyId!, D(b._sum.debit ?? 0).minus(b._sum.credit ?? 0).minus(custodyBy.get(b.partyId!) ?? ZERO)]));
  const otherRecoveryBy = new Map(otherRecoveries.map((o) => [o.employeeId, o._sum.advanceRecovery ?? ZERO]));
  const planRecoveredBy = new Map(planRecoveries.map((p) => [p.sourceId ?? "", p._sum.amount ?? ZERO]));
  const empBy = new Map(employees.map((e) => [e.id, e]));
  const thisSettlement = runType === "final_settlement" ? (await tx.employeeFinalSettlement.findUnique({ where: { runId: run.id }, include: { items: { include: { payComponent: true }, orderBy: { id: "asc" } } } })) : null;

  // Leave balances for a settlement's encashment (HR-11): encashable types, as of the last working day.
  const encashable = thisSettlement?.encashLeave
    ? await tx.leaveType.findMany({ where: { encashable: true }, select: { id: true, code: true, nameAr: true } })
    : [];
  const balances = encashable.length
    ? await tx.leaveLedgerEntry.groupBy({ by: ["leaveTypeId"], where: { employeeId: thisSettlement!.employeeId, leaveTypeId: { in: encashable.map((t) => t.id) }, date: { lte: thisSettlement!.lastWorkingDay } }, _sum: { days: true } })
    : [];
  const balanceOf = new Map(balances.map((b) => [b.leaveTypeId, b._sum.days ?? ZERO]));

  const payslips: Payslip[] = [];
  for (const slip of slips) {
    const ex: Exception[] = [];
    const lines: Line[] = [];
    const empId = slip.employeeId;
    const myPackages = packages.filter((p) => p.employeeId === empId);
    const myDays = new Map(attendance.filter((a) => a.employeeId === empId).map((a) => [a.date, a]));
    const myAdjustments = adjustments.filter((a) => a.employeeId === empId);
    const myPosted = postedLines.filter((l) => l.runEmployee.employeeId === empId);
    const mySettlement = settlements.find((s) => s.employeeId === empId) ?? null;
    const employment = dates.map((d) => ({ date: d, row: ctx.employmentOn(empId, d) }));
    // HR-20: the termination date is the last working day — employed and paid.
    const employed = employment.filter((e) => onPayroll(e.row, e.date)).map((e) => e.date);
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

    // ── A leaver (HR-12): blocked until the final settlement is posted ──
    const leftThisMonth = employment.some((e) => e.row?.status === "terminated") && employed.length > 0;
    if (leftThisMonth && runType === "regular") {
      if (mySettlement?.run.status === "posted") {
        ex.push({ severity: "warning", code: "paid_by_settlement", params: { run: mySettlement.run.number } });
        payslips.push(finish(slip.id, empId, slip.inclusion, [], ex, [], [], ZERO, ZERO, {
          employment: { employee: empBy.get(empId), employedDays: employed.length, monthDays },
          inputs: { paidBySettlement: mySettlement.run.id },
        }));
        continue;
      }
      ex.push({ severity: "error", code: mySettlement ? "settlement_pending" : "terminated_in_period", params: mySettlement ? { run: mySettlement.run.number } : undefined });
    }
    if (leftThisMonth && runType === "correction") {
      // A settled leaver's month is corrected by reversing and recomputing the settlement.
      if (mySettlement) ex.push({ severity: "error", code: "settled_in_period", params: { run: mySettlement.run.number } });
      else ex.push({ severity: "error", code: "terminated_in_period" });
    }
    if (runType === "final_settlement" && !leftThisMonth) ex.push({ severity: "error", code: "settlement_not_terminated" });

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
    const fixedPay = lines.filter((l) => l.sourceType === "compensation" && l.kind === "earning").reduce((a, l) => a.plus(l.amount), ZERO);

    // ── Unpaid and partially paid days ──
    const dailyBase = (d: string, codes: string[]) => {
      const p = packageOn(d);
      return p ? p.lines.filter((l) => codes.includes(l.payComponent.code)).reduce((a, l) => a.plus(l.amount), ZERO) : ZERO;
    };
    const deductAbsent = absentPolicy === "deduct";
    let unpaidDays = ZERO, unpaidAmount = ZERO, partialDays = ZERO, partialAmount = ZERO, absentDays = 0, missing = 0, drafts = 0, unruled = false;
    for (const d of employed) {
      const a = myDays.get(d);
      if (!a) { missing++; continue; }
      if (a.state === "draft") drafts++;
      let share = ZERO;
      let partial = false;
      if (a.status === "absent_unpaid") share = D(1);
      else if (a.status === "absent") { absentDays++; if (deductAbsent) share = D(1); }
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
    if (absentDays) ex.push({ severity: "warning", code: deductAbsent ? "absent_deducted" : "absent_not_deducted", params: { n: absentDays } });
    if (rules.proration) {
      // HR-19: unpaid days never take more than the month's fixed pay of the employed days.
      let unpaid = roundBy(unpaidAmount, rules.proration.params.rounding);
      let partialAmt = roundBy(partialAmount, rules.proration.params.rounding);
      if (unpaid.plus(partialAmt).gt(fixedPay)) {
        const excess = unpaid.plus(partialAmt).minus(fixedPay);
        unpaid = Prisma.Decimal.min(unpaid, fixedPay);
        partialAmt = Prisma.Decimal.max(ZERO, Prisma.Decimal.min(partialAmt, fixedPay.minus(unpaid)));
        ex.push({ severity: "warning", code: "unpaid_capped", params: { amount: fmt(excess) } });
      }
      if (unpaidDays.gt(0)) push(component("unpaid_absence"), { kind: "deduction", quantity: unpaidDays, rate: null, base: null, amount: unpaid, sourceType: "attendance", sourceId: null, ruleSetId: rules.proration.id, ruleSetVersion: rules.proration.version, explanation: `${unpaidDays.toString()} × daily rate`, sortOrder: 500 });
      if (partialDays.gt(0)) push(component("partial_leave"), { kind: "deduction", quantity: partialDays, rate: null, base: null, amount: partialAmt, sourceType: "leave", sourceId: null, ruleSetId: rules.proration.id, ruleSetVersion: rules.proration.version, explanation: `${partialDays.toString()} × daily rate`, sortOrder: 501 });
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
      if (a.status !== "applied") adjustmentIds.push(a.id);
      push(a.payComponent, { kind: a.payComponent.kind as Line["kind"], quantity: null, rate: null, base: null, amount: r2(a.amount), sourceType: "adjustment", sourceId: a.id, ruleSetId: null, ruleSetVersion: null, explanation: `${a.number}: ${a.reason}`.slice(0, 300), sortOrder: a.payComponent.payslipOrder });
    }

    // ── Final settlement items and leave encashment (HR-11, HR-12) ──
    const leaveInputs: [string, string][] = [];
    if (thisSettlement && thisSettlement.employeeId === empId) {
      for (const it of thisSettlement.items) {
        if (it.payComponent.kind === "information") continue;
        push(it.payComponent, { kind: it.payComponent.kind as Line["kind"], quantity: null, rate: null, base: null, amount: r2(it.amount), sourceType: "settlement", sourceId: it.id, ruleSetId: null, ruleSetVersion: null, explanation: it.reason.slice(0, 300), sortOrder: it.payComponent.payslipOrder });
      }
      for (const t of encashable) {
        const days = balanceOf.get(t.id) ?? ZERO;
        leaveInputs.push([t.id, days.toString()]);
        if (days.lt(0)) { ex.push({ severity: "warning", code: "leave_balance_negative", params: { type: t.code, days: Number(days) } }); continue; }
        if (days.isZero()) continue;
        if (!needRule(rules.proration, "pay_proration")) continue;
        const p = rules.proration.params;
        const rate = dailyBase(thisSettlement.lastWorkingDay, p.base_components).div(p.method === "calendar_days" ? monthDays : p.divisor_days!);
        push(component("leave_encashment"), {
          kind: "earning", quantity: days, rate: r2(rate), base: null, amount: roundBy(rate.mul(days), p.rounding), sourceType: "settlement", sourceId: `leave:${t.id}`,
          ruleSetId: rules.proration.id, ruleSetVersion: rules.proration.version, explanation: `${t.code}: ${days.toString()} × ${fmt(rate)}`, sortOrder: 300,
        });
      }
    }

    // ── Statutory ──
    const sum = (k: Line["kind"], pred: (l: Line) => boolean = () => true) => lines.filter((l) => l.kind === k && pred(l)).reduce((a, l) => a.plus(l.amount), ZERO);
    const settlementComponents = thisSettlement?.items.map((i) => i.payComponent) ?? [];
    const compFlag = (l: Line, flag: "taxable" | "insurable") => (l.payComponentId ? componentsById(l.payComponentId, myPackages, myAdjustments, [...components, ...settlementComponents])?.[flag] === true : false);
    const gross = sum("earning");
    const taxableGross = Prisma.Decimal.max(ZERO, sum("earning", (l) => compFlag(l, "taxable")).minus(sum("deduction", (l) => l.sourceType !== "statutory" && compFlag(l, "taxable"))));
    const lastPackage = segments.length ? segments[segments.length - 1].pkg : null;
    let siEmployee = ZERO, siBase = ZERO;
    if (lastPackage) {
      // HR-04: an insurable wage of 0 is not "no insurance" unless the package says so.
      if (lastPackage.insuranceExempt) ex.push({ severity: "warning", code: "insurance_exempt", params: { reason: (lastPackage.insuranceExemptReason ?? "").slice(0, 100) } });
      else if (lastPackage.insurableWage === null) ex.push({ severity: "error", code: "insurable_wage_missing" });
      else if (lastPackage.insurableWage.lte(0)) ex.push({ severity: "error", code: "insurable_wage_zero" });
      else {
        const insurableComponents = lastPackage.lines.filter((l) => l.payComponent.insurable === true).reduce((a, l) => a.plus(l.amount), ZERO);
        if (!insurableComponents.equals(lastPackage.insurableWage)) ex.push({ severity: "warning", code: "insurable_wage_differs", params: { wage: fmt(lastPackage.insurableWage), components: fmt(insurableComponents) } });
        if (needRule(rules.insurance, "eg_social_insurance")) {
          const p = rules.insurance.params;
          siBase = Prisma.Decimal.min(D(p.max_insurable_wage), Prisma.Decimal.max(D(p.min_insurable_wage), lastPackage.insurableWage));
          siEmployee = roundBy(siBase.mul(p.employee_rate).div(100), p.rounding);
          const siEmployer = roundBy(siBase.mul(p.employer_rate).div(100), p.rounding);
          push(component("social_insurance_employee"), { kind: "deduction", quantity: null, rate: D(p.employee_rate), base: siBase, amount: siEmployee, sourceType: "statutory", sourceId: null, ruleSetId: rules.insurance.id, ruleSetVersion: rules.insurance.version, explanation: `${fmt(siBase)} × ${p.employee_rate}%`, sortOrder: 800 });
          push(component("social_insurance_employer"), { kind: "employer_contribution", quantity: null, rate: D(p.employer_rate), base: siBase, amount: siEmployer, sourceType: "statutory", sourceId: null, ruleSetId: rules.insurance.id, ruleSetVersion: rules.insurance.version, explanation: `${fmt(siBase)} × ${p.employer_rate}%`, sortOrder: 900 });
          if (employed.length < monthDays) ex.push({ severity: "warning", code: "insurance_partial_month" });
        }
      }
    }
    const taxPrior = priorTax.filter((t) => t.runEmployee.employeeId === empId);
    let ytdInputs: [string, string] | null = null;
    if (taxableGross.gt(0) && needRule(rules.tax, "eg_salary_income_tax")) {
      const p = rules.tax.params;
      const base = p.taxable_base === "taxable_gross_minus_employee_insurance" ? Prisma.Decimal.max(ZERO, taxableGross.minus(siEmployee)) : taxableGross;
      if (p.period_method === "cumulative_ytd") {
        // HR-05: the year so far, projected to a year by month number, less tax already withheld.
        const month = Number(run.period.slice(5));
        const priorBase = taxPrior.reduce((a, t) => a.plus(t.base ?? ZERO), ZERO);
        const priorWithheld = taxPrior.reduce((a, t) => a.plus(t.amount), ZERO);
        ytdInputs = [priorBase.toString(), priorWithheld.toString()];
        const ytdBase = priorBase.plus(base);
        const annual = Prisma.Decimal.max(ZERO, ytdBase.div(month).mul(12).minus(p.annual_exemption));
        const annualTax = annualTaxOf(annual, p);
        const dueToDate = annualTax.mul(month).div(12);
        let monthly = roundBy(dueToDate.minus(priorWithheld), p.rounding);
        if (monthly.lt(0)) { ex.push({ severity: "warning", code: "tax_ytd_overwithheld", params: { amount: fmt(monthly.negated()) } }); monthly = ZERO; }
        push(component("income_tax"), { kind: "deduction", quantity: null, rate: null, base, amount: monthly, sourceType: "statutory", sourceId: null, ruleSetId: rules.tax.id, ruleSetVersion: rules.tax.version, explanation: `YTD (${fmt(ytdBase)} ÷ ${month} × 12 − ${fmt(p.annual_exemption)}) → ${fmt(annualTax)} × ${month}/12 − ${fmt(priorWithheld)}`, sortOrder: 810 });
      } else {
        const annual = Prisma.Decimal.max(ZERO, base.mul(12).minus(p.annual_exemption));
        const annualTax = annualTaxOf(annual, p);
        const monthly = roundBy(annualTax.div(12), p.rounding);
        push(component("income_tax"), { kind: "deduction", quantity: null, rate: null, base, amount: monthly, sourceType: "statutory", sourceId: null, ruleSetId: rules.tax.id, ruleSetVersion: rules.tax.version, explanation: `(${fmt(base)} × 12 − ${fmt(p.annual_exemption)}) → ${fmt(annualTax)} ÷ 12`, sortOrder: 810 });
        if (runType === "final_settlement" && lines.some((l) => l.sourceType === "settlement" && l.kind === "earning")) ex.push({ severity: "warning", code: "settlement_tax_annualised" });
      }
    }
    // HR-03: a statutory levy (Martyrs' Fund, Law 4/2021) is never silently left out: pay with
    // no verified levy rule for the month is blocked like missing insurance or tax rules.
    if (gross.gt(0) && needRule(rules.levies, "eg_other_levies")) {
      const p = rules.levies.params;
      const deductionsSoFar = sum("deduction");
      for (const lv of p.levies) {
        const base = lv.base === "gross" ? gross : lv.base === "taxable_gross" ? taxableGross : lv.base === "insurable_wage" ? siBase : gross.minus(deductionsSoFar);
        const amount = roundBy(Prisma.Decimal.max(ZERO, base).mul(lv.rate).div(100), p.rounding);
        const c = component(lv.payer === "employee" ? "other_levy_employee" : "other_levy_employer");
        push(c, { kind: lv.payer === "employee" ? "deduction" : "employer_contribution", quantity: null, rate: D(lv.rate), base, amount, sourceType: "statutory", sourceId: lv.code, ruleSetId: rules.levies.id, ruleSetVersion: rules.levies.version, explanation: `${lv.name_ar}: ${fmt(base)} × ${lv.rate}%`, sortOrder: 820 });
      }
    }

    // ── Net ──
    const fullNet = gross.minus(sum("deduction"));
    if (fullNet.lt(0)) ex.push({ severity: "error", code: "negative_net", params: { amount: fmt(fullNet) } });

    // Settlement and correction runs keep only what differs from the month as posted.
    const baselineKeys: [string, string][] = [];
    let payLines = lines;
    if (signedRun) {
      const key = (l: { kind: string; payComponentId: string | null; code: string }) => `${l.kind}|${l.payComponentId ?? l.code}`;
      const posted = new Map<string, { amount: Prisma.Decimal; base: Prisma.Decimal | null; sample: (typeof myPosted)[number] }>();
      for (const l of myPosted) {
        if (l.kind === "recovery") continue;
        const k = key(l);
        const cur = posted.get(k);
        posted.set(k, { amount: (cur?.amount ?? ZERO).plus(l.amount), base: l.base === null && !cur?.base ? null : (cur?.base ?? ZERO).plus(l.base ?? ZERO), sample: cur?.sample ?? l });
      }
      for (const [k, v] of [...posted].sort(([a], [b]) => a.localeCompare(b))) baselineKeys.push([k, v.amount.toString()]);
      const next: Line[] = [];
      const fresh = new Map<string, Line[]>();
      for (const l of lines) fresh.set(key(l), [...(fresh.get(key(l)) ?? []), l]);
      for (const k of new Set([...fresh.keys(), ...posted.keys()])) {
        const mine = fresh.get(k) ?? [];
        const before = posted.get(k);
        if (!before || before.amount.isZero()) { next.push(...mine); continue; }
        const now = mine.reduce((a, l) => a.plus(l.amount), ZERO);
        const delta = now.minus(before.amount);
        if (delta.isZero()) continue;
        const nowBase = mine.some((l) => l.base) ? mine.reduce((a, l) => a.plus(l.base ?? ZERO), ZERO) : null;
        const s = mine[0] ?? null;
        next.push({
          payComponentId: s?.payComponentId ?? before.sample.payComponentId, code: s?.code ?? before.sample.code, nameAr: s?.nameAr ?? before.sample.nameAr, nameEn: s?.nameEn ?? before.sample.nameEn,
          kind: (s?.kind ?? before.sample.kind) as Line["kind"], quantity: null, rate: null,
          base: nowBase !== null || before.base !== null ? (nowBase ?? ZERO).minus(before.base ?? ZERO) : null,
          amount: delta, sourceType: "correction", sourceId: null, ruleSetId: s?.ruleSetId ?? null, ruleSetVersion: s?.ruleSetVersion ?? null,
          explanation: `${fmt(now)} − ${fmt(before.amount)}`, sortOrder: s?.sortOrder ?? 990,
        });
      }
      payLines = next;
      if (runType === "correction" && !payLines.length) ex.push({ severity: "warning", code: "no_difference" });
    }
    const netEntitlement = payLines.filter((l) => l.kind === "earning").reduce((a, l) => a.plus(l.amount), ZERO)
      .minus(payLines.filter((l) => l.kind === "deduction").reduce((a, l) => a.plus(l.amount), ZERO));

    // ── Recovery of what was paid ahead ──
    // On-account salary of the month is recovered in full (it is this month's wage); ordinary
    // advances by approved instalment plans and the preparer's entry, within the cap (HR-17).
    const onAcc = runType === "correction" ? ZERO : Prisma.Decimal.max(ZERO, (onAccountBy.get(empId) ?? ZERO).minus(myPosted.filter((l) => l.kind === "recovery" && l.sourceId === "on_account").reduce((a, l) => a.plus(l.amount), ZERO)));
    const manual = runType === "correction" ? ZERO : slip.advanceRecoveryRequested;
    const openAdvance = (advanceBy.get(empId) ?? ZERO).minus(otherRecoveryBy.get(empId) ?? ZERO);
    const capAmount = r2(Prisma.Decimal.max(ZERO, netEntitlement).mul(capPct).div(100));
    const myPlans = runType === "regular" ? plans.filter((p) => p.employeeId === empId) : [];
    let room = capAmount.minus(manual);
    let openLeft = openAdvance.minus(onAcc).minus(manual);
    const planDues: { id: string; amount: Prisma.Decimal; remaining: Prisma.Decimal }[] = [];
    for (const p of myPlans) {
      const remaining = Prisma.Decimal.max(ZERO, p.totalAmount.minus(planRecoveredBy.get(p.id) ?? ZERO));
      let due = Prisma.Decimal.min(p.instalmentAmount, remaining);
      if (due.lte(0)) continue;
      if (!p.allowAboveCap && due.gt(Prisma.Decimal.max(ZERO, room))) {
        ex.push({ severity: "warning", code: "instalment_reduced_to_cap", params: { due: fmt(due), cap: fmt(capAmount), pct: capPct } });
        due = Prisma.Decimal.max(ZERO, room);
      }
      if (due.gt(Prisma.Decimal.max(ZERO, openLeft))) {
        ex.push({ severity: "warning", code: "plan_limited_by_open_advance", params: { due: fmt(due), open: fmt(Prisma.Decimal.max(ZERO, openLeft)) } });
        due = Prisma.Decimal.max(ZERO, openLeft);
      }
      due = r2(due);
      if (!p.allowAboveCap) room = room.minus(due);
      openLeft = openLeft.minus(due);
      if (due.gt(0)) planDues.push({ id: p.id, amount: due, remaining });
    }
    if (manual.gt(capAmount)) {
      if (runType === "final_settlement") ex.push({ severity: "warning", code: "recovery_above_cap_settlement", params: { recovery: fmt(manual), cap: fmt(capAmount), pct: capPct } });
      else ex.push({ severity: "error", code: "recovery_exceeds_cap", params: { recovery: fmt(manual), cap: fmt(capAmount), pct: capPct } });
    }
    const planTotal = planDues.reduce((a, p) => a.plus(p.amount), ZERO);
    const recovery = onAcc.plus(manual).plus(planTotal);
    let applied = ZERO;
    const recoveryLines: Line[] = [];
    if (recovery.gt(0)) {
      if (recovery.gt(openAdvance)) ex.push({ severity: "error", code: "recovery_exceeds_open", params: { recovery: fmt(recovery), open: fmt(openAdvance) } });
      else if (recovery.gt(Prisma.Decimal.max(ZERO, netEntitlement))) ex.push({ severity: "error", code: "recovery_exceeds_net", params: { recovery: fmt(recovery), net: fmt(netEntitlement) } });
      else {
        applied = recovery;
        const c = component("advance_recovery");
        const rl = (amount: Prisma.Decimal, sourceId: string, explanation: string) => {
          if (amount.gt(0)) recoveryLines.push({ payComponentId: c?.id ?? null, code: c?.code ?? "", nameAr: c?.nameAr ?? "", nameEn: c?.nameEn ?? null, kind: "recovery", quantity: null, rate: null, base: null, amount: r2(amount), sourceType: "advance_recovery", sourceId, ruleSetId: null, ruleSetVersion: null, explanation, sortOrder: 950 });
        };
        rl(onAcc, "on_account", `on account ${fmt(onAcc)}`);
        rl(manual, "manual", `advance ${fmt(manual)}`);
        for (const p of planDues) rl(p.amount, p.id, `instalment ${fmt(p.amount)} of ${fmt(p.remaining)}`);
      }
    }
    if (runType === "final_settlement") {
      const left = openAdvance.minus(applied);
      if (left.gt(0)) ex.push({ severity: "warning", code: "advance_remaining", params: { amount: fmt(left) } });
      // Custody still held by a leaver: settled by a cash return or a payment, reviewed by finance — not deducted here.
      const custody = custodyBy.get(empId) ?? ZERO;
      if (custody.gt(0)) ex.push({ severity: "warning", code: "purchasing_custody_open", params: { amount: fmt(custody) } });
    }
    // A negative difference (the employee was overpaid) becomes an advance to recover.
    if (signedRun && netEntitlement.lt(0)) {
      const c = component("advance_recovery");
      recoveryLines.push({ payComponentId: c?.id ?? null, code: c?.code ?? "", nameAr: c?.nameAr ?? "", nameEn: c?.nameEn ?? null, kind: "recovery", quantity: null, rate: null, base: null, amount: netEntitlement, sourceType: "correction", sourceId: "overpayment", ruleSetId: null, ruleSetVersion: null, explanation: `overpaid ${fmt(netEntitlement.negated())} → employee advances`, sortOrder: 960 });
      applied = applied.plus(netEntitlement);
      ex.push({ severity: "warning", code: "overpayment_to_advances", params: { amount: fmt(netEntitlement.negated()) } });
    }

    const emp = empBy.get(empId);
    payslips.push(finish(slip.id, empId, slip.inclusion, [...payLines, ...recoveryLines], ex, myPackages.map((p) => p.id), adjustmentIds, applied, slip.advanceRecoveryRequested, {
      employment: { employee: emp, rows: employment.filter((e) => e.row).length, employedDays: employed.length, monthDays, suspendedDays: suspended },
      inputs: {
        packages: myPackages.map((p) => ({ id: p.id, number: p.number, from: p.effectiveFrom, to: p.effectiveTo, insurableWage: p.insurableWage?.toString() ?? null, exempt: p.insuranceExempt, lines: p.lines.map((l) => [l.payComponent.code, l.amount.toString()]) })),
        // What pays, not how it is filed: locking a day for this run (state, version) must not
        // change the hash the approver compares; a corrected value must.
        attendance: [...myDays.values()].map((a) => [a.date, a.status, a.state === "draft", a.overtimeDayMinutes, a.overtimeNightMinutes, a.overtimeRestDayMinutes, a.overtimeHolidayMinutes, a.leaveRequestId]).sort(),
        adjustments: myAdjustments.map((a) => [a.id, a.amount.toString()]),
        onAccount: onAcc.toString(), openAdvance: openAdvance.toString(), recoveryRequested: slip.advanceRecoveryRequested.toString(),
        plans: planDues.map((p) => [p.id, p.amount.toString()]), capPct, absentPolicy,
        settlement: thisSettlement && thisSettlement.employeeId === empId ? { items: thisSettlement.items.map((i) => [i.id, i.payComponentId, i.amount.toString()]), leave: leaveInputs, lastDay: thisSettlement.lastWorkingDay } : null,
        // Another run's settlement of this leaver (its own run's status would change the hash).
        settlementOfMonth: mySettlement && mySettlement.run.id !== run.id ? [mySettlement.run.id, mySettlement.run.status] : null,
        posted: baselineKeys, ytd: ytdInputs,
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
    engine: ENGINE_VERSION, period: run.period, runType, rules: rulesUsed,
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
