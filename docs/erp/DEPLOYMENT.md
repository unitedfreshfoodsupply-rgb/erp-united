# Deployment, backup and recovery

## Configuration (environment)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Pooled connection used by the app at runtime |
| `DIRECT_URL` | Direct connection used by `prisma migrate deploy` (DDL can't go through the pooler) |
| `JWT_SECRET` | Session signing secret — long, random, never shared between environments |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | Attachment storage (files never go into PostgreSQL) |
| `N8N_API_KEY` | **Legacy** shared integration key — remove after switching n8n/Hermes to per-channel keys |
| `ETA_ENV` | `preprod` or `prod` — shown on the e-invoicing screen |
| `ETA_API_BASE_URL`, `ETA_ID_SERVER_URL` | ETA API and identity-server base URLs for that environment (from the ETA SDK; no defaults in code) |
| `ETA_CLIENT_ID`, `ETA_CLIENT_SECRET` | ERP system credentials from the ETA portal — **secret**, server only, never returned by any API |
| `ETA_SIGNER_URL`, `ETA_SIGNER_TOKEN` | The e-seal signing bridge (contract in `lib/eta/gateway.ts`); the token is **secret** |

While any required `ETA_*` variable is empty, ETA submission is refused (503) and nothing is
recorded; everything else works. See `docs/erp/ETA_EINVOICE.md`.

`lib/env.ts` validates these at start-up. The demo seed refuses a Supabase-hosted
database unless `ALLOW_DEMO_SEED=1` is set deliberately — **never set it in production**.

## Release procedure

1. **Backup** (below) and note its timestamp.
2. Read `MIGRATIONS.md` for every migration in the release; run any pre-flight query it
   lists. Migrations are additive; the only one that writes existing rows is
   `…_purchasing_suppliers` (supplier codes), previewable with the query given there.
3. `npx prisma migrate deploy` (uses `DIRECT_URL`).
4. `npm run db:sync-permissions` — role bundles for new permissions.
5. Deploy the app build; check `GET /api/health` → `{"status":"ok"}`.
   Then, from the release directory, `node scripts/ops/warm-up.mjs http://127.0.0.1:<port>`:
   it opens every page route once without a session (no data read or written) so the
   first user after the deploy does not pay the route-loading cost (~0.85 s per screen).
6. First release with accounting only: `POST /api/accounting/sync` (accountant) posts
   documents issued before the ledger existed and the stock valuation to date.
   **Go-live from Odoo** (in this order):
   1. Import master data (customers, suppliers, products, price lists) so codes match.
   2. In `/accounting` → الأرصدة الافتتاحية, enter each customer's and supplier's open balance
      (as of the cut-over date, with its due date) and the opening stock per product (quantity,
      unit cost, expiry).
   3. Enter cash, bank and capital as one manual journal. Manual journals can't touch
      receivables, payables or inventory, by design.
   4. `/accounting` → سلامة الحسابات must be all green, and the trial balance must match
      Odoo's at cut-over.
7. Integrations: create a key per channel (الإدارة → التكاملات), switch each flow,
   then remove `N8N_API_KEY`.

Verified on a fresh database (2026-10-08): the full migration chain applies cleanly,
leaves **no drift** against the Prisma schema, and the seed + permission sync succeed.

## Backup and recovery

* **What to back up:** the PostgreSQL database (everything — ledgers, documents, audit)
  and the attachment bucket. Nothing else holds business state.
* **How:** Supabase point-in-time recovery (enable it on the production project) plus a
  daily logical dump kept off-site:
  `pg_dump --format=custom --no-owner "$DIRECT_URL" > united-$(date +%F).dump`
* **Restore drill** (do it once before go-live, then quarterly) — the full, verified
  procedure with its automated checks is in [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md). In short: into a *new* database,
  never over production:
  `createdb united_restore && pg_restore --no-owner -d united_restore united-YYYY-MM-DD.dump`
  then point a staging build at it and run `GET /api/health`, open the trial balance
  (it must say balanced) and a customer statement.
* The append-only triggers and the deferred balance check are part of the schema, so a
  restored database enforces the same rules.

## Reports & exports

Every report is available as an Excel-safe CSV download (UTF-8 BOM, RFC 4180 quoting) in addition to its JSON view, gated by the same permission as the JSON route:

| Export endpoint | Permission | Contents |
|---|---|---|
| `GET /api/sales/customers/[id]/statement/export?from=&to=` | `sales.invoices.view` | Customer statement rows with running balance |
| `GET /api/purchasing/suppliers/[id]/statement/export?from=&to=` | `purchasing.bills.view` | Supplier statement rows with running balance |
| `GET /api/management/finance/export?from=&to=` | `reports.finance` | Sales by product, P&L, top customers/suppliers, inventory value, stock movement |
| `GET /api/inventory/reports/valuation/export` | `stock.valuation.view` | Current inventory value per product |

CSV bytes start with `EF BB BF` (UTF-8 BOM) so Excel renders Arabic correctly; filenames are `<report>-<entity>-<from>-<to>.csv`. Routes register in the RBAC snapshot (`docs/erp/rbac-snapshot.json`, regenerated with `npx tsx scripts/rbac/matrix.ts`); `tests/unit/rbac-snapshot.test.ts` fails if they drift, and `tests/exports.test.ts` covers format, permissions and BOM.

## Operating notes

* Server errors return `{ "error": "خطأ في السيرفر", "ref": "xxxxxxxx" }`; the same ref is in
  the server log line `[api-error xxxxxxxx]`.
* Sign-in lockout (5 failures / 5 min) is stored in the database, so it holds across
  instances and restarts; failed attempts are in `LoginAttempt`, lockouts in the audit log.
* Close each accounting month (الحسابات → الفترات) after the stock valuation is posted —
  closing posts it automatically.
