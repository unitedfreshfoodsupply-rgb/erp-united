# UNITED ERP — Production migration plan, maturity release (November 2026)

Status: **prepared and rehearsed, not executed.** Nothing in this plan has been run on production. Every production step needs the owner's written go-ahead and an operator with VPS and Supabase access. This plan replaces §0 and §3 of `DEPLOYMENT_PLAN_2026-11.md`, which describe an earlier set of 14 migrations (77 → 91) on `integration/2026-11`.

## 1. What changes in the database

| Item | Value |
|---|---|
| Production today (read-only check, 3 Nov 2026) | PostgreSQL 17.6 on Supabase. 77 migrations applied, each checksum equal to the branch's file. Every table is owned by `postgres` (bypassrls). The `ensure_rls` event trigger enables RLS on every new table. No anon/authenticated grants. One unused sequence (`StockMovement_seq`) is harmless drift |
| Release | branch `maturity/2026-11`, final commit (see the release-readiness report) |
| Pending migrations | **18**, 77 → 95, applied in timestamp order by `prisma migrate deploy` in one run |
| New permissions | 4 keys: `purchasing.requests.view/create/approve`, `sales.pricing.approve` (`npm run db:sync-permissions`; none removed) |
| New env var | `MFA_ENCRYPTION_KEY` (required, at least 32 characters) |

The 18 migrations, in order:

| # | Migration | What it does | Risk on existing data | Reversible? |
|---|---|---|---|---|
| 1 | 20261102100000_stock_exception_reconciliation | 2 nullable columns, CHECKs, FK; UPDATE backfill of resolved rows | 0 rows to backfill (1 open, 0 resolved) | Yes, until kinds are recorded |
| 2 | 20261102101000_purchase_requests | New table | None | Yes (drop table) |
| 3 | 20261102102000_order_pricing_approval | `Order.pricingStatus` NOT NULL DEFAULT 'ok' + CHECK | The 1 order gets 'ok' | Yes |
| 4 | 20261102103000_ws1_db_security | RLS on the new table | None | Yes |
| 5 | 20261102110000_cash_never_negative | Lock trigger + deferred balance trigger on JournalLine; `CashAccount.allowOverdraft` | **Behavioural**: from commit time, any posting that takes a cash or bank account below zero is refused, for the old app too | Technically; removes an approved control |
| 6 | 20261102111000_cash_functions_security | REVOKE EXECUTE (must follow #5) | None | Yes |
| 7 | 20261102120000_provisional_cost | Revaluation table and columns; **4 CHECKs dropped and re-added** as strict supersets | Re-validates 47 movements and 47 layers (passed) | **No** once a revaluation exists |
| 8 | 20261102121000_customer_charges | New append-only table | None | Only while empty |
| 9 | 20261102122000_account_liquidity | `Account.liquidity` + CHECK; UPDATE backfill | **Aborts** if a system account is not an asset or liability (precondition #9) | Yes |
| 10 | 20261102130000_eta_state_machine | 5 columns, CHECK superset, UUID guard trigger | 0 ETA documents | No once ETA is live |
| 11–12 | 20261102131000 / 131500 (ETA security, search_path) | REVOKE; pinned search_path | None | Yes |
| 13 | 20261102140000_hr_ws5_payroll_remediation | 3 tables, columns, 4 CHECKs replaced, 3 rules NOT VALID, partial UNIQUE index, segregation triggers | 0 payroll rows. **Behavioural**: payroll needs a second person, for the old app too | No once figures exist |
| 14 | 20261102150000_user_mfa | 5 nullable User columns, recovery-code table | None (MFA is enforced by the new app) | Yes (users re-enrol) |
| 15 | 20261103100000_standard_costing | **Replaces the trigger function `stock_valuation_append_only`**; new table; CHECKs re-replaced | 0 standard products | No once PPV is posted |
| 16 | 20261103110000_posting_locks | **Replaces `accounting_period_open()`** used by every journal insert | **Behavioural**: closed fiscal years and the lock date refuse postings, for the old app too | Yes |
| 17 | 20261103120000_supplier_payment_approval | New table | None | Yes |
| 18 | 20261103130000_search_normalization | `united_norm(text)`, REVOKE FROM PUBLIC (owner-only) | None; search needs the runtime user to own it | Yes |

No migration drops a table or column, changes a column type, deletes rows or adds NOT NULL to an existing nullable column. Each file is one transaction: a failure rolls that file back and stops the run.

**Data migration or backfill needed:** none beyond what the files do themselves (#1: 0 rows; #3: 1 order; #9: 12 system and cash accounts classified). After deploy, the accountant classifies the remaining 20 accounts as current or non-current; until then the balance sheet shows them as unclassified.

## 2. Rehearsal evidence (3 Nov 2026, local PostgreSQL 17, production untouched)

Source: the verified production dump of 2 Nov (`~/UNITED_FINAL_BACKUP_20261102/db/united-production-20261102T124752Z.dump`, sha256 OK), restored **with owners and ACLs** so that, as on Supabase, the tables belong to the non-superuser `postgres` role (bypassrls), the anon/authenticated/service_role roles exist, and `postgres` owns the database. Evidence: `UNITED_AUDIT_20261102/maturity/evidence/migration-rehearsal-20261103/`.

| Check | Result |
|---|---|
| `migrate deploy` 77 → 95 as `postgres` | All 18 applied; `migrate diff` empty |
| Data preservation (139 pre-existing tables, row count + md5 of every row on the original columns) | 139 of 139 identical |
| New values | `pricingStatus` 'ok' on the 1 order; `allowOverdraft` false on both cash accounts; `priceVariance` 0 everywhere; `resolutionKind` NULL; liquidity on 12 accounts, 20 left for the accountant |
| Trial balance and inventory valuation | identical before and after (inventory 418,281.23; opening equity −418,281.23) |
| Privileges | RLS on all 149 tables; no anon/authenticated grants; `united_norm('إسكندرية')` = 'اسكندريه' as the runtime owner |
| Old build `7991d66` against a fresh database migrated to all 95 (old fixtures) | Green: core 107, orders 180, stock 148, workflow 64, sales 193, inventory 119, purchasing 125, ledger-audit 39, security 69, ETA 28 (after the sales suite, which issues the invoice it needs), fiscal-year 42 (close and reopen under the new posting-lock function), lot-adjustment 13, cost-reconciliation 21. Refused: accounting, business-cycle and hr-payroll stop at a payment from an unfunded bank or cash account: the database rule `cash_account_negative` refuses it and the old code answers 500. Same root cause as the 2 Nov rehearsal |
| Failure injection: a system account retyped as equity | #9 aborts atomically (85 applied, the column absent). Recovery: correct the account, `prisma migrate resolve --rolled-back 20261102122000_account_liquidity`, rerun: 95 applied, `migrate diff` empty |
| Privilege trap found | If the migrating role cannot CREATE in schema `public`, #2 fails with 42501. On Supabase `postgres` owns the database, so it can; precondition P0 now checks it |
| Restore drill | `pg_dump -Fc` of the migrated copy, sha256 recorded and verified, restored into a new database: 149 of 149 tables identical row by row, same objects (56 functions, 92 triggers, 774 constraints, 528 indexes), schema dump identical, 95 migrations recorded |
| New build (final commit) on the migrated copy | See the release-readiness report, §Migration |

## 3. Preconditions (read-only, on production, immediately before the window)

Every result must match. Any deviation stops the window.

- **P0** `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;` → 0 rows. `SELECT count(*) FROM "_prisma_migrations";` → 77.
- **P0** On both the DATABASE_URL and DIRECT_URL connections: `SELECT current_user, has_schema_privilege('public','CREATE'), (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database());` → the same user on both, `true`, and that user.
- **P0** `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname='public';` → one row, that user.
- **P0** `SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('united_norm','united_cash_line_lock','united_cash_never_negative','hr_payslip_signed','hr_payroll_payment_segregation','hr_settlement_frozen','hr_advance_plan_guard','supplier_payment_request_guard');` → 0 rows.
- **#1** `SELECT status, count(*) FROM "StockIssueException" GROUP BY 1;` → open 1, no resolved rows.
- **#5** `SELECT c."code", coalesce(sum(l."debit"-l."credit"),0), count(l."id") FROM "CashAccount" c LEFT JOIN "JournalLine" l ON l."accountId"=c."accountId" GROUP BY 1;` → 2 rows, balance ≥ 0.
- **#7/#15** `SELECT kind, count(*) FROM "StockMovement" GROUP BY 1;` → adjustment 47. `SELECT count(*) FROM "StockIntake";` → 0. `SELECT "costingMethod", count(*) FROM "StockProduct" GROUP BY 1;` → avco only.
- **#9** `SELECT "code" FROM "Account" WHERE "systemKey" IN ('cash','bank','ar','inventory','vat_input','employee_advances','ap','grni','vat_output','employee_payable','vat_payable') AND "type" NOT IN ('asset','liability');` → 0 rows.
- **#10** `SELECT count(*) FROM "EtaDocument";` → 0.
- **#13** `SELECT count(*) FROM "PayrollRun";` → 0. `SELECT count(*) FROM "PayrollPayment";` → 0.
- **#14** `SELECT column_name FROM information_schema.columns WHERE table_name='User' AND column_name LIKE 'mfa%';` → 0 rows.
- **#16** `SELECT code FROM "FiscalYear" WHERE status='closed';` → 0 rows. `SELECT key FROM "SystemSetting";` → 0 rows.
- **#17** `SELECT count(*) FROM "SupplierPayment";` → 0.
- Record the trial balance per account and the inventory valuation (expected today: inventory 418,281.23, opening equity −418,281.23, sum of absolute balances 837,362.46). They must be identical after migrating.

## 4. Runbook (gates in order)

- **G0 Approvals and access (before the window, on the current release).** Owner's written go-ahead for this plan. Rotate the Supabase database password (exposed on 2 Nov; `OPERATIONS_RUNBOOK.md` §6) and confirm `/api/health`. Generate `MFA_ENCRYPTION_KEY` on the VPS without displaying it and keep a copy in the password manager. Create the second SUPER_ADMIN and the accountant user.
- **G1 Build.** On the VPS, check out the approved commit into a new release directory: `npm ci && npx prisma generate && npm run build`.
- **G2 Rehearsal.** Done (§2). Repeat it on a fresh dump if production data changed materially since 2 Nov (any receipt, bill, payroll or ETA row).
- **G3 Backup.** Take a fresh `pg_dump -Fc` (17.x) immediately before migrating. Record its sha256. Restore it into a throwaway database and compare table and row counts. Keep it with the final backup.
- **G4 Preconditions.** Run §3. Stop on any deviation.
- **G5 Stop the old app.** `pm2 stop <current>` (never delete it: it is the rollback). This prevents writes during the window and lock queueing behind open transactions.
- **G6 Migrate.** `npx prisma migrate status` must list exactly the 18 names. Then `npx prisma migrate deploy` over DIRECT_URL. On failure: stop, fix the data cause, `npx prisma migrate resolve --rolled-back <name>`, rerun (rehearsed, §2). Never edit a migration file.
- **G7 Post-checks.** `_prisma_migrations` = 95, `migrate status` up to date, `migrate diff` empty. No table with RLS off. No anon/authenticated grants. `SELECT united_norm('إسكندرية')` on the DATABASE_URL connection returns 'اسكندريه'. Trial balance and inventory valuation identical to G4.
- **G8 Permissions and switch.** `npm run db:sync-permissions`. Start the new build on port 3200, smoke test (sign-in with MFA enrolment, accounts health, trial balance, cut-over readiness, search in Arabic and English, a report), then switch to 3000 and `pm2 save`. Run the Supabase advisors.

## 5. Backward compatibility and rollback limits

| Situation | Action | Limits |
|---|---|---|
| New app misbehaves | Start the old build again (`pm2`). Rehearsed on all 95 migrations (§2) | Data-safe, but the database keeps enforcing cash-never-negative, payroll segregation and the posting locks; the old screens show a generic error for those refusals. The old app does not enforce MFA, payment approval, purchase requests or price exceptions |
| Schema must go back | Restore the G3 dump | Everything written after the dump must be re-entered |
| Single migration, emergency only | Down SQL in the assessment (D1–D18), in reverse order, then delete the `_prisma_migrations` row | Not rehearsed; #7, #8, #10, #13 and #15 cannot be reversed once the new app has written their rows |

## 6. Decisions this plan needs

| Decision | Recommended | Who approves |
|---|---|---|
| Apply all 18 migrations in one window with the old app stopped | Yes | Owner (the SUPER_ADMIN holder with production authority); the operator executes |
| Accept that the database-enforced controls (cash never negative, payroll segregation, posting locks) apply at migrate time | Yes; they are approved controls | Owner |
| Which bank accounts, if any, may go into overdraft (with the bank's written facility) | None until the accountant says otherwise | Chief accountant, countersigned by the owner |
| Liquidity classification of the 20 unclassified accounts | After deploy | Chief accountant |
