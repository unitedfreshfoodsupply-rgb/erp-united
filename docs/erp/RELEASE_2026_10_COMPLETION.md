# Release checklist — completion program (Oct 2026)

Upgrade from the deployed branch head `origin/united-full-project` (`37f9064`) to this
branch. **Nothing here has been pushed or deployed; no production database was touched.**
Every step below was rehearsed on disposable local databases (§3).

## 1. What changes in the database (14 migrations, all inside `BEGIN`/`COMMIT`)

| Migration | Kind | Effect on existing rows |
|---|---|---|
| `20261027120000_supplier_name_ar` | add nullable column | none |
| `20261027130000_stock_intake_grade_b_product` | add nullable column + FK (idempotent) | none — **fixes the deployed branch**: its `schema.prisma` declares `StockIntake.gradeBProductId` but no migration creates it, so on a database built with `migrate deploy` every stock intake fails (reproduced: HTTP 500, `P2022`) |
| `20261028090000_settlement_deductions` | new tables | none |
| `20261028100000_supplier_service_bills` | new column (default `goods`) + tables | existing bills become `kind = goods` |
| `20261028120000_hr_employee_foundation` | new tables, guards | **inserts** one `EmployeeEmployment` row per existing employee (history starts from the current record) |
| `20261028130000_hr_attendance` | new tables, guards; seeds the `manual` attendance source | none |
| `20261028140000_hr_leave` | new tables, guards | none |
| `20261028150000_hr_compensation` | new tables, guards | none (no component, rate or rule is seeded) |
| `20261028160000_hr_payroll_runs` | new tables, guards; employee-transaction type `salary_on_account` | none |
| `20261029090000_rls_all_public_tables` | RLS on 7 tables + `_prisma_migrations`; revokes table/sequence grants from `anon` / `authenticated` **if those roles exist** | none. The app connects as the table owner (RLS bypassed); attachments use the storage API with the service-role key; nothing in the app uses the anon key. Anything *outside* the app that reads tables with the anon/authenticated key stops working — none is known; check before deploying |
| `20261029100000_hr_payroll_posting` | run posting/reversal columns; payment tables, guards; journal source types | none |
| `20261029110000_order_board_window_index` | index on `Order.updatedAt` | none (on a large `Order` table this takes a lock while building; at current volume it is instant) |
| `20261029120000_revoke_function_execute` | revokes `EXECUTE` on public functions from `PUBLIC` (and `anon` / `authenticated` if they exist), also for functions created later | none. Every public function is a trigger function; triggers keep firing (they need no `EXECUTE` grant). Nothing is reachable through the Data API's `/rpc` |
| `20261029130000_bilingual_names` | nullable `nameAr` on `Employee`, `Department`, `CashAccount` | the two seeded accounts (`cash_main`, `bank_main`), **only if they still carry the seeded Arabic text**, get it moved to `nameAr` and an English `name` (`Main cash`, `Bank account`); every other row is untouched and keeps showing its single name in both languages until the other is entered |

## 2. Release steps

1. **Backup** (`BACKUP_RESTORE.md`): confirm point-in-time recovery is on, take the logical dump, note its timestamp. Do not proceed without it.
2. **Pre-flight on a copy**: restore the dump into a scratch database and run step 3 there first (the rehearsal in §3, on real data).
3. `npx prisma migrate deploy` (with `DIRECT_URL`). Expect 14 migrations.
4. `npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` → exit 0.
5. `npm run db:sync-permissions` → "79 permissions defined, 79 stored". New permissions: `hr.payroll.post`, `hr.payroll.pay` (ACCOUNTANT by default) plus the HR permissions of phases 1–5.
6. Deploy the build; `GET /api/health` → `{"status":"ok"}`.
7. Verify in the app (signed in as an administrator):
   * الحسابات → سلامة الحسابات: all green (now includes payroll and waste-awaiting-write-off lines).
   * Management → cash flow: the "net cash flow" equals the cash and bank change (the statement now balances by construction).
   * One stock intake on a test product (the Grade-B column fix).
   * Orders boards load and show open orders plus the last 7 days.
   * Switch the language (top bar): customer, product, employee, department and cash-account names follow it; dropdowns show names without codes.
8. **Compression**: confirm JSON responses are gzip-compressed by the host/proxy (`curl -H 'accept-encoding: gzip' -D - …/api/orders` → `Content-Encoding: gzip`); see `PERFORMANCE_AND_COST.md` §3.1.

## 3. Rehearsal evidence (29 Oct 2026, local PostgreSQL 16, disposable databases)

| Rehearsal | Result |
|---|---|
| **A — from empty**: `migrate deploy` of all 62 migrations (repeated with 64 on 29 Oct after R1/R2: 3.1 s, exit 0, drift none, seed + permissions OK, RLS on every table) | 3.1 s, exit 0; drift against `schema.prisma` = none; `db:seed` + `db:sync-permissions` OK; every public table has RLS (0 without); `db-security` suite 4/4 |
| **B — from the deployed branch**: built `37f9064` in an isolated worktree with its own install, applied its migrations, loaded its fixtures and ran its own suites against its own server (orders 175/175, sales 190/193, HR 22/22; its stock/inventory/purchasing suites crash on the missing Grade-B column — the defect fixed by `20261027130000`); then applied this branch's 12 migrations | 2.0 s, exit 0; drift = none; every business table kept its row count (only `Permission` 63→79, `RolePermission` 154→180, `_prisma_migrations` 50→62 changed); this branch's server on the upgraded data: health, orders, daily report, Accounts Health (all green), trial balance, invoices, payroll, stock, audit, cash flow (balanced), settings all HTTP 200; `db-security` 4/4 |
| **C — the two R1/R2 migrations on existing data**: a database at the state before them (62 migrations, the migrations' own seeded cash accounts, `bank_main` renamed by hand) | 1.8 s, exit 0; drift none; `cash_main` → `Main cash` / `الخزينة الرئيسية`; the hand-renamed `bank_main` untouched; no public function executable by `PUBLIC` or `anon` |

## 4. Rollback and recovery

* Migrations are additive; there is no down migration. **Rollback = restore** the backup
  from step 1 into a new database and point the previous build at it
  (`BACKUP_RESTORE.md`). Documents created between the upgrade and the rollback are lost,
  so decide go/no-go within the verification window of step 7, before users post work.
* If only the app build is faulty (database fine), redeploy the previous build: every new
  column is nullable or defaulted and the previous code does not read the new tables. (With
  the Grade-B column now present, the previous build's stock intake also works.)
* Payroll: nothing posts until the accountant configures accounts (posting is refused
  while any is missing), so a rollback cannot leave half-posted payroll.

## 5. Inputs required before the new functions are used in production

| Input | Who | Until then |
|---|---|---|
| Statutory payroll rules (social insurance, income tax, overtime, proration, levies) with their official sources, verified by a second person | accountant / HR (HR_PAYROLL_GAP_AUDIT §7) | payroll runs calculate but refuse submission |
| Pay component accounts and the net-salaries account (`hr.payroll_net_pay_account`) | accountant | posting refused, preview lists what is missing |
| Withholding / bank-charge / write-off accounts (settlement deductions) | accountant | those deductions are not offered |
| ETA credentials and e-seal bridge | owner / accountant | e-invoice submission refused (503) |
| Bank upload format for salary transfers, if the bank requires one | bank | use the generic bank list CSV |
| Role decisions for HR approvals and private data (HR audit §12 P1–P3) | owner | those stay with the super admin |
| The second-language name of existing employees, departments and cash accounts (only one name was stored before) | HR / accountant, as data entry | the single existing name shows in both languages |
