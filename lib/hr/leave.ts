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
import { cancelPendingApproval, requestApproval, type Decider } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";
import type { Permission } from "@/lib/permissions";
import { datesBetween } from "@/lib/hr/attendance-calc";
import { loadContext, scheduleDayOf, writeDay } from "@/lib/hr/attendance";

/**
 * Leave (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.5, §4.4).
 *
 * Types and policies are company / statutory inputs entered by HR — nothing is seeded, and a
 * policy is used only after someone other than its author verifies it. Balances are the sum
 * of an append-only ledger. A request is recorded (hr.leave.request), decided by someone else
 * (hr.leave.approve), and on approval writes its `taken` entry and turns the counted days of
 * the attendance register into confirmed leave days, in one transaction. Cancelling an
 * approved leave reverses both.
 *
 * Not built here (recorded as open in §12): half days, carry-over and expiry jobs, encashment,
 * and the retro payroll effect of cancelling a leave whose days a payroll run already locked
 * (refused until payroll runs exist).
 */

const READ: Permission[] = ["hr.leave.request", "hr.leave.approve", "hr.leave.configure"];
function assertCanRead(actor: ServiceActor) {
  if (!READ.some((p) => actorCan(actor, p))) assertPermission(actor, "hr.leave.request");
}
const day = z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD");
const dec = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

const typeInput = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/, "الكود حروف إنجليزي وأرقام"),
  name_ar: text("الاسم", 100),
  name_en: optText("الاسم بالإنجليزي", 100).optional(),
  pay_mode: z.enum(["paid", "unpaid", "partially_paid"], { errorMap: () => ({ message: "طريقة الدفع غير معروفة" }) }),
  paid_percent: z.number().gt(0).lt(100).nullable().optional(),
  counts_days: z.enum(["working", "calendar"], { errorMap: () => ({ message: "طريقة عد الأيام غير معروفة" }) }),
  requires_attachment: z.boolean().optional(),
  allow_negative_balance: z.boolean().optional(),
  active: z.boolean().optional(),
  expected_version: z.number().int().positive().optional(),
});

export async function listLeaveTypes(actor: ServiceActor) {
  assertCanRead(actor);
  return prisma.leaveType.findMany({ orderBy: [{ active: "desc" }, { code: "asc" }] });
}

/** Once a type has requests or ledger entries, how it pays and counts can no longer change. */
export async function saveLeaveType(id: string | null, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.leave.configure");
  const v = parse(typeInput, input);
  if (v.pay_mode === "partially_paid" && v.paid_percent == null) throw new ApiError(400, "اكتب نسبة الأجر المدفوعة");
  const data = {
    code: v.code, nameAr: v.name_ar, nameEn: v.name_en ?? null, payMode: v.pay_mode,
    paidPercent: v.pay_mode === "partially_paid" ? dec(v.paid_percent!) : null, countsDays: v.counts_days,
    requiresAttachment: v.requires_attachment ?? false, allowNegativeBalance: v.allow_negative_balance ?? false, active: v.active ?? true,
  };
  try {
    return await inTx(async (tx) => {
      let row;
      if (!id) {
        row = await tx.leaveType.create({ data: { ...data, createdBy: actor.name } });
      } else {
        const cur = await tx.leaveType.findUnique({ where: { id } });
        if (!cur) throw new ApiError(404, "نوع الإجازة مش موجود");
        if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "نوع الإجازة اتعدّل من واحد تاني، حدّث الشاشة");
        const used = (await tx.leaveRequest.count({ where: { leaveTypeId: id } })) + (await tx.leaveLedgerEntry.count({ where: { leaveTypeId: id } }));
        const ruleChanged = cur.payMode !== data.payMode || cur.countsDays !== data.countsDays || String(cur.paidPercent ?? "") !== String(data.paidPercent ?? "");
        if (used && ruleChanged) throw new ApiError(409, "النوع ده عليه طلبات أو أرصدة — طريقة الدفع والعد مينفعش تتغير؛ اعمل نوع جديد");
        row = await tx.leaveType.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      }
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: id ? "leave_type_updated" : "leave_type_created", entityType: "leave_type", entityId: row.id, fieldChanged: row.code, newValue: `${row.payMode}${row.paidPercent ? ` ${row.paidPercent}%` : ""} · ${row.countsDays}${row.active ? "" : " · inactive"}`, source: "user", deviceId: actor.deviceId }, tx);
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ApiError(409, "الكود ده مستخدم لنوع تاني");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

const tierInput = z.object({
  min_service_months: z.number().int().min(0).max(1200),
  min_age: z.number().int().min(14).max(100).nullable().optional(),
  days_per_year: z.number().min(0).max(366),
});
const policyInput = z.object({
  leave_type_id: z.string().min(1),
  effective_from: day,
  effective_to: day.nullable().optional(),
  accrual_method: z.enum(["none", "annual_upfront", "monthly"], { errorMap: () => ({ message: "طريقة الاستحقاق غير معروفة" }) }),
  carry_over_max_days: z.number().min(0).max(366).nullable().optional(),
  carry_over_expiry_months: z.number().int().min(0).max(120).nullable().optional(),
  source_reference: text("المرجع", 300),
  tiers: z.array(tierInput).min(1, "اكتب شريحة واحدة على الأقل").max(20),
});

export async function listPolicies(actor: ServiceActor) {
  assertCanRead(actor);
  return prisma.leavePolicy.findMany({
    orderBy: [{ createdAt: "desc" }],
    include: { leaveType: { select: { id: true, code: true, nameAr: true, nameEn: true } }, tiers: { orderBy: [{ minServiceMonths: "asc" }, { minAge: "asc" }] } },
  });
}

function policyData(v: z.infer<typeof policyInput>) {
  if (v.effective_to && v.effective_to < v.effective_from) throw new ApiError(400, "تاريخ النهاية قبل البداية");
  const keys = new Set(v.tiers.map((t) => `${t.min_service_months}|${t.min_age ?? ""}`));
  if (keys.size !== v.tiers.length) throw new ApiError(400, "فيه شريحتين بنفس الشروط");
  return {
    leaveTypeId: v.leave_type_id, effectiveFrom: v.effective_from, effectiveTo: v.effective_to ?? null, accrualMethod: v.accrual_method,
    carryOverMaxDays: v.carry_over_max_days == null ? null : dec(v.carry_over_max_days), carryOverExpiryMonths: v.carry_over_expiry_months ?? null,
    sourceReference: v.source_reference,
  };
}
const tierRows = (v: z.infer<typeof policyInput>) => v.tiers.map((t) => ({ minServiceMonths: t.min_service_months, minAge: t.min_age ?? null, daysPerYear: dec(t.days_per_year) }));

/** A draft policy (POST) or a change to a draft (PATCH). Verified policies are never edited. */
export async function savePolicy(id: string | null, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.leave.configure");
  const v = parse(policyInput, input);
  const data = policyData(v);
  return inTx(async (tx) => {
    if (!(await tx.leaveType.findUnique({ where: { id: v.leave_type_id } }))) throw new ApiError(400, "نوع الإجازة مش موجود");
    let row;
    if (!id) {
      row = await tx.leavePolicy.create({ data: { ...data, createdById: actor.id, createdBy: actor.name, tiers: { create: tierRows(v) } } });
    } else {
      const cur = await tx.leavePolicy.findUnique({ where: { id } });
      if (!cur) throw new ApiError(404, "سياسة الإجازة مش موجودة");
      if (cur.status !== "draft") throw new ApiError(409, "السياسة اتراجعت — مينفعش تتعدل؛ أوقفها واعمل واحدة جديدة");
      await tx.leavePolicyTier.deleteMany({ where: { policyId: id } });
      // The editor becomes the author: the four-eyes rule applies to the values as they stand.
      row = await tx.leavePolicy.update({ where: { id }, data: { ...data, createdById: actor.id, createdBy: actor.name, version: { increment: 1 }, tiers: { create: tierRows(v) } } });
    }
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: id ? "leave_policy_updated" : "leave_policy_created", entityType: "leave_policy", entityId: row.id, fieldChanged: v.leave_type_id, newValue: `${v.accrual_method} · ${v.effective_from} · ${v.tiers.map((t) => `${t.min_service_months}m${t.min_age ? `/${t.min_age}y` : ""}=${t.days_per_year}`).join(", ")}`, reason: v.source_reference, source: "user", deviceId: actor.deviceId }, tx);
    return tx.leavePolicy.findUniqueOrThrow({ where: { id: row.id }, include: { tiers: true } });
  });
}

/** Someone other than the author checks the values against the source and makes the policy usable. */
export async function verifyPolicy(id: string, actor: ServiceActor) {
  assertPermission(actor, "hr.leave.configure");
  try {
    return await inTx(async (tx) => {
      const p = await tx.leavePolicy.findUnique({ where: { id }, include: { tiers: true } });
      if (!p) throw new ApiError(404, "سياسة الإجازة مش موجودة");
      if (p.status !== "draft") throw new ApiError(409, "السياسة دي مش مسودة");
      if (p.createdById && p.createdById === actor.id) throw new ApiError(403, "المراجعة لازم تكون من شخص غير اللي كتب السياسة");
      const row = await tx.leavePolicy.update({ where: { id, version: p.version }, data: { status: "verified", verifiedById: actor.id, verifiedBy: actor.name, verifiedAt: new Date(), version: { increment: 1 } } });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "leave_policy_verified", entityType: "leave_policy", entityId: id, fieldChanged: "status", oldValue: "draft", newValue: "verified", reason: p.sourceReference, source: "user", deviceId: actor.deviceId }, tx);
      return row;
    });
  } catch (err) {
    if (err instanceof Error && /overlaps another verified policy/.test(err.message)) throw new ApiError(409, "فيه سياسة معتمدة تانية لنفس النوع في نفس الفترة — أوقفها الأول");
    throw err;
  }
}

/** Ends a verified policy: from `effective_to` on (default yesterday) it no longer applies. */
export async function retirePolicy(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.leave.configure");
  const v = parse(z.object({ effective_to: day.optional(), reason: text("السبب", 300) }), input);
  return inTx(async (tx) => {
    const p = await tx.leavePolicy.findUnique({ where: { id } });
    if (!p) throw new ApiError(404, "سياسة الإجازة مش موجودة");
    if (p.status === "draft") {
      await tx.leavePolicy.delete({ where: { id } });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "leave_policy_discarded", entityType: "leave_policy", entityId: id, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
      return { deleted: true };
    }
    if (p.status !== "verified") throw new ApiError(409, "السياسة دي متوقفة بالفعل");
    const to = v.effective_to ?? p.effectiveTo ?? todayLocalISO();
    if (to < p.effectiveFrom) throw new ApiError(400, "تاريخ النهاية قبل البداية");
    if (p.effectiveTo && to !== p.effectiveTo) throw new ApiError(409, "السياسة ليها تاريخ نهاية بالفعل");
    const row = await tx.leavePolicy.update({ where: { id }, data: { status: "retired", effectiveTo: to, version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "leave_policy_retired", entityType: "leave_policy", entityId: id, fieldChanged: "status", oldValue: "verified", newValue: `retired · ${to}`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Entitlements: allocation runs and manual adjustments
// ---------------------------------------------------------------------------

function monthsBetween(from: string, to: string) {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
}

/**
 * POST /api/hr/leave/allocate — gives each eligible employee the days of the highest tier
 * they qualify for at the start of the period (service from their first employment row; age
 * from the private file when a tier needs it). Idempotent per (policy, employee, period).
 * Employees who join during the period are not prorated by the system — they are reported,
 * and HR adds an adjustment under the agreed rule (proration is an open decision, §7 S2).
 */
export async function allocateLeave(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.leave.configure");
  const v = parse(z.object({ policy_id: z.string().min(1), period: z.string().regex(/^\d{4}(-\d{2})?$/, "الفترة لازم تكون YYYY أو YYYY-MM") }), input);
  return inTx(async (tx) => {
    const p = await tx.leavePolicy.findUnique({ where: { id: v.policy_id }, include: { tiers: true, leaveType: true } });
    if (!p || p.status !== "verified") throw new ApiError(409, "السياسة لازم تكون معتمدة الأول");
    const monthly = p.accrualMethod === "monthly";
    if (p.accrualMethod === "none") throw new ApiError(400, "السياسة دي من غير استحقاق تلقائي — استخدم التسوية اليدوية");
    if (monthly !== (v.period.length === 7)) throw new ApiError(400, monthly ? "السياسة شهرية — الفترة YYYY-MM" : "السياسة سنوية — الفترة YYYY");
    const start = monthly ? `${v.period}-01` : `${v.period}-01-01`;
    if (start > todayLocalISO()) throw new ApiError(400, "مينفعش توزع رصيد لفترة لسه مبدأتش");
    if (start < p.effectiveFrom || (p.effectiveTo && start > p.effectiveTo)) throw new ApiError(400, "بداية الفترة خارج مدة السياسة");
    await advisoryXactLock(tx, `hr-leave-allocate:${p.id}`);

    const rows = await tx.employeeEmployment.findMany({ select: { employeeId: true, effectiveFrom: true, effectiveTo: true, status: true } });
    const live = rows.filter((r) => !(r.effectiveTo && r.effectiveTo < r.effectiveFrom));
    const firstDay = new Map<string, string>();
    for (const r of live) if (!firstDay.has(r.employeeId) || r.effectiveFrom < firstDay.get(r.employeeId)!) firstDay.set(r.employeeId, r.effectiveFrom);
    const onStart = new Map(live.filter((r) => r.effectiveFrom <= start && (!r.effectiveTo || r.effectiveTo >= start)).map((r) => [r.employeeId, r]));
    const births = new Map((await tx.employeePrivateInfo.findMany({ select: { employeeId: true, birthDate: true } })).map((b) => [b.employeeId, b.birthDate]));

    let created = 0, already = 0, noTier = 0, missingBirthDate = 0;
    const joinedDuring: string[] = [];
    const data: Prisma.LeaveLedgerEntryCreateManyInput[] = [];
    for (const [employeeId, first] of firstDay) {
      const emp = onStart.get(employeeId);
      if (!emp || emp.status === "terminated") {
        if (first > start) joinedDuring.push(employeeId);
        continue;
      }
      const service = monthsBetween(first, start);
      const birth = births.get(employeeId) ?? null;
      const age = birth ? Math.floor(monthsBetween(birth, start) / 12) : null;
      let best: Prisma.Decimal | null = null;
      let needsBirth = false;
      for (const t of p.tiers) {
        if (service < t.minServiceMonths) continue;
        if (t.minAge != null) { if (age == null) { needsBirth = true; continue; } if (age < t.minAge) continue; }
        if (!best || t.daysPerYear.gt(best)) best = t.daysPerYear;
      }
      if (needsBirth) missingBirthDate++;
      if (!best || best.isZero()) { noTier++; continue; }
      const days = monthly ? best.div(12).toDecimalPlaces(2) : best;
      if (days.lte(0)) { noTier++; continue; }
      data.push({ employeeId, leaveTypeId: p.leaveTypeId, date: start, kind: monthly ? "accrual" : "allocation", days, sourceType: "leave_policy", sourceId: `${p.id}:${employeeId}:${v.period}`, note: `${p.leaveType.code} ${v.period}`, createdById: actor.id, createdBy: actor.name });
    }
    if (data.length) {
      const res = await tx.leaveLedgerEntry.createMany({ data, skipDuplicates: true });
      created = res.count;
      already = data.length - res.count;
    }
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "leave_allocated", entityType: "leave_policy", entityId: p.id, fieldChanged: v.period, newValue: `${created} new · ${already} already · ${joinedDuring.length} joined during · ${noTier} no tier · ${missingBirthDate} missing birth date`, source: "user", deviceId: actor.deviceId }, tx);
    return { period: v.period, created, already, noTier, missingBirthDate, joinedDuring: joinedDuring.length };
  });
}

const adjustInput = z.object({
  employee_id: z.string().min(1),
  leave_type_id: z.string().min(1),
  days: z.number().min(-366).max(366).refine((n) => n !== 0, "عدد الأيام لازم يكون غير صفر"),
  date: day.optional(),
  reason: text("السبب", 300),
});

/** An opening balance or a correction to an entitlement, with its reason. */
export async function adjustLeaveBalance(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.leave.configure");
  const v = parse(adjustInput, input);
  return inTx(async (tx) => {
    const [emp, type] = await Promise.all([tx.employee.findUnique({ where: { id: v.employee_id } }), tx.leaveType.findUnique({ where: { id: v.leave_type_id } })]);
    if (!emp) throw new ApiError(404, "الموظف مش موجود");
    if (!type) throw new ApiError(400, "نوع الإجازة مش موجود");
    const id = `adj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const row = await tx.leaveLedgerEntry.create({ data: { employeeId: emp.id, leaveTypeId: type.id, date: v.date ?? todayLocalISO(), kind: "adjustment", days: dec(v.days), sourceType: "manual_adjustment", sourceId: id, note: v.reason, createdById: actor.id, createdBy: actor.name } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "leave_balance_adjusted", entityType: "leave_type", entityId: type.id, fieldChanged: emp.code, newValue: `${v.days > 0 ? "+" : ""}${v.days}`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

async function balanceOf(db: Pick<Tx, "leaveLedgerEntry" | "leaveRequest">, employeeId: string, leaveTypeId: string, excludeRequestId?: string) {
  const [ledger, pending] = await Promise.all([
    db.leaveLedgerEntry.aggregate({ where: { employeeId, leaveTypeId }, _sum: { days: true } }),
    db.leaveRequest.aggregate({ where: { employeeId, leaveTypeId, status: "pending", ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}) }, _sum: { days: true } }),
  ]);
  const balance = ledger._sum.days ?? dec(0);
  const pend = pending._sum.days ?? dec(0);
  return { balance, pending: pend, available: balance.minus(pend) };
}

/** GET /api/hr/leave/balances?employee_id= — per type: entitled, taken, pending, available. */
export async function leaveBalances(employeeId: string | null, actor: ServiceActor) {
  assertCanRead(actor);
  const where = employeeId ? { employeeId } : {};
  const [entries, pending, types, employees] = await Promise.all([
    prisma.leaveLedgerEntry.groupBy({ by: ["employeeId", "leaveTypeId", "kind"], where, _sum: { days: true } }),
    prisma.leaveRequest.groupBy({ by: ["employeeId", "leaveTypeId"], where: { ...where, status: "pending" }, _sum: { days: true } }),
    prisma.leaveType.findMany({ select: { id: true, code: true, nameAr: true, nameEn: true, allowNegativeBalance: true } }),
    prisma.employee.findMany({ where: employeeId ? { id: employeeId } : { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
  ]);
  const key = (e: string, t: string) => `${e}|${t}`;
  const out = new Map<string, { employeeId: string; leaveTypeId: string; entitled: Prisma.Decimal; taken: Prisma.Decimal; other: Prisma.Decimal; pending: Prisma.Decimal }>();
  const slot = (e: string, t: string) => {
    const k = key(e, t);
    if (!out.has(k)) out.set(k, { employeeId: e, leaveTypeId: t, entitled: dec(0), taken: dec(0), other: dec(0), pending: dec(0) });
    return out.get(k)!;
  };
  for (const g of entries) {
    const s = slot(g.employeeId, g.leaveTypeId);
    const d = g._sum.days ?? dec(0);
    if (["allocation", "accrual", "carry_over"].includes(g.kind)) s.entitled = s.entitled.plus(d);
    else if (g.kind === "taken" || g.kind === "taken_reversal") s.taken = s.taken.minus(d);
    else s.other = s.other.plus(d);
  }
  for (const g of pending) slot(g.employeeId, g.leaveTypeId).pending = g._sum.days ?? dec(0);
  const typeBy = new Map(types.map((t) => [t.id, t]));
  return employees.map((e) => ({
    employee: e,
    types: [...out.values()].filter((s) => s.employeeId === e.id).map((s) => {
      const balance = s.entitled.minus(s.taken).plus(s.other);
      return { leaveType: typeBy.get(s.leaveTypeId), entitled: s.entitled, taken: s.taken, adjustments: s.other, pending: s.pending, balance, available: balance.minus(s.pending) };
    }),
  }));
}

/** GET /api/hr/leave/ledger?employee_id= — every entry behind a balance. */
export async function leaveLedger(employeeId: string, actor: ServiceActor) {
  assertCanRead(actor);
  return prisma.leaveLedgerEntry.findMany({ where: { employeeId }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], include: { leaveType: { select: { code: true, nameAr: true, nameEn: true } } }, take: 300 });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Counts the days a leave takes: working days of the employee's schedule (holidays excluded) or calendar days. */
async function countLeaveDays(db: Tx | typeof prisma, employeeId: string, type: { countsDays: string }, start: string, end: string) {
  const ctx = await loadContext(db, start, end, [employeeId]);
  const counted: string[] = [];
  for (const d of datesBetween(start, end)) {
    const emp = ctx.employmentOn(employeeId, d);
    if (!emp || emp.status === "terminated") throw new ApiError(400, `الموظف مش على رأس العمل يوم ${d}`);
    if (type.countsDays === "calendar") { counted.push(d); continue; }
    const schedule = ctx.scheduleFor(emp);
    if (!schedule) throw new ApiError(400, "الموظف مالوش جدول دوام — حدد جدول، أو استخدم نوع إجازة بالأيام التقويمية");
    if (ctx.holiday(d)) continue;
    if (scheduleDayOf(schedule, d)?.isWorkingDay) counted.push(d);
  }
  return counted;
}

const requestInput = z.object({
  employee_id: z.string().min(1),
  leave_type_id: z.string().min(1),
  start_date: day,
  end_date: day,
  reason: optText("السبب", 500).optional(),
});

export async function previewLeave(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.leave.request");
  const v = parse(requestInput, input);
  const type = await prisma.leaveType.findUnique({ where: { id: v.leave_type_id } });
  if (!type || !type.active) throw new ApiError(400, "نوع الإجازة مش موجود أو موقوف");
  if (v.end_date < v.start_date) throw new ApiError(400, "تاريخ النهاية قبل البداية");
  if (datesBetween(v.start_date, v.end_date).length > 366) throw new ApiError(400, "أقصى مدة للطلب سنة");
  const dates = await countLeaveDays(prisma, v.employee_id, type, v.start_date, v.end_date);
  const bal = await balanceOf(prisma, v.employee_id, type.id);
  return { days: dates.length, dates, balance: bal.balance, pending: bal.pending, available: bal.available, limited: !type.allowNegativeBalance };
}

/** POST /api/hr/leave/requests — recorded for an employee and sent for approval by someone else. */
export async function requestLeave(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.leave.request");
  const v = parse(requestInput, input);
  if (v.end_date < v.start_date) throw new ApiError(400, "تاريخ النهاية قبل البداية");
  if (datesBetween(v.start_date, v.end_date).length > 366) throw new ApiError(400, "أقصى مدة للطلب سنة");
  try {
    return await inTx(async (tx) => {
      await advisoryXactLock(tx, `hr-leave-employee:${v.employee_id}`);
      const [type, employee] = await Promise.all([tx.leaveType.findUnique({ where: { id: v.leave_type_id } }), tx.employee.findUnique({ where: { id: v.employee_id }, select: { id: true, code: true, name: true } })]);
      if (!type || !type.active) throw new ApiError(400, "نوع الإجازة مش موجود أو موقوف");
      if (!employee) throw new ApiError(404, "الموظف مش موجود");
      const dates = await countLeaveDays(tx, v.employee_id, type, v.start_date, v.end_date);
      if (!dates.length) throw new ApiError(400, "الفترة دي مفيهاش أيام شغل تتحسب إجازة");
      const worked = await tx.attendanceDay.findFirst({ where: { employeeId: v.employee_id, date: { in: dates }, status: "present" }, select: { date: true } });
      if (worked) throw new ApiError(409, `الموظف متسجل حضور يوم ${worked.date}`);
      if (!type.allowNegativeBalance) {
        const bal = await balanceOf(tx, v.employee_id, type.id);
        if (bal.available.lt(dates.length)) throw new ApiError(409, `الرصيد المتاح ${bal.available.toString()} يوم — الطلب ${dates.length} يوم`);
      }
      const number = await nextDocumentNumber(tx, "hr.leave_request", todayLocalISO());
      const req = await tx.leaveRequest.create({
        data: { number, employeeId: v.employee_id, leaveTypeId: type.id, startDate: v.start_date, endDate: v.end_date, days: dec(dates.length), reason: v.reason ?? null, requestedById: actor.id, requestedBy: actor.name },
      });
      const { request } = await requestApproval(tx, {
        type: "hr.leave",
        entityId: req.id,
        title: `${number} · ${employee.name} · ${type.nameAr}`,
        summary: `${v.start_date} → ${v.end_date} · ${dates.length}`,
        payload: { leaveRequestId: req.id },
        reason: v.reason ?? undefined,
        requester: actor,
      });
      const row = await tx.leaveRequest.update({ where: { id: req.id }, data: { approvalRequestId: request.id } });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "leave_requested", entityType: "leave_request", entityId: req.id, fieldChanged: type.code, newValue: `${number} · ${v.start_date}..${v.end_date} · ${dates.length}`, reason: v.reason ?? undefined, source: "user", deviceId: actor.deviceId }, tx);
      return row;
    });
  } catch (err) {
    if (err instanceof Error && /overlaps another open request/.test(err.message)) throw new ApiError(409, "فيه طلب إجازة تاني مفتوح أو معتمد في نفس الفترة");
    throw err;
  }
}

/**
 * The approval handler's effect (lib/core/approval-handlers.ts). Approved: re-checks the
 * balance and the register, writes `taken`, and turns each counted day into a confirmed leave
 * day (with its revision) — all or nothing. The recorder may not decide (also a DB CHECK).
 */
export async function applyLeaveDecision(tx: Tx, id: string, approved: boolean, decider: Decider, comment?: string) {
  const r = await tx.leaveRequest.findUnique({ where: { id }, include: { leaveType: true } });
  if (!r) throw new ApiError(404, "طلب الإجازة مش موجود");
  if (r.status !== "pending") throw new ApiError(409, "طلب الإجازة ده اتقفل بالفعل");
  if (decider.id && decider.id === r.requestedById) throw new ApiError(403, "مينفعش تعتمد إجازة انت اللي سجلتها");
  await advisoryXactLock(tx, `hr-leave-employee:${r.employeeId}`);
  const decided = { decidedById: decider.id, decidedBy: decider.name, decidedAt: new Date(), decisionComment: comment?.trim() || null, version: { increment: 1 } };
  if (!approved) {
    await tx.leaveRequest.update({ where: { id }, data: { status: "rejected", ...decided } });
    await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "leave_rejected", entityType: "leave_request", entityId: id, fieldChanged: r.number, reason: comment, source: "user", deviceId: decider.deviceId }, tx);
    return;
  }
  if (r.leaveType.requiresAttachment && !(await tx.attachment.count({ where: { entityType: "leave_request", entityId: id, deletedAt: null } }))) {
    throw new ApiError(409, "النوع ده محتاج مستند مرفق قبل الاعتماد");
  }
  // The days are counted again: a schedule or holiday may have changed since the request.
  const dates = await countLeaveDays(tx, r.employeeId, r.leaveType, r.startDate, r.endDate);
  if (!dates.length) throw new ApiError(409, "الفترة مبقاش فيها أيام تتحسب إجازة");
  if (!r.leaveType.allowNegativeBalance) {
    const bal = await balanceOf(tx, r.employeeId, r.leaveTypeId, id);
    if (bal.available.lt(dates.length)) throw new ApiError(409, `الرصيد المتاح ${bal.available.toString()} يوم — الطلب ${dates.length} يوم`);
  }
  for (const date of dates) await advisoryXactLock(tx, `hr-attendance-date:${date}`);
  const existing = new Map((await tx.attendanceDay.findMany({ where: { employeeId: r.employeeId, date: { in: dates } } })).map((d) => [d.date, d]));
  for (const date of dates) {
    const cur = existing.get(date) ?? null;
    if (cur?.state === "locked") throw new ApiError(409, `يوم ${date} مقفول في مسير مرتبات`);
    if (cur?.status === "present") throw new ApiError(409, `الموظف متسجل حضور يوم ${date}`);
    if (cur?.leaveRequestId) throw new ApiError(409, `يوم ${date} عليه إجازة تانية`);
    await writeDay(
      tx, cur, { employeeId: r.employeeId, date },
      { status: "leave", leaveRequestId: id, firstIn: null, lastOut: null, source: "leave", state: "confirmed", notes: cur?.notes ?? null, workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeDayMinutes: 0, overtimeNightMinutes: 0, overtimeRestDayMinutes: 0, overtimeHolidayMinutes: 0 },
      { action: "leave", reason: r.number }, decider
    );
  }
  await tx.leaveLedgerEntry.create({ data: { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, date: r.startDate, kind: "taken", days: dec(-dates.length), sourceType: "leave_request", sourceId: id, note: r.number, createdById: decider.id, createdBy: decider.name } });
  await tx.leaveRequest.update({ where: { id }, data: { status: "approved", ...decided } });
  await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "leave_approved", entityType: "leave_request", entityId: id, fieldChanged: r.number, newValue: `${dates.length} days`, reason: comment, source: "user", deviceId: decider.deviceId }, tx);
}

/**
 * POST /api/hr/leave/requests/:id/cancel. Pending: the recorder or an approver withdraws it.
 * Approved: an approver cancels it with a reason — the balance gets `taken_reversal` and each
 * leave day returns to the register as a draft for review (its earlier entry when it had
 * one). Refused while a payroll run holds any of its days.
 */
export async function cancelLeave(id: string, input: unknown, actor: ServiceActor) {
  const v = parse(z.object({ reason: optText("السبب", 300).optional() }), input);
  return inTx(async (tx) => {
    const r = await tx.leaveRequest.findUnique({ where: { id } });
    if (!r) throw new ApiError(404, "طلب الإجازة مش موجود");
    await advisoryXactLock(tx, `hr-leave-employee:${r.employeeId}`);
    if (r.status === "pending") {
      if (r.requestedById !== actor.id) assertPermission(actor, "hr.leave.approve");
      const row = await tx.leaveRequest.update({ where: { id, version: r.version }, data: { status: "cancelled", cancelledBy: actor.name, cancelReason: v.reason ?? null, version: { increment: 1 } } });
      await cancelPendingApproval(tx, { type: "hr.leave", entityId: id, reason: v.reason ?? "سحب طلب الإجازة", actor });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "leave_withdrawn", entityType: "leave_request", entityId: id, fieldChanged: r.number, reason: v.reason ?? undefined, source: "user", deviceId: actor.deviceId }, tx);
      return row;
    }
    if (r.status !== "approved") throw new ApiError(409, "طلب الإجازة ده اتقفل بالفعل");
    assertPermission(actor, "hr.leave.approve");
    if (!v.reason) throw new ApiError(400, "اكتب سبب إلغاء الإجازة المعتمدة");
    const days = await tx.attendanceDay.findMany({ where: { leaveRequestId: id } });
    const lockedDay = days.find((d) => d.state === "locked");
    if (lockedDay) throw new ApiError(409, `يوم ${lockedDay.date} مقفول في مسير مرتبات — الإلغاء بعد القفل بيتعمل مع تسويات المرتبات`);
    for (const d of days) {
      await advisoryXactLock(tx, `hr-attendance-date:${d.date}`);
      const leaveRev = await tx.attendanceDayRevision.findFirst({ where: { attendanceDayId: d.id, action: "leave" }, orderBy: { revision: "desc" } });
      const before = (leaveRev?.before ?? null) as Record<string, unknown> | null;
      const restore = before && before.status !== "leave"
        ? {
            status: String(before.status), firstIn: before.firstIn ? new Date(String(before.firstIn)) : null, lastOut: before.lastOut ? new Date(String(before.lastOut)) : null,
            workedMinutes: Number(before.workedMinutes ?? 0), lateMinutes: Number(before.lateMinutes ?? 0), earlyLeaveMinutes: Number(before.earlyLeaveMinutes ?? 0),
            overtimeDayMinutes: Number(before.overtimeDayMinutes ?? 0), overtimeNightMinutes: Number(before.overtimeNightMinutes ?? 0),
            overtimeRestDayMinutes: Number(before.overtimeRestDayMinutes ?? 0), overtimeHolidayMinutes: Number(before.overtimeHolidayMinutes ?? 0),
            source: String(before.source ?? "manual"), notes: (before.notes as string | null) ?? null,
          }
        : { status: "absent", firstIn: null, lastOut: null, workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeDayMinutes: 0, overtimeNightMinutes: 0, overtimeRestDayMinutes: 0, overtimeHolidayMinutes: 0, source: "system", notes: `إلغاء ${r.number} — راجع اليوم` };
      await writeDay(tx, d, d, { ...restore, leaveRequestId: null, state: "draft" }, { action: "reopened", reason: `${r.number}: ${v.reason}` }, actor);
    }
    await tx.leaveLedgerEntry.create({ data: { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, date: todayLocalISO(), kind: "taken_reversal", days: r.days, sourceType: "leave_request", sourceId: id, note: v.reason, createdById: actor.id, createdBy: actor.name } });
    const row = await tx.leaveRequest.update({ where: { id, version: r.version }, data: { status: "cancelled", cancelledBy: actor.name, cancelReason: v.reason, version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "leave_cancelled", entityType: "leave_request", entityId: id, fieldChanged: r.number, oldValue: "approved", newValue: `cancelled · ${days.length} days back to the register`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

export async function listLeaveRequests(actor: ServiceActor, filter: { status?: string | null; employeeId?: string | null }) {
  assertCanRead(actor);
  const rows = await prisma.leaveRequest.findMany({
    where: {
      ...(filter.status && ["pending", "approved", "rejected", "cancelled"].includes(filter.status) ? { status: filter.status } : {}),
      ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { employee: { select: { id: true, code: true, name: true } }, leaveType: { select: { id: true, code: true, nameAr: true, nameEn: true, requiresAttachment: true, payMode: true } } },
  });
  const approver = actorCan(actor, "hr.leave.approve");
  return rows.map((r) => ({
    ...r,
    canDecide: approver && r.status === "pending" && r.requestedById !== actor.id,
    canCancel: (r.status === "pending" && (r.requestedById === actor.id || approver)) || (r.status === "approved" && approver),
  }));
}
