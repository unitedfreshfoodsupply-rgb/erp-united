/* HR phase 1 — employee foundation (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.2–3.3, §6).
   Employment history (append-only, effective-dated, mirrored onto Employee), confidential
   personal data, bank accounts and the document register — with the permission gates on
   the server, audited reads, and the database guarantees attempted directly in SQL. */
import { BASE, call, cookieFor, login, makeChecker } from "./_harness";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./_guard";

const { check, section, finish } = makeChecker();
const TAG = `ZZHRF${Date.now() % 1_000_000_000}`;
const today = (() => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" })); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const shift = (iso: string, days: number) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };
let r: any;

let db: PrismaClient | null = null;
function sql() {
  if (!db) { assertTestDatabase(); db = new PrismaClient(); }
  return db;
}
const rejects = async (q: () => Promise<unknown>) => { try { await q(); return false; } catch { return true; } };

async function upload(who: string, entityId: string, category: string, name: string, bytes: Uint8Array) {
  const form = new FormData();
  form.set("entity_type", "employee"); form.set("entity_id", entityId); form.set("category", category);
  form.set("file", new Blob([bytes as BlobPart], { type: "application/pdf" }), name);
  const res = await fetch(`${BASE}/api/attachments`, { method: "POST", headers: { cookie: cookieFor(who) ?? "" }, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  for (const u of ["admin", "karim", "sara", "ahmed"]) await login(u);

  section("1. EVERY EMPLOYEE HAS EXACTLY ONE OPEN EMPLOYMENT ROW (migration backfill + create)");
  const db1 = sql();
  const withoutOpen = await db1.employee.count({ where: { employments: { none: { effectiveTo: null } } } });
  check("no employee lacks an open employment row", withoutOpen === 0, withoutOpen);
  const dep1 = (await call("karim", "POST", "/api/hr/departments", { code: `${TAG}A`.slice(-12), name: `${TAG} مخازن` })).body.department;
  const dep2 = (await call("karim", "POST", "/api/hr/departments", { code: `${TAG}B`.slice(-12), name: `${TAG} توزيع` })).body.department;
  r = await call("karim", "POST", "/api/hr/employees", { name: `${TAG} سامي`, job_title: "أمين مخزن", department_id: dep1.id, hire_date: shift(today, -400) });
  check("finance creates an employee", r.status === 201, r.body);
  const emp = r.body.employee;
  r = await call("karim", "GET", `/api/hr/employees/${emp.id}`);
  check("the file shows one hire row from the hire date", r.status === 200 && r.body.history.length === 1 && r.body.history[0].event === "hire" && r.body.history[0].effectiveFrom === shift(today, -400) && r.body.current?.status === "active", r.body);
  const mgr = (await call("karim", "POST", "/api/hr/employees", { name: `${TAG} مدير`, department_id: dep1.id })).body.employee;

  section("2. PLACEMENT CHANGES ARE HISTORY, MIRRORED ONTO THE REGISTER");
  let cur = (await call("karim", "GET", "/api/hr/employees")).body.employees.find((e: any) => e.id === emp.id);
  r = await call("karim", "PATCH", `/api/hr/employees/${emp.id}`, { name: cur.name, department_id: dep2.id, expected_version: cur.version, change_reason: "نقل للتوزيع" });
  check("moving department through the register: 200", r.status === 200 && r.body.employee.departmentId === dep2.id, r.body);
  r = await call("karim", "GET", `/api/hr/employees/${emp.id}`);
  check("…writes a transfer row today and closes the hire row yesterday", r.body.history.length === 2 && r.body.history[0].event === "transfer" && r.body.history[0].effectiveFrom === today && r.body.history[1].effectiveTo === shift(today, -1) && r.body.history[0].reason === "نقل للتوزيع", r.body.history);
  r = await call("karim", "POST", `/api/hr/employees/${emp.id}/employment`, { event: "promotion", effective_from: shift(today, 3), job_title: "مشرف", reason: "x" });
  check("a future-dated change is refused (400)", r.status === 400, r.body);
  r = await call("karim", "POST", `/api/hr/employees/${emp.id}/employment`, { event: "promotion", effective_from: shift(today, -10), job_title: "مشرف", reason: "x" });
  check("a change before the open row's start is refused (400)", r.status === 400, r.body);
  r = await call("karim", "POST", `/api/hr/employees/${emp.id}/employment`, { event: "promotion", effective_from: today, job_title: "مشرف مخزن", manager_employee_id: mgr.id, reason: "ترقية" });
  check("a same-day promotion supersedes today's transfer row (201)", r.status === 201, r.body);
  r = await call("karim", "GET", `/api/hr/employees/${emp.id}`);
  const live = r.body.history.filter((h: any) => !h.superseded);
  const ranges = live.map((h: any) => [h.effectiveFrom, h.effectiveTo ?? "9999-12-31"]).sort();
  const overlaps = ranges.some((a: string[], i: number) => i > 0 && a[0] <= ranges[i - 1][1]);
  check("…periods never overlap; the superseded transfer is kept and marked, not hidden", !overlaps && live[0].event === "promotion" && live.length === 2 && r.body.history.some((h: any) => h.superseded && h.event === "transfer"), r.body.history);
  check("…the register shows the new title and the manager is recorded", r.body.employee.jobTitle === "مشرف مخزن" && r.body.current.manager?.id === mgr.id, r.body);
  check("an employee cannot manage themselves (400)", (await call("karim", "POST", `/api/hr/employees/${emp.id}/employment`, { event: "transfer", effective_from: today, manager_employee_id: emp.id, reason: "x" })).status === 400);

  section("3. TERMINATION AND RE-HIRE");
  check("termination without a reason -> 400", (await call("karim", "POST", `/api/hr/employees/${emp.id}/employment`, { event: "termination", effective_from: today, reason: "x" })).status === 400);
  r = await call("karim", "POST", `/api/hr/employees/${emp.id}/employment`, { event: "termination", effective_from: today, termination_reason: "استقالة", reason: "استقالة مقبولة" });
  check("termination with a reason: employee becomes inactive", r.status === 201 && (await call("karim", "GET", `/api/hr/employees/${emp.id}`)).body.employee.active === false, r.body);
  check("a transfer after termination is refused (409)", (await call("karim", "POST", `/api/hr/employees/${emp.id}/employment`, { event: "transfer", effective_from: today, department_id: dep1.id, reason: "x" })).status === 409);
  check("no new advance for a terminated employee (400)", (await call("karim", "POST", "/api/hr/transactions", { employee_id: emp.id, type: "advance", amount: 10, cash_account_id: "cash_main" })).status === 400);
  r = await call("karim", "POST", `/api/hr/employees/${emp.id}/employment`, { event: "rehire", effective_from: today, reason: "رجع" });
  check("re-hire makes the employee active again", r.status === 201 && (await call("karim", "GET", `/api/hr/employees/${emp.id}`)).body.employee.active === true, r.body);
  r = await call("karim", "GET", `/api/hr/employees/${emp.id}`);
  check("finance (hr.employees.manage) sees the termination — kept, marked superseded by the same-day re-hire", r.body.history.some((h: any) => h.event === "termination" && h.superseded && h.terminationReason === "استقالة"), r.body.history);

  section("4. WHO SEES THE FILE");
  check("the supervisor cannot open an employee file (403)", (await call("sara", "GET", `/api/hr/employees/${emp.id}`)).status === 403);
  check("the preparer cannot list employees (403)", (await call("ahmed", "GET", "/api/hr/employees")).status === 403);
  check("finance cannot read private data (403) — private data is the owner's until an HR role is decided", (await call("karim", "GET", `/api/hr/employees/${emp.id}/private`)).status === 403);
  check("finance cannot add a bank account (403)", (await call("karim", "POST", `/api/hr/employees/${emp.id}/bank-accounts`, { bank_name: "x", account_number: "1", holder_name: "x", reason: "x" })).status === 403);

  section("5. PRIVATE DATA");
  const nid = `2${String(Date.now()).slice(-13)}`;
  r = await call("admin", "PATCH", `/api/hr/employees/${emp.id}/private`, { national_id: nid, insurance_number: "INS-1", birth_date: "1979-05-01" });
  check("the owner records private data", r.status === 200 && r.body.info.nationalId === nid, r.body);
  check("the same national ID on another employee -> 409", (await call("admin", "PATCH", `/api/hr/employees/${mgr.id}/private`, { national_id: nid })).status === 409);
  check("a stale version -> 409", (await call("admin", "PATCH", `/api/hr/employees/${emp.id}/private`, { address: "x", expected_version: 99 })).status === 409);
  r = await call("admin", "GET", `/api/hr/employees/${emp.id}/private`);
  check("reading the private file works for the owner", r.status === 200 && r.body.info.insuranceNumber === "INS-1", r.body);
  const auditRows = (await call("admin", "GET", `/api/audit?entity=employee&q=${emp.id}&limit=50`));
  const priv = await db1.auditLog.findMany({ where: { entityType: "employee_private", entityId: emp.id } });
  check("every read is audited (employee_private_viewed)", priv.some((a) => a.action === "employee_private_viewed"));
  check("…and audit rows hold field names, never the values", priv.every((a) => !(a.newValue ?? "").includes(nid)) && priv.some((a) => (a.newValue ?? "").includes("nationalId")));
  check("finance cannot see private-data audit rows", auditRows.status === 200 && ((await call("karim", "GET", `/api/audit?q=${emp.id}&limit=100`)).body.logs ?? []).every((l: any) => !String(l.entityType).startsWith("employee_private")));

  section("6. BANK ACCOUNTS — REPLACED, NEVER EDITED");
  r = await call("admin", "POST", `/api/hr/employees/${emp.id}/bank-accounts`, { bank_name: "البنك الأهلي", account_number: "1234 5678 9012", holder_name: `${TAG} سامي`, reason: "حساب المرتب" });
  check("adding an account returns only the masked number", r.status === 201 && r.body.account.accountNumberMasked === "•••• 9012" && r.body.account.accountNumber === undefined, r.body);
  const acc1 = r.body.account.id;
  r = await call("admin", "POST", `/api/hr/employees/${emp.id}/bank-accounts`, { bank_name: "بنك مصر", account_number: "5555000011", holder_name: `${TAG} سامي`, reason: "غيّر البنك" });
  r = await call("admin", "GET", `/api/hr/employees/${emp.id}/private`);
  check("the new account replaces the old one; the old one is kept, inactive", r.body.bankAccounts.length === 2 && r.body.bankAccounts.filter((a: any) => a.active).length === 1 && r.body.bankAccounts.find((a: any) => a.id === acc1)?.active === false, r.body.bankAccounts);
  check("lists never carry the full number", JSON.stringify(r.body).indexOf("5555000011") === -1);
  r = await call("admin", "POST", `/api/hr/employees/${emp.id}/bank-accounts/${acc1}/reveal`, {});
  check("reveal returns the full number and is audited", r.status === 200 && r.body.account.accountNumber === "123456789012" && (await db1.auditLog.count({ where: { entityId: acc1, action: "employee_bank_account_revealed" } })) === 1, r.body);
  check("DB: the account number cannot be edited", await rejects(() => db1.employeeBankAccount.update({ where: { id: acc1 }, data: { accountNumber: "999" } })));
  check("DB: a deactivated account cannot be reactivated", await rejects(() => db1.employeeBankAccount.update({ where: { id: acc1 }, data: { active: true, deactivatedAt: null } })));
  check("DB: accounts cannot be deleted", await rejects(() => db1.employeeBankAccount.delete({ where: { id: acc1 } })));

  section("7. EMPLOYEE DOCUMENTS");
  const pdf = new TextEncoder().encode(`%PDF-1.4\n% ${TAG}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
  check("finance cannot upload to an employee file (403)", (await upload("karim", emp.id, "id_document", "id.pdf", pdf)).status === 403);
  const up = await upload("admin", emp.id, "id_document", "id.pdf", pdf);
  check("the owner uploads an ID copy to the employee file", up.status === 201 || up.status === 200, up.body);
  r = await call("admin", "POST", `/api/hr/employees/${emp.id}/documents`, { attachment_id: up.body.attachment.id, doc_type: "id_document", document_number: "A1234567", issue_date: shift(today, -100), expiry_date: shift(today, 20) });
  check("the document is registered with its expiry", r.status === 201, r.body);
  check("registering the same attachment twice -> 409", (await call("admin", "POST", `/api/hr/employees/${emp.id}/documents`, { attachment_id: up.body.attachment.id, doc_type: "id_document" })).status === 409);
  check("an attachment from another record is refused (400)", (await call("admin", "POST", `/api/hr/employees/${mgr.id}/documents`, { attachment_id: up.body.attachment.id, doc_type: "other" })).status === 400);
  r = await call("admin", "GET", "/api/hr/documents/expiring");
  check("the expiring-documents list includes it", r.status === 200 && r.body.documents.some((d: any) => d.employee.id === emp.id), r.body);
  check("finance cannot list expiring private documents (403)", (await call("karim", "GET", "/api/hr/documents/expiring")).status === 403);

  section("8. DATABASE GUARANTEES ON THE HISTORY");
  const open = await db1.employeeEmployment.findFirstOrThrow({ where: { employeeId: emp.id, effectiveTo: null } });
  check("DB: history rows cannot be deleted", await rejects(() => db1.employeeEmployment.delete({ where: { id: open.id } })));
  check("DB: a history row's content cannot be edited", await rejects(() => db1.employeeEmployment.update({ where: { id: open.id }, data: { jobTitle: "x" } })));
  check("DB: a second open row for the same employee is refused", await rejects(() => db1.employeeEmployment.create({ data: { employeeId: emp.id, effectiveFrom: shift(today, 1), event: "transfer", status: "active", reason: "x", createdBy: "test" } })));
  check("DB: a terminated row without a reason is refused", await rejects(() => db1.$transaction(async (tx) => {
    await tx.employeeEmployment.update({ where: { id: open.id }, data: { effectiveTo: shift(today, 0) } });
    await tx.employeeEmployment.create({ data: { employeeId: emp.id, effectiveFrom: shift(today, 1), event: "termination", status: "terminated", reason: "x", createdBy: "test" } });
  })));
  // Like lib/tx.ts inTx: Prisma reports a COMMIT-time (deferred) failure as success, so the
  // deferred checks are forced to run inside the transaction.
  check("DB: overlapping periods are refused (deferred check)", await rejects(() => db1.$transaction(async (tx) => {
    await tx.employeeEmployment.update({ where: { id: open.id }, data: { effectiveTo: shift(today, 5) } });
    await tx.employeeEmployment.create({ data: { employeeId: emp.id, effectiveFrom: shift(today, 2), event: "transfer", status: "active", reason: "x", createdBy: "test" } });
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
  })));
  check("…and the open row is still open after those failures", (await db1.employeeEmployment.findUnique({ where: { id: open.id } }))?.effectiveTo === null);

  await db?.$disconnect();
  finish("HR FOUNDATION");
}

main().catch(async (e) => { console.error("SUITE CRASHED", e); await db?.$disconnect(); process.exit(2); });
