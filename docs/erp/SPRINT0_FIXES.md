# Sprint 0 — performance and UX fixes

Follow-up to the Sprint 0 audit (findings F-01 … F-19). Branch `perf/sprint-0-fixes`, based on
the production release `8f01e96`. Business rules, permissions and polling intervals are unchanged.

## What changed

| Finding | Change | Where |
|---|---|---|
| F-02 | Route error boundary (retry / home, digest as reference) and a last-resort `global-error` for the root layout | `app/error.tsx`, `app/global-error.tsx` |
| F-03, F-07 | Large and polled GET endpoints answer gzip-compressed JSON with a weak ETag and `Cache-Control: private, no-cache`; an unchanged poll costs a body-less `304`. The supervisor board's ETag leaves out its `generatedAt` stamp. Measured locally: 86 KB → 8.5 KB (board), 58 KB → 6.6 KB (orders) | `lib/http-response.ts`, `jsonForGet` in `lib/security/redact.ts`, 13 routes |
| F-05 | Independent report queries run together instead of one after another (the pool still caps concurrency at `connection_limit`): finance report, accounting integrity check (same order in the result), AR and AP aging (four read chains; party names in one query per chain instead of one per party). Output verified identical to the previous code on the same database (finance for two periods, integrity, AR/AP aging at three dates) | `lib/management/reports.ts`, `lib/accounting/integrity.ts`, `agingReport`, `apAgingReport` |
| F-06 | Lists of customers, invoices, supplier bills and refunds return `total` and accept `?limit=`; the screens show "showing N of M" and **Load more**. The default stays at the old 300, so other callers see the same rows | `lib/core/list-window.ts`, `components/ui/ListMore.tsx`, the four services and views |
| F-08 | Customer search waits for a 300 ms pause before querying | `lib/hooks/useDebouncedValue.ts`, `CustomersView` |
| F-09 | The top bar keeps its height while the session loads (it used to push every page down by 57 px); on the desktop the sidebar's width is reserved too, from a layout-hint cookie (`u_shell`, no security meaning) the shell sets once the session is known. The supervisor board reserves the funnel and health-banner space while its first poll is in flight. Side effect: `/login` is rendered per request instead of prerendered | `components/Nav.tsx`, `app/layout.tsx`, `app/globals.css`, `SupervisorBoard.tsx` |
| F-12 | Nine indexes on foreign-key columns that had none | migration `20261030130000_fk_indexes`, `@@index` in the schema |
| F-15 | The app serves WebP copies of the brand images (17 KB and 30 KB instead of 178 KB and 159 KB; visually identical at quality 90) | `public/brand/*.webp` |
| F-16 | Post-deploy warm-up script, no credentials, read-only | `scripts/ops/warm-up.mjs`, `DEPLOYMENT.md` step 5 |
| F-17 | Sort select labelled; five compact text buttons/links raised to a 40 px touch height | supervisor, stock, ETA views |
| F-18 | `search_path` pinned (`public, extensions, pg_temp`) on the 35 business-rule trigger functions; bodies unchanged | migration `20261030131000_function_search_path` |

## Measured (local, production build)

| | Before | After |
|---|---|---|
| `/api/management/finance` at 190 ms database round trip | 4.7 s | 2.3 s |
| `/api/accounting/integrity` at 190 ms | 3.1 s | 1.2 s |
| `/api/admin/overview` at 190 ms | 1.16 s | 0.6 s |
| Supervisor board poll, changed / unchanged | 86 KB / 86 KB | 8.5 KB / 304, no body |
| Layout shift `/supervisor` (390 px / 1366 px) | 0.46 / 0.27 | 0.065 / 0.023 |
| Layout shift `/hr` (390 px / 1366 px) | 0.14 / 0.14 | 0.054 / 0 |
| Unlabelled inputs, targets under 32 px (`/supervisor`, `/eta`, `/stock`) | 1, 15 | 0, 0 |

`/stock` on a phone still shifts when the supplier list is long (the supplier chips arrive after
the form); with the test database's dozens of test suppliers it measures 0.22. Not addressed here.

## Validation

Typecheck, lint, dictionary integrity (3,097 keys); unit 134/134; integration 68/68; the full
end-to-end run (`npm run test:e2e`, 57 suites, 9,676 checks, 0 failed) on a local disposable
database; after the aging change, scenarios, accounting, cash-flow, sales, purchasing,
accounting-access, settlement-deductions and service-bills again (620 checks, 0 failed).
The migration chain applies to an empty database with no drift against the schema.

## Not changed, and why

| Finding | Decision |
|---|---|
| F-01 (distance between the VPS and the database) | Needs a round-trip measurement on the VPS first; the commands are in the Sprint 0 audit §9. No code change. |
| F-10 (route `loading.tsx`) | Tried and removed: page guards run inside each page, so a route loading boundary makes Next stream a `200` before the guard runs and an anonymous visit gets a client-side redirect instead of `307 → /login` (caught by `tests/security.test.ts`). Doing it properly means moving the guards into segment layouts — a separate change. |
| F-11 (session look-up cache) | Session resolution is already one joined query, memoised per request. A cross-request cache would let a disabled account or a removed permission keep working until it expires, which breaks the rule documented in `lib/authz.ts` ("takes effect on the very next request"). Not done. |
| F-14 (bundle size) | Page code is 2–15 kB per route; the shared weight is the bilingual dictionary (3,097 keys, ~73 kB gzip, both languages on every page). Splitting it per language is the lever; it touches `t()` and the integrity checker, so it is left for its own change. |
| F-13 (backup schema), F-04 (storage bucket), proxy gzip | Production configuration — prepared, applied only with approval (below). |
| F-19 (trigram search) | When customer volume justifies it. |

## Production steps (each needs approval; none has been run)

1. Backup, then `npx prisma migrate deploy` for the two new migrations. Both are additive:
   `CREATE INDEX` on small tables (brief write lock), `ALTER FUNCTION … SET search_path`.
2. Deploy the build, `GET /api/health`, then `node scripts/ops/warm-up.mjs http://127.0.0.1:<port>`.
3. Optional, separate approvals: drop schema `reset_backup_20261029_prelaunch` after go-live
   acceptance (F-13); create the Supabase Storage bucket for attachments (F-04).

Rollback: the previous build still runs against the new schema (indexes and a function setting
only); the migrations need no rollback for that.
