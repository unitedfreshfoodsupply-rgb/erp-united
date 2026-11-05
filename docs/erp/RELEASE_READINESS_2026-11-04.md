# Release readiness — 4 Nov 2026

This branch is a release candidate. It has not been deployed. Applying it to production needs a separate approval. Facts about production below come from read-only queries made on 4 Nov 2026; nothing in production was changed.

## 1. Production baseline (read-only)

| Item | Value |
|---|---|
| Code | `main` @ `04be32a` (build `EtkShaaRcZ_cy1dU6A7QT`) |
| Migrations | 95 applied. Latest `20261103130000_search_normalization`. None unfinished |
| Users | 1 active (SUPER_ADMIN), with two-step verification enrolled |
| Company record | Legal name only. Tax number, registry, address, phone, email, legal form, capital, bank and terms are empty |
| Documents | 1 issued sales invoice, 0 supplier bills, 0 ETA documents, no ETA issuer profile |
| Opening balances | None posted. Account 3900 is free and the chart equals the reference chart |

## 2. Migrations in this release (in order, all additive)

| Migration | Adds |
|---|---|
| `20261104100000_supplier_category` | `Supplier.category` (nullable) with a CHECK, **and a data backfill**: the 83 production suppliers are classified from the approved lists (decision D-1: SUP-00001–39 fruit, SUP-00040–83 vegetable). Each row is matched by its id and its code, and only rows still unclassified change. Read-only check on 4 Nov: all 83 id/code pairs exist in production |
| `20261104130000_supplier_category_other` | widens the CHECK to `other` (services) |
| `20261104140000_phased_opening_migration` | account 3900 and its guard trigger; `OpeningMigration`, `OpeningException`; phase columns on opening batches |
| `20261104150000_customer_po_shortage` | `Order.customerPoRef`, `Order.stockStatus` (default `ok`); order-line link and one-open-request index on purchase requests |
| `20261104160000_purchasing_custody` | `Employee.purchasingCategory`; custody purpose on employee transactions (default `salary`); `EmployeeCustodyRequest`; custody source on supplier payments |
| `20261104170000_commercial_invoice_documents` | `SalesInvoice.issueSnapshot`, `SupplierBill.postSnapshot`; company legal form, capital, bank details and invoice terms |

**Rehearsed** on `united_deploy_rehearsal`, a local copy of the production rehearsal database at the same 95 migrations:
- `scripts/ops/migrations-sql.ts --after=20261103130000_search_normalization` produced one transaction holding the six migrations, applied with no error;
- `prisma migrate status` reported "Database schema is up to date";
- `prisma migrate diff` found no drift;
- running the same file a second time was refused ("latest applied migration is not 20261103130000_search_normalization").

**Backward compatibility (tested).** The previous release (`04be32a`) was built and run on a database with all 101 migrations. Its own reset and seed worked, and its e2e suites passed with 0 failures: orders 186, sales 199, purchasing 126, stock 153, accounting 54, flows 68, HR 38, treasury 73, business cycle 59, opening batch 12. An application-only rollback is therefore possible, because:
- every new column is nullable or has a default;
- every CHECK only widens;
- the new triggers act only on rows the previous code never writes: account 3900, phase batches, custody payments.

## 3. Deploy steps (when approved)

1. **Backup and restore test.**
   - Take an encrypted backup with `scripts/ops/backup-pg-dump.sh`.
   - Test it on the owner's machine with `scripts/ops/verify-restore.sh <dump>` (local throwaway database only).
   - Record the dump name and its SHA-256.
2. **Database.**
   - Run `npx tsx scripts/ops/migrations-sql.ts --after=20261103130000_search_normalization > deploy-20261104.sql`.
   - Review the file, then run it once in the Supabase SQL editor.
   - Then run `prisma migrate status` against production; it must report up to date.
3. **Permissions.**
   - Run `npx tsx scripts/ops/permissions-sql.ts > sync-permissions.sql` (it only prints the SQL), review it, and run it once in the SQL editor.
   - Alternatively, run `npm run db:sync-permissions` with production's `DATABASE_URL` on the VPS.
   - This release adds `purchasing.suppliers.view` to STOCK_CONTROLLER (decision D-2).
   - Rehearsed on the production copy: the grant goes from 0 to 1, and a second run changes nothing.
4. **Application.**
   - Build this commit in a new release directory on the VPS.
   - Start it under PM2 beside the running one, then switch the port with the existing switch script (`/root/united-switch.sh` pattern).
   - Keep the previous process stopped, not deleted.
5. **Checks.**
   - `GET /api/health` returns `{"status":"ok"}`.
   - `GET /api/health/deep` reports the database and the backup marker.
   - Sign in as the administrator and open: the opening-migration control center (status "not started"), a supplier with its category, and the printed invoice of the one issued invoice (`data-source="legacy"`, title "فاتورة مبيعات").
6. **Rollback.**
   - Switch PM2 back to the previous release.
   - The schema can stay, because it is additive and backward compatible (§2).
   - Restore the backup only if data written by the new release must be removed. The first item on that list is a phased opening migration, which is permanent by design.

**Environment, by name only.** These must be set on the VPS; this release adds none:
- `DATABASE_URL`, `DIRECT_URL`
- `JWT_SECRET`, `MFA_ENCRYPTION_KEY`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`
- `N8N_API_KEY`
- `ETA_ENV`, `ETA_API_BASE_URL`, `ETA_ID_SERVER_URL`, `ETA_CLIENT_ID`, `ETA_CLIENT_SECRET`, `ETA_SIGNER_URL`, `ETA_SIGNER_TOKEN`
- ETA submission stays off while the ETA credentials are unset.

## 4. Operations review

| Area | State | Evidence or gap |
|---|---|---|
| PM2 boot persistence | **Not verified** | No access to the VPS from this session (SSH denied by policy), and PM2 is not installed locally. The last record (30 Oct) found no `pm2-hermes` systemd unit. The owner must run `pm2 startup` and `pm2 save` as the app user, then reboot the VPS once and confirm the process comes back |
| Backups | Scripts in place (encrypted, retention, health marker); one verified backup on 2 Nov | The cron on the VPS was not checked from here |
| Restore | `verify-restore.sh` (local throwaway database) | Run before the deploy (§3.1) |
| Two-step verification | The only production user is enrolled | New finance users must enroll at first sign-in (enforced) |
| Credential rotation | **Unknown** | The database password rotation was not confirmed. The VPS root password was exposed in an earlier chat and must be rotated. A plan for this needs its own approval |
| Health checks | `/api/health`, `/api/health/deep` | — |
| Migration ordering | Guarded by `migrations-sql.ts` (refuses out of order or twice) | Rehearsed (§2); re-checked 4 Nov after the gate fixes (same SHA-256), with the supplier backfill matched exactly and its rollback tested (`RELEASE_GATE_REVIEW_2026-11-04.md` §5) |
| Database connection limit | **Not verified** | `lib/prisma.ts` describes the Supavisor pooler with `connection_limit=1`. The D-3 load test showed receipts queuing behind each other at that limit: at 50 ms round trip, the fourth of four simultaneous receipts waited past the pool timeout. With 5 connections every measured case passed. Changing it is an infrastructure change and needs its own approval (gate review §3.4) |

## 5. Tests (local test databases only)

After the release-gate fixes (`e5f70b2`, gate review §3): unit 245/245; integration 218/218 on a fresh seeded database (21 new tests, 17 of which fail on the code before the fix); full e2e chain in gate review §4. The table below is the run on `5bfc42b`.

| Suite | Result |
|---|---|
| GitHub CI | Integration tests failed there (19 of 197, 9 of them already on `main` @ `04be32a`) because CI ran them on an unseeded database. Fixed in `74e69ba`: CI now seeds the database first (`npm run test:reset`), as locally. Reproduced: unseeded 178/197, seeded 197/197 |
| Typecheck, lint, production build | clean, clean, OK |
| Unit | 245 / 245 |
| Integration (fresh database, 101 migrations) | 197 / 197 |
| Full e2e chain (84 suite runs: 12,946 checks passed, 2 failed) | 82 suite runs pass |
| — `commercial-invoices` | 1 check failed in the chain. A content check was too broad and matched build hashes. Fixed; 30 / 30 in its chain position |
| — `hr-attendance` | 1 check fails because of the calendar: the night shift of 29 Oct crosses Egypt's clock change and lasts 10 hours, while the test expects 9. It also fails before this release's changes |
| Re-runs after the last fixes | sales 199, flows 69, ETA 35, commercial invoices 30, purchasing 136 |
| A4 print through Chrome's print engine | 60-line invoice on 3 pages (AR and EN) with the header repeated and the totals kept together; bill on 1 page (AR and EN) |

## 6. Blockers and decisions before going live with these features

1. **Second production user.** Every opening batch, the migration closure and bill variances need a second person; production has one user. Create a finance user, who will enroll in two-step verification.
2. **Opening decisions AD-1 to AD-6** (`PHASED_OPENING_MIGRATION_2026-11.md` §5):
   - the class of 3900;
   - moving 3300 into 3900;
   - the 40 exception rows;
   - column D (47,177);
   - row 4 (160,020 or 160,200);
   - the legacy trial balance.
   - Posting the reconciled supplier amount (4,260,486.80) in production is **not** authorised by this release.
3. **Company details** for documents (§1): to be entered by the administrator.
4. **ETA obligation.** The research shows that invoices must be electronic for obligated taxpayers (Law 206/2020 Art. 37; ETA: all taxpayers since 15 Dec 2022). Commercial invoices do not replace the e-invoice. Activating the ETA integration is the owner's compliance decision (`COMMERCIAL_INVOICES_2026-11.md` §6).
5. **Workflow defaults to confirm:**
   - custody (10 defaults in the custody section of the release notes);
   - shared free stock across orders awaiting stock;
   - Grade B is its own product and every receipt is graded once;
   - over-receipt tolerance on the accepted quantity.
