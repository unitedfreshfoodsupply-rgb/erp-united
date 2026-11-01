# UNITED ERP — Production deployment approval package

Prepared 1 November 2026. **Read-only checks only. Nothing in production was changed.** The
execution steps (§4 onward) wait for the owner's explicit approval.

## 1. What is deployed, and onto what

| Item | Value |
|---|---|
| Code | `ui/enterprise-ux` @ **`90791c1`** (= `f6c7613` code + docs only; `git diff f6c7613 90791c1` outside `docs/` is empty) |
| Live release (baseline) | `release/2026-10-29` @ `8f01e96`. PM2 app `united-erp` on port 3000 behind Nginx Proxy Manager. Release dir `/home/hermes/releases/united-8f01e96`. |
| Database | Supabase project `exzdzjyqwfvpvqqaadzh`. eu-west-1. Postgres **17.6**. Status ACTIVE_HEALTHY. Size 21 MB. **Free plan.** |
| Changes since the live release | 38 commits, 229 files. `package-lock.json` **unchanged** (same dependencies). No new environment variables. |
| Migrations | **8 pending**, 69 → 77. All additive. |

## 2. Read-only production preflight — results (1 Nov 2026)

| Check | Result |
|---|---|
| Migrations applied | 69. None failed or rolled back. Latest `20261030120000_user_email`. |
| Applied names **and checksums** vs repository | **69/69 identical**. The 8 pending are exactly the expected ones. |
| Account codes and system keys the release creates (1700/2250/4300/6400/6500, vat_payable, fa_*) | free (0 conflicts) |
| Parent header accounts (acc_1000/2000/4000/6000) | present |
| One cash account per GL account (new unique index) | 0 duplicates |
| Objects the release creates already present (half-applied run) | 0 tables, 0 columns, 0 indexes |
| Journal source types outside the old rule | 0 (there are 0 journal entries) |
| 35 functions the search-path migration alters | all 35 present |
| New permission keys already present | 0 (79 permissions now → 84 after sync) |
| **Schema fingerprint vs a database built from the same 69 migrations** | **Identical:** 1,627 columns, 615 constraints, 418 indexes, 67 triggers, RLS on 127 tables, 35 functions (same source hashes). |
| Only difference | Supabase's own `ensure_rls` event trigger / `rls_auto_enable` function. It auto-enables RLS on new tables. It was present when the earlier 69 migrations ran, and the new migrations enable RLS anyway. **Compatible.** |
| Business data at risk | **None.** 0 orders, invoices, journal entries, stock movements, customers, suppliers, employees. |
| Data present | Reference data and access only: RolePermission 186, Permission 79, Account 27, UnitOfMeasure 12, StorageLocation 7, LoginAttempt 5, AuditLog 4, Currency 3, TaxRate 3, CashAccount 2, AttendanceSource 1, Branch 1, Company 1, **User 1 (SUPER_ADMIN)**, Warehouse 1. SystemSetting 0 (all defaults). |

**Production-equivalent rehearsal.** A local database was built from the same 69 migrations, so
its schema fingerprint equals production's. On it, the 8 pending migrations:
- **all applied, in ~1.5 s** including Prisma start-up;
- `migrate status` reported up to date;
- accounts went 27 → 32;
- `db:sync-permissions` gave 84 permissions and 194 role-permission rows;
- the resulting schema is **identical** to a fresh 77.

**Rollback rehearsal** (earlier, on 1,015 entries of demo data): rollback gives a schema
identical to 71 with the data unchanged; re-applying gives a schema identical to 77 with the data
unchanged.

**Backup commands tested.** The exact dump and restore commands in §4.1 were tested on a local
replica built from the same 69 migrations:
- 128 public tables in the dump, the same number production has;
- restore exit code 0; counts `69|27|2`;
- columns and indexes identical after restore;
- constraints: same 615, with three CHECK texts that differ only in redundant parentheses
  (PostgreSQL normalises nested `AND`s on restore). They are logically identical.

**Deployment package.** A clean `git worktree` at `90791c1` passed `npm ci`, `prisma generate`
and `next build` (Node 22.22, npm 10.9).

**Not verified from this session:**
- The live site's `/api/health`. This session's network policy blocks the outbound tunnel. The
  operator checks it in step 4.0.
- The VPS itself. This session has no VPS shell, so the build, backup, migration and switch are
  run by the operator with the commands below.

## 3. Backup position — read this first

- **The project is on the Supabase free plan. Free-plan projects have no automatic backups**
  (Supabase docs, "Database Backups"). There is nothing to restore from unless a backup is
  taken.
- The backup is therefore a **manual logical dump, taken immediately before migrating, and
  verified by restoring it** (§4.1).
- Because production holds no business data, the dump is small and the restore check is quick.
- **Without that dump, do not migrate.**

## 4. Exact deployment commands (operator, on the VPS) — run only after approval

Environment comes from the release's `.env.local`, which already holds `DATABASE_URL` and
`DIRECT_URL`. **Never echo it.** `DIRECT_URL` must be the direct or session connection (port
5432), not the transaction pooler.

```bash
set -euo pipefail
SHA=90791c1
OLD=/home/hermes/releases/united-8f01e96
NEW=/home/hermes/releases/united-$SHA
BK=~/backups; mkdir -p "$BK"
set -a; . "$OLD/.env.local"; set +a        # loads DATABASE_URL / DIRECT_URL without printing them
```

### 4.0 Baseline (read-only)
```bash
curl -fsS https://erp.united-ffv.com/api/health          # 200 / {"status":"ok"}
pm2 ls                                                    # united-erp online on :3000 (do not touch the :3111 app)
```

### 4.1 Backup and restore check (mandatory)
```bash
pg_dump --version            # MUST be 17.x (a 16 client refuses a 17 server)
DUMP="$BK/united-pre-accounting-$(date +%Y%m%d-%H%M).dump"
pg_dump "$DIRECT_URL" --no-owner --no-acl -Fc -f "$DUMP"
# If pg_dump is not 17.x, use the same command through Docker instead (the URL is passed as an env var, not printed):
#   docker run --rm -e DIRECT_URL -v "$BK":/bk postgres:17 sh -c 'pg_dump "$DIRECT_URL" --no-owner --no-acl -Fc -f /bk/'"$(basename "$DUMP")"
ls -l "$DUMP"; sha256sum "$DUMP" > "$DUMP.sha256"
pg_restore --list "$DUMP" | grep -c 'TABLE DATA public'   # 128 (every public table, including _prisma_migrations)

# Restore into a throwaway Postgres 17 (never into production):
docker run -d --name united-restore-check -e POSTGRES_PASSWORD=check -p 127.0.0.1:55499:5432 postgres:17
sleep 5
docker exec -i united-restore-check pg_restore -U postgres -d postgres --schema=public --no-owner --no-acl < "$DUMP"   # the app's schema only
docker exec united-restore-check psql -U postgres -d postgres -tAc \
 'SELECT (SELECT count(*) FROM public."_prisma_migrations"), (SELECT count(*) FROM public."Account"), (SELECT count(*) FROM public."Permission"), (SELECT count(*) FROM public."RolePermission"), (SELECT count(*) FROM public."User"), (SELECT count(*) FROM public."CashAccount")'
# expected: 69|27|79|186|1|2
docker rm -f united-restore-check
```
**Gate:** the counts must match `69|27|79|186|1|2`. Otherwise stop.

### 4.2 Build the release (no impact on the live app)
```bash
git clone --branch ui/enterprise-ux https://github.com/unitedfreshfoodsupply-rgb/erp-united.git "$NEW"
cd "$NEW" && git checkout --detach "$SHA" && git rev-parse --short HEAD    # must print 90791c1
cp "$OLD/.env.local" .env.local
npm ci && npx prisma generate && npm run build
```

### 4.3 Preflight again, immediately before migrating (read-only)
```bash
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/ops/gap-closure-preflight.sql    # every section: 0 rows
npx prisma migrate status                                                         # 8 pending, none failed
```

### 4.4 Migrate and sync permissions
**The approval point.** The live app keeps serving throughout, because the old build is
compatible with the additive schema.
```bash
npx prisma migrate deploy          # expect the 8 "Applying migration" lines
npx prisma migrate status          # "Database schema is up to date!"
npm run db:sync-permissions        # "84 permissions defined, 84 stored, 194 role-permission rows"
```

### 4.5 Trial port, then switch
```bash
pm2 start npm --name united-$SHA -- start -- -p 3200
curl -fsS http://127.0.0.1:3200/api/health
node scripts/ops/warm-up.mjs http://127.0.0.1:3200
# Sign in on :3200 as the administrator:
#   Accounting → Health check green; Cash & Banks shows 2 accounts;
#   /assets opens; Comparatives & ratios opens.
pm2 stop united-erp                       # STOP, never delete
pm2 delete united-$SHA && pm2 start npm --name united-$SHA -- start -- -p 3000
curl -fsS https://erp.united-ffv.com/api/health
pm2 save
```
**Downtime:** only between `pm2 stop united-erp` and the new app answering on 3000, about
**1–2 minutes**. The migration itself needs no downtime.

### 4.6 Post-deploy (first 30 minutes)
- Health 200 through the domain.
- The administrator signs in; the Arabic/English switch works.
- Health check, trial balance, balance sheet and cash flow are all green or balanced.
- Settings show the new accounting keys at their defaults.
- The Super Admin holds the 5 new permissions.
- No new errors in the Supabase logs.
- `united-erp` is present and **stopped**.

## 5. Exact rollback commands

**A. Application only.** Always possible, with no data loss:
```bash
pm2 stop united-90791c1
pm2 start united-erp          # previous release 8f01e96 on :3000, unchanged
curl -fsS https://erp.united-ffv.com/api/health
pm2 save
```
The old build runs on the migrated schema (all changes additive; verified in the rehearsal).

**B. Migration failed part-way:**
```bash
npx prisma migrate status                                # identify the failed one (its transaction rolled back)
npx prisma migrate resolve --rolled-back <migration_name>
```
Fix the cause with the owner, then re-run 4.3 → 4.4. The live app keeps serving the whole time.

**C. Schema back to 69/71.** Only while the new features hold no data; the script refuses
otherwise:
```bash
pg_dump "$DIRECT_URL" --no-owner --no-acl -Fc -f "$BK/united-before-rollback-$(date +%Y%m%d-%H%M).dump"
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -1 -f "$NEW/scripts/ops/gap-closure-rollback.sql"
cd "$OLD" && npm run db:sync-permissions        # with the old build: back to 79 permissions
```

**D. Restore the dump from 4.1.** Last resort. Everything recorded after the dump is lost:
```bash
pm2 stop united-90791c1 united-erp
pg_restore --clean --if-exists --schema=public --no-owner --no-acl -d "$DIRECT_URL" "$DUMP"   # public schema only; Supabase's own schemas untouched
pm2 start united-erp
```

## 6. Ready before staff use the new accounting features (not needed for the deployment itself)

| # | Item | Now in production | Needed |
|---|---|---|---|
| 1 | Finance users | **1 user (SUPER_ADMIN only)** | At least **2**: an accountant, and a finance manager holding `accounting.periods.reopen`, `accounting.opening.approve` and `accounting.journals.approve`. Reopen, opening approval and approval-gated journals and transfers always need a second person. |
| 2 | Net salaries account (`hr.payroll_net_pay_account`) | empty | Set before the first payroll posting |
| 3 | Bank charges / withholding / write-off accounts | empty | Set before using those deductions or transfer fees |
| 4 | Segregation of duties (`approvals.require_different_approver`) | off | Decide; recommended on |
| 5 | Manual-journal and transfer approval, with thresholds | off | Decide |
| 6 | Cost centres; asset categories | none | Create (cost centres before switching on "cost centre required") |
| 7 | Opening balances | none | One initial batch: prepared, validated (difference 0), approved by the finance manager. Then the Health check must be green. |
| 8 | ETA e-invoicing | off | Stays off until the pre-production run with UNITED's credentials |

Full list: `BUSINESS_CONFIGURATION_CHECKLIST.md`.
