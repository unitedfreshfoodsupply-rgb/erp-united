# UNITED ERP — Rollback runbook (accounting release)

> **Status: prepared, NOT executed.** Each step needs the owner's explicit approval at the time.

Choose the **smallest** rollback that resolves the problem.

| Situation | Rollback | Data loss |
|---|---|---|
| New build misbehaves, whether or not the new features hold data | **§1 Application only** | None |
| A migration failed part-way during deployment | **§2 Failed migration** | None |
| The schema must go back to 69/71 **and** the new features hold **no** data | **§3 Schema rollback script** | None (refuses otherwise) |
| The schema must go back **and** the new features hold data | **§4 Restore from backup** | Everything after the backup — **last resort** |

## 1. Application-only rollback (preferred; always possible)

1. On the VPS, stop the new app on port 3000, and restart the previous app `united-erp`
   (release `8f01e96`) on port 3000. Do not delete either app.
2. `curl -fsS https://erp.united-ffv.com/api/health` → 200. The administrator signs in.

**Why this is safe.** Every schema change is additive, and the old build never reads the new
tables or columns.

Three database behaviours remain while the old build runs:
- **The widened journal source-type CHECK.** It is a superset, so it accepts everything the old
  build writes.
- **The replaced journal-line guard.** Its new rule applies only when a cost centre is set, and
  the old build never sets one.
- **The VAT period lock trigger.** It refuses VAT lines dated inside a **filed** VAT return
  period. With no return filed it is inert. If returns were filed, the old build is refused
  posting VAT into those periods, which is the correct accounting.

Records created by the new features (transfers, assets, VAT returns, cost centres, opening
batches) stay in the database. Their journal entries stay in the ledger, so trial balance and
reports in the old build still include their amounts. Re-deploying the new build later picks
them up again.

## 2. A migration failed during deployment

1. `npx prisma migrate status`. Identify the failed migration; Prisma marks it failed and its
   transaction is rolled back.
2. Keep the old app serving. It works on the partially migrated, all-additive schema.
3. Inspect the error. A **data conflict** is the likely cause (preflight §1–§3).
   - Resolve it with the owner.
   - Mark the failed migration rolled back: `npx prisma migrate resolve --rolled-back <name>`.
   - Re-run `npx prisma migrate deploy`.
4. If the cause is not understood, stop and use §3 for the migrations that did apply.

## 3. Schema rollback script (only while the new features hold no data)

```bash
pg_dump "$DIRECT_URL" --no-owner --no-acl -Fc -f ~/backups/united-before-rollback-$(date +%Y%m%d-%H%M).dump
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -1 -f scripts/ops/gap-closure-rollback.sql
npx prisma migrate status        # the six gap-closure migrations are no longer applied
```

**What the script does:**
- It **refuses and changes nothing** if any row was written by the new features: transfers,
  VAT returns, journal requests, fiscal years, assets, opening batches, cost centres, journals
  with the new source types, postings to the new accounts, or reopened periods.
- Otherwise, in one transaction, it:
  - drops the new tables, columns and functions in reverse order;
  - restores the previous journal CHECK and line guard;
  - removes the five new accounts;
  - deletes the six rows from `_prisma_migrations`.

After it runs:
- Run `npm run db:sync-permissions` **with the old build**, which removes the five new
  permissions.
- The two earlier migrations (`fk_indexes`, `function_search_path`) can stay, because they are
  harmless to the old build. If required:
  - `DROP INDEX` the nine indexes listed in `20261030130000_fk_indexes`;
  - `ALTER FUNCTION … RESET search_path` the 35 functions in `20261030131000_function_search_path`;
  - delete their two `_prisma_migrations` rows.

**Rehearsal evidence** (scratch databases, `scripts/ops/rehearse-gap-closure.sh`), on a
database with 1,015 journal entries, 219 invoices and 1,580 stock movements:
- After rollback, the schema is **identical** to a fresh database at migration 71, and the data
  fingerprint is **unchanged**.
- Re-applying the migrations gives a schema **identical** to a fresh database at 77, with the data
  **unchanged**.
- On a database where the features hold data, the script **refused**.

## 4. Restore from backup (last resort)

Use only if the database itself is damaged. Everything recorded after the backup is lost and
must be re-entered.

1. Stop both apps. Announce the outage.
2. Restore the Supabase point-in-time or daily backup from the dashboard, **or** restore the
   logical dump taken in deployment step 2 (`pg_restore --clean --no-owner`), following
   `BACKUP_RESTORE.md`.
3. Start the old app (`united-erp`, `8f01e96`). Check health, sign-in and the trial balance.
4. List the documents finance and operations recorded after the backup time, for re-entry.

## After any rollback

- Record what happened, the time, who approved it, and the health-check results.
- Keep the new release directory for diagnosis. Do not delete it.
