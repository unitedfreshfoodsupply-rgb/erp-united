# UNITED ERP — Remediation release, deployment and rollback plan (November 2026)

> **Superseded in part (3 Nov 2026).** The release is now `maturity/2026-11` with **18 migrations, 77 → 95**. §0 and §3 below describe the earlier set of 14 (77 → 91) and are kept for history; use `PRODUCTION_MIGRATION_PLAN_2026-11.md` for the migration set, preconditions, runbook gates and rollback limits.

Status: **prepared, not executed.** Production is untouched. Every step below needs the
owner's go-ahead and someone with VPS and Supabase access; the agent that prepared it
has neither and never types credentials.

## 0. What is being deployed

| Item | Value |
|---|---|
| Baseline in production | code `f6c7613` (tip `7991d66`, branch `ui/enterprise-ux`), 77 migrations |
| Release branch | `integration/2026-11` (merges WS1/2 sales-stock-controls, WS3 accounting, WS4 ETA, WS5 HR, WS6 security, test migration) |
| New migrations | all additive; listed in §3 (applied in timestamp order by `prisma migrate deploy`) |
| New env vars | `MFA_ENCRYPTION_KEY` (**required** in production, ≥ 32 chars); optional `BACKUP_MARKER_FILE`; ETA vars stay empty (ETA off) |
| New permissions | `purchasing.requests.view/create/approve`, `sales.pricing.approve` → run `npm run db:sync-permissions` |
| Recovery point | `~/UNITED_FINAL_BACKUP_20261102` (restore-tested). Take a **fresh** dump immediately before migrating (§2.3) |

## 1. Behaviour changes users will notice on day one

1. **MFA**: SUPER_ADMIN and ACCOUNTANT must enrol an authenticator app at their next
   sign-in before anything else works. Prepare phones; create a second SUPER_ADMIN first.
   (Gentler rollout: set `auth.mfa_required_roles` to `[]` right after deploy, let people
   enrol, then restore the default.)
2. **Orders**: a line is confirmed only if the stock is sellable now and it is reserved at
   once; otherwise the screen offers a purchase request. Dispatch with a shortfall is
   refused. The integration (n8n) intake gets 409 for unmapped or unavailable lines — the
   flow must handle that answer.
3. **Approvals by a second person** (on by default): stock adjustments, grading losses
   (stock waits in QUAR), manual journals, cash transfers, purchase requests, price
   exceptions, payroll steps. With only one user, a SUPER_ADMIN may self-approve **only**
   with a written reason — audited and broadcast. **Create the accountant and finance
   manager users before go-live.**
4. **Invoices** need a buyer tax identity (card or linked legal entity). In production
   100 of 108 customers already resolve through their legal entity; the cutover report
   (`/api/accounting/cutover-readiness`) lists the 8 that need data.
5. **Direct opening entries are closed**: customer/supplier opening balances go through the
   approved opening batch. The opening stock already posted directly is recognised; the
   batch refuses stock lines that would count it twice.
6. **Month close** is refused while waste is still valued in inventory (post a scrap first).
7. **Cash/bank** can never go below zero (database-enforced).
8. **Session cookie SameSite=Strict**, sessions capped at 24 h, new passwords ≥ 10 chars.

## 2. Deployment steps (controlled window, operator on the VPS)

### 2.1 Before the window
1. Rotate the Supabase database password (it was exposed in a chat on 2 Nov 2026) —
   OPERATIONS_RUNBOOK.md §6: reset in the dashboard → update `DATABASE_URL`/`DIRECT_URL`
   in the VPS env → `pm2 restart <app> --update-env` → `/api/health` 200. Do this first,
   on the current release, so a credential problem is not confused with the deploy.
2. Generate `MFA_ENCRYPTION_KEY` on the VPS without displaying it (runbook §1.1) and keep a
   copy in the password manager, separate from backups.
3. Create the second SUPER_ADMIN and the accountant users (current release).
4. Reconcile the one open stock-issue exception — after deploy (§2.6), not before.

### 2.2 Build and rehearse (no production writes)
1. On the VPS: check out `integration/2026-11` at the approved commit into a new release
   directory; `npm ci && npx prisma generate && npm run build`.
2. Rehearsal already done in isolation: the restored production dump migrated to the new
   schema and the full acceptance chain ran green (see `REMEDIATION_REGISTER_2026-11.md` §Evidence).

### 2.3 Backup immediately before migrating
`scripts/ops/backup-pg-dump.sh` (runbook §4) or the same `pg_dump` used for the final
backup; confirm the checksum and table count; keep it with the final backup.

### 2.4 Migrate and sync (production writes — approved step)
```
npx prisma migrate status            # lists exactly the pending migrations in §3
npx prisma migrate deploy
npm run db:sync-permissions          # adds the 4 new permissions, keeps all ids
```

### 2.5 Switch
Trial on port 3200 → `pm2 stop <current>` (never delete it: it is the rollback) → start the
new release on 3000 → `pm2 save`.

### 2.6 Post-deploy validation
1. `/api/health` 200 (now checks the DB); `/api/health/deep` as SUPER_ADMIN: migrations
   shipped = applied, users without MFA, pending approvals.
2. Sign in (MFA enrolment), language switch, accounts health, trial balance, cutover
   readiness report.
3. Reconcile the open exception: order dispatched on 1 Nov with 0 of 20 kg issued, invoice
   fully credited. If nothing physically left: `close_no_movement` + approval by the second
   user. If goods did leave: record the late receipt, then `issue_now` (posts COGS).
4. Business cycle with real master data, small quantities: receive (with grading) → order
   (reserves) → prepare → load → dispatch → invoice → receipt.
5. Supabase advisors: security and performance, no new WARN/ERROR.

## 3. Migrations in this release and their production impact

14 migrations, 77 → 91. Rehearsed on a restored copy of production (2 Nov 2026 dump):
applied cleanly, `migrate status` up to date, `migrate diff` empty, and **all 139 existing
tables byte-identical on their original columns** (row count + md5 of every row).

| Migration | What it does | Touches existing production data? |
|---|---|---|
| 20261102100000_stock_exception_reconciliation | 2 nullable columns on StockIssueException; CHECKs; FK; UPDATE resolutionKind='legacy_note' for already-resolved rows | No (production has 1 open, 0 resolved) |
| 20261102101000_purchase_requests | new table PurchaseRequest + CHECKs/FKs | No |
| 20261102102000_order_pricing_approval | Order.pricingStatus NOT NULL DEFAULT 'ok' + CHECK | Adds a column; the 1 existing order gets 'ok' |
| 20261102103000_ws1_db_security | RLS on PurchaseRequest | No |
| 20261102110000_cash_never_negative | CashAccount.allowOverdraft DEFAULT false; lock trigger + deferred balance trigger on JournalLine | **Behavioural**: every future posting on a cash/bank account is checked. Existing balances: 0 postings on cash/bank in production, so nothing can fail at deploy |
| 20261102111000_cash_functions_security | REVOKE EXECUTE FROM PUBLIC | No |
| 20261102120000_provisional_cost | StockIntake.costProvisional, StockRevaluation table, StockMovement.revaluationId; 4 CHECKs dropped and re-added as strict supersets | Re-validates 4 CHECKs over existing rows (47 movements/layers) — passed in rehearsal |
| 20261102121000_customer_charges | new append-only table | No |
| 20261102122000_account_liquidity | Account.liquidity + CHECK; UPDATE of the new column for system accounts only | Fills a new column on system accounts; no existing value changes (verified) |
| 20261102130000_eta_state_machine | 5 EtaDocument columns; status CHECK replaced by a superset; UUID guard trigger | No (0 ETA documents) |
| 20261102131000_eta_db_security / 131500_eta_function_search_path | REVOKE; pinned search_path | No |
| 20261102140000_hr_ws5_payroll_remediation | 3 tables, 5 columns, 4 CHECKs replaced by supersets, 4 rules added NOT VALID (apply to new rows only), triggers | No (0 payroll rows) |
| 20261102150000_user_mfa | 5 nullable User columns + recovery-code table | Adds columns to the 1 user; MFA enforced by the app on next sign-in |

No migration drops a table or column, deletes rows, or changes an existing value.
Settings: production has 0 `SystemSetting` rows, so the new safe defaults apply at once
(see §1). Permissions: `db:sync-permissions` adds 4 keys and keeps every existing id.

## 4. Rollback

| Situation | Action | Data loss |
|---|---|---|
| New app misbehaves | `pm2 stop <new> && pm2 start <old>`. Rehearsed: the old build on the new schema passes core, orders, stock, workflow, sales, inventory, purchasing, ledger-audit, ETA and security suites. The database keeps enforcing the new rules (cash never negative, payroll segregation): the old screens show a generic error for those refusals | none |
| Schema must go back | restore the pre-migration dump (§2.3) into a new Supabase project or the same one after export of anything written since; never drop columns by hand | writes after the dump must be re-entered |
| Credential rotation broke the connection | restore the previous env file kept by the operator, `pm2 restart --update-env` | none |
| MFA lock-out | second SUPER_ADMIN resets MFA (`/api/admin/users/:id/mfa/reset`); last resort: set `auth.mfa_required_roles` to `[]` in SystemSetting via SQL, audited | none |

## 5. Owner decisions still open (safe defaults are active until decided)
See `REMEDIATION_PLAN_2026-11.md` "Decisions" and the register's "Blocked by decision" list.
