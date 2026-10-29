/* The business-data reset (scripts/ops/reset-business-data.ts): what it keeps, what it empties,
   and the guards baked into the SQL it runs (or prints for the SQL editor). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { businessTables, mixedTables, resetSql, snapshotSql } from "../../scripts/ops/reset-business-data";

const ALL = ["_prisma_migrations", "Permission", "RolePermission", "User", "UserPermissionOverride", "Account", "CashAccount", "Customer", "Order", "AuditLog", "SystemSetting", "AccountingPeriod", "Integration", "AttendanceSource", "Currency"];

test("permissions, migrations and bootstrap tables are never emptied", () => {
  const b = businessTables(ALL, "admin");
  for (const kept of ["_prisma_migrations", "Permission", "RolePermission", "User", "Account", "CashAccount", "Currency", "AttendanceSource"]) assert.ok(!b.includes(kept), kept);
  for (const gone of ["Customer", "Order", "AuditLog", "SystemSetting", "AccountingPeriod", "Integration"]) assert.ok(b.includes(gone), gone);
});

test("only the named administrator and the reference rows survive in mixed tables", () => {
  const m = Object.fromEntries(mixedTables("admin").map((x) => [x.table, x.keep]));
  assert.equal(m.User, "username = 'admin'");
  assert.match(m.Account, /'acc_1100'/);
  assert.match(m.CashAccount, /'cash_main'.*'bank_main'/);
  assert.equal(m.AttendanceSource, "id = 'att_src_manual'");
});

test("the SQL refuses another database, a missing administrator, and checks again before commit", () => {
  const sql = resetSql(ALL, "admin", "postgres", ["Integration"]);
  assert.match(sql, /current_database\(\) <> 'postgres'/);
  assert.match(sql, /role = 'SUPER_ADMIN' AND active/);
  assert.match(sql, /TRUNCATE TABLE [^;]*"Customer"[^;]* RESTART IDENTITY;/);
  assert.doesNotMatch(sql, /CASCADE/);
  assert.doesNotMatch(sql.match(/TRUNCATE TABLE [^;]*;/)![0], /"Integration"/);
  assert.match(sql, /DELETE FROM "public"\."Integration";/);
  assert.match(sql, /reset aborted: the administrator check failed/);
  assert.match(snapshotSql(ALL, "reset_backup_1"), /REVOKE ALL ON SCHEMA "reset_backup_1" FROM PUBLIC/);
});
