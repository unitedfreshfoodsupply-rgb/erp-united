/* HR phase 3 — leave (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.5, §4.4). Types and policies entered
   by HR and verified by a second person, idempotent allocation from tiers, requests counted on
   the schedule and holidays, approval by someone else writing the ledger and the attendance
   register in one go, cancellation reversing both — and the database guarantees in SQL. */
import { BASE, call, cookieFor, login, makeChecker } from "./_harness";
import { Prisma, PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./_guard";

const { check, section, finish } = makeChecker();
const TAG = `ZZLV${Date.now() % 1_000_000_000}`;
const today = (() => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" })); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const shift = (iso: string, days: number) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };
const weekday = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const year = today.slice(0, 4);
let r: any;

let db: PrismaClient | null = null;
function sql() {
  if (!db) { assertTestDatabase(); db = new PrismaClient(); }
  return db;
}
const rejects = async (q: () => Promise<unknown>) => { try { await q(); return false; } catch { return true; } };
const strictTx = (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
  sql().$transaction(async (tx) => { await fn(tx); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; });

async function upload(who: string, entityId: string) {
  const form = new FormData();
  form.set("entity_type", "leave_request"); form.set("entity_id", entityId); form.set("category", "medical");
  form.set("file", new Blob([new Uint8Array([37, 80, 68, 70, 45, 49])], { type: "application/pdf" }), "note.pdf");
  const res = await fetch(`${BASE}/api/attachments`, { method: "POST", headers: { cookie: cookieFor(who) ?? "" }, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  for (const u of ["admin", "karim", "sara", "ahmed"]) await login(u);
  const s = sql();
  const karim = await s.user.findFirstOrThrow({ where: { username: "karim" } });
  const grant = (permission: string, effect: "grant" | null) => call("admin", "POST", `/api/admin/users/${karim.id}/permissions`, { permission, effect, reason: `${TAG} test` });

  section("1. LEAVE TYPES — company inputs, none seeded");
  check("finance cannot define leave types (403)", (await call("karim", "POST", "/api/hr/leave/types", { code: `${TAG}A`, name_ar: "x", pay_mode: "paid", counts_days: "working" })).status === 403);
  check("partially paid without its share -> 400", (await call("admin", "POST", "/api/hr/leave/types", { code: `${TAG}P`, name_ar: "x", pay_mode: "partially_paid", counts_days: "working" })).status === 400);
  const annual = (await call("admin", "POST", "/api/hr/leave/types", { code: `${TAG}A`, name_ar: `${TAG} اعتيادي`, pay_mode: "paid", counts_days: "working" })).body.type;
  const unpaid = (await call("admin", "POST", "/api/hr/leave/types", { code: `${TAG}U`, name_ar: `${TAG} بدون أجر`, pay_mode: "unpaid", counts_days: "calendar", allow_negative_balance: true })).body.type;
  r = await call("admin", "POST", "/api/hr/leave/types", { code: `${TAG}S`, name_ar: `${TAG} مرضي`, pay_mode: "partially_paid", paid_percent: 60, counts_days: "working", requires_attachment: true, allow_negative_balance: true });
  check("the owner defines three types (paid, unpaid, partially paid with a document)", !!annual?.id && !!unpaid?.id && r.status === 201 && Number(r.body.type.paidPercent) === 60, r.body);
  const sick = r.body.type;
  check("finance (records requests) can read the types", (await call("karim", "GET", "/api/hr/leave/types")).body.types?.some((t: any) => t.id === annual.id));
  check("the supervisor cannot (403)", (await call("sara", "GET", "/api/hr/leave/types")).status === 403);

  section("2. POLICIES — four eyes before use, never edited after");
  const tiers = [{ min_service_months: 0, days_per_year: 10 }, { min_service_months: 12, days_per_year: 15 }, { min_service_months: 0, min_age: 50, days_per_year: 20 }];
  r = await call("admin", "POST", "/api/hr/leave/policies", { leave_type_id: annual.id, effective_from: `${year}-01-01`, accrual_method: "annual_upfront", source_reference: `${TAG} test values — not statutory`, tiers });
  check("the owner enters a draft policy with tiers", r.status === 201 && r.body.policy.status === "draft" && r.body.policy.tiers.length === 3, r.body);
  const policy = r.body.policy;
  check("a policy needs a source reference (400)", (await call("admin", "POST", "/api/hr/leave/policies", { leave_type_id: annual.id, effective_from: `${year}-01-01`, accrual_method: "annual_upfront", tiers })).status === 400);
  check("allocation from a draft is refused (409)", (await call("admin", "POST", "/api/hr/leave/allocate", { policy_id: policy.id, period: year })).status === 409);
  check("its author cannot verify it (403)", (await call("admin", "POST", `/api/hr/leave/policies/${policy.id}/verify`, {})).status === 403);
  await grant("hr.leave.configure", "grant");
  r = await call("karim", "POST", `/api/hr/leave/policies/${policy.id}/verify`, {});
  check("a second person verifies it", r.status === 200 && r.body.policy.status === "verified" && r.body.policy.verifiedBy, r.body);
  check("a verified policy cannot be edited (409)", (await call("admin", "PATCH", `/api/hr/leave/policies/${policy.id}`, { leave_type_id: annual.id, effective_from: `${year}-01-01`, accrual_method: "annual_upfront", source_reference: "x", tiers })).status === 409);
  check("DB: tiers of a verified policy cannot change", await rejects(() => s.leavePolicyTier.updateMany({ where: { policyId: policy.id }, data: { daysPerYear: 99 } })));
  check("DB: a verified policy's values cannot change", await rejects(() => s.leavePolicy.update({ where: { id: policy.id }, data: { accrualMethod: "monthly" } })));
  check("DB: the author cannot be recorded as verifier", await rejects(() => s.leavePolicy.create({ data: { leaveTypeId: annual.id, effectiveFrom: "2000-01-01", effectiveTo: "2000-12-31", accrualMethod: "none", sourceReference: "x", status: "verified", createdById: karim.id, createdBy: "k", verifiedById: karim.id, verifiedBy: "k", verifiedAt: new Date() } })));
  const dup = (await call("karim", "POST", "/api/hr/leave/policies", { leave_type_id: annual.id, effective_from: `${year}-06-01`, accrual_method: "annual_upfront", source_reference: "overlap", tiers })).body.policy;
  check("a second verified policy over the same dates is refused (409)", (await call("admin", "POST", `/api/hr/leave/policies/${dup.id}/verify`, {})).status === 409);
  check("a draft can be discarded", (await call("karim", "POST", `/api/hr/leave/policies/${dup.id}/retire`, { reason: "مكرر" })).status === 200 && !(await s.leavePolicy.findUnique({ where: { id: dup.id } })));

  section("3. EMPLOYEES, SCHEDULE AND ALLOCATION");
  const days = [0, 1, 2, 3, 4, 5, 6].map((w) => (w === 5 ? { weekday: w, is_working_day: false } : { weekday: w, is_working_day: true, start: "08:00", end: "16:00", break_minutes: 30 }));
  const schedule = (await call("karim", "POST", "/api/hr/schedules", { code: `${TAG}W`, name_ar: `${TAG} دوام`, days })).body.schedule;
  const mk = async (name: string, hire: string) => {
    const e = (await call("karim", "POST", "/api/hr/employees", { name: `${TAG} ${name}`, hire_date: hire })).body.employee;
    await call("karim", "POST", `/api/hr/employees/${e.id}/employment`, { event: "contract_change", effective_from: hire, work_schedule_id: schedule.id, reason: "جدول" });
    return e;
  };
  const e1 = await mk("أكبر", `${Number(year) - 3}-03-01`);
  const e2 = await mk("وسط", `${Number(year) - 1}-11-01`);
  const e3 = await mk("جديد", shift(today, -30));
  await call("admin", "PATCH", `/api/hr/employees/${e1.id}/private`, { birth_date: "1970-04-01" });
  check("the wrong period shape -> 400", (await call("admin", "POST", "/api/hr/leave/allocate", { policy_id: policy.id, period: `${year}-01` })).status === 400);
  check("finance (without configure) cannot allocate (403)", (await grant("hr.leave.configure", null)).status === 200 && (await call("karim", "POST", "/api/hr/leave/allocate", { policy_id: policy.id, period: year })).status === 403);
  r = await call("admin", "POST", "/api/hr/leave/allocate", { policy_id: policy.id, period: year });
  check("the owner allocates the year", r.status === 200 && r.body.created >= 2 && r.body.joinedDuring >= 1, r.body);
  const bal = async (e: string, type: string) => ((await call("karim", "GET", `/api/hr/leave/balances?employee_id=${e}`)).body.balances?.[0]?.types ?? []).find((x: any) => x.leaveType?.id === type);
  check("the highest tier applies: 50+ → 20 days", Number((await bal(e1.id, annual.id))?.entitled) === 20);
  check("2 months' service at the start of the year → 10 days", Number((await bal(e2.id, annual.id))?.entitled) === 10);
  check("a joiner during the year is reported, not prorated by the system", !(await bal(e3.id, annual.id)));
  r = await call("admin", "POST", "/api/hr/leave/allocate", { policy_id: policy.id, period: year });
  check("allocating again adds nothing (idempotent)", r.status === 200 && r.body.created === 0 && r.body.already >= 2, r.body);
  r = await call("admin", "POST", "/api/hr/leave/adjustments", { employee_id: e3.id, leave_type_id: annual.id, days: 2, reason: "رصيد تناسبي حسب القاعدة المعتمدة" });
  check("HR records the joiner's entitlement as an adjustment with its reason", r.status === 201 && Number((await bal(e3.id, annual.id))?.available) === 2, r.body);
  check("an adjustment without a reason -> 400", (await call("admin", "POST", "/api/hr/leave/adjustments", { employee_id: e3.id, leave_type_id: annual.id, days: 1 })).status === 400);

  section("4. REQUESTS — counted on the schedule and holidays");
  let S = shift(today, 20);
  while (weekday(S) !== 0) S = shift(S, 1);
  const hol = shift(S, 2);
  r = await call("karim", "POST", "/api/hr/holidays", { date: hol, name_ar: `${TAG} عطلة` });
  check("a holiday inside the range (201, or 409 if already there)", r.status === 201 || r.status === 409, r.body);
  const reqBody = { employee_id: e2.id, leave_type_id: annual.id, start_date: S, end_date: shift(S, 6), reason: "إجازة سنوية" };
  r = await call("karim", "POST", "/api/hr/leave/preview", reqBody);
  check("Sun–Sat with Friday off and a holiday counts 5 working days", r.status === 200 && r.body.days === 5 && Number(r.body.available) === 10, r.body);
  check("the supervisor cannot record leave (403)", (await call("sara", "POST", "/api/hr/leave/requests", reqBody)).status === 403);
  check("more days than the balance -> 409", (await call("karim", "POST", "/api/hr/leave/requests", { ...reqBody, end_date: shift(S, 20) })).status === 409);
  check("an end before the start -> 400", (await call("karim", "POST", "/api/hr/leave/requests", { ...reqBody, end_date: shift(S, -1) })).status === 400);
  r = await call("karim", "POST", "/api/hr/leave/requests", reqBody);
  check("finance records the request (201, LVR- number, 5 days, approval opened)", r.status === 201 && /^LVR-/.test(r.body.request.number) && Number(r.body.request.days) === 5 && r.body.request.approvalRequestId, r.body);
  const lr = r.body.request;
  check("an overlapping request for the same employee -> 409", (await call("karim", "POST", "/api/hr/leave/requests", { ...reqBody, start_date: shift(S, 3), end_date: shift(S, 4) })).status === 409);
  let b2 = await bal(e2.id, annual.id);
  check("the pending days reduce what is available, not the balance", Number(b2?.balance) === 10 && Number(b2?.pending) === 5 && Number(b2?.available) === 5, b2);
  check("the recorder cannot approve (403)", (await call("karim", "POST", `/api/approvals/${lr.approvalRequestId}/decide`, { decision: "approve" })).status === 403);
  r = await call("admin", "POST", `/api/approvals/${lr.approvalRequestId}/decide`, { decision: "approve" });
  check("an approver approves", r.status === 200 && r.body.request.status === "approved", r.body);
  const leaveDays = await s.attendanceDay.findMany({ where: { leaveRequestId: lr.id }, orderBy: { date: "asc" } });
  check("…5 confirmed leave days are written to the register (none on Friday or the holiday)", leaveDays.length === 5 && leaveDays.every((d) => d.status === "leave" && d.state === "confirmed" && d.source === "leave") && !leaveDays.some((d) => d.date === hol || weekday(d.date) === 5), leaveDays.map((d) => d.date));
  check("…each with its revision", (await s.attendanceDayRevision.count({ where: { attendanceDayId: { in: leaveDays.map((d) => d.id) }, action: "leave" } })) === 5);
  b2 = await bal(e2.id, annual.id);
  check("…and the ledger takes 5 days", Number(b2?.taken) === 5 && Number(b2?.balance) === 5 && Number(b2?.pending) === 0, b2);
  check("a correction cannot turn a leave day into something else (409 — cancel the leave)", (await call("sara", "POST", "/api/hr/attendance/corrections", { employee_id: e2.id, date: leaveDays[0].date, status: "present", reason: "x" })).status === 409);

  r = await call("admin", "POST", "/api/hr/leave/requests", { employee_id: e1.id, leave_type_id: annual.id, start_date: shift(S, 7), end_date: shift(S, 8) });
  const own = r.body.request;
  check("whoever recorded a leave cannot approve it, even with the permission (403)", (await call("admin", "POST", `/api/approvals/${own.approvalRequestId}/decide`, { decision: "approve" })).status === 403);
  check("…nothing was written", (await s.attendanceDay.count({ where: { leaveRequestId: own.id } })) === 0 && (await s.leaveRequest.findUnique({ where: { id: own.id } }))?.status === "pending");
  r = await call("admin", "POST", `/api/hr/leave/requests/${own.id}/cancel`, {});
  check("the recorder withdraws it; its approval is cancelled", r.status === 200 && r.body.request.status === "cancelled" && (await s.approvalRequest.findUnique({ where: { id: own.approvalRequestId } }))?.status === "cancelled", r.body);

  section("5. DOCUMENTS, PRESENCE AND REJECTION");
  r = await call("karim", "POST", "/api/hr/leave/requests", { employee_id: e1.id, leave_type_id: sick.id, start_date: shift(S, 7), end_date: shift(S, 7) });
  const sk = r.body.request;
  check("a type needing a document cannot be approved without one (409)", r.status === 201 && (await call("admin", "POST", `/api/approvals/${sk.approvalRequestId}/decide`, { decision: "approve" })).status === 409);
  r = await upload("karim", sk.id);
  check("the recorder attaches the certificate", r.status === 201, r.body);
  check("the supervisor cannot see leave documents (403)", (await call("sara", "GET", `/api/attachments?entity_type=leave_request&entity_id=${sk.id}`)).status === 403);
  check("…then it can be approved", (await call("admin", "POST", `/api/approvals/${sk.approvalRequestId}/decide`, { decision: "approve" })).status === 200);
  const P = (() => { let d = shift(today, -3); while (weekday(d) === 5) d = shift(d, -1); return d; })();
  await call("sara", "POST", "/api/hr/attendance/days", { date: P, rows: [{ employee_id: e3.id, status: "present" }] });
  check("leave over a day the employee is recorded present -> 409", (await call("karim", "POST", "/api/hr/leave/requests", { employee_id: e3.id, leave_type_id: annual.id, start_date: P, end_date: P })).status === 409);
  r = await call("karim", "POST", "/api/hr/leave/requests", { employee_id: e3.id, leave_type_id: unpaid.id, start_date: shift(S, 10), end_date: shift(S, 12) });
  check("unpaid leave (no balance limit, calendar days) counts 3 days with no entitlement", r.status === 201 && Number(r.body.request.days) === 3, r.body);
  const up = r.body.request;
  check("rejecting needs a reason (400)", (await call("admin", "POST", `/api/approvals/${up.approvalRequestId}/decide`, { decision: "reject" })).status === 400);
  r = await call("admin", "POST", `/api/approvals/${up.approvalRequestId}/decide`, { decision: "reject", comment: "ضغط شغل" });
  check("a rejection writes nothing", r.status === 200 && (await s.attendanceDay.count({ where: { leaveRequestId: up.id } })) === 0 && (await s.leaveLedgerEntry.count({ where: { sourceId: up.id } })) === 0);

  section("6. CANCELLING AN APPROVED LEAVE");
  check("finance cannot cancel an approved leave (403)", (await call("karim", "POST", `/api/hr/leave/requests/${lr.id}/cancel`, { reason: "x" })).status === 403);
  check("an approver must give a reason (400)", (await call("admin", "POST", `/api/hr/leave/requests/${lr.id}/cancel`, {})).status === 400);
  r = await call("admin", "POST", `/api/hr/leave/requests/${lr.id}/cancel`, { reason: "الموظف رجع الشغل" });
  check("an approver cancels it", r.status === 200 && r.body.request.status === "cancelled", r.body);
  const after = await s.attendanceDay.findMany({ where: { id: { in: leaveDays.map((d) => d.id) } } });
  check("…its days return to the register as drafts for review, no longer leave", after.every((d) => d.status !== "leave" && d.state === "draft" && d.leaveRequestId === null), after.map((d) => [d.status, d.state]));
  b2 = await bal(e2.id, annual.id);
  check("…and the balance gets the days back (taken_reversal)", Number(b2?.balance) === 10 && Number(b2?.taken) === 0, b2);
  check("a cancelled leave cannot be cancelled again (409)", (await call("admin", "POST", `/api/hr/leave/requests/${lr.id}/cancel`, { reason: "x" })).status === 409);

  section("7. DATABASE GUARANTEES");
  const entry = (await s.leaveLedgerEntry.findFirst({ where: { sourceId: lr.id, kind: "taken" } }))!;
  check("DB: ledger entries cannot be edited", await rejects(() => s.leaveLedgerEntry.update({ where: { id: entry.id }, data: { days: -1 } })));
  check("DB: ledger entries cannot be deleted", await rejects(() => s.leaveLedgerEntry.delete({ where: { id: entry.id } })));
  check("DB: a 'taken' entry must be negative", await rejects(() => s.leaveLedgerEntry.create({ data: { employeeId: e2.id, leaveTypeId: annual.id, date: today, kind: "taken", days: 3, sourceType: "test", sourceId: `${TAG}-x`, createdBy: "t" } })));
  check("DB: the same source cannot write the same kind twice", await rejects(() => s.leaveLedgerEntry.create({ data: { employeeId: e2.id, leaveTypeId: annual.id, date: today, kind: "taken", days: -5, sourceType: "leave_request", sourceId: lr.id, createdBy: "t" } })));
  check("DB: a request's dates cannot change", await rejects(() => s.leaveRequest.update({ where: { id: sk.id }, data: { endDate: shift(S, 9) } })));
  check("DB: requests are never deleted", await rejects(() => s.leaveRequest.delete({ where: { id: up.id } })));
  check("DB: a rejected request cannot be approved", await rejects(() => s.leaveRequest.update({ where: { id: up.id }, data: { status: "approved" } })));
  const skRequester = (await s.leaveRequest.findUniqueOrThrow({ where: { id: sk.id } })).requestedById;
  check("DB: a request decided by its recorder is refused", await rejects(() => s.leaveRequest.update({ where: { id: sk.id }, data: { decidedById: skRequester } })));
  check("DB: overlapping open requests are refused at commit", await rejects(() => strictTx((tx) => tx.leaveRequest.create({ data: { number: `${TAG}-o`, employeeId: e1.id, leaveTypeId: sick.id, startDate: shift(S, 7), endDate: shift(S, 7), days: 1, requestedBy: "t" } }))));
  check("DB: a leave day needs its request", await rejects(() => strictTx(async (tx) => {
    const d = await tx.attendanceDay.findFirstOrThrow({ where: { leaveRequestId: sk.id } });
    await tx.attendanceDay.update({ where: { id: d.id }, data: { leaveRequestId: null, version: d.version + 1 } });
    await tx.attendanceDayRevision.create({ data: { attendanceDayId: d.id, revision: d.version + 1, action: "entered", after: {}, changedBy: "t" } });
  })));

  section("8. WHO SEES LEAVE");
  check("the preparer cannot read requests (403)", (await call("ahmed", "GET", "/api/hr/leave/requests")).status === 403);
  const saraAudit = (await call("sara", "GET", `/api/audit?limit=200&q=${TAG}`)).body.logs ?? [];
  check("leave audit rows are hidden from those who do not handle leave", saraAudit.every((l: any) => !["leave_type", "leave_policy", "leave_request"].includes(l.entityType)));
  const audited = new Set((await s.auditLog.findMany({ where: { action: { startsWith: "leave_" }, timestamp: { gte: new Date(Date.now() - 3600_000) } }, select: { action: true } })).map((a) => a.action));
  check("every step is audited", ["leave_type_created", "leave_policy_created", "leave_policy_verified", "leave_allocated", "leave_balance_adjusted", "leave_requested", "leave_approved", "leave_rejected", "leave_withdrawn", "leave_cancelled"].every((a) => audited.has(a)), [...audited]);

  await grant("hr.leave.configure", null);
  await db?.$disconnect();
  finish("HR LEAVE");
}

main().catch(async (e) => { console.error(e); await db?.$disconnect(); process.exit(1); });
