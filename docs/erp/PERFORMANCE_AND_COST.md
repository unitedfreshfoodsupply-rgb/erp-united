# Performance and cost review

| | |
|---|---|
| Date | 29 Oct 2026 |
| Scope | Completion program F-1 (performance) and F-2 (cost). Measured figures are labelled **measured**; anything not measured here is labelled **estimate** or **to confirm**, with what it depends on. No vendor price is quoted: none was verified in this review. |

## 1. How it was measured

* A disposable copy of the test database (`united_perf`, never production) grown with valid rows:
  20,000 orders (60,000 lines) spread over 365 days, 300,000 audit rows, 20,000 balanced
  journal entries (40,000 lines). Seed: plain SQL inserts that pass every CHECK and trigger.
* The production build (`next start`) against that copy on a local PostgreSQL 16; one client,
  median of 5 requests per endpoint, signed in as the super admin (the widest permissions).
* Local machine, same host for app and database: absolute times will differ on a hosted
  setup (network round trips to the database add per query); the *ratios* are what matter.

## 2. Response times (measured, ms, median of 5)

| Endpoint | Before (`7606dd0`) | After (`a9844d5`) | Note |
|---|---:|---:|---|
| `GET /api/orders` (command center, exceptions) | 6,999 | 321 | loaded every order ever, with lines, every 4–5 s |
| `GET /api/supervisor/intelligence` | 5,404 | 297 | same |
| `GET /api/reports/daily` | 4,126 | 167 | read every order to count open ones |
| `GET /api/production/daily` | 3,550 | 158 | summed every non-cancelled order ever |
| `GET /api/audit?q=…` (text search over 300k rows) | 694 | 694 | sequential scan with `ILIKE`; see §4 |
| `GET /api/audit?limit=50` | 50 | 50 | index on `timestamp` |
| `GET /api/accounting/trial-balance` (12 months) | 57 | 57 | |
| `GET /api/accounting/integrity` | 46 | 46 | |
| `GET /api/management/finance` (12 months) | 106 | 106 | |
| `GET /api/management/cash-flow` (12 months) | 124 | 124 | |
| `GET /api/accounting/balance-sheet` | 86 | 86 | |
| `GET /api/stock/products`, `/api/sales/customers` | 12–14 | 12–14 | |

What changed (`a9844d5`): the live boards show open orders plus orders closed in the last
7 days; production counts open orders plus what was delivered or closed today (it used to
count all history, so "today's" totals grew every day — a correctness fix as much as a
speed one); the daily report reads open orders only; index on `Order.updatedAt`.

## 3. Cost drivers (measured)

### 3.1 Polling traffic

The floor screens refresh on a timer (React Query `refetchInterval`):

| Screen | Interval | Payload at the test volume (≈1,200 orders in the board window) | Uncompressed per open screen |
|---|---:|---:|---:|
| Command center (`/api/supervisor/intelligence`) | 4 s | 2.63 MB raw / 72 KB gzip | ≈ 39 MB/min raw, ≈ 1.1 MB/min gzip |
| Exceptions (`/api/orders`) | 5 s | 1.93 MB raw / 53 KB gzip | ≈ 23 MB/min raw |
| Production drill-down (`/api/orders?scope=production`) | 5 s | 1.32 MB raw / 36 KB gzip | ≈ 16 MB/min raw |
| Prep / load boards (`status=` filters) | 3 s | 1.26 MB raw / 34 KB gzip | ≈ 25 MB/min raw |

**Finding — compression.** Route-handler JSON is served uncompressed by `next start`
(no `Content-Encoding` header even when the client accepts gzip). Gzip reduces these
payloads ≈ 36×. **Action (deployment, to confirm on the chosen host):** serve the app
behind a layer that compresses JSON (most managed Next.js hosts and any nginx/Caddy proxy
do); verify with `curl -H 'accept-encoding: gzip' -D - …/api/orders` showing
`Content-Encoding: gzip`. This is the largest bandwidth lever and needs no code change.

**Estimate — realistic volume.** The synthetic window holds ≈ 900 open orders (the seed
leaves every 40th/50th order open over a whole year). A distribution business typically
has tens to low hundreds of open orders a day; payloads scale linearly with orders in the
window (≈ 1.6 KB per order with three lines, raw). Measure again after the first month
of production data.

### 3.2 Database size (measured)

| Table | Rows (perf copy) | Size incl. indexes | Per row |
|---|---:|---:|---:|
| AuditLog | 300,776 | 90 MB | ≈ 310 B |
| OrderItem | 60,008 | 11 MB | ≈ 200 B |
| JournalLine | 40,218 | 7.2 MB | ≈ 180 B |
| Order | 20,009 | 6.0 MB | ≈ 300 B |
| JournalEntry | 20,065 | 6.0 MB | ≈ 300 B |
| Whole database | — | 139 MB (test copy without the volume: 17 MB) | |

The audit log is the growth driver. The seed's ratio (15 audit rows per order) is synthetic;
the real one depends on how many steps and edits each order gets — measure it after a month. **Estimate:** at 100 orders a
day with that ratio, the audit log grows ≈ 170 MB a year and everything else a fraction
of that — well inside small managed-PostgreSQL tiers. Audit rows are never deleted by
design (they are the record); archiving them is a policy decision, not proposed here.

### 3.3 Other recurring items (to confirm — not measurable from the repository)

| Item | What drives it | Where it is configured | Status |
|---|---|---|---|
| Application hosting | instances × hours; bandwidth (§3.1) | not in the repository (no host config file) | to confirm with the chosen host |
| PostgreSQL (Supabase per `DEPLOYMENT.md`) | plan tier, storage (§3.2), point-in-time recovery add-on | Supabase project | to confirm with the plan; PITR is required by `BACKUP_RESTORE.md` — do not drop it to save cost |
| Attachment storage | files uploaded (max size: setting `documents.max_upload_mb`) | `SUPABASE_STORAGE_BUCKET` | to confirm; grows with scanned documents |
| Off-site daily dump | dump size ≈ database size, retention | `BACKUP_RESTORE.md` | keep; integrity over cost |
| ETA e-invoicing | per the Tax Authority's terms and the e-seal provider | `ETA_*` env | external (X-1) |
| CI minutes | one job per push: install, typecheck, lint, unit, migrations, build, integration, e2e chain | `.github/workflows/ci.yml` | the e2e chain is the long step (not timed in this review); runs only on push/PR |

## 4. Not changed, and why

* **Audit text search (0.7 s at 300k rows).** `ILIKE '%…%'` scans. A trigram index
  (`pg_trgm` GIN on the searched columns) would make it fast but needs the extension on the
  production database and adds write cost to the busiest table. Recommended when the log
  passes ~1M rows or search is felt slow; not done now.
* **Polling intervals** are kept: they are operational choices for the floor (3–5 s on
  the prep/load boards). With compression in place their cost is small; lengthening them
  trades freshness the floor relies on.
* **Board window = 7 days** (`BOARD_HISTORY_DAYS` in `lib/orders-service.ts`). A shorter
  window loads less; 7 days keeps a week of closed orders one click away on the boards.

## 5. How to repeat

```bash
createdb united_perf && pg_dump "$TEST_DB" | psql united_perf     # disposable copy only
psql united_perf -f perf-seed.sql                                  # volume (see §1)
DATABASE_URL=…/united_perf npx next start -p 3112
# median of 5 per endpoint, signed in: curl -w '%{time_total}' …
```

Never point a load test or the seed at the production database.
