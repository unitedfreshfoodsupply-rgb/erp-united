/* Writing many attendance days at once (Nov 2026): a payroll run locked and unlocked its days one
   by one (2–3 statements each), and the register / device compile wrote them one by one, so a
   month for ~10 employees ran past the 20 s transaction limit on production latency. The batched
   writers must leave exactly the rows writeDay leaves — days, versions and revisions — in a fixed
   number of statements, and refuse a day changed meanwhile with the same 409. Every scenario runs
   in a transaction that is rolled back after the deferred checks (a version needs its revision). */
import { countQueries } from "./_query-count";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AttendanceDay } from "@prisma/client";
import { prisma, inTx, actor } from "./_db";
import type { Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { createHireRecord } from "@/lib/hr/employment";
import { writeDay, writeDayStates, writeDayValues } from "@/lib/hr/attendance";
import { unlockAttendance } from "@/lib/hr/payroll";

const TAG = `ZZATT${Date.now()}`;
const hr = actor("موارد بشرية", ["hr.attendance.record", "hr.employees.manage"], null, "HR");
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const today = todayLocalISO();

after(async () => { await prisma.$disconnect(); });

class Rollback extends Error {}
async function rolledBack(fn: (tx: Tx) => Promise<void>) {
  await assert.rejects(inTx(async (tx) => { await fn(tx); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; throw new Rollback(); }), (e) => { if (e instanceof Rollback) return true; throw e; });
}

let serial = 900_000_000 + Math.floor(Math.random() * 90_000_000);
async function employees(tx: Tx, n: number, label: string) {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const e = await tx.employee.create({ data: { code: `EMP-${serial++}`, name: `${TAG} ${label} ${i}`, hireDate: shift(today, -90) } });
    await createHireRecord(tx, e, hr);
    out.push(e.id);
  }
  return out;
}

const minutes = (worked: number) => ({ workedMinutes: worked, lateMinutes: 5, earlyLeaveMinutes: 0, overtimeDayMinutes: 30, overtimeNightMinutes: 0, overtimeRestDayMinutes: 0, overtimeHolidayMinutes: 0 });
const present = (date: string, worked: number, notes: string | null) => ({
  status: "present", firstIn: new Date(`${date}T06:05:00.000Z`), lastOut: new Date(`${date}T14:30:00.000Z`), notes, source: "manual", ...minutes(worked),
});
const dates = (n: number) => Array.from({ length: n }, (_, i) => shift(today, -10 - i));

/** A day and its revisions without what differs between two employees (ids, times). */
async function shape(tx: Tx, employeeIds: string[]) {
  const days = await tx.attendanceDay.findMany({ where: { employeeId: { in: employeeIds } }, include: { revisions: { orderBy: { revision: "asc" } } } });
  const index = new Map(employeeIds.map((id, i) => [id, i]));
  const clean = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));
  return days
    .map(({ id: _id, employeeId, createdAt: _c, updatedAt: _u, revisions, ...rest }) => ({
      who: index.get(employeeId), ...rest,
      revisions: revisions.map(({ id: _rid, attendanceDayId: _d, changedAt: _a, before, after, ...r }) => ({ ...r, before: clean(before), after: clean(after) })),
    }))
    .sort((a, b) => a.who! - b.who! || a.date.localeCompare(b.date));
}

const run = (tx: Tx, n: number) => tx.payrollRun.create({
  data: { number: `${TAG}-RUN-${n}`, period: "2099-12", runType: "off_cycle", attendanceFrom: shift(today, -80), attendanceTo: today, preparedBy: "test" },
});

test("batched day writes leave exactly the rows writeDay leaves: entered, re-entered, confirmed, locked, unlocked", async () => {
  await rolledBack(async (tx) => {
    const [a, b] = [await employees(tx, 3, "A"), await employees(tx, 3, "B")];
    const ds = dates(4);
    const entries = (ids: string[], worked: number, notes: string | null) => ids.flatMap((employeeId) => ds.map((date) => ({ target: { employeeId, date }, values: present(date, worked, notes) })));
    const daysOf = async (ids: string[]) => tx.attendanceDay.findMany({ where: { employeeId: { in: ids } }, orderBy: [{ employeeId: "asc" }, { date: "asc" }] });

    // First entry (creates), then a changed entry (updates) — one by one for A, batched for B.
    for (const e of entries(a, 480, null)) await writeDay(tx, null, e.target, e.values, { action: "entered" }, hr);
    await writeDayValues(tx, entries(b, 480, null).map((e) => ({ existing: null, ...e })), { action: "entered" }, hr);
    const bySlot = (rows: AttendanceDay[]) => new Map(rows.map((d) => [`${d.employeeId}|${d.date}`, d]));
    const oldA = bySlot(await daysOf(a));
    for (const e of entries(a, 450, "تأخير")) await writeDay(tx, oldA.get(`${e.target.employeeId}|${e.target.date}`)!, e.target, { ...e.values, source: "device" }, { action: "compiled" }, hr);
    const oldB = bySlot(await daysOf(b));
    await writeDayValues(tx, entries(b, 450, "تأخير").map((e) => ({ existing: oldB.get(`${e.target.employeeId}|${e.target.date}`)!, ...e, values: { ...e.values, source: "device" } })), { action: "compiled" }, hr);
    assert.deepEqual(await shape(tx, b), await shape(tx, a), "entered and re-entered days");

    // Confirm, lock to a run, then unlock (with an approved correction waiting for a retro adjustment).
    for (const d of await daysOf(a)) await writeDay(tx, d, d, { state: "confirmed" }, { action: "confirmed" }, hr);
    await writeDayStates(tx, await daysOf(b), { state: "confirmed" }, { action: "confirmed" }, hr);
    const [runA, runB] = [await run(tx, 1), await run(tx, 2)];
    for (const d of await daysOf(a)) await writeDay(tx, d, d, { state: "locked", lockedRunId: runA.id }, { action: "locked", reason: runA.id }, hr);
    await writeDayStates(tx, await daysOf(b), { state: "locked", lockedRunId: runB.id }, { action: "locked", reason: runB.id }, hr);
    const lockedA = await shape(tx, a), lockedB = await shape(tx, b);
    const runless = (s: typeof lockedA, id: string) => JSON.parse(JSON.stringify(s).replaceAll(id, "RUN"));
    assert.deepEqual(runless(lockedB, runB.id), runless(lockedA, runA.id), "confirmed and locked days");

    const correction = (employeeId: string, date: string, n: string) => tx.attendanceCorrection.create({
      data: { number: `${TAG}-${n}`, employeeId, date, requested: {}, reason: "test", status: "approved", retroStatus: "pending", requestedBy: "test", decidedBy: "approver", decidedAt: new Date(), appliedRevision: 2 },
    });
    const [cA, cB, cOther] = [await correction(a[1], ds[2], "CA"), await correction(b[1], ds[2], "CB"), await correction(b[1], shift(today, -70), "CX")];
    for (const d of await tx.attendanceDay.findMany({ where: { lockedRunId: runA.id } })) {
      await tx.attendanceCorrection.updateMany({ where: { employeeId: d.employeeId, date: d.date, status: "approved", retroStatus: "pending" }, data: { retroStatus: "none" } });
      await writeDay(tx, d, d, { state: "confirmed", lockedRunId: null }, { action: "unlocked", reason: runA.id }, hr);
    }
    await unlockAttendance(tx, runB.id, hr);
    assert.deepEqual(runless(await shape(tx, b), runB.id), runless(await shape(tx, a), runA.id), "unlocked days");
    const retro = async (id: string) => (await tx.attendanceCorrection.findUniqueOrThrow({ where: { id } })).retroStatus;
    assert.equal(await retro(cA.id), "none");
    assert.equal(await retro(cB.id), "none", "the run's correction no longer needs a retro adjustment");
    assert.equal(await retro(cOther.id), "pending", "a correction of a day outside the run is left alone");
  });
});

test("a day changed meanwhile is refused with the same 409, whichever writer", async () => {
  const conflict = (e: unknown) => (e as { status?: number }).status === 409 && /اتغيّر من واحد تاني/.test((e as Error).message);
  // Each refusal in its own transaction, rolled back as the request's would be.
  const refused = (write: (tx: Tx, stale: AttendanceDay[]) => Promise<unknown>) => assert.rejects(inTx(async (tx) => {
    const ids = await employees(tx, 2, "S");
    const date = dates(1)[0];
    await writeDayValues(tx, ids.map((employeeId) => ({ existing: null, target: { employeeId, date }, values: present(date, 480, null) })), { action: "entered" }, hr);
    const days = await tx.attendanceDay.findMany({ where: { employeeId: { in: ids } }, orderBy: { employeeId: "asc" } });
    await write(tx, days.map((d, i) => (i === 1 ? { ...d, version: d.version + 7 } : d)));
    throw new Rollback();
  }), conflict);
  await refused((tx, stale) => writeDayStates(tx, stale, { state: "confirmed" }, { action: "confirmed" }, hr));
  await refused((tx, stale) => writeDayValues(tx, stale.map((d) => ({ existing: d, target: d, values: present(d.date, 400, null) })), { action: "entered" }, hr));
  await refused((tx, stale) => writeDay(tx, stale[1], stale[1], { state: "confirmed" }, { action: "confirmed" }, hr));
});

test("statements are constant in the number of days: 5 vs 50 (enter, re-enter, confirm, lock, unlock)", async () => {
  async function measure(n: number) {
    const counts: Record<string, number> = {};
    await rolledBack(async (tx) => {
      const ids = await employees(tx, n, `N${n}`);
      const date = dates(1)[0];
      const daysOf = () => tx.attendanceDay.findMany({ where: { employeeId: { in: ids } } });
      counts.enter = (await countQueries(() => writeDayValues(tx, ids.map((employeeId) => ({ existing: null, target: { employeeId, date }, values: present(date, 480, null) })), { action: "entered" }, hr))).queries;
      const cur = await daysOf();
      counts.reenter = (await countQueries(() => writeDayValues(tx, cur.map((d) => ({ existing: d, target: d, values: present(date, 470, "x") })), { action: "entered" }, hr))).queries;
      const drafts = await daysOf();
      counts.confirm = (await countQueries(() => writeDayStates(tx, drafts, { state: "confirmed" }, { action: "confirmed" }, hr))).queries;
      const r = await run(tx, n);
      const confirmed = await daysOf();
      counts.lock = (await countQueries(() => writeDayStates(tx, confirmed, { state: "locked", lockedRunId: r.id }, { action: "locked", reason: r.id }, hr))).queries;
      counts.unlock = (await countQueries(() => unlockAttendance(tx, r.id, hr))).queries;
      const final = await daysOf();
      assert.equal(final.length, n);
      assert.ok(final.every((d) => d.state === "confirmed" && d.version === 5 && d.lockedRunId === null));
      assert.equal(await tx.attendanceDayRevision.count({ where: { attendanceDayId: { in: final.map((d) => d.id) } } }), 5 * n);
    });
    return counts;
  }
  const small = await measure(5), large = await measure(50);
  assert.deepEqual(large, small, `statements per step: 5 days ${JSON.stringify(small)}, 50 days ${JSON.stringify(large)}`);
  assert.ok(Object.values(large).every((q) => q <= 4), JSON.stringify(large));
});
