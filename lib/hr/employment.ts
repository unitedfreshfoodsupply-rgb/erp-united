import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidCalendarDate } from "@/lib/dates";
import { optText, parse, text } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";

/**
 * Employment history (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.2).
 *
 * Every change to where someone works, as what, under whom and in which status is a new
 * EmployeeEmployment row; the previous row is closed the day before. The database keeps
 * the rows append-only, non-overlapping and with one open row per employee. Employee's own
 * departmentId / jobTitle / active are the open row's values, written in the same
 * transaction, so every existing screen keeps reading the current state.
 *
 * Changes are effective today or earlier, never in the future: a future-dated row would be
 * "open" before it applies. A change dated the open row's first day supersedes that row
 * (it is closed as an empty range) — the way to correct a same-day mistake.
 */

export const EMPLOYMENT_EVENTS = ["hire", "transfer", "promotion", "status_change", "contract_change", "termination", "rehire"] as const;
export type EmploymentEvent = (typeof EMPLOYMENT_EVENTS)[number];
type Status = "active" | "suspended" | "terminated";
type Actorish = { id: string | null; name: string; role: string; deviceId?: string };

const day = z.string().refine(isValidCalendarDate, "التاريخ لازم يكون YYYY-MM-DD");
const optDay = day.nullable().optional();

/** YYYY-MM-DD minus one day. */
export function dayBefore(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

const changeInput = z.object({
  event: z.enum(["transfer", "promotion", "status_change", "contract_change", "termination", "rehire"], { errorMap: () => ({ message: "نوع التغيير غير معروف" }) }),
  effective_from: day,
  department_id: z.string().nullable().optional(),
  job_title: optText("الوظيفة", 100).optional(),
  manager_employee_id: z.string().nullable().optional(),
  employment_type: optText("نوع التعاقد", 40).optional(),
  contract_start: optDay,
  contract_end: optDay,
  probation_end: optDay,
  status: z.enum(["active", "suspended"]).optional(),
  work_schedule_id: z.string().nullable().optional(),
  termination_reason: optText("سبب انتهاء الخدمة", 500).optional(),
  reason: text("سبب التغيير", 500),
});

export type EmploymentPatch = {
  event: EmploymentEvent;
  effectiveFrom: string;
  departmentId?: string | null;
  jobTitle?: string | null;
  managerEmployeeId?: string | null;
  employmentType?: string | null;
  contractStart?: string | null;
  contractEnd?: string | null;
  probationEnd?: string | null;
  status?: "active" | "suspended";
  workScheduleId?: string | null;
  terminationReason?: string | null;
  reason: string;
};

/**
 * Closes the open row and opens the next one, inside the caller's transaction, and mirrors
 * the result onto Employee. Validates the transition; the database re-checks shape and overlap.
 */
export async function applyEmploymentChange(tx: Tx, employeeId: string, patch: EmploymentPatch, actor: Actorish) {
  await advisoryXactLock(tx, `hr-employment:${employeeId}`);
  const employee = await tx.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new ApiError(404, "الموظف مش موجود");
  const open = await tx.employeeEmployment.findFirst({ where: { employeeId, effectiveTo: null } });
  if (!open) throw new ApiError(409, "مفيش سجل تعيين مفتوح للموظف ده");

  const today = todayLocalISO();
  if (patch.effectiveFrom > today) throw new ApiError(400, "التغيير لازم يكون من النهارده أو قبل كده — مفيش تغيير بتاريخ مستقبلي");
  if (patch.effectiveFrom < open.effectiveFrom) throw new ApiError(400, `التغيير مينفعش يكون قبل بداية السجل الحالي (${open.effectiveFrom})`);

  const current = open.status as Status;
  if (current === "terminated" && patch.event !== "rehire") throw new ApiError(409, "الموظف خدمته انتهت — التغيير الوحيد المسموح إعادة تعيين");
  if (patch.event === "rehire" && current !== "terminated") throw new ApiError(409, "إعادة التعيين لموظف خدمته انتهت بس");
  if (patch.event === "termination" && !patch.terminationReason) throw new ApiError(400, "اكتب سبب انتهاء الخدمة");

  let status: Status = current;
  if (patch.event === "termination") status = "terminated";
  else if (patch.event === "rehire") status = "active";
  else if (patch.event === "status_change") {
    if (!patch.status) throw new ApiError(400, "اختار الحالة الجديدة");
    if (patch.status === current) throw new ApiError(400, "الحالة الجديدة زي الحالية");
    status = patch.status;
  }

  const departmentId = patch.departmentId !== undefined ? patch.departmentId : open.departmentId;
  if (departmentId && departmentId !== open.departmentId && !(await tx.department.findFirst({ where: { id: departmentId, active: true } }))) {
    throw new ApiError(400, "القسم مش موجود أو مقفول");
  }
  const managerEmployeeId = patch.managerEmployeeId !== undefined ? patch.managerEmployeeId : open.managerEmployeeId;
  if (managerEmployeeId) {
    if (managerEmployeeId === employeeId) throw new ApiError(400, "الموظف مينفعش يكون مدير نفسه");
    if (managerEmployeeId !== open.managerEmployeeId && !(await tx.employee.findFirst({ where: { id: managerEmployeeId, active: true } }))) {
      throw new ApiError(400, "المدير المباشر مش موجود أو موقوف");
    }
  }

  const workScheduleId = patch.workScheduleId !== undefined ? patch.workScheduleId : open.workScheduleId;
  if (workScheduleId && workScheduleId !== open.workScheduleId && !(await tx.workSchedule.findFirst({ where: { id: workScheduleId, active: true } }))) {
    throw new ApiError(400, "جدول الدوام مش موجود أو مقفول");
  }

  const keep = <T,>(v: T | undefined, prev: T) => (v !== undefined ? v : prev);
  // Same-day change supersedes the open row (closed as an empty range, effectiveFrom − 1).
  await tx.employeeEmployment.update({ where: { id: open.id }, data: { effectiveTo: dayBefore(patch.effectiveFrom) } });
  const row = await tx.employeeEmployment.create({
    data: {
      employeeId,
      effectiveFrom: patch.effectiveFrom,
      event: patch.event,
      departmentId,
      jobTitle: keep(patch.jobTitle, open.jobTitle),
      managerEmployeeId,
      employmentType: keep(patch.employmentType, open.employmentType),
      contractStart: keep(patch.contractStart, open.contractStart),
      contractEnd: keep(patch.contractEnd, open.contractEnd),
      probationEnd: keep(patch.probationEnd, open.probationEnd),
      workScheduleId,
      status,
      terminationReason: status === "terminated" ? patch.terminationReason ?? null : null,
      reason: patch.reason,
      createdById: actor.id,
      createdBy: actor.name,
    },
  });
  await tx.employee.update({
    where: { id: employeeId },
    data: { departmentId: row.departmentId, jobTitle: row.jobTitle, active: status === "active", version: { increment: 1 } },
  });
  await writeAudit(
    {
      userId: actor.id, userName: actor.name, role: actor.role, action: `employment_${patch.event}`, entityType: "employee", entityId: employeeId,
      fieldChanged: "employment", oldValue: `${open.status}`, newValue: `${patch.event} · ${patch.effectiveFrom} · ${status}`, reason: patch.reason,
      source: "user", deviceId: actor.deviceId,
    },
    tx
  );
  return row;
}

/** The first row for a new employee. */
export async function createHireRecord(
  tx: Tx,
  employee: { id: string; departmentId: string | null; jobTitle: string | null; hireDate: string | null; active: boolean },
  actor: Actorish
) {
  return tx.employeeEmployment.create({
    data: {
      employeeId: employee.id,
      effectiveFrom: employee.hireDate && employee.hireDate <= todayLocalISO() ? employee.hireDate : todayLocalISO(),
      event: "hire",
      departmentId: employee.departmentId,
      jobTitle: employee.jobTitle,
      status: employee.active ? "active" : "suspended",
      reason: "تعيين",
      createdById: actor.id,
      createdBy: actor.name,
    },
  });
}

/** POST /api/hr/employees/:id/employment */
export async function recordEmploymentChange(employeeId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.employees.manage");
  const v = parse(changeInput, input);
  return inTx((tx) =>
    applyEmploymentChange(
      tx,
      employeeId,
      {
        event: v.event,
        effectiveFrom: v.effective_from,
        departmentId: v.department_id,
        jobTitle: v.job_title,
        managerEmployeeId: v.manager_employee_id,
        employmentType: v.employment_type,
        contractStart: v.contract_start,
        contractEnd: v.contract_end,
        probationEnd: v.probation_end,
        status: v.status,
        workScheduleId: v.work_schedule_id,
        terminationReason: v.termination_reason,
        reason: v.reason,
      },
      actor
    )
  );
}

/**
 * GET /api/hr/employees/:id — the employee file as the caller may see it: identity,
 * current placement and employment history. Termination reasons are HR-only; money,
 * private data and salary come from their own endpoints with their own permissions.
 */
export async function employeeProfile(employeeId: string, actor: ServiceActor) {
  const e = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: {
      department: { select: { id: true, code: true, name: true, nameAr: true } },
      employments: {
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
        include: { department: { select: { name: true, nameAr: true } }, manager: { select: { id: true, code: true, name: true, nameAr: true } }, schedule: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
      },
    },
  });
  if (!e) throw new ApiError(404, "الموظف مش موجود");
  const hrManager = actorCan(actor, "hr.employees.manage");
  const open = e.employments.find((r) => r.effectiveTo === null) ?? null;
  return {
    employee: {
      id: e.id, code: e.code, name: e.name, nameAr: e.nameAr, jobTitle: e.jobTitle, active: e.active, hireDate: e.hireDate, department: e.department, version: e.version,
      ...(hrManager ? { phone: e.phone, userId: e.userId } : {}),
    },
    current: open ? { status: open.status, employmentType: open.employmentType, since: open.effectiveFrom, manager: open.manager, contractEnd: open.contractEnd, probationEnd: open.probationEnd, schedule: open.schedule } : null,
    // A row superseded on its first day (an empty range) is still a recorded event — e.g. a
    // termination reversed by a same-day re-hire — so it is returned, marked, never hidden.
    history: e.employments
      .map((r) => ({
        superseded: !!r.effectiveTo && r.effectiveTo < r.effectiveFrom,
        id: r.id, event: r.event, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, status: r.status, department: r.department?.name ?? null, departmentAr: r.department?.nameAr ?? null,
        jobTitle: r.jobTitle, manager: r.manager, employmentType: r.employmentType, contractStart: r.contractStart, contractEnd: r.contractEnd,
        probationEnd: r.probationEnd, schedule: r.schedule, reason: r.reason, createdBy: r.createdBy, createdAt: r.createdAt,
        ...(hrManager ? { terminationReason: r.terminationReason } : {}),
      })),
  };
}

/** Departments: set or clear the head (routing for approvals once enabled). */
export async function setDepartmentManager(tx: Tx, departmentId: string, managerEmployeeId: string | null) {
  if (managerEmployeeId && !(await tx.employee.findFirst({ where: { id: managerEmployeeId, active: true } }))) {
    throw new ApiError(400, "المدير مش موجود أو موقوف");
  }
  return tx.department.update({ where: { id: departmentId }, data: { managerEmployeeId } });
}
