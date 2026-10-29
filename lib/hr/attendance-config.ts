import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx } from "@/lib/tx";
import { isValidISODate, isValidTimeOfDay } from "@/lib/dates";
import { optText, parse, text } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import type { Permission } from "@/lib/permissions";
import type { Caller } from "@/lib/integrations/service";
import { scheduledMinutes } from "@/lib/hr/attendance-calc";

/**
 * What attendance is measured against, and where punches come from: work schedules, the
 * public-holiday calendar, attendance sources (devices, bound to an Integration key) and the
 * badge-number → employee map. Values are company inputs: none is seeded.
 * Read: whoever keeps the register; write: hr.employees.manage.
 */

const READ: Permission[] = ["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"];
function assertCanRead(actor: ServiceActor) {
  if (!READ.some((p) => actorCan(actor, p))) {
    assertPermission(actor, "hr.attendance.record");
  }
}

const hhmmOpt = z.string().refine(isValidTimeOfDay, "الوقت لازم يكون HH:MM").nullable().optional();

// ---------------------------------------------------------------------------
// Work schedules
// ---------------------------------------------------------------------------

const dayInput = z.object({
  weekday: z.number().int().min(0).max(6),
  is_working_day: z.boolean(),
  start: hhmmOpt,
  end: hhmmOpt,
  break_minutes: z.number().int().min(0).max(600).optional(),
  night_start: hhmmOpt,
  night_end: hhmmOpt,
});

const scheduleInput = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/, "الكود حروف إنجليزي وأرقام"),
  name_ar: text("الاسم", 100),
  name_en: optText("الاسم بالإنجليزي", 100).optional(),
  is_default: z.boolean().optional(),
  active: z.boolean().optional(),
  days: z.array(dayInput).length(7, "الجدول لازم يكون فيه الـ 7 أيام"),
  expected_version: z.number().int().positive().optional(),
});

function normaliseDays(days: z.infer<typeof dayInput>[]) {
  if (new Set(days.map((d) => d.weekday)).size !== 7) throw new ApiError(400, "الجدول لازم يكون فيه الـ 7 أيام");
  return days
    .sort((a, b) => a.weekday - b.weekday)
    .map((d) => {
      if (d.is_working_day && (!d.start || !d.end || d.start === d.end)) throw new ApiError(400, "يوم الشغل محتاج ميعاد بداية ونهاية مختلفين");
      if (!!d.night_start !== !!d.night_end) throw new ApiError(400, "فترة الليل محتاجة بداية ونهاية");
      return {
        weekday: d.weekday,
        isWorkingDay: d.is_working_day,
        start: d.is_working_day ? d.start! : null,
        end: d.is_working_day ? d.end! : null,
        breakMinutes: d.is_working_day ? d.break_minutes ?? 0 : 0,
        nightStart: d.night_start ?? null,
        nightEnd: d.night_end ?? null,
      };
    });
}

export async function listSchedules(actor: ServiceActor) {
  assertCanRead(actor);
  const rows = await prisma.workSchedule.findMany({ orderBy: [{ active: "desc" }, { code: "asc" }], include: { days: { orderBy: { weekday: "asc" } }, _count: { select: { employments: { where: { effectiveTo: null } } } } } });
  return rows.map(({ _count, ...s }) => ({ ...s, assigned: _count.employments }));
}

/** POST /api/hr/schedules (create) and PATCH /api/hr/schedules/:id. Weekly hours are computed from the days. */
export async function saveSchedule(id: string | null, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.employees.manage");
  const v = parse(scheduleInput, input);
  const days = normaliseDays(v.days);
  const weekly = new Prisma.Decimal(days.reduce((a, d) => a + scheduledMinutes(d), 0)).div(60).toDecimalPlaces(2);
  const active = v.active ?? true;
  const isDefault = (v.is_default ?? false) && active;
  try {
    return await inTx(async (tx) => {
      await advisoryXactLock(tx, "hr-work-schedules");
      if (isDefault) await tx.workSchedule.updateMany({ where: { isDefault: true, ...(id ? { id: { not: id } } : {}) }, data: { isDefault: false, version: { increment: 1 } } });
      let row;
      if (!id) {
        row = await tx.workSchedule.create({ data: { code: v.code, nameAr: v.name_ar, nameEn: v.name_en ?? null, weeklyHours: weekly, isDefault, active, createdBy: actor.name, days: { create: days } } });
      } else {
        const cur = await tx.workSchedule.findUnique({ where: { id } });
        if (!cur) throw new ApiError(404, "جدول الدوام مش موجود");
        if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "الجدول اتعدّل من واحد تاني، حدّث الشاشة");
        if (!active && (await tx.employeeEmployment.count({ where: { workScheduleId: id, effectiveTo: null } }))) throw new ApiError(409, "الجدول ده عليه موظفين — انقلهم لجدول تاني الأول");
        await tx.workScheduleDay.deleteMany({ where: { scheduleId: id } });
        row = await tx.workSchedule.update({ where: { id }, data: { code: v.code, nameAr: v.name_ar, nameEn: v.name_en ?? null, weeklyHours: weekly, isDefault, active, version: { increment: 1 }, days: { create: days } } });
      }
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: id ? "work_schedule_updated" : "work_schedule_created", entityType: "work_schedule", entityId: row.id, fieldChanged: row.code, newValue: `${row.nameAr} · ${weekly.toString()}h${isDefault ? " · default" : ""}${active ? "" : " · inactive"}`, source: "user", deviceId: actor.deviceId }, tx);
      return tx.workSchedule.findUniqueOrThrow({ where: { id: row.id }, include: { days: { orderBy: { weekday: "asc" } } } });
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ApiError(409, "الكود ده مستخدم لجدول تاني");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public holidays
// ---------------------------------------------------------------------------

const holidayInput = z.object({
  date: z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD"),
  name_ar: text("الاسم", 100),
  name_en: optText("الاسم بالإنجليزي", 100).optional(),
  paid: z.boolean().optional(),
  reference: optText("المرجع", 200).optional(),
});

export async function listHolidays(actor: ServiceActor, year?: string | null) {
  assertCanRead(actor);
  return prisma.publicHoliday.findMany({ where: year && /^\d{4}$/.test(year) ? { date: { startsWith: year } } : {}, orderBy: { date: "asc" } });
}

export async function createHoliday(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.employees.manage");
  const v = parse(holidayInput, input);
  try {
    return await inTx(async (tx) => {
      const row = await tx.publicHoliday.create({ data: { date: v.date, nameAr: v.name_ar, nameEn: v.name_en ?? null, paid: v.paid ?? true, reference: v.reference ?? null, createdById: actor.id, createdBy: actor.name } });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "public_holiday_created", entityType: "public_holiday", entityId: row.id, fieldChanged: row.date, newValue: `${row.nameAr}${row.paid ? "" : " · unpaid"}`, reason: row.reference ?? undefined, source: "user", deviceId: actor.deviceId }, tx);
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ApiError(409, "اليوم ده متسجل إجازة رسمية بالفعل");
    throw err;
  }
}

/** A holiday is removed only while no confirmed or locked day of that date relies on it. */
export async function deleteHoliday(id: string, actor: ServiceActor) {
  assertPermission(actor, "hr.employees.manage");
  return inTx(async (tx) => {
    const h = await tx.publicHoliday.findUnique({ where: { id } });
    if (!h) throw new ApiError(404, "الإجازة الرسمية مش موجودة");
    if (await tx.attendanceDay.count({ where: { date: h.date, state: { in: ["confirmed", "locked"] } } })) {
      throw new ApiError(409, "فيه حضور متأكد لليوم ده — مينفعش تشيل الإجازة الرسمية");
    }
    await tx.publicHoliday.delete({ where: { id } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "public_holiday_deleted", entityType: "public_holiday", entityId: id, fieldChanged: h.date, oldValue: h.nameAr, source: "user", deviceId: actor.deviceId }, tx);
    return { deleted: true };
  });
}

// ---------------------------------------------------------------------------
// Sources and identities
// ---------------------------------------------------------------------------

export async function listSources(actor: ServiceActor) {
  assertCanRead(actor);
  const rows = await prisma.attendanceSource.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      integration: { select: { code: true, keyPrefix: true, active: true } },
      identities: { include: { employee: { select: { id: true, code: true, name: true, nameAr: true } } }, orderBy: { externalUserId: "asc" } },
      batches: { orderBy: { receivedAt: "desc" }, take: 5 },
    },
  });
  // Keys a manager may bind to a new device: active, holding attendance.ingest, not bound yet.
  // Creating keys stays with integrations.manage; only their code and name are shown here.
  const keys = actorCan(actor, "hr.employees.manage")
    ? await prisma.integration.findMany({ where: { active: true, scopes: { has: "attendance.ingest" }, attendanceSource: null }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } })
    : [];
  return { sources: rows, keys };
}

const sourceInput = z.object({
  code: z.string().trim().regex(/^[a-z][a-z0-9_-]{1,30}$/, "الكود حروف إنجليزي صغيرة وأرقام"),
  name: text("الاسم", 100),
  kind: z.enum(["device", "import_file"], { errorMap: () => ({ message: "نوع المصدر غير معروف" }) }),
  integration_id: z.string().min(1, "اختار مفتاح التكامل"),
});

/** A device (or file import) source, authenticated by an integration key holding attendance.ingest. */
export async function createSource(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.employees.manage");
  const v = parse(sourceInput, input);
  const integration = await prisma.integration.findUnique({ where: { id: v.integration_id } });
  if (!integration || !integration.active) throw new ApiError(400, "مفتاح التكامل مش موجود أو اتلغى");
  if (!integration.scopes.includes("attendance.ingest")) throw new ApiError(400, "مفتاح التكامل ده مش مسموح له بإرسال الحضور (attendance.ingest)");
  try {
    return await inTx(async (tx) => {
      const row = await tx.attendanceSource.create({ data: { code: v.code, name: v.name, kind: v.kind, integrationId: integration.id, createdBy: actor.name } });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "attendance_source_created", entityType: "attendance_source", entityId: row.id, fieldChanged: row.code, newValue: `${row.kind} · ${integration.code}`, source: "user", deviceId: actor.deviceId }, tx);
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ApiError(409, "الكود أو مفتاح التكامل مستخدم لمصدر تاني");
    throw err;
  }
}

const identityInput = z.object({
  source_id: z.string().min(1),
  external_user_id: text("رقم الموظف على الجهاز", 64),
  employee_id: z.string().min(1),
});

export async function addIdentity(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.employees.manage");
  const v = parse(identityInput, input);
  const [source, employee] = await Promise.all([
    prisma.attendanceSource.findUnique({ where: { id: v.source_id } }),
    prisma.employee.findUnique({ where: { id: v.employee_id }, select: { id: true, code: true } }),
  ]);
  if (!source || source.kind === "manual") throw new ApiError(400, "مصدر الحضور مش موجود");
  if (!employee) throw new ApiError(404, "الموظف مش موجود");
  try {
    return await inTx(async (tx) => {
      const row = await tx.attendanceIdentity.create({ data: { sourceId: source.id, externalUserId: v.external_user_id, employeeId: employee.id, createdBy: actor.name } });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "attendance_identity_added", entityType: "attendance_source", entityId: source.id, fieldChanged: v.external_user_id, newValue: employee.code, source: "user", deviceId: actor.deviceId }, tx);
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ApiError(409, "الرقم ده متربط بموظف على نفس الجهاز");
    throw err;
  }
}

export async function removeIdentity(id: string, actor: ServiceActor) {
  assertPermission(actor, "hr.employees.manage");
  return inTx(async (tx) => {
    const row = await tx.attendanceIdentity.findUnique({ where: { id }, include: { employee: { select: { code: true } } } });
    if (!row) throw new ApiError(404, "الربط مش موجود");
    await tx.attendanceIdentity.delete({ where: { id } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "attendance_identity_removed", entityType: "attendance_source", entityId: row.sourceId, fieldChanged: row.externalUserId, oldValue: row.employee.code, source: "user", deviceId: actor.deviceId }, tx);
    return { deleted: true };
  });
}

// ---------------------------------------------------------------------------
// Ingestion (POST /api/integrations/attendance/events, x-api-key with attendance.ingest)
// ---------------------------------------------------------------------------

const eventsInput = z.object({
  events: z
    .array(
      z.object({
        external_event_id: z.string().trim().min(1).max(100),
        external_user_id: z.string().trim().min(1).max(64),
        occurred_at: z.string().datetime({ offset: true, message: "occurred_at لازم يكون ISO 8601 بالمنطقة الزمنية" }),
        direction: z.enum(["in", "out", "unknown"]).optional(),
        payload: z.record(z.unknown()).optional(),
      })
    )
    .min(1, "مفيش events")
    .max(1000, "أقصى عدد 1000 event في المرة"),
});

/**
 * Stores raw punches for the caller's source. Idempotent per (source, external_event_id):
 * a re-delivered event is counted as a duplicate, never stored twice. Nothing is compiled
 * here — people compile and confirm.
 */
export async function ingestAttendanceEvents(caller: Caller, input: unknown) {
  if (!caller.integrationId) throw new ApiError(403, "المفتاح ده مش مربوط بمصدر حضور");
  const source = await prisma.attendanceSource.findUnique({ where: { integrationId: caller.integrationId } });
  if (!source || !source.active) throw new ApiError(403, "المفتاح ده مش مربوط بمصدر حضور");
  const v = parse(eventsInput, input);
  const latest = Date.now() + 5 * 60 * 1000;
  const unique = new Map<string, (typeof v.events)[number]>();
  for (const e of v.events) {
    if (new Date(e.occurred_at).getTime() > latest) throw new ApiError(400, `الحدث ${e.external_event_id} وقته في المستقبل`);
    if (!unique.has(e.external_event_id)) unique.set(e.external_event_id, e);
  }
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `attendance-ingest:${source.id}`);
    const seen = new Set(
      (await tx.attendanceEvent.findMany({ where: { sourceId: source.id, externalEventId: { in: [...unique.keys()] } }, select: { externalEventId: true } })).map((r) => r.externalEventId)
    );
    const fresh = [...unique.values()].filter((e) => !seen.has(e.external_event_id));
    const mapped = new Set(
      (await tx.attendanceIdentity.findMany({ where: { sourceId: source.id, externalUserId: { in: [...new Set(fresh.map((e) => e.external_user_id))] } }, select: { externalUserId: true } })).map((r) => r.externalUserId)
    );
    const unmatched = fresh.filter((e) => !mapped.has(e.external_user_id)).length;
    const batch = await tx.attendanceImportBatch.create({
      data: { sourceId: source.id, eventCount: v.events.length, accepted: fresh.length, duplicates: v.events.length - fresh.length, unmatched },
    });
    if (fresh.length) {
      await tx.attendanceEvent.createMany({
        data: fresh.map((e) => ({
          sourceId: source.id, externalEventId: e.external_event_id, externalUserId: e.external_user_id, occurredAt: new Date(e.occurred_at),
          direction: e.direction ?? "unknown", payload: (e.payload ?? undefined) as Prisma.InputJsonValue | undefined, batchId: batch.id,
        })),
      });
    }
    return { batch_id: batch.id, received: v.events.length, accepted: fresh.length, duplicates: v.events.length - fresh.length, unmatched };
  });
}
