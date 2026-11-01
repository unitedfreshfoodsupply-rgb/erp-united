# UNITED ERP — Production deployment record, 1 Nov 2026

Release: **`90791c1`** on `ui/enterprise-ux`. Approval: the owner's written go-ahead
(8 reviewed migrations 69 → 77, the 5 reviewed permissions, backup first).

| Step | Status |
|---|---|
| Backup before the first migration | **Done.** Two independent copies, restore-tested (below) |
| 8 migrations, 69 → 77 | **Done.** Applied and verified |
| Permission sync, 79 → 84 | **Done.** Applied and verified |
| Database integrity checks | **Done.** All pass |
| Build and switch the application to `90791c1` | **Not done.** No VPS shell from the deploying session (see §5) |
| Health, sign-in and smoke checks on erp.united-ffv.com | **Not done.** The domain is unreachable from the deploying session (proxy 403) |

The live application is still release **`8f01e96`** (PM2 `united-erp`, port 3000). It now
runs on the 77 schema. That combination was tested before migrating: the 8f01e96 build ran
against a 77 database and passed 15 suites, 1,745 checks, 0 failures and 0 server errors.
Production is therefore in a safe intermediate state. The new accounting screens appear only
after the switch in §5.

## 1. Backup (taken before the first migration)

The Supabase free plan has no automatic backups, and the deploying session had no
`pg_dump` / direct-connection access. The backup was therefore made with SQL, in two layers:

1. **Off-site JSON export.** All 16 non-empty tables, exported 2026-11-01T10:32:45Z.
   `User.passwordHash` is excluded.
   - File: `united-prod-backup-pre-accounting-20261101.json`
   - sha256 `926ddd3e995446e578729b883fc64c4c722044cbf413941645c03ac15782fec0`
   - Delivered to the owner.
   - Restore test: restored into a fresh local 69-migration replica, all 15 table content
     hashes compared against production matched.
2. **In-database copy.** Schema `backup_pre_accounting_20261101` holds full copies of the
   same 16 tables, password hash included.
   - RLS is on for all 16 tables.
   - There are no grants to `anon`, `authenticated` or `PUBLIC`.
   - It is never read by the app. Drop it once the owner signs off on the deployment.

Before migrating, production held no business data: 0 journals, orders, invoices or stock,
and 1 user (SUPER_ADMIN).

## 2. Migrations applied

Each migration ran in its own transaction:
1. Insert its `_prisma_migrations` row, with the sha256 of `migration.sql`.
2. Run the migration SQL, byte-identical to the repository file.
3. Mark the row finished.

This writes exactly the record `prisma migrate deploy` writes. It was verified on a replica,
where `prisma migrate status` reported "Database schema is up to date!" and
`migrate deploy` reported "No pending migrations".

| Migration | sha256 (first 8) | Finished (UTC) |
|---|---|---|
| 20261030130000_fk_indexes | dbf59e95 | 2026-11-01 11:56:59 |
| 20261030131000_function_search_path | 2320c4a8 | 11:57:37 |
| 20261031100000_cash_bank_and_cash_flow | f115c1cd | 11:58:24 |
| 20261031110000_vat_returns_and_journal_approval | 75eaf9b5 | 11:59:22 |
| 20261031120000_fiscal_years | 4a12c066 | 11:59:44 |
| 20261031130000_fixed_assets | 996aab31 | 12:00:57 |
| 20261031140000_opening_batches | 96f35a5e | 12:01:28 |
| 20261031150000_cost_centers | fbd4f977 | 12:01:57 |

Result: 77 applied, 0 unfinished, 0 rolled back. The production schema fingerprint (columns,
constraints, indexes, triggers, functions, RLS) matches a Prisma-built 77 database in all 6
parts. Supabase's own `rls_auto_enable` function is excluded from the comparison.

## 3. Permission sync

`scripts/ops/permissions-sql.ts` generated one transaction equivalent to
`npm run db:sync-permissions`. Before production, it was proven on a copy of production's
Permission/RolePermission rows:
- The SQL result was identical to the app's own sync (`npm run db:sync-permissions`).
- A second run changed nothing.
- All 79 existing permission ids were kept.

| Check (production, after) | Result |
|---|---|
| Permissions | 84 (was 79) |
| Role-permission rows / roles | 194 / 9 (was 186) |
| Catalogue hash | `6d13948b…`, the same as the app's sync |
| Role-permission hash (C collation) | `e165f004…`, the same as the app's sync |
| Existing permission ids kept | 79 / 79 |
| SUPER_ADMIN holds the 5 new keys | `accounting.periods.reopen`, `accounting.journals.approve`, `accounting.opening.approve`, `accounting.assets.view`, `accounting.assets.manage` |

## 4. Database integrity after deployment (read-only)

| Check | Result |
|---|---|
| Accounts | 32. The new control accounts are seeded by the migrations |
| Users / active Super Admins | 1 / 1 (unchanged) |
| Journals, orders, invoices | 0 (no business data imported or fabricated) |
| Cost centers, fixed assets, opening batches, fiscal years | 0 (nothing configured on the owner's behalf) |
| `SystemSetting` rows | 0. Every setting is at its default, and ETA e-invoicing is **not** enabled |
| Public tables / without RLS | 140 / 0 |
| Backup schema tables / without RLS | 16 / 0 |
| Client-role grants (`anon`, `authenticated`, `PUBLIC`) on public or backup | 0 |
| Supabase security advisor | Only the INFO "RLS enabled, no policy" finding: the intended deny-all for the browser API. No WARN or ERROR |

The new release needs **no new environment variables** and **no dependency changes**,
compared with 8f01e96.

## 5. Remaining: application switch (operator, on the VPS)

This step needs a shell on the VPS, either through the operator or a Remote Control folder on
the VPS. The deploying session had neither. Use `DEPLOYMENT_APPROVAL_PACKAGE.md` with these
adjustments:

- **§4.1 Backup.** Optional now. If a `pg_dump` is taken, its restore check now expects
  `77|32|84|194|1|2`, not `69|27|79|186|1|2`.
- **§4.2 Build.** Run as written. The checkout must print `90791c1`.
- **§4.3 / §4.4 Preflight, migrate and sync.** **Already done.** Run only the checks:
  - `npx prisma migrate status` must say "Database schema is up to date!".
  - `npm run db:sync-permissions` may be run; it is idempotent and must report
    "84 permissions defined, 84 stored, 194 role-permission rows".
  - Do not run the gap-closure preflight SQL; it expects the 69 schema.
- **§4.5 Trial and switch.** Run as written:
  1. Trial on port 3200 first.
  2. `pm2 stop united-erp`. **Stop it, never delete it.** It is the rollback.
  3. Start the new release on 3000, then `pm2 save`.
- **§4.6 Post-deploy checks.** Run as written: health 200 through the domain, administrator
  sign-in, language switch, accounting health check, trial balance, balance sheet, cash flow,
  and a clean Supabase log.

## 6. Rollback options

- **Application.** After the switch, `pm2 stop united-90791c1 && pm2 start united-erp`
  (8f01e96, unchanged on disk, compatible with 77). No data loss.
- **Schema back to 69.** While the new features hold no data, use
  `scripts/ops/gap-closure-rollback.sql`, then re-sync the permissions with the old build.
  It refuses to run once the new tables hold data.
- **Data.** Two sources:
  - Restore from `backup_pre_accounting_20261101` (in the database).
  - Restore from the off-site JSON. Password hashes come from the in-database copy, or the
    administrator resets the password.

## 7. Next phase (not started; owner-led)

The next phase follows `BUSINESS_CONFIGURATION_CHECKLIST.md`:
1. Chart of accounts.
2. Customers and suppliers.
3. Products and inventory master data.
4. Warehouses and settings.
5. Finance and staff users. At least an accountant plus a finance manager are needed, because
   reopening, opening approval and approval-gated journals need a second person.
6. Opening balances, as one opening batch. It is approved by a second person and posted once.

First real transactions start only after that validation.
