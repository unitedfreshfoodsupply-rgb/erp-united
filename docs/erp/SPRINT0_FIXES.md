# Sprint 0 — performance and UX fixes

Follow-up to the Sprint 0 audit (findings F-01 … F-19). Branch `perf/sprint-0-fixes`, based on
the production release `8f01e96`. Business rules, permissions and polling intervals are unchanged.

## What changed

| Finding | Change | Where |
|---|---|---|
| F-02 | Route error boundary (retry / home, digest as reference) and a last-resort `global-error` for the root layout | `app/error.tsx`, `app/global-error.tsx` |
| F-03, F-07 | Large and polled GET endpoints answer gzip-compressed JSON with a weak ETag and `Cache-Control: private, no-cache`; an unchanged poll costs a body-less `304`. The supervisor board's ETag leaves out its `generatedAt` stamp. Measured locally: 86 KB → 8.5 KB (board), 58 KB → 6.6 KB (orders) | `lib/http-response.ts`, `jsonForGet` in `lib/security/redact.ts`, 13 routes |
| F-05 | Independent report queries run together instead of one after another (the pool still caps concurrency at `connection_limit`): finance report (12 queries) and the accounting integrity check (9 checks, same order in the result) | `lib/management/reports.ts`, `lib/accounting/integrity.ts` |
| F-06 | Lists of customers, invoices, supplier bills and refunds return `total` and accept `?limit=`; the screens show "showing N of M" and **Load more**. The default stays at the old 300, so other callers see the same rows | `lib/core/list-window.ts`, `components/ui/ListMore.tsx`, the four services and views |
| F-08 | Customer search waits for a 300 ms pause before querying | `lib/hooks/useDebouncedValue.ts`, `CustomersView` |
| F-09 | The top bar keeps its height while the session loads (it used to push every page down by 57 px); the supervisor board reserves the funnel and health-banner space while its first poll is in flight | `components/Nav.tsx`, `SupervisorBoard.tsx` |
| F-12 | Nine indexes on foreign-key columns that had none | migration `20261030130000_fk_indexes`, `@@index` in the schema |
| F-15 | The app serves WebP copies of the brand images (17 KB and 30 KB instead of 178 KB and 159 KB; visually identical at quality 90) | `public/brand/*.webp` |
| F-16 | Post-deploy warm-up script, no credentials, read-only | `scripts/ops/warm-up.mjs`, `DEPLOYMENT.md` step 5 |
| F-17 | Sort select labelled; five compact text buttons/links raised to a 40 px touch height | supervisor, stock, ETA views |
| F-18 | `search_path` pinned (`public, extensions, pg_temp`) on the 35 business-rule trigger functions; bodies unchanged | migration `20261030131000_function_search_path` |

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
