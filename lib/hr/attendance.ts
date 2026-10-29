import { z } from "zod";
import { Prisma, type AttendanceDay } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate, isValidTimeOfDay } from "@/lib/dates";
import { optText, parse, text } from "@/lib/core/validation";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { cancelPendingApproval, requestApproval, type Decider } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";
import type { Permission } from "@/lib/permissions";
import {
  ZERO_MINUTES, cairoInstant, cairoLocal, datesBetween, measureDay, minutesFromLocalMidnight, scheduledMinutes, weekdayOf,
  type DayMinutes, type ScheduleDay,
} from "@/lib/hr/attendance-calc";

/**
 * Attendance register (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.4, §4.3).
 *
 * One AttendanceDay per employee per day, entered by hand (manual), compiled from device
 * punches (device), or written by an approved correction or leave. Lifecycle:
 *   draft → confirmed (hr.attendance.record) → locked (by a payroll run, phase 5)
 *   confirmed → draft: reopened by an approver, with a reason
 *   confirmed / locked → changed only by an approved AttendanceCorrection
 * Every change bumps the day's version and writes its revision row; the database refuses a
 * version without its revision, any delete, and any change to a locked day outside a correction.
 */

type Actorish = { id: string | null; name: string; role: string; deviceId?: string };

const VIEW: Permission[] = ["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"];
function assertCanView(actor: ServiceActor) {
  if (!VIEW.some((p) => actorCan(actor, p))) assertPermission(actor, "hr.attendance.record");
}

/** Statuses a person may enter. "leave" comes only from an approved leave request (phase 3). */
export const MANUAL_STATUSES = ["present", "absent", "absent_unpaid", "holiday", "rest_day", "suspended"] as const;
type ManualStatus = (typeof MANUAL_STATUSES)[number];

const day = z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD");
const time = z.string().refine(isValidTimeOfDay, "الوقت لازم يكون HH:MM").nullable().optional();
const statusField = z.enum(MANUAL_STATUSES, { errorMap: () => ({ message: "حالة الحضور غير معروفة" }) });

function assertNotFuture(date: string) {
  if (date > todayLocalISO()) throw new ApiError(400, "مينفعش تسجل حضور ليوم لسه مجاش");
}

// ---------------------------------------------------------------------------
// Context: employment, schedule and holiday of each employee on each date
// ---------------------------------------------------------------------------

type EmploymentSlice = { employeeId: string; effectiveFrom: string; effectiveTo: string | null; status: string; workScheduleId: string | null; createdAt: Date };
type ScheduleWithDays = Prisma.WorkScheduleGetPayload<{ include: { days: true } }>;

export async function loadContext(db: Pick<Tx, "employeeEmployment" | "workSchedule" | "publicHoliday">, from: string, to: string, employeeIds?: string[]) {
  const [employments, schedules, holidays] = await Promise.all([
    db.employeeEmployment.findMany({
      where: {
        ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
        effectiveFrom: { lte: to },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
      },
      select: { employeeId: true, effectiveFrom: true, effectiveTo: true, status: true, workScheduleId: true, createdAt: true },
    }),
    db.workSchedule.findMany({ include: { days: true } }),
    db.publicHoliday.findMany({ where: { date: { gte: from, lte: to } } }),
  ]);
  const byEmployee = new Map<string, EmploymentSlice[]>();
  for (const e of employments) {
    // A row superseded on its first day (an empty range) never applied.
    if (e.effectiveTo && e.effectiveTo < e.effectiveFrom) continue;
    byEmployee.set(e.employeeId, [...(byEmployee.get(e.employeeId) ?? []), e]);
  }
  const scheduleById = new Map(schedules.map((s) => [s.id, s]));
  const defaultSchedule = schedules.find((s) => s.isDefault && s.active) ?? null;
  const holidayByDate = new Map(holidays.map((h) => [h.date, h]));
  return {
    employmentOn(employeeId: string, date: string) {
      return (byEmployee.get(employeeId) ?? []).find((e) => e.effectiveFrom <= date && (!e.effectiveTo || e.effectiveTo >= date)) ?? null;
    },
    scheduleFor(employment: EmploymentSlice | null): ScheduleWithDays | null {
      return (employment?.workScheduleId ? scheduleById.get(employment.workScheduleId) : null) ?? defaultSchedule;
    },
    holiday: (date: string) => holidayByDate.get(date) ?? null,
    employeeIds: () => [...byEmployee.keys()],
  };
}
export type Ctx = Awaited<ReturnType<typeof loadContext>>;

export function scheduleDayOf(schedule: ScheduleWithDays | null, date: string): ScheduleDay | null {
  if (!schedule) return null;
  const d = schedule.days.find((x) => x.weekday === weekdayOf(date));
  return d ? { isWorkingDay: d.isWorkingDay, start: d.start, end: d.end, breakMinutes: d.breakMinutes, nightStart: d.nightStart, nightEnd: d.nightEnd } : null;
}

/** What the register proposes for a day nobody entered yet. */
function suggestedStatus(ctx: Ctx, employeeId: string, date: string): ManualStatus | null {
  const emp = ctx.employmentOn(employeeId, date);
  if (emp?.status === "suspended") return "suspended";
  if (ctx.holiday(date)) return "holiday";
  const sd = scheduleDayOf(ctx.scheduleFor(emp), date);
  if (sd && !sd.isWorkingDay) return "rest_day";
  return null;
}

// ---------------------------------------------------------------------------
// Writing a day: version + revision, always together
// ---------------------------------------------------------------------------

type DayValues = DayMinutes & {
  status: string;
  firstIn: Date | null;
  lastOut: Date | null;
  notes: string | null;
  source: string;
};

const SNAPSHOT_KEYS = [
  "status", "firstIn", "lastOut", "workedMinutes", "lateMinutes", "earlyLeaveMinutes", "overtimeDayMinutes", "overtimeNightMinutes",
  "overtimeRestDayMinutes", "overtimeHolidayMinutes", "source", "state", "notes", "leaveRequestId", "lockedRunId",
] as const;

export function snapshot(d: Partial<AttendanceDay>) {
  const out: Record<string, unknown> = {};
  for (const k of SNAPSHOT_KEYS) {
    const v = d[k as keyof AttendanceDay];
    out[k] = v instanceof Date ? v.toISOString() : v ?? null;
  }
  return out as Prisma.InputJsonObject;
}

function sameValues(a: AttendanceDay, b: DayValues) {
  const t = (x: Date | null) => (x ? x.getTime() : null);
  return a.status === b.status && t(a.firstIn) === t(b.firstIn) && t(a.lastOut) === t(b.lastOut) && (a.notes ?? null) === (b.notes ?? null)
    && a.workedMinutes === b.workedMinutes && a.lateMinutes === b.lateMinutes && a.earlyLeaveMinutes === b.earlyLeaveMinutes
    && a.overtimeDayMinutes === b.overtimeDayMinutes && a.overtimeNightMinutes === b.overtimeNightMinutes
    && a.overtimeRestDayMinutes === b.overtimeRestDayMinutes && a.overtimeHolidayMinutes === b.overtimeHolidayMinutes;
}

export async function writeDay(
  tx: Tx,
  existing: AttendanceDay | null,
  target: { employeeId: string; date: string },
  data: Partial<DayValues> & { state?: string; leaveRequestId?: string | null; lockedRunId?: string | null },
  rev: { action: string; reason?: string | null; correctionId?: string | null },
  actor: Actorish
) {
  if (!existing) {
    const created = await tx.attendanceDay.create({
      data: {
        employeeId: target.employeeId, date: target.date, status: data.status ?? "absent", source: data.source ?? "manual",
        firstIn: data.firstIn ?? null, lastOut: data.lastOut ?? null, notes: data.notes ?? null, state: data.state ?? "draft", leaveRequestId: data.leaveRequestId ?? null,
        ...pickMinutes(data), version: 1, enteredById: actor.id, enteredBy: actor.name,
      },
    });
    await tx.attendanceDayRevision.create({
      data: { attendanceDayId: created.id, revision: 1, action: rev.action, before: Prisma.JsonNull, after: snapshot(created), reason: rev.reason ?? null, correctionId: rev.correctionId ?? null, changedById: actor.id, changedBy: actor.name },
    });
    return created;
  }
  let updated: AttendanceDay;
  try {
    updated = await tx.attendanceDay.update({
      where: { id: existing.id, version: existing.version },
      // Locking, unlocking and confirming move only the state: the day keeps who entered it.
      data: { ...data, version: existing.version + 1, ...(Object.keys(data).every((k) => k === "state" || k === "lockedRunId") ? {} : { enteredById: actor.id, enteredBy: actor.name }) },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") throw new ApiError(409, "اليوم ده اتغيّر من واحد تاني، حدّث الشاشة");
    throw err;
  }
  await tx.attendanceDayRevision.create({
    data: {
      attendanceDayId: existing.id, revision: updated.version, action: rev.action, before: snapshot(existing), after: snapshot(updated),
      reason: rev.reason ?? null, correctionId: rev.correctionId ?? null, changedById: actor.id, changedBy: actor.name,
    },
  });
  return updated;
}

function pickMinutes(d: Partial<DayMinutes>): DayMinutes {
  return {
    workedMinutes: d.workedMinutes ?? 0, lateMinutes: d.lateMinutes ?? 0, earlyLeaveMinutes: d.earlyLeaveMinutes ?? 0,
    overtimeDayMinutes: d.overtimeDayMinutes ?? 0, overtimeNightMinutes: d.overtimeNightMinutes ?? 0,
    overtimeRestDayMinutes: d.overtimeRestDayMinutes ?? 0, overtimeHolidayMinutes: d.overtimeHolidayMinutes ?? 0,
  };
}

/**
 * Turns an entry (status + optional local times) into stored values, measured against the
 * employee's schedule and the holiday calendar of that date.
 */
function valuesFor(ctx: Ctx, employeeId: string, date: string, entry: { status: ManualStatus; first_in?: string | null; last_out?: string | null; notes?: string | null }, source: string): DayValues {
  const emp = ctx.employmentOn(employeeId, date);
  if (!emp || emp.status === "terminated") throw new ApiError(400, `الموظف مش على رأس العمل يوم ${date}`);
  const holiday = ctx.holiday(date);
  if (entry.status === "holiday" && !holiday) throw new ApiError(400, `يوم ${date} مش مسجل إجازة رسمية — سجّله في الإجازات الرسمية الأول`);
  if (entry.status !== "present" && (entry.first_in || entry.last_out)) throw new ApiError(400, "مواعيد الحضور والانصراف لليوم اللي فيه حضور بس");
  const notes = entry.notes ?? null;
  if (entry.status !== "present") return { status: entry.status, firstIn: null, lastOut: null, notes, source, ...ZERO_MINUTES };

  const sd = scheduleDayOf(ctx.scheduleFor(emp), date);
  if (!entry.first_in || !entry.last_out) {
    if ((entry.first_in && !entry.last_out) || (!entry.first_in && entry.last_out)) throw new ApiError(400, "اكتب ميعاد الحضور والانصراف الاتنين، أو سيبهم فاضيين");
    // Present without times: the scheduled day, nothing outside it. Not possible where every
    // minute is outside the schedule (rest day, holiday) — those need real times.
    if (holiday || !sd?.isWorkingDay) throw new ApiError(400, `يوم ${date} مش يوم شغل في جدول الموظف — اكتب ميعاد الحضور والانصراف`);
    return { status: "present", firstIn: null, lastOut: null, notes, source, ...ZERO_MINUTES, workedMinutes: scheduledMinutes(sd) };
  }
  const firstIn = cairoInstant(date, entry.first_in);
  // A last-out earlier than the first-in is the next morning (a night shift).
  const lastOut = cairoInstant(date, entry.last_out, entry.last_out <= entry.first_in ? 1 : 0);
  const minutes = measureDay({ inMin: minutesFromLocalMidnight(date, firstIn), outMin: minutesFromLocalMidnight(date, lastOut), schedule: sd, holiday: !!holiday });
  return { status: "present", firstIn, lastOut, notes, source, ...minutes };
}

// ---------------------------------------------------------------------------
// Register: read
// ---------------------------------------------------------------------------

/** GET /api/hr/attendance?date= — everyone on the payroll that day, with their entry or a suggestion. */
export async function attendanceRegister(date: string, actor: ServiceActor) {
  assertCanView(actor);
  if (!isValidISODate(date)) throw new ApiError(400, "التاريخ لازم يكون YYYY-MM-DD");
  const ctx = await loadContext(prisma, date, date);
  const ids = ctx.employeeIds().filter((id) => {
    const e = ctx.employmentOn(id, date);
    return e && e.status !== "terminated";
  });
  const [employees, days, pending] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, nameAr: true, jobTitle: true, department: { select: { name: true, nameAr: true } } }, orderBy: { code: "asc" } }),
    prisma.attendanceDay.findMany({ where: { date, employeeId: { in: ids } } }),
    prisma.attendanceCorrection.findMany({ where: { date, status: "pending" }, select: { employeeId: true, number: true } }),
  ]);
  const dayBy = new Map(days.map((d) => [d.employeeId, d]));
  const pendingBy = new Map(pending.map((p) => [p.employeeId, p.number]));
  const holiday = ctx.holiday(date);
  return {
    date,
    holiday: holiday ? { nameAr: holiday.nameAr, nameEn: holiday.nameEn, paid: holiday.paid } : null,
    rows: employees.map((e) => {
      const emp = ctx.employmentOn(e.id, date);
      const schedule = ctx.scheduleFor(emp);
      const sd = scheduleDayOf(schedule, date);
      const d = dayBy.get(e.id) ?? null;
      return {
        employee: e,
        schedule: schedule ? { code: schedule.code, nameAr: schedule.nameAr, nameEn: schedule.nameEn, day: sd } : null,
        suggested: d ? null : suggestedStatus(ctx, e.id, date),
        pendingCorrection: pendingBy.get(e.id) ?? null,
        day: d ? presentDay(d, date) : null,
      };
    }),
  };
}

function hm(at: Date | null, date: string) {
  if (!at) return null;
  const l = cairoLocal(at);
  const hh = String(Math.floor(l.minutes / 60)).padStart(2, "0");
  const mm = String(l.minutes % 60).padStart(2, "0");
  return l.date === date ? `${hh}:${mm}` : `${hh}:${mm}+1`;
}

function presentDay(d: AttendanceDay, date: string) {
  return {
    id: d.id, status: d.status, state: d.state, source: d.source, version: d.version, notes: d.notes,
    firstIn: hm(d.firstIn, date), lastOut: hm(d.lastOut, date),
    workedMinutes: d.workedMinutes, lateMinutes: d.lateMinutes, earlyLeaveMinutes: d.earlyLeaveMinutes,
    overtimeDayMinutes: d.overtimeDayMinutes, overtimeNightMinutes: d.overtimeNightMinutes,
    overtimeRestDayMinutes: d.overtimeRestDayMinutes, overtimeHolidayMinutes: d.overtimeHolidayMinutes,
    enteredBy: d.enteredBy, updatedAt: d.updatedAt,
  };
}

/** GET /api/hr/attendance/month?month=YYYY-MM — the grid: one status per employee per day, plus totals. */
export async function attendanceMonth(month: string, actor: ServiceActor) {
  assertCanView(actor);
  if (!/^\d{4}-\d{2}$/.test(month) || !isValidISODate(`${month}-01`)) throw new ApiError(400, "الشهر لازم يكون YYYY-MM");
  const from = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const dates = datesBetween(from, to);
  const ctx = await loadContext(prisma, from, to);
  const ids = ctx.employeeIds().filter((id) => dates.some((d) => { const e = ctx.employmentOn(id, d); return e && e.status !== "terminated"; }));
  const [employees, days] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, nameAr: true }, orderBy: { code: "asc" } }),
    prisma.attendanceDay.findMany({ where: { date: { gte: from, lte: to }, employeeId: { in: ids } } }),
  ]);
  const key = (e: string, d: string) => `${e}|${d}`;
  const byKey = new Map(days.map((d) => [key(d.employeeId, d.date), d]));
  return {
    month, from, to, dates,
    holidays: dates.filter((d) => ctx.holiday(d)),
    rows: employees.map((e) => {
      const cells = dates.map((date) => {
        const emp = ctx.employmentOn(e.id, date);
        if (!emp || emp.status === "terminated") return { date, employed: false as const };
        const d = byKey.get(key(e.id, date));
        return d
          ? { date, employed: true as const, status: d.status, state: d.state, overtime: d.overtimeDayMinutes + d.overtimeNightMinutes + d.overtimeRestDayMinutes + d.overtimeHolidayMinutes, late: d.lateMinutes }
          : { date, employed: true as const, status: null, state: null, suggested: suggestedStatus(ctx, e.id, date) };
      });
      const entered = days.filter((d) => d.employeeId === e.id);
      const count = (s: string) => entered.filter((d) => d.status === s).length;
      return {
        employee: e,
        cells,
        totals: {
          present: count("present"), absent: count("absent"), absentUnpaid: count("absent_unpaid"), leave: count("leave"),
          lateMinutes: entered.reduce((a, d) => a + d.lateMinutes, 0),
          overtimeMinutes: entered.reduce((a, d) => a + d.overtimeDayMinutes + d.overtimeNightMinutes + d.overtimeRestDayMinutes + d.overtimeHolidayMinutes, 0),
          missing: cells.filter((c) => c.employed && !("status" in c && c.status) && c.date <= todayLocalISO()).length,
          draft: entered.filter((d) => d.state === "draft").length,
        },
      };
    }),
  };
}

/** GET /api/hr/attendance/days/:id — the day and its full revision history. */
export async function attendanceDayDetail(id: string, actor: ServiceActor) {
  assertCanView(actor);
  const d = await prisma.attendanceDay.findUnique({
    where: { id },
    include: { employee: { select: { id: true, code: true, name: true, nameAr: true } }, revisions: { orderBy: { revision: "desc" }, include: { correction: { select: { number: true } } } } },
  });
  if (!d) throw new ApiError(404, "يوم الحضور مش موجود");
  return { day: { ...presentDay(d, d.date), date: d.date, employee: d.employee }, revisions: d.revisions };
}

// ---------------------------------------------------------------------------
// Register: write
// ---------------------------------------------------------------------------

const rowInput = z.object({
  employee_id: z.string().min(1),
  status: statusField,
  first_in: time,
  last_out: time,
  notes: optText("الملاحظات", 300).optional(),
  expected_version: z.number().int().positive().optional(),
});
const saveInput = z.object({ date: day, rows: z.array(rowInput).min(1, "مفيش صفوف تتسجل").max(500, "أقصى عدد 500 صف في المرة") });

/**
 * POST /api/hr/attendance/days — saves the register for one date as drafts. A confirmed or
 * locked day is not changed here: it needs a correction (or an approver reopens it).
 * An unchanged row is left alone (no new version).
 */
export async function saveAttendanceDays(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.attendance.record");
  const v = parse(saveInput, input);
  assertNotFuture(v.date);
  const ids = v.rows.map((r) => r.employee_id);
  if (new Set(ids).size !== ids.length) throw new ApiError(400, "الموظف متكرر في نفس اليوم");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `hr-attendance-date:${v.date}`);
    const ctx = await loadContext(tx, v.date, v.date, ids);
    const existing = new Map((await tx.attendanceDay.findMany({ where: { date: v.date, employeeId: { in: ids } } })).map((d) => [d.employeeId, d]));
    let created = 0, updated = 0, unchanged = 0;
    for (const r of v.rows) {
      const cur = existing.get(r.employee_id) ?? null;
      if (cur && cur.state !== "draft") throw new ApiError(409, `حضور يوم ${v.date} لموظف اتأكد — اطلب تصحيح`);
      if (cur && r.expected_version !== undefined && r.expected_version !== cur.version) throw new ApiError(409, "اليوم ده اتغيّر من واحد تاني، حدّث الشاشة");
      const values = valuesFor(ctx, r.employee_id, v.date, r, "manual");
      if (cur && sameValues(cur, values)) { unchanged++; continue; }
      await writeDay(tx, cur, { employeeId: r.employee_id, date: v.date }, values, { action: "entered" }, actor);
      if (cur) updated++; else created++;
    }
    if (created + updated > 0) {
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "attendance_saved", entityType: "attendance_day", entityId: v.date, fieldChanged: "register", newValue: `${created} new · ${updated} changed`, source: "user", deviceId: actor.deviceId }, tx);
    }
    return { date: v.date, created, updated, unchanged };
  });
}

const confirmInput = z.object({ date: day, employee_ids: z.array(z.string()).max(500).optional() });

/** POST /api/hr/attendance/confirm — draft days of a date (or of some employees) become confirmed. */
export async function confirmAttendance(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.attendance.record");
  const v = parse(confirmInput, input);
  assertNotFuture(v.date);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `hr-attendance-date:${v.date}`);
    const drafts = await tx.attendanceDay.findMany({ where: { date: v.date, state: "draft", ...(v.employee_ids ? { employeeId: { in: v.employee_ids } } : {}) } });
    for (const d of drafts) await writeDay(tx, d, d, { state: "confirmed" }, { action: "confirmed" }, actor);
    if (drafts.length) {
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "attendance_confirmed", entityType: "attendance_day", entityId: v.date, fieldChanged: "state", oldValue: "draft", newValue: `confirmed · ${drafts.length}`, source: "user", deviceId: actor.deviceId }, tx);
    }
    return { date: v.date, confirmed: drafts.length };
  });
}

/** POST /api/hr/attendance/days/:id/reopen — an approver sends a confirmed (not locked) day back to draft. */
export async function reopenAttendanceDay(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.attendance.approve");
  const v = parse(z.object({ reason: text("السبب", 500) }), input);
  return inTx(async (tx) => {
    const d = await tx.attendanceDay.findUnique({ where: { id } });
    if (!d) throw new ApiError(404, "يوم الحضور مش موجود");
    await advisoryXactLock(tx, `hr-attendance-date:${d.date}`);
    if (d.state === "locked") throw new ApiError(409, "اليوم ده مقفول في مسير مرتبات — التغيير بطلب تصحيح بس");
    if (d.state !== "confirmed") throw new ApiError(409, "اليوم ده لسه مسودة");
    if (d.leaveRequestId) throw new ApiError(409, "اليوم ده إجازة معتمدة — الغي الإجازة بدل التصحيح");
    const row = await writeDay(tx, d, d, { state: "draft" }, { action: "reopened", reason: v.reason }, actor);
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "attendance_reopened", entityType: "attendance_day", entityId: d.id, fieldChanged: "state", oldValue: "confirmed", newValue: "draft", reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return presentDay(row, row.date);
  });
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

const correctionInput = z.object({
  employee_id: z.string().min(1),
  date: day,
  status: statusField,
  first_in: time,
  last_out: time,
  notes: optText("الملاحظات", 300).optional(),
  reason: text("سبب التصحيح", 500),
});

/** POST /api/hr/attendance/corrections — asks to change a confirmed or locked day. */
export async function requestAttendanceCorrection(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.attendance.record");
  const v = parse(correctionInput, input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `hr-attendance-date:${v.date}`);
    const d = await tx.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: v.employee_id, date: v.date } } });
    if (!d) throw new ApiError(404, "مفيش حضور متسجل لليوم ده — سجّله من الكشف");
    if (d.state === "draft") throw new ApiError(409, "اليوم ده لسه مسودة — عدّله من الكشف مباشرة");
    if (d.leaveRequestId) throw new ApiError(409, "اليوم ده إجازة معتمدة — الغي الإجازة بدل التصحيح");
    // Validate the requested values now, so an approver only sees requests that can apply.
    const ctx = await loadContext(tx, v.date, v.date, [v.employee_id]);
    const values = valuesFor(ctx, v.employee_id, v.date, v, "correction");
    if (sameValues(d, values)) throw new ApiError(400, "القيم المطلوبة زي المسجلة");
    if (await tx.attendanceCorrection.findFirst({ where: { employeeId: v.employee_id, date: v.date, status: "pending" } })) {
      throw new ApiError(409, "فيه طلب تصحيح مفتوح لنفس اليوم");
    }
    const number = await nextDocumentNumber(tx, "hr.attendance_correction", todayLocalISO());
    const requested = { status: v.status, first_in: v.first_in ?? null, last_out: v.last_out ?? null, notes: v.notes ?? null };
    const c = await tx.attendanceCorrection.create({
      data: { number, employeeId: v.employee_id, date: v.date, requested, reason: v.reason, requestedById: actor.id, requestedBy: actor.name },
    });
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: v.employee_id }, select: { name: true, code: true } });
    const { request } = await requestApproval(tx, {
      type: "hr.attendance_correction",
      entityId: c.id,
      title: `${number} · ${employee.name} · ${v.date}`,
      summary: `${d.status} → ${v.status}${v.first_in ? ` (${v.first_in}–${v.last_out})` : ""}${d.state === "locked" ? " · مقفول في مسير" : ""}`,
      payload: { correctionId: c.id },
      reason: v.reason,
      requester: actor,
    });
    const row = await tx.attendanceCorrection.update({ where: { id: c.id }, data: { approvalRequestId: request.id } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "attendance_correction_requested", entityType: "attendance_correction", entityId: c.id, fieldChanged: v.date, oldValue: d.status, newValue: `${number} · ${v.status}`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

/**
 * The approval handler's effect (lib/core/approval-handlers.ts): applies an approved
 * correction to the day — locked or not — or records a rejection. Whoever requested the
 * correction may not decide it (also a database CHECK). A locked day's pay difference is
 * marked for the next payroll run (retroStatus = pending); the run that used it is not touched.
 */
export async function applyCorrectionDecision(tx: Tx, correctionId: string, approved: boolean, decider: Decider, comment?: string) {
  const c = await tx.attendanceCorrection.findUnique({ where: { id: correctionId } });
  if (!c) throw new ApiError(404, "طلب التصحيح مش موجود");
  if (c.status !== "pending") throw new ApiError(409, "طلب التصحيح ده اتقفل بالفعل");
  if (decider.id && decider.id === c.requestedById) throw new ApiError(403, "مينفعش تعتمد تصحيح انت اللي طالبه");
  await advisoryXactLock(tx, `hr-attendance-date:${c.date}`);
  const decided = { decidedById: decider.id, decidedBy: decider.name, decidedAt: new Date(), decisionComment: comment?.trim() || null, version: { increment: 1 } };
  if (!approved) {
    await tx.attendanceCorrection.update({ where: { id: c.id }, data: { status: "rejected", ...decided } });
    await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "attendance_correction_rejected", entityType: "attendance_correction", entityId: c.id, fieldChanged: c.date, reason: comment, source: "user", deviceId: decider.deviceId }, tx);
    return;
  }
  const d = await tx.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: c.employeeId, date: c.date } } });
  if (!d) throw new ApiError(409, "يوم الحضور مش موجود");
  const ctx = await loadContext(tx, c.date, c.date, [c.employeeId]);
  const req = c.requested as { status: ManualStatus; first_in: string | null; last_out: string | null; notes: string | null };
  const values = valuesFor(ctx, c.employeeId, c.date, req, "correction");
  // Marks this transaction as the correction path the database lets through a payroll lock.
  await tx.$queryRaw`SELECT set_config('united.attendance_correction', ${c.id}, true)`;
  const row = await writeDay(tx, d, d, values, { action: "corrected", reason: c.reason, correctionId: c.id }, decider);
  await tx.$queryRaw`SELECT set_config('united.attendance_correction', '', true)`;
  await tx.attendanceCorrection.update({
    where: { id: c.id },
    data: { status: "approved", appliedRevision: row.version, retroStatus: d.state === "locked" ? "pending" : "none", ...decided },
  });
  await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "attendance_correction_applied", entityType: "attendance_correction", entityId: c.id, fieldChanged: c.date, oldValue: d.status, newValue: `${row.status} · v${row.version}${d.state === "locked" ? " · retro" : ""}`, reason: comment, source: "user", deviceId: decider.deviceId }, tx);
}

/** POST /api/hr/attendance/corrections/:id/cancel — the requester (or an approver) withdraws it. */
export async function cancelAttendanceCorrection(id: string, actor: ServiceActor) {
  return inTx(async (tx) => {
    const c = await tx.attendanceCorrection.findUnique({ where: { id } });
    if (!c) throw new ApiError(404, "طلب التصحيح مش موجود");
    if (c.requestedById !== actor.id) assertPermission(actor, "hr.attendance.approve");
    if (c.status !== "pending") throw new ApiError(409, "طلب التصحيح ده اتقفل بالفعل");
    const row = await tx.attendanceCorrection.update({ where: { id, version: c.version }, data: { status: "cancelled", version: { increment: 1 } } });
    await cancelPendingApproval(tx, { type: "hr.attendance_correction", entityId: id, reason: "سحب طلب التصحيح", actor });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "attendance_correction_cancelled", entityType: "attendance_correction", entityId: id, fieldChanged: c.date, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

/** GET /api/hr/attendance/corrections */
export async function listCorrections(actor: ServiceActor, status?: string | null) {
  assertCanView(actor);
  const rows = await prisma.attendanceCorrection.findMany({
    where: status && ["pending", "approved", "rejected", "cancelled"].includes(status) ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { employee: { select: { id: true, code: true, name: true, nameAr: true } } },
  });
  const canDecide = actorCan(actor, "hr.attendance.approve");
  return rows.map((r) => ({ ...r, canDecide: canDecide && r.status === "pending" && r.requestedById !== actor.id, canCancel: r.status === "pending" && (r.requestedById === actor.id || canDecide) }));
}

// ---------------------------------------------------------------------------
// Device punches → draft days
// ---------------------------------------------------------------------------

const compileInput = z.object({ from: day, to: day });

/**
 * POST /api/hr/attendance/compile — turns mapped punches into draft device days. Writes only
 * where there is no day yet, or the day is still a device draft; a manual entry, a correction,
 * a confirmed or a locked day is never overwritten (they are reported as kept).
 */
export async function compileDeviceAttendance(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.attendance.record");
  const v = parse(compileInput, input);
  if (v.to < v.from) throw new ApiError(400, "تاريخ النهاية قبل البداية");
  if (v.to > todayLocalISO()) throw new ApiError(400, "مينفعش تسجل حضور ليوم لسه مجاش");
  if (datesBetween(v.from, v.to).length > 62) throw new ApiError(400, "أقصى فترة 62 يوم في المرة");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, "hr-attendance-compile");
    const start = cairoInstant(v.from, "00:00");
    const end = cairoInstant(v.to, "00:00", 1);
    const identities = await tx.attendanceIdentity.findMany();
    const who = new Map(identities.map((i) => [`${i.sourceId}|${i.externalUserId}`, i.employeeId]));
    const events = await tx.attendanceEvent.findMany({ where: { occurredAt: { gte: start, lt: end }, source: { active: true } }, orderBy: { occurredAt: "asc" } });
    const groups = new Map<string, Date[]>();
    let unmapped = 0;
    for (const e of events) {
      const employeeId = who.get(`${e.sourceId}|${e.externalUserId}`);
      if (!employeeId) { unmapped++; continue; }
      const k = `${employeeId}|${cairoLocal(e.occurredAt).date}`;
      groups.set(k, [...(groups.get(k) ?? []), e.occurredAt]);
    }
    const employeeIds = [...new Set([...groups.keys()].map((k) => k.split("|")[0]))];
    const ctx = await loadContext(tx, v.from, v.to, employeeIds);
    const existing = new Map((await tx.attendanceDay.findMany({ where: { date: { gte: v.from, lte: v.to }, employeeId: { in: employeeIds } } })).map((d) => [`${d.employeeId}|${d.date}`, d]));
    let created = 0, updated = 0, kept = 0, incomplete = 0, notEmployed = 0;
    for (const [k, punches] of groups) {
      const [employeeId, date] = k.split("|");
      if (punches.length < 2) { incomplete++; continue; }
      const emp = ctx.employmentOn(employeeId, date);
      if (!emp || emp.status === "terminated") { notEmployed++; continue; }
      const cur = existing.get(k) ?? null;
      if (cur && !(cur.source === "device" && cur.state === "draft")) { kept++; continue; }
      const firstIn = punches[0];
      const lastOut = punches[punches.length - 1];
      const sd = scheduleDayOf(ctx.scheduleFor(emp), date);
      const minutes = measureDay({ inMin: minutesFromLocalMidnight(date, firstIn), outMin: minutesFromLocalMidnight(date, lastOut), schedule: sd, holiday: !!ctx.holiday(date) });
      const values: DayValues = { status: "present", firstIn, lastOut, notes: cur?.notes ?? null, source: "device", ...minutes };
      if (cur && sameValues(cur, values)) { kept++; continue; }
      await writeDay(tx, cur, { employeeId, date }, values, { action: "compiled" }, actor);
      if (cur) updated++; else created++;
    }
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "attendance_compiled", entityType: "attendance_day", entityId: `${v.from}..${v.to}`, fieldChanged: "device", newValue: `${created} new · ${updated} changed · ${kept} kept · ${incomplete} incomplete · ${unmapped} unmapped`, source: "user", deviceId: actor.deviceId }, tx);
    return { from: v.from, to: v.to, events: events.length, created, updated, kept, incomplete, unmapped, notEmployed };
  });
}
