# Release plan — enterprise UI/UX release (`ui/enterprise-ux`)

Status: **prepared, not deployed.** Nothing in this document has been run against production.
Every production step below needs the owner's approval at the time it is run.

## 1. What is being released

| | |
|---|---|
| Branch | `ui/enterprise-ux` (contains `perf/sprint-0-fixes`, which contains the deployed release `release/2026-10-29` = `8f01e96`) |
| Deployed today | `8f01e96` (PM2 app `united-8f01e96`, build `JftzQ-J7lCpX4RTH4EtvZ`, Supabase project `exzdzjyqwfvpvqqaadzh`) |
| Delta | Sprint 0 performance fixes + enterprise UI/UX work: home dashboard, redesigned sidebar, performance overview, charts, identity, users admin, labels and localisation fixes, touch sizing — see `UX_TRANSFORMATION.md`, `SPRINT0_FIXES.md`, `DESIGN_SYSTEM.md` §9–10 |
| Dependencies | none added or upgraded |
| Environment variables | none added (two browser cookies are new: `u_shell`, `u_rail` — layout hints only, no security meaning) |
| Permission catalogue | unchanged; RBAC snapshot adds only `/home` + `/api/home` (any desk permission) and `/management/overview` + `/api/management/overview` (`reports.finance`) |

### Branch audit (31 Oct 2026)

`main` ⊂ `united-full-project` ⊂ `release/2026-10-29` ⊂ `perf/sprint-0-fixes` ⊂ `ui/enterprise-ux` — a
straight line; no commit of an earlier branch is missing from `ui/enterprise-ux`.
`release/workflow-repair-20261012-clean` (2 commits, 12 Oct) forked from the initial commit; its work
was rebuilt on the main line in the 21 Oct operational release (grading migration, deferred grading as
the intake "sort", picking sheet, per-tab session isolation). Two of its features exist only there —
item-level "reject preparation" and form-draft persistence — and are listed as product decisions
(§8), not merged.

## 2. Migration inventory

| Migration | What it does | Risk | Rollback |
|---|---|---|---|
| `20261030130000_fk_indexes` | 9 `CREATE INDEX` on foreign-key columns | Additive; brief write lock per table (tables are near-empty in production) | Not needed for the old build (indexes are invisible to it); `DROP INDEX` if ever required |
| `20261030131000_function_search_path` | `ALTER FUNCTION … SET search_path = public, extensions, pg_temp` on 35 trigger functions | Additive (function setting only, bodies unchanged); verified on a fresh chain with zero drift | `ALTER FUNCTION … RESET search_path` |

No data migration, no column change, no destructive statement. Production history today: 69 applied
migrations matching the repository; after these two: 71.

The accounting gap-closure work on the same branch adds six more additive migrations (cash & banks,
VAT returns + journal approval, fiscal years, fixed assets, opening batches, cost centers) — 77 in all.
Their inventory, pre-checks, deployment and rollback are in `ACCOUNTING_GAP_CLOSURE.md` §6 and §13.

## 3. Data compatibility

- Production holds only the Super Admin account after the 29 Oct reset (verified then; re-check
  before deploying with the read-only query in §5.1).
- Every new screen was verified on an empty database: home, performance overview, command center,
  sales, accounting and stock render with empty states, no errors (local run, 31 Oct).
- New read paths only: order payloads carry the linked customer's and product's names
  (`customerAccount`, `stockProduct` selects); the dashboard and home services are aggregates.
- Master data compatibility (customers, suppliers, products, units, warehouses, accounts, roles,
  permissions, opening balances) is unchanged by this release — no schema or rule changes. The
  12-week demo history used for testing was created through the application API, so every record
  passed the same validation production uses.

## 4. Backups (before any production step)

1. Supabase: confirm the latest automatic backup time in the dashboard (Database → Backups); take a
   manual logical dump if the plan allows: `pg_dump --no-owner --no-acl -Fc` via `DIRECT_URL`.
2. VPS: keep the current release directory `/home/hermes/releases/united-8f01e96` and the PM2 app
   untouched until the new release is accepted.

## 5. Deployment sequence (needs approval)

1. **Read-only checks** (Supabase SQL editor):
   `SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;` → 69;
   `SELECT username, role FROM "User";` → only the administrator (or the users created since).
2. **Build on the VPS** in a new directory `/home/hermes/releases/united-<sha>` from the pushed
   branch head; `npm ci && npx prisma generate && npm run build` with the existing `.env.local`.
3. **Migrations**: `npx prisma migrate deploy` (uses `DIRECT_URL`) → expect 2 applied, then
   `npx prisma migrate status` → up to date.
4. **Permissions**: `npm run db:sync-permissions` (idempotent; no new keys in this release).
5. **Start on a trial port** under PM2 (e.g. 3200), `GET /api/health` → `{"status":"ok"}`,
   `node scripts/ops/warm-up.mjs http://127.0.0.1:3200`.
6. **Switch**: point PM2's served app (port 3000 behind Nginx Proxy Manager) to the new build; keep
   the old app stopped, not deleted.
7. **Post-deployment verification** (§7).

## 6. Rollback

- Application: restart the previous PM2 app (`united-8f01e96`) on port 3000 and stop the new one.
  The previous build runs unchanged against the migrated database (indexes and a function setting
  only).
- Database: no rollback needed for the old build. Only if explicitly required:
  `DROP INDEX` the nine indexes and `ALTER FUNCTION … RESET search_path` the 35 functions.
- Browser cookies `u_shell` / `u_rail` are ignored by the old build.

## 7. Post-deployment verification checklist

- [ ] `GET /api/health` 200 through `https://erp.united-ffv.com`
- [ ] Administrator signs in and lands on **Home**; sidebar shows Home and the People group
- [ ] Sidebar folds to the icon rail and stays folded after a reload
- [ ] Performance overview loads (empty states while there is no data)
- [ ] A preparer account (if created) lands on Preparation with the tab row, no sidebar
- [ ] Arabic and English switch on any page; no raw keys
- [ ] Response compression: `curl -sI -H 'accept-encoding: gzip' …/api/orders` (signed in) shows `content-encoding: gzip`
- [ ] Supavisor / database logs: no new errors in the 30 minutes after the switch
- [ ] Old PM2 app still present (stopped) for rollback

## 8. Product decisions left open

| Item | Why it is not in this release |
|---|---|
| Item-level "reject preparation" (exists only on the 12 Oct repair branch) | Supervisors can reopen an order with a reason today; an item-level reject changes the preparation workflow and needs the operations lead's decision |
| Form-draft persistence (repair branch only) | Stores unsent form data in the browser; needs a privacy decision for shared tablets |
| Customer balances in the customer list | Would show finance figures to sales roles that cannot see them today — needs a permission decision |
| Production validation | All results in this release are local (isolated test database); nothing has been measured on production yet |
