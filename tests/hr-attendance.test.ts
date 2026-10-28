/* HR phase 2 — schedules, holidays, attendance, corrections and the device seam
   (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.4, §4.3). Measurement against the schedule, the
   draft → confirmed lifecycle, corrections approved by someone else, payroll locks that only a
   correction gets through, idempotent device ingestion — and the database guarantees attempted
   directly in SQL. */
import { BASE, call, login, makeChecker } from "./_harness";
import { Prisma, PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./_guard";
import { cairoInstant } from "../lib/hr/attendance-calc";

const { check, section, finish } = makeChecker();
const TAG = `ZZATT${Date.now() % 1_000_000_000}`;
const today = (() => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" })); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const shift = (iso: string, days: number) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };
const weekday = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
let r: any;

let db: PrismaClient | null = null;
function sql() {
  if (!db) { assertTestDatabase(); db = new PrismaClient(); }
  return db;
}
const rejects = async (q: () => Promise<unknown>) => { try { await q(); return false; } catch { return true; } };
/** A raw transaction that surfaces deferred-constraint failures (Prisma reports a failed COMMIT as success). */
const strictTx = (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
  sql().$transaction(async (tx) => { await fn(tx); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; });

async function ingest(key: string | null, events: unknown[]) {
  const res = await fetch(`${BASE}/api/integrations/attendance/events`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, body: JSON.stringify({ events }) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  for (const u of ["admin", "karim", "sara", "ahmed"]) await login(u);
  const s = sql();

  // Dates: the schedule works every day but Friday. Pick past, distinct, non-Friday dates.
  const past = Array.from({ length: 30 }, (_, i) => shift(today, -(i + 2))).filter((d) => weekday(d) !== 5);
  const [D, D2, D3, DL] = past;
  const H = past[4];
  const FRI = Array.from({ length: 14 }, (_, i) => shift(today, -(i + 1))).find((d) => weekday(d) === 5)!;

  section("1. WORK SCHEDULES — company values, none seeded");
  const days = [0, 1, 2, 3, 4, 5, 6].map((w) => w === 5
    ? { weekday: w, is_working_day: false }
    : { weekday: w, is_working_day: true, start: "09:00", end: "17:00", break_minutes: 60, night_start: "22:00", night_end: "06:00" });
  check("the supervisor cannot define a schedule (403)", (await call("sara", "POST", "/api/hr/schedules", { code: `${TAG}S`.slice(-20), name_ar: "x", days })).status === 403);
  check("a schedule without all 7 days is refused (400)", (await call("karim", "POST", "/api/hr/schedules", { code: `${TAG}X`.slice(-20), name_ar: "x", days: days.slice(0, 6) })).status === 400);
  check("a working day without hours is refused (400)", (await call("karim", "POST", "/api/hr/schedules", { code: `${TAG}Y`.slice(-20), name_ar: "x", days: days.map((d) => (d.weekday === 0 ? { weekday: 0, is_working_day: true } : d)) })).status === 400);
  r = await call("karim", "POST", "/api/hr/schedules", { code: `${TAG}S`.slice(-20), name_ar: `${TAG} وردية صباحي`, name_en: "Morning", days });
  check("HR defines a schedule; weekly hours are computed from the days (6 × 7h = 42)", r.status === 201 && Number(r.body.schedule.weeklyHours) === 42, r.body);
  const schedule = r.body.schedule;
  check("the supervisor (who keeps the register) can read schedules", (await call("sara", "GET", "/api/hr/schedules")).body.schedules?.some((x: any) => x.id === schedule.id));
  check("the preparer cannot (403)", (await call("ahmed", "GET", "/api/hr/schedules")).status === 403);

  section("2. PUBLIC HOLIDAYS — entered with their reference");
  r = await call("karim", "POST", "/api/hr/holidays", { date: H, name_ar: `${TAG} عيد`, reference: "قرار رقم X" });
  check("HR records a holiday (201, or 409 when an earlier run already did)", r.status === 201 || r.status === 409, r.body);
  check("the same date twice -> 409", (await call("karim", "POST", "/api/hr/holidays", { date: H, name_ar: "مكرر" })).status === 409);
  check("the supervisor cannot add holidays (403)", (await call("sara", "POST", "/api/hr/holidays", { date: shift(H, 400), name_ar: "x" })).status === 403);

  section("3. EMPLOYEES ON THE SCHEDULE (through employment history)");
  const e1 = (await call("karim", "POST", "/api/hr/employees", { name: `${TAG} حسن`, hire_date: shift(today, -60) })).body.employee;
  const e2 = (await call("karim", "POST", "/api/hr/employees", { name: `${TAG} منى`, hire_date: shift(today, -60) })).body.employee;
  for (const e of [e1, e2]) {
    r = await call("karim", "POST", `/api/hr/employees/${e.id}/employment`, { event: "contract_change", effective_from: shift(today, -60), work_schedule_id: schedule.id, reason: "جدول الوردية" });
  }
  check("a contract change assigns the schedule from the hire date", r.status === 201 && r.body.employment.workScheduleId === schedule.id, r.body);
  check("an inactive or unknown schedule is refused (400)", (await call("karim", "POST", `/api/hr/employees/${e1.id}/employment`, { event: "contract_change", effective_from: today, work_schedule_id: "nope", reason: "x" })).status === 400);
  r = await call("karim", "GET", `/api/hr/employees/${e1.id}`);
  check("the employee file shows the schedule", r.body.current?.schedule?.id === schedule.id, r.body.current);

  section("4. THE DAILY REGISTER — measured against the schedule");
  r = await call("sara", "GET", `/api/hr/attendance?date=${D}`);
  const row1 = r.body.rows?.find((x: any) => x.employee.id === e1.id);
  check("the register lists the employee with the schedule's hours", r.status === 200 && row1?.schedule?.day?.start === "09:00" && row1.day === null, row1);
  r = await call("sara", "GET", `/api/hr/attendance?date=${FRI}`);
  check("…and suggests a rest day on Friday", r.body.rows?.find((x: any) => x.employee.id === e1.id)?.suggested === "rest_day");
  r = await call("sara", "GET", `/api/hr/attendance?date=${H}`);
  check("…and a public holiday on the holiday", r.body.holiday && r.body.rows?.find((x: any) => x.employee.id === e1.id)?.suggested === "holiday", r.body.holiday);
  check("the preparer cannot read the register (403)", (await call("ahmed", "GET", `/api/hr/attendance?date=${D}`)).status === 403);
  check("the preparer cannot record (403)", (await call("ahmed", "POST", "/api/hr/attendance/days", { date: D, rows: [{ employee_id: e1.id, status: "present" }] })).status === 403);
  check("a future date is refused (400)", (await call("sara", "POST", "/api/hr/attendance/days", { date: shift(today, 1), rows: [{ employee_id: e1.id, status: "present" }] })).status === 400);
  check("'leave' cannot be entered by hand (400 — it comes from an approved leave)", (await call("sara", "POST", "/api/hr/attendance/days", { date: D, rows: [{ employee_id: e1.id, status: "leave" }] })).status === 400);
  check("'holiday' on a date that is not a holiday is refused (400)", (await call("sara", "POST", "/api/hr/attendance/days", { date: D, rows: [{ employee_id: e1.id, status: "holiday" }] })).status === 400);
  check("present without times on a rest day is refused (400)", (await call("sara", "POST", "/api/hr/attendance/days", { date: FRI, rows: [{ employee_id: e1.id, status: "present" }] })).status === 400);
  check("times on an absence are refused (400)", (await call("sara", "POST", "/api/hr/attendance/days", { date: D, rows: [{ employee_id: e2.id, status: "absent", first_in: "09:00", last_out: "17:00" }] })).status === 400);
  check("an employee before their hire date is refused (400)", (await call("sara", "POST", "/api/hr/attendance/days", { date: shift(today, -90), rows: [{ employee_id: e1.id, status: "present" }] })).status === 400);

  r = await call("sara", "POST", "/api/hr/attendance/days", { date: D, rows: [
    { employee_id: e1.id, status: "present", first_in: "08:45", last_out: "18:30" },
    { employee_id: e2.id, status: "absent" },
  ] });
  check("the supervisor saves the day as drafts", r.status === 200 && r.body.created === 2, r.body);
  let d1 = await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: D } } });
  check("worked = 9h45 present − 1h break = 525 min; not late; 15 min before + 90 min after the schedule", d1?.workedMinutes === 525 && d1.lateMinutes === 0 && d1.earlyLeaveMinutes === 0 && d1.overtimeDayMinutes === 105 && d1.overtimeNightMinutes === 0, d1);
  check("the instants are Cairo local time", d1?.firstIn?.getTime() === cairoInstant(D, "08:45").getTime(), d1?.firstIn);

  r = await call("sara", "POST", "/api/hr/attendance/days", { date: D2, rows: [{ employee_id: e1.id, status: "present", first_in: "09:30", last_out: "23:00" }] });
  const d2 = await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: D2 } } });
  check("late 30 min; 6h after the end, of which 1h inside the night window", d2?.lateMinutes === 30 && d2.overtimeDayMinutes === 300 && d2.overtimeNightMinutes === 60 && d2.workedMinutes === 750, d2);
  r = await call("sara", "POST", "/api/hr/attendance/days", { date: DL, rows: [{ employee_id: e1.id, status: "present", first_in: "22:00", last_out: "07:00" }] });
  const dn = await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: DL } } });
  check("a last-out before the first-in is the next morning (night shift)", r.status === 200 && !!dn?.lastOut && !!dn.firstIn && dn.lastOut.getTime() - dn.firstIn.getTime() === 9 * 3600_000, dn);
  r = await call("sara", "POST", "/api/hr/attendance/days", { date: H, rows: [{ employee_id: e1.id, status: "present", first_in: "10:00", last_out: "14:00" }, { employee_id: e2.id, status: "holiday" }] });
  const dh = await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: H } } });
  check("working on a public holiday: every minute is holiday time (240)", r.status === 200 && dh?.overtimeHolidayMinutes === 240 && dh.overtimeDayMinutes === 0, dh);
  r = await call("sara", "POST", "/api/hr/attendance/days", { date: FRI, rows: [{ employee_id: e1.id, status: "present", first_in: "10:00", last_out: "12:00" }] });
  const df = await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: FRI } } });
  check("working on a rest day: every minute is rest-day time (120)", df?.overtimeRestDayMinutes === 120, df);

  section("5. EVERY CHANGE IS A NEW VERSION WITH ITS REVISION");
  let d2e = await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e2.id, date: D } } });
  r = await call("sara", "POST", "/api/hr/attendance/days", { date: D, rows: [{ employee_id: e1.id, status: "present", first_in: "08:45", last_out: "18:30" }, { employee_id: e2.id, status: "absent_unpaid", expected_version: d2e!.version }] });
  check("re-saving: the unchanged row is left alone, the changed one gets a new version", r.status === 200 && r.body.unchanged === 1 && r.body.updated === 1, r.body);
  d2e = await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e2.id, date: D } } });
  const revs = await s.attendanceDayRevision.findMany({ where: { attendanceDayId: d2e!.id }, orderBy: { revision: "asc" } });
  check("…version 2, two revisions with before/after", d2e?.version === 2 && revs.length === 2 && (revs[1].before as any)?.status === "absent" && (revs[1].after as any)?.status === "absent_unpaid", revs);
  check("a stale expected_version -> 409", (await call("sara", "POST", "/api/hr/attendance/days", { date: D, rows: [{ employee_id: e2.id, status: "absent", expected_version: 1 }] })).status === 409);

  section("6. CONFIRM, THEN ONLY A CORRECTION (OR AN APPROVER) CHANGES IT");
  r = await call("sara", "POST", "/api/hr/attendance/confirm", { date: D });
  check("the supervisor confirms the day's drafts", r.status === 200 && r.body.confirmed >= 2, r.body);
  check("a confirmed day cannot be re-entered (409)", (await call("sara", "POST", "/api/hr/attendance/days", { date: D, rows: [{ employee_id: e1.id, status: "absent" }] })).status === 409);
  d1 = await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: D } } });
  check("the supervisor cannot reopen a confirmed day (403)", (await call("sara", "POST", `/api/hr/attendance/days/${d1!.id}/reopen`, { reason: "x" })).status === 403);
  check("reopening needs a reason (400)", (await call("admin", "POST", `/api/hr/attendance/days/${d1!.id}/reopen`, {})).status === 400);
  r = await call("admin", "POST", `/api/hr/attendance/days/${d1!.id}/reopen`, { reason: "مراجعة المواعيد" });
  check("an approver reopens it to draft, with a revision", r.status === 200 && r.body.day.state === "draft" && (await s.attendanceDayRevision.findFirst({ where: { attendanceDayId: d1!.id, action: "reopened" } }))?.reason === "مراجعة المواعيد", r.body);
  await call("sara", "POST", "/api/hr/attendance/confirm", { date: D });
  r = await call("sara", "GET", `/api/hr/attendance/days/${d1!.id}`);
  check("the day's history lists every revision, newest first", r.status === 200 && r.body.revisions.length === 4 && r.body.revisions[0].action === "confirmed", r.body.revisions?.map((x: any) => x.action));

  section("7. CORRECTIONS — approved by someone else, applied atomically");
  check("a correction on a draft is refused (409 — edit it directly)", (await call("sara", "POST", "/api/hr/attendance/corrections", { employee_id: e1.id, date: D2, status: "absent", reason: "x" })).status === 409);
  check("a correction without a reason is refused (400)", (await call("sara", "POST", "/api/hr/attendance/corrections", { employee_id: e2.id, date: D, status: "present" })).status === 400);
  check("a correction to the same values is refused (400)", (await call("sara", "POST", "/api/hr/attendance/corrections", { employee_id: e2.id, date: D, status: "absent_unpaid", reason: "x" })).status === 400);
  r = await call("sara", "POST", "/api/hr/attendance/corrections", { employee_id: e2.id, date: D, status: "present", first_in: "09:00", last_out: "17:00", reason: "نسيت البصمة — كانت موجودة" });
  check("the supervisor requests a correction (201, ATC- number, approval opened)", r.status === 201 && /^ATC-/.test(r.body.correction.number) && r.body.correction.approvalRequestId, r.body);
  const corr = r.body.correction;
  check("a second pending correction for the same day -> 409", (await call("sara", "POST", "/api/hr/attendance/corrections", { employee_id: e2.id, date: D, status: "absent", reason: "x" })).status === 409);
  r = await call("sara", "GET", `/api/hr/attendance?date=${D}`);
  check("the register shows the pending correction", r.body.rows.find((x: any) => x.employee.id === e2.id)?.pendingCorrection === corr.number);
  check("the requester (no approve permission) cannot decide it (403)", (await call("sara", "POST", `/api/approvals/${corr.approvalRequestId}/decide`, { decision: "approve" })).status === 403);
  r = await call("admin", "GET", "/api/approvals?status=pending");
  check("it is in the approver's inbox", (r.body.requests ?? r.body.approvals ?? []).some((a: any) => a.id === corr.approvalRequestId && a.canDecide), r.body);
  r = await call("admin", "POST", `/api/approvals/${corr.approvalRequestId}/decide`, { decision: "approve", comment: "تمام" });
  check("an approver approves", r.status === 200 && r.body.request.status === "approved", r.body);
  d2e = await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e2.id, date: D } } });
  const c1 = await s.attendanceCorrection.findUnique({ where: { id: corr.id } });
  check("…the day takes the requested values, source = correction, still confirmed", d2e?.status === "present" && d2e.source === "correction" && d2e.state === "confirmed" && d2e.workedMinutes === 420, d2e);
  check("…the correction records who decided and the revision it produced", c1?.status === "approved" && !!c1.decidedBy && c1.appliedRevision === d2e?.version && c1.retroStatus === "none", c1);
  check("…the revision points at the correction", (await s.attendanceDayRevision.findFirst({ where: { attendanceDayId: d2e!.id, revision: d2e!.version } }))?.correctionId === corr.id);

  r = await call("admin", "POST", "/api/hr/attendance/corrections", { employee_id: e1.id, date: D, status: "absent", reason: "اختبار الفصل بين الطالب والمعتمد" });
  const own = r.body.correction;
  r = await call("admin", "POST", `/api/approvals/${own.approvalRequestId}/decide`, { decision: "approve" });
  check("whoever requested a correction cannot approve it (403), even with the permission", r.status === 403, r.body);
  check("…and nothing changed: the request and the day are as they were", (await s.attendanceCorrection.findUnique({ where: { id: own.id } }))?.status === "pending" && (await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: D } } }))?.status === "present");
  check("someone else (not the requester, no approve permission) cannot withdraw it (403)", (await call("sara", "POST", `/api/hr/attendance/corrections/${own.id}/cancel`, {})).status === 403);
  r = await call("admin", "POST", `/api/hr/attendance/corrections/${own.id}/cancel`, {});
  check("the requester withdraws it; its approval request is cancelled too", r.status === 200 && r.body.correction.status === "cancelled" && (await s.approvalRequest.findUnique({ where: { id: own.approvalRequestId } }))?.status === "cancelled", r.body);
  r = await call("sara", "POST", "/api/hr/attendance/corrections", { employee_id: e1.id, date: D, status: "absent", reason: "رفض" });
  const rej = r.body.correction;
  check("rejecting needs a reason (400)", (await call("admin", "POST", `/api/approvals/${rej.approvalRequestId}/decide`, { decision: "reject" })).status === 400);
  r = await call("admin", "POST", `/api/approvals/${rej.approvalRequestId}/decide`, { decision: "reject", comment: "المواعيد صح" });
  check("a rejection leaves the day untouched", r.status === 200 && (await s.attendanceCorrection.findUnique({ where: { id: rej.id } }))?.status === "rejected" && (await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: D } } }))?.status === "present");
  r = await call("sara", "GET", "/api/hr/attendance/corrections");
  check("the corrections list shows all three outcomes", ["approved", "cancelled", "rejected"].every((st) => r.body.corrections.some((c: any) => [corr.id, own.id, rej.id].includes(c.id) && c.status === st)), r.body.corrections?.length);

  section("8. PAYROLL LOCK — only an approved correction gets through");
  const lockDay = (await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: D } } }))!;
  // A stand-in run (off-cycle, so it never collides with a real month's regular run).
  const RUN = (await s.payrollRun.create({ data: { number: `${TAG}-R`, period: D.slice(0, 7), runType: "off_cycle", attendanceFrom: D, attendanceTo: D, preparedBy: "test" } })).id;
  await strictTx(async (tx) => {
    const v = lockDay.version + 1;
    await tx.attendanceDay.update({ where: { id: lockDay.id }, data: { state: "locked", lockedRunId: RUN, version: v } });
    await tx.attendanceDayRevision.create({ data: { attendanceDayId: lockDay.id, revision: v, action: "locked", after: { state: "locked" }, changedBy: "test" } });
  });
  let locked = (await s.attendanceDay.findUnique({ where: { id: lockDay.id } }))!;
  check("(simulated run) the day is locked", locked.state === "locked");
  check("DB: a locked day's values cannot change outside a correction", await rejects(() => strictTx(async (tx) => {
    await tx.attendanceDay.update({ where: { id: lockDay.id }, data: { status: "absent", firstIn: null, lastOut: null, workedMinutes: 0, overtimeDayMinutes: 0, version: locked.version + 1 } });
    await tx.attendanceDayRevision.create({ data: { attendanceDayId: lockDay.id, revision: locked.version + 1, action: "entered", after: {}, changedBy: "test" } });
  })));
  check("DB: locking cannot change values at the same time", await rejects(() => strictTx(async (tx) => {
    await tx.attendanceDay.update({ where: { id: lockDay.id }, data: { state: "confirmed", lockedRunId: null, notes: "x", version: locked.version + 1 } });
    await tx.attendanceDayRevision.create({ data: { attendanceDayId: lockDay.id, revision: locked.version + 1, action: "unlocked", after: {}, changedBy: "test" } });
  })));
  check("reopening a locked day is refused (409)", (await call("admin", "POST", `/api/hr/attendance/days/${lockDay.id}/reopen`, { reason: "x" })).status === 409);
  r = await call("sara", "POST", "/api/hr/attendance/corrections", { employee_id: e1.id, date: D, status: "present", first_in: "09:00", last_out: "17:00", reason: "تصحيح بعد القفل" });
  check("a correction can be requested on a locked day", r.status === 201, r.body);
  const lc = r.body.correction;
  r = await call("admin", "POST", `/api/approvals/${lc.approvalRequestId}/decide`, { decision: "approve" });
  locked = (await s.attendanceDay.findUnique({ where: { id: lockDay.id } }))!;
  const lcRow = await s.attendanceCorrection.findUnique({ where: { id: lc.id } });
  check("…approved: the locked day is corrected, stays locked to the same run", r.status === 200 && locked.state === "locked" && locked.lockedRunId === RUN && locked.overtimeDayMinutes === 0 && locked.source === "correction", locked);
  check("…and its pay difference is marked for the next run (retroStatus = pending)", lcRow?.retroStatus === "pending", lcRow);
  // Leave nothing locked to a run that does not exist (payroll runs arrive in phase 5).
  await strictTx(async (tx) => {
    const v = locked.version + 1;
    await tx.attendanceDay.update({ where: { id: lockDay.id }, data: { state: "confirmed", lockedRunId: null, version: v } });
    await tx.attendanceDayRevision.create({ data: { attendanceDayId: lockDay.id, revision: v, action: "unlocked", after: { state: "confirmed" }, changedBy: "test" } });
  });
  check("(simulated run withdrawn) the day is unlocked again", (await s.attendanceDay.findUnique({ where: { id: lockDay.id } }))?.state === "confirmed");
  await s.payrollRun.update({ where: { id: RUN }, data: { status: "cancelled", cancelledReason: "test stand-in" } });
  check("DB: a day cannot be locked to a run that does not exist", await rejects(() => strictTx(async (tx) => {
    const d = (await tx.attendanceDay.findUnique({ where: { id: lockDay.id } }))!;
    await tx.attendanceDay.update({ where: { id: d.id }, data: { state: "locked", lockedRunId: "no-such-run", version: d.version + 1 } });
    await tx.attendanceDayRevision.create({ data: { attendanceDayId: d.id, revision: d.version + 1, action: "locked", after: {}, changedBy: "test" } });
  })));

  section("9. DATABASE GUARANTEES");
  const anyDay = (await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e1.id, date: D2 } } }))!;
  check("DB: attendance days cannot be deleted", await rejects(() => s.attendanceDay.delete({ where: { id: anyDay.id } })));
  check("DB: an update must move the version by exactly one", await rejects(() => s.attendanceDay.update({ where: { id: anyDay.id }, data: { notes: "x" } })));
  check("DB: a new version without its revision row is refused at commit", await rejects(() => strictTx((tx) => tx.attendanceDay.update({ where: { id: anyDay.id }, data: { notes: "x", version: anyDay.version + 1 } }))));
  check("DB: the employee and date of a day cannot change", await rejects(() => strictTx(async (tx) => {
    await tx.attendanceDay.update({ where: { id: anyDay.id }, data: { date: shift(anyDay.date, -1), version: anyDay.version + 1 } });
    await tx.attendanceDayRevision.create({ data: { attendanceDayId: anyDay.id, revision: anyDay.version + 1, action: "entered", after: {}, changedBy: "test" } });
  })));
  check("DB: confirmed → draft → locked skipping confirmed is refused", await rejects(() => strictTx(async (tx) => {
    await tx.attendanceDay.update({ where: { id: anyDay.id }, data: { state: "locked", lockedRunId: "x", version: anyDay.version + 1 } });
    await tx.attendanceDayRevision.create({ data: { attendanceDayId: anyDay.id, revision: anyDay.version + 1, action: "locked", after: {}, changedBy: "test" } });
  })));
  check("DB: an absence with worked minutes is refused", await rejects(() => strictTx(async (tx) => {
    await tx.attendanceDay.update({ where: { id: anyDay.id }, data: { status: "absent", version: anyDay.version + 1 } });
    await tx.attendanceDayRevision.create({ data: { attendanceDayId: anyDay.id, revision: anyDay.version + 1, action: "entered", after: {}, changedBy: "test" } });
  })));
  const rev = (await s.attendanceDayRevision.findFirst({ where: { attendanceDayId: anyDay.id } }))!;
  check("DB: revisions are append-only (no update)", await rejects(() => s.attendanceDayRevision.update({ where: { id: rev.id }, data: { reason: "x" } })));
  check("DB: revisions are append-only (no delete)", await rejects(() => s.attendanceDayRevision.delete({ where: { id: rev.id } })));
  check("DB: a correction decided by its own requester is refused", await rejects(() => s.attendanceCorrection.update({ where: { id: corr.id }, data: { decidedById: c1!.requestedById } })));
  check("DB: two pending corrections for the same day are refused", await rejects(async () => {
    await s.attendanceCorrection.create({ data: { number: `${TAG}-a`, employeeId: e2.id, date: D2, requested: {}, reason: "x", requestedBy: "t" } });
    await s.attendanceCorrection.create({ data: { number: `${TAG}-b`, employeeId: e2.id, date: D2, requested: {}, reason: "x", requestedBy: "t" } });
  }));
  await s.attendanceCorrection.updateMany({ where: { number: { startsWith: `${TAG}-` } }, data: { status: "cancelled" } });

  section("10. DEVICE SEAM — punches in, idempotent, never over a person's entry");
  r = await call("admin", "POST", "/api/admin/integrations", { code: `${TAG.toLowerCase()}d`, name: "بوابة 1", scopes: ["attendance.ingest"] });
  check("the administrator issues a device key with the attendance scope", r.status === 201 && r.body.key, r.body);
  const key = r.body.key;
  const keyId = r.body.integration.id;
  const ordersKey = (await call("admin", "POST", "/api/admin/integrations", { code: `${TAG.toLowerCase()}o`, name: "orders", scopes: ["orders.create"] })).body;
  r = await call("karim", "GET", "/api/hr/attendance/sources");
  check("HR sees the key as bindable (code and name only, never the key)", r.body.keys?.some((k: any) => k.id === keyId) && !JSON.stringify(r.body).includes(key), r.body.keys);
  check("binding a key without attendance.ingest is refused (400)", (await call("karim", "POST", "/api/hr/attendance/sources", { code: `${TAG.toLowerCase()}x`, name: "x", kind: "device", integration_id: ordersKey.integration.id })).status === 400);
  check("the supervisor cannot add devices (403)", (await call("sara", "POST", "/api/hr/attendance/sources", { code: `${TAG.toLowerCase()}g`, name: "x", kind: "device", integration_id: keyId })).status === 403);
  check("a key not yet bound to a source cannot send punches (403)", (await ingest(key, [{ external_event_id: "x", external_user_id: "1", occurred_at: new Date().toISOString() }])).status === 403);
  r = await call("karim", "POST", "/api/hr/attendance/sources", { code: `${TAG.toLowerCase()}g`, name: "بوابة المخزن", kind: "device", integration_id: keyId });
  check("HR binds the key to a device source", r.status === 201, r.body);
  const source = r.body.source;
  r = await call("karim", "POST", "/api/hr/attendance/identities", { source_id: source.id, external_user_id: "1001", employee_id: e2.id });
  check("HR maps device user 1001 to an employee", r.status === 201, r.body);
  check("the same device number twice -> 409", (await call("karim", "POST", "/api/hr/attendance/identities", { source_id: source.id, external_user_id: "1001", employee_id: e1.id })).status === 409);

  const events = [
    { external_event_id: `${TAG}-1`, external_user_id: "1001", occurred_at: cairoInstant(D3, "08:50").toISOString(), direction: "in" },
    { external_event_id: `${TAG}-2`, external_user_id: "1001", occurred_at: cairoInstant(D3, "17:20").toISOString(), direction: "out" },
    { external_event_id: `${TAG}-3`, external_user_id: "9999", occurred_at: cairoInstant(D3, "09:00").toISOString() },
    { external_event_id: `${TAG}-4`, external_user_id: "1001", occurred_at: cairoInstant(D, "08:00").toISOString() },
    { external_event_id: `${TAG}-5`, external_user_id: "1001", occurred_at: cairoInstant(D, "20:00").toISOString() },
  ];
  check("no key -> 401", (await ingest(null, events)).status === 401);
  check("a key without attendance.ingest -> 403", (await ingest(ordersKey.key, events)).status === 403);
  check("a punch in the future is refused (400)", (await ingest(key, [{ external_event_id: `${TAG}-f`, external_user_id: "1001", occurred_at: new Date(Date.now() + 3600_000).toISOString() }])).status === 400);
  r = await ingest(key, events);
  check("the device sends 5 punches: 5 accepted, 1 for an unmapped user", r.status === 201 && r.body.accepted === 5 && r.body.duplicates === 0 && r.body.unmatched === 1, r.body);
  r = await ingest(key, events);
  check("re-delivering the same punches stores nothing twice (5 duplicates)", r.status === 201 && r.body.accepted === 0 && r.body.duplicates === 5, r.body);
  check("every call is in the integration log", (await s.integrationLog.count({ where: { integrationId: keyId, path: "/api/integrations/attendance/events" } })) >= 4);
  check("DB: punches are append-only", await rejects(() => s.attendanceEvent.updateMany({ where: { externalEventId: `${TAG}-1` }, data: { direction: "out" } })));

  check("the preparer cannot compile (403)", (await call("ahmed", "POST", "/api/hr/attendance/compile", { from: D, to: D3 })).status === 403);
  r = await call("sara", "POST", "/api/hr/attendance/compile", { from: D3 < D ? D3 : D, to: D3 < D ? D : D3 });
  check("compiling creates a draft device day; a confirmed manual day is kept; unmapped punches are reported", r.status === 200 && r.body.created === 1 && r.body.kept >= 1 && r.body.unmapped >= 1, r.body);
  const dd = await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e2.id, date: D3 } } });
  check("…the device day is measured like any other (08:50–17:20: 450 worked, 10 before + 20 after)", dd?.source === "device" && dd.state === "draft" && dd.workedMinutes === 450 && dd.overtimeDayMinutes === 30 && dd.lateMinutes === 0, dd);
  check("…and the confirmed day of the other date was not touched", (await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e2.id, date: D } } }))?.source === "correction");
  r = await call("sara", "POST", "/api/hr/attendance/compile", { from: D3, to: D3 });
  check("compiling again changes nothing (kept)", r.status === 200 && r.body.created === 0 && r.body.updated === 0, r.body);
  r = await call("sara", "POST", "/api/hr/attendance/days", { date: D3, rows: [{ employee_id: e2.id, status: "present", first_in: "09:00", last_out: "17:00", expected_version: dd!.version }] });
  await call("sara", "POST", "/api/hr/attendance/compile", { from: D3, to: D3 });
  check("once a person edits a device day, compiling never overwrites it", (await s.attendanceDay.findUnique({ where: { employeeId_date: { employeeId: e2.id, date: D3 } } }))?.source === "manual");
  check("a compile range over 62 days is refused (400)", (await call("sara", "POST", "/api/hr/attendance/compile", { from: shift(today, -100), to: today })).status === 400);

  section("11. MONTH VIEW, HOLIDAY REMOVAL, AUDIT");
  r = await call("sara", "GET", `/api/hr/attendance/month?month=${D.slice(0, 7)}`);
  const mrow = r.body.rows?.find((x: any) => x.employee.id === e1.id);
  check("the month grid has one cell per day, with the entered statuses", r.status === 200 && mrow && mrow.cells.length === r.body.dates.length && mrow.cells.find((c: any) => c.date === D)?.status === "present", mrow?.totals);
  check("the preparer cannot read the month (403)", (await call("ahmed", "GET", `/api/hr/attendance/month?month=${D.slice(0, 7)}`)).status === 403);
  await call("sara", "POST", "/api/hr/attendance/confirm", { date: H });
  const hol = (await call("karim", "GET", `/api/hr/holidays?year=${H.slice(0, 4)}`)).body.holidays.find((h: any) => h.date === H);
  check("a holiday that confirmed attendance relies on cannot be removed (409)", (await call("karim", "DELETE", `/api/hr/holidays/${hol.id}`)).status === 409);
  const tmp = (await call("karim", "POST", "/api/hr/holidays", { date: shift(today, 300 + (Date.now() % 50)), name_ar: `${TAG} مؤقت` })).body.holiday;
  check("an unused holiday can be removed", tmp && (await call("karim", "DELETE", `/api/hr/holidays/${tmp.id}`)).status === 200);
  const audited = new Set((await s.auditLog.findMany({ where: { action: { startsWith: "attendance_" }, timestamp: { gte: new Date(Date.now() - 3600_000) } }, select: { action: true } })).map((a) => a.action));
  check("saving, confirming, reopening, corrections and compiles are audited", ["attendance_saved", "attendance_confirmed", "attendance_reopened", "attendance_correction_requested", "attendance_correction_applied", "attendance_correction_rejected", "attendance_correction_cancelled", "attendance_compiled"].every((a) => audited.has(a)), [...audited]);

  await db?.$disconnect();
  finish("HR ATTENDANCE");
}

main().catch(async (e) => { console.error(e); await db?.$disconnect(); process.exit(1); });
