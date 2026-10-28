/* HR and expenses end to end: employees, expenses under / over the approval threshold
   posting to the ledger on approval, and an employee's balance moved by advances,
   reimbursements and expenses — read back from the journal. */
import { call, login, makeChecker } from "./_harness";

const { check, section, finish } = makeChecker();
const TAG = `ZZHR${Date.now() % 1_000_000_000}`;
let r: any;

async function main() {
  for (const u of ["admin", "sara", "ahmed", "mona", "karim"]) await login(u);
  const balance = async (id: string) => (await call("karim", "GET", "/api/hr/employees")).body.employees.find((e: any) => e.id === id)?.balance;
  const acc = (await call("sara", "GET", "/api/hr/expense-accounts")).body.accounts;
  const fuel = acc.find((a: any) => a.code === "6200");

  section("1. EMPLOYEES");
  check("the supervisor cannot add employees -> 403", (await call("sara", "POST", "/api/hr/employees", { name: "x" })).status === 403);
  check("sales cannot record expenses -> 403", (await call("mona", "POST", "/api/hr/expenses", {})).status === 403);
  check("the preparer has no HR access -> 403", (await call("ahmed", "GET", "/api/hr/employees")).status === 403);
  r = await call("karim", "POST", "/api/hr/employees", { name: `${TAG} عم صابر`, job_title: "سواق" });
  check("finance adds an employee (EMP- code)", r.status === 201 && /^EMP-\d{5,}$/.test(r.body.employee.code), r.body);
  const emp = r.body.employee;
  check("expense accounts offered exclude cost-of-sales accounts", fuel && !acc.some((a: any) => a.code === "5100"));

  section("2. EXPENSES AND APPROVAL");
  r = await call("sara", "POST", "/api/hr/expenses", { account_id: fuel.id, amount: 200, description: `${TAG} سولار`, payment_mode: "cash", cash_account_id: "cash_main" });
  check("200 fuel from the cash box: under the threshold, approved and posted", r.status === 201 && r.body.expense.status === "approved", r.body);
  const je = (await call("karim", "GET", "/api/accounting/journals?source_type=expense")).body.journals.find((j: any) => j.description.includes(r.body.expense.number));
  const jd = (await call("karim", "GET", `/api/accounting/journals/${je?.id}`)).body.journal;
  check("…Dr Transport and fuel 200 / Cr Cash 200", jd?.lines.some((l: any) => l.account.code === "6200" && l.debit === "200.00") && jd.lines.some((l: any) => l.account.code === "1100" && l.credit === "200.00"), jd?.lines);
  check("reimburse without an employee -> 400", (await call("sara", "POST", "/api/hr/expenses", { account_id: fuel.id, amount: 10, description: "x", payment_mode: "reimburse" })).status === 400);
  r = await call("sara", "POST", "/api/hr/expenses", { account_id: fuel.id, amount: 1500, description: `${TAG} صيانة عربية دفعها السواق`, payment_mode: "reimburse", employee_id: emp.id });
  check("1500 paid by the driver: waits for approval", r.body.expense?.status === "pending_approval", r.body);
  const big = r.body.expense;
  const ap = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === big.id);
  check("finance cannot approve expenses -> 403 (segregation)", (await call("karim", "POST", `/api/approvals/${ap.id}/decide`, { decision: "approve" })).status === 403);
  check("management approves", (await call("admin", "POST", `/api/approvals/${ap.id}/decide`, { decision: "approve", comment: "تمام" })).status === 200);
  check("…the company now owes the driver 1500", (await balance(emp.id)) === "-1500.00");
  r = await call("sara", "POST", "/api/hr/expenses", { account_id: fuel.id, amount: 900, description: `${TAG} مرفوض`, payment_mode: "reimburse", employee_id: emp.id });
  const ap2 = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((a: any) => a.entityId === r.body.expense.id);
  await call("admin", "POST", `/api/approvals/${ap2.id}/decide`, { decision: "reject", comment: "مش مبرر" });
  check("a rejected expense posts nothing", (await balance(emp.id)) === "-1500.00");
  const mine = (await call("sara", "GET", "/api/hr/expenses")).body.expenses;
  check("the submitter sees their own expenses; finance sees all", mine.every((e: any) => e.createdBy === mine[0].createdBy) && (await call("karim", "GET", "/api/hr/expenses")).body.expenses.length >= mine.length);

  section("3. ADVANCES AND REIMBURSEMENTS");
  check("paying more than is owed -> 400", (await call("karim", "POST", "/api/hr/transactions", { employee_id: emp.id, type: "reimbursement", amount: 2000, cash_account_id: "cash_main" })).status === 400);
  check("reimburse the 1500", (await call("karim", "POST", "/api/hr/transactions", { employee_id: emp.id, type: "reimbursement", amount: 1500, cash_account_id: "cash_main" })).status === 201 && (await balance(emp.id)) === "0.00");
  check("an advance of 1000", (await call("karim", "POST", "/api/hr/transactions", { employee_id: emp.id, type: "advance", amount: 1000, cash_account_id: "cash_main" })).status === 201 && (await balance(emp.id)) === "1000.00");
  check("300 spent from the advance (expense)", (await call("sara", "POST", "/api/hr/expenses", { account_id: fuel.id, amount: 300, description: `${TAG} بنزين من السلفة`, payment_mode: "advance", employee_id: emp.id })).body.expense?.status === "approved" && (await balance(emp.id)) === "700.00");
  check("returning more than is held -> 400", (await call("karim", "POST", "/api/hr/transactions", { employee_id: emp.id, type: "advance_return", amount: 800, cash_account_id: "cash_main" })).status === 400);
  check("the rest returned: settled", (await call("karim", "POST", "/api/hr/transactions", { employee_id: emp.id, type: "advance_return", amount: 700, cash_account_id: "cash_main" })).status === 201 && (await balance(emp.id)) === "0.00");
  const st = (await call("karim", "GET", `/api/hr/employees/${emp.id}/statement`)).body.statement;
  check("the employee statement reads from the journal", st.rows.length === 5 && st.advancesHeld === "0.00" && st.owedToEmployee === "0.00", st);
  check("the supervisor cannot pay employees -> 403", (await call("sara", "POST", "/api/hr/transactions", { employee_id: emp.id, type: "advance", amount: 1, cash_account_id: "cash_main" })).status === 403);

  section("4. CONFIDENTIALITY — WHO SEES WHAT");
  const supList = (await call("sara", "GET", "/api/hr/employees")).body;
  const supEmp = supList.employees.find((e: any) => e.id === emp.id);
  check("the supervisor (expenses only) still gets names to pick from", !!supEmp && supEmp.name === emp.name);
  check("…but no balance, phone, user link or hire date for anyone", supList.employees.every((e: any) => e.balance === undefined && e.phone === undefined && e.userId === undefined && e.hireDate === undefined), supList.employees[0]);
  check("…and only active employees", supList.employees.every((e: any) => e.active === true));
  const finList = (await call("karim", "GET", "/api/hr/employees")).body;
  check("finance sees balances and phones", finList.employees.find((e: any) => e.id === emp.id)?.balance === "0.00");

  section("5. EMPLOYEE EDITS AND DEPARTMENTS");
  const DEP = `Z${Date.now() % 1_000_000}`;
  r = await call("karim", "POST", "/api/hr/departments", { code: DEP.toLowerCase(), name: `${TAG} مخزن` });
  check("finance adds a department (code upper-cased)", r.status === 201 && r.body.department.code === DEP, r.body);
  const dep = r.body.department;
  let cur = (await call("karim", "GET", "/api/hr/employees")).body.employees.find((e: any) => e.id === emp.id);
  r = await call("karim", "PATCH", `/api/hr/employees/${emp.id}`, { name: cur.name, phone: "01000000000", hire_date: "2026-01-15", department_id: dep.id, expected_version: cur.version });
  check("edit with the current version: 200", r.status === 200, r.body);
  check("a stale version is refused -> 409", (await call("karim", "PATCH", `/api/hr/employees/${emp.id}`, { name: cur.name, expected_version: cur.version })).status === 409);
  cur = (await call("karim", "GET", "/api/hr/employees")).body.employees.find((e: any) => e.id === emp.id);
  r = await call("karim", "PATCH", `/api/hr/employees/${emp.id}`, { name: `${TAG} عم صابر الكبير`, expected_version: cur.version });
  const after = (await call("karim", "GET", "/api/hr/employees")).body.employees.find((e: any) => e.id === emp.id);
  check("an edit that sends only the name keeps phone, hire date, job title and department", r.status === 200 && after.phone === "01000000000" && after.hireDate === "2026-01-15" && after.jobTitle === "سواق" && after.departmentId === dep.id, after);
  check("closing a department with active employees -> 409", (await call("karim", "POST", "/api/hr/departments", { code: DEP, name: `${TAG} مخزن`, active: false })).status === 409);
  check("deactivate the employee", (await call("karim", "PATCH", `/api/hr/employees/${emp.id}`, { name: after.name, active: false })).status === 200);
  r = await call("karim", "POST", "/api/hr/departments", { code: DEP, name: `${TAG} مخزن`, active: false });
  check("…then the department closes", r.status === 201 && r.body.department.active === false, r.body);
  r = await call("karim", "POST", "/api/hr/employees", { name: `${TAG} جديد`, department_id: dep.id });
  check("nobody can be added to a closed department -> 400", r.status === 400, r.body);
  check("an inactive employee cannot be given a new advance -> 400", (await call("karim", "POST", "/api/hr/transactions", { employee_id: emp.id, type: "advance", amount: 50, cash_account_id: "cash_main" })).status === 400);
  check("…and the record is kept, marked inactive", (await call("karim", "GET", "/api/hr/employees")).body.employees.find((e: any) => e.id === emp.id)?.active === false);
  check("the supervisor cannot add departments -> 403", (await call("sara", "POST", "/api/hr/departments", { code: "X", name: "x" })).status === 403);
  const log = await call("admin", "GET", `/api/audit?entity=department&q=${dep.id}`);
  const acts = (log.body.logs ?? []).filter((l: any) => l.entityId === dep.id).map((l: any) => l.action);
  check("department changes are audited (created + closed)", log.status === 200 && acts.includes("department_created") && acts.filter((a: string) => a === "department_updated").length >= 1, log.body);

  finish("HR / EXPENSES");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
