# UNITED ERP — Production deployment runbook (accounting release)

> **Status: prepared, NOT executed.** Every step below needs the owner's separate, explicit
> approval. Nothing in this document has been run against production.

**What is being deployed.**
- **Code:** branch `ui/enterprise-ux`, at the commit named in `FINAL_ACCEPTANCE_REPORT.md` §9.
- **Currently live:** `release/2026-10-29` (`8f01e96`). PM2 app `united-erp`, port 3000 behind
  Nginx Proxy Manager. Supabase PG17 project `exzdzjyqwfvpvqqaadzh`, with 69 migrations applied.

**Hard rules, carried over.**
- Do not kill or update the PM2 daemon.
- Do not delete the `united-erp` PM2 app.
- Do not touch the app on port 3111.
- Do not change the Nginx or reverse-proxy configuration.
- Do not purchase or upgrade any service.
- Never print credentials or connection strings.

## 0. Roles and window

| Role | Who | Needed for |
|---|---|---|
| Operator | Person with VPS shell and `DIRECT_URL` | Steps 2–7 |
| Approver | Owner | Go decision at step 0, and go/rollback at step 8 |
| Finance tester | Finance manager | Step 8 checks |

**Expected downtime.**
- **Normal path: about 1–2 minutes** of degraded service at the switch (step 6). The new build
  is started and checked on a trial port before the switch.
- **Migration:** 8 additive migrations, under 10 seconds on current production volumes.
  - They take short exclusive locks on the tables they alter: Account, CashAccount, JournalEntry
    (CHECK re-validation), JournalLine, AccountingPeriod, Expense, SupplierBillServiceLine, plus
    9 index builds.
  - **Run it in a quiet window** (before the morning shift or after dispatch). Postings that
    arrive during those seconds wait, then continue.

## 1. Preconditions (stop if any is not met)

- [ ] The business configuration in `BUSINESS_CONFIGURATION_CHECKLIST.md` has been approved.
      Settings can be entered right after deployment, but approvals and finance users must exist
      before finance starts using the new features.
- [ ] At least **two finance users** are planned (C10).
- [ ] The branch head named in the acceptance report is the one being built (`git rev-parse HEAD`).
- [ ] CI is green on that commit, or the local evidence in the acceptance report §8 is accepted.

## 2. Backup and restore verification (mandatory before migrating)

1. **No automatic backup exists.** The project is on the Supabase **free plan**, which has no
   automatic daily backups (verified 1 Nov 2026). The manual dump below is the only backup.
   It must be taken, and restore-checked, immediately before migrating. The exact commands, with
   the expected counts, are in `DEPLOYMENT_APPROVAL_PACKAGE.md` §4.1. `pg_dump` must be
   version 17.x for the Postgres 17 server.
2. **Logical dump** from the VPS, using `DIRECT_URL` from the environment and never echoing it:
   ```bash
   pg_dump "$DIRECT_URL" --no-owner --no-acl -Fc -f ~/backups/united-pre-accounting-$(date +%Y%m%d-%H%M).dump
   ```
3. **Restore check.** Prove the dump is usable. Run this against a scratch local database or
   another non-production one; **never against production**:
   ```bash
   pg_restore --list ~/backups/united-pre-accounting-*.dump | head        # catalogue readable
   createdb united_restore_check && pg_restore --no-owner -d united_restore_check ~/backups/united-pre-accounting-*.dump
   psql -d united_restore_check -c 'SELECT count(*) FROM "_prisma_migrations";'   # 69
   psql -d united_restore_check -c 'SELECT count(*) FROM "JournalEntry";'          # same as production
   dropdb united_restore_check
   ```
4. Record the dump file name, its size, and the restore-check counts in the change log.

## 3. Read-only preflight (production)

Run against production. It is read-only:
```bash
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/ops/gap-closure-preflight.sql
```
**Every section must show 0 rows.** The sections cover:
- account codes and system keys free;
- parent accounts present;
- one cash account per GL account;
- no half-applied objects;
- none of the gap-closure migrations applied, and none failed;
- journal source types valid.

Also run:
```sql
SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;   -- 69
SELECT migration_name FROM "_prisma_migrations" WHERE migration_name >= '20261030130000';  -- 0 rows
```
If any section returns rows, **stop**. The fix is a data decision (for example, renumber a
user-created account 1700), taken with the owner.

## 4. Build the release (no impact on the live app)

```bash
cd /home/hermes/releases && git clone --branch ui/enterprise-ux <repo> united-<sha> && cd united-<sha>
git rev-parse HEAD            # must equal the accepted commit
cp ../united-8f01e96/.env.local .env.local     # same environment; do not print it
npm ci && npx prisma generate && npm run build
```

## 5. Migrate and seed permissions

```bash
npx prisma migrate deploy          # expect exactly 8 to apply:
#  20261030130000_fk_indexes, 20261030131000_function_search_path,
#  20261031100000_cash_bank_and_cash_flow, 20261031110000_vat_returns_and_journal_approval,
#  20261031120000_fiscal_years, 20261031130000_fixed_assets,
#  20261031140000_opening_batches, 20261031150000_cost_centers
npx prisma migrate status          # "Database schema is up to date"
npm run db:sync-permissions        # adds the 5 new permissions; idempotent
```
- **If `migrate deploy` fails part-way:** stop and follow the rollback runbook §2. Prisma applies
  each migration in its own transaction, so a failed one leaves nothing half-written.
- The **old build keeps working** against the migrated schema, because every change is additive.
  The live app does not need to stop for the migration.

## 6. Start on a trial port, then switch

```bash
pm2 start npm --name united-<sha> -- start -- -p 3200      # new app, trial port
curl -fsS http://127.0.0.1:3200/api/health                   # {"status":"ok"}
node scripts/ops/warm-up.mjs http://127.0.0.1:3200
```
Smoke-test on the trial port (signed in as the administrator):
- Accounting → Health check is green.
- Cash & Banks lists the existing accounts with their balances.
- `/assets` opens.
- The VAT tab shows "no returns yet".
- Comparatives & ratios opens.

**Switch:** serve port 3000 from the new build, as in `RELEASE_ENTERPRISE.md` §5:
- stop `united-erp` (**stop, never delete**);
- start the new build on port 3000;
- stop the trial instance.

## 7. Post-deployment validation (first 30 minutes)

- [ ] `GET https://erp.united-ffv.com/api/health` → 200.
- [ ] The administrator signs in. The Arabic/English switch works. There are no raw dictionary
      keys.
- [ ] Accounting → Health check green.
- [ ] Trial balance balances for the current year.
- [ ] Balance sheet balances.
- [ ] Cash flow says balanced.
- [ ] Comparatives open.
- [ ] Integrity "traceability" is green.
- [ ] Settings page lists the new accounting settings at their defaults. **Nothing is switched
      on.**
- [ ] Permissions: Super Admin holds `accounting.periods.reopen`, `accounting.journals.approve`,
      `accounting.opening.approve`, `accounting.assets.view` and `accounting.assets.manage`.
- [ ] Database logs show no new errors.
- [ ] Response times are as before (home and orders under the Sprint-0 baseline).
- [ ] The old PM2 app `united-erp` is present and **stopped**.

## 8. Hand-over to finance (after the technical checks)

1. Create the finance users (C10) and assign their roles.
2. Enter the approved settings (C1–C18). Each change asks for a reason and is audited.
3. Create cost centres (C5) and asset categories (C6).
4. Opening balances: prepare the batch, validate it (difference 0), submit it, and have the
   finance manager approve it. Then run the Health check, which must be green.
5. Keep the old app stopped (not deleted) for at least one full month-end cycle.

## Operational risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Preflight finds a conflicting account code | Low (production was reset 29 Oct) | Stop. Renumber with the owner's approval and re-run the preflight. |
| A posting arrives during the migration's table locks | Low | Quiet window. Locks last seconds, and requests wait rather than fail. |
| Finance cannot complete approvals (one user only) | Medium if C10 is ignored | Create two finance users before using reopen, opening and approval features. |
| A setting enabled without decision (e.g. cost centre required) blocks expense entry | Low | Settings change only with a reason; revert in Settings. |
| E-invoicing switched on before the ETA pre-production run | — | ETA stays off. See gap register L9. |
| Rollback needed after finance has used the new features | — | Roll back the **application only** (rollback runbook §1). The database stays. |
