import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import type { ServiceActor } from "@/lib/core/actor";
import type { Permission } from "@/lib/permissions";

/**
 * Monthly statutory remittance summary (WS5, audit HR-13).
 *
 * Per employee, from the posted payroll runs of a month (regular, final settlement and
 * correction runs together, reversed ones left out): insurable wage, social insurance
 * (employee and employer shares), taxable base and salary tax withheld, other levies (the
 * Martyrs' Fund is configured as an employee levy), and — for holders of hr.private.view —
 * national ID, insurance number and tax registration from the private file.
 *
 * It is a working summary for the accountant who files with NOSI and the ETA. It is NOT any
 * official form (Form 2, the NOSI monthly statement, ETA Form 4…): which forms and
 * frequencies apply is unverified and must be confirmed on the portals.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const ZERO = D(0);
const READ: Permission[] = ["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"];

const ROLES = ["social_insurance_employee", "social_insurance_employer", "income_tax", "other_levy_employee", "other_levy_employer"] as const;
type Role = (typeof ROLES)[number];

export async function remittanceReport(period: string, actor: ServiceActor, opts: { export?: boolean } = {}) {
  if (!READ.some((p) => actorCan(actor, p))) assertPermission(actor, "hr.payroll.view");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ApiError(400, "الشهر لازم يكون YYYY-MM");
  const showPrivate = actorCan(actor, "hr.private.view");
  const runs = await prisma.payrollRun.findMany({ where: { period, status: "posted" }, select: { id: true, number: true, runType: true }, orderBy: { createdAt: "asc" } });
  const comps = await prisma.payComponent.findMany({ where: { systemRole: { in: [...ROLES] } }, select: { id: true, systemRole: true, liabilityAccount: { select: { code: true } } } });
  const compBy = new Map(comps.map((c) => [c.id, c]));
  const lines = await prisma.payrollRunLine.findMany({
    where: { runEmployee: { runId: { in: runs.map((r) => r.id) }, inclusion: "included" }, payComponentId: { in: comps.map((c) => c.id) } },
    select: { amount: true, base: true, payComponentId: true, runEmployee: { select: { employeeId: true, runId: true } } },
  });
  const empIds = [...new Set(lines.map((l) => l.runEmployee.employeeId))];
  const [employees, privates] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, code: true, name: true, nameAr: true } }),
    showPrivate ? prisma.employeePrivateInfo.findMany({ where: { employeeId: { in: empIds } }, select: { employeeId: true, nationalId: true, insuranceNumber: true, taxRegistrationNo: true } }) : [],
  ]);
  const priv = new Map(privates.map((p) => [p.employeeId, p]));
  type Acc = { insurableWage: Prisma.Decimal; taxableBase: Prisma.Decimal } & Record<Role, Prisma.Decimal>;
  const blank = (): Acc => ({ insurableWage: ZERO, taxableBase: ZERO, social_insurance_employee: ZERO, social_insurance_employer: ZERO, income_tax: ZERO, other_levy_employee: ZERO, other_levy_employer: ZERO });
  const per = new Map<string, Acc>();
  const liability = new Map<Role, Set<string>>();
  for (const l of lines) {
    const comp = compBy.get(l.payComponentId!)!;
    const role = comp.systemRole as Role;
    const a = per.get(l.runEmployee.employeeId) ?? blank();
    a[role] = a[role].plus(l.amount);
    if (role === "social_insurance_employee") a.insurableWage = a.insurableWage.plus(D(l.base));
    if (role === "income_tax") a.taxableBase = a.taxableBase.plus(D(l.base));
    per.set(l.runEmployee.employeeId, a);
    if (comp.liabilityAccount) liability.set(role, (liability.get(role) ?? new Set()).add(comp.liabilityAccount.code));
  }
  const rows = employees
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((e) => {
      const a = per.get(e.id) ?? blank();
      const p = priv.get(e.id);
      return {
        employee_code: e.code, employee_name: e.name,
        ...(showPrivate ? { national_id: p?.nationalId ?? "", insurance_number: p?.insuranceNumber ?? "", tax_registration_no: p?.taxRegistrationNo ?? "" } : {}),
        insurable_wage: a.insurableWage.toFixed(2), si_employee: a.social_insurance_employee.toFixed(2), si_employer: a.social_insurance_employer.toFixed(2),
        si_total: a.social_insurance_employee.plus(a.social_insurance_employer).toFixed(2),
        taxable_base: a.taxableBase.toFixed(2), income_tax: a.income_tax.toFixed(2),
        levy_employee: a.other_levy_employee.toFixed(2), levy_employer: a.other_levy_employer.toFixed(2),
      };
    });
  const total = (k: Role | "insurableWage" | "taxableBase") => [...per.values()].reduce((s, a) => s.plus(a[k]), ZERO).toFixed(2);
  const totals = {
    insurable_wage: total("insurableWage"), si_employee: total("social_insurance_employee"), si_employer: total("social_insurance_employer"),
    taxable_base: total("taxableBase"), income_tax: total("income_tax"), levy_employee: total("other_levy_employee"), levy_employer: total("other_levy_employer"),
  };
  if (opts.export) {
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "payroll_remittance_exported", entityType: "payroll_run", entityId: period, fieldChanged: period, newValue: `${rows.length} employees · ${runs.length} runs${showPrivate ? " · with identifiers" : ""}`, source: "user", deviceId: actor.deviceId }, prisma);
  }
  return {
    period, runs, rows, totals, identifiers: showPrivate,
    liabilityAccounts: Object.fromEntries([...liability].map(([k, v]) => [k, [...v]])),
    notice: "Working summary from posted payroll — not an official NOSI or ETA form; forms and deadlines must be confirmed by the accountant.",
  };
}
