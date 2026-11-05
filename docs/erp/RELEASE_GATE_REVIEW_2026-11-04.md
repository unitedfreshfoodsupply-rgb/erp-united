# Release-gate review — PR #1 (4–5 Nov 2026)

Read-only against production; nothing deployed or migrated by this review. Final state recorded 5 Nov, before the merge of PR #1.

The review started at PR head `5bfc42b155192d1c9c5f2bfb6b1f933d491c10a9` (verified on GitHub). The review added:
- `74e69ba` — CI seeds the test database;
- `21652e7` — the first version of this report and the readiness corrections;
- `e5f70b2` — the fix for D-1, D-2 and D-3 (§2), approved by the owner on 4 Nov;
- the commit that adds this version of the report.

| # | Area | Result | Evidence | Open risk |
|---|---|---|---|---|
| 1 | PR head and CI | **PASS** | Code head `e5f70b2`. GitHub Actions on it, re-run after 00:00 Cairo on 5 Nov (runs `41914855697` pull request and `41914843679` push, attempt 2): both **success**, including: <br>• unit 245/245; <br>• integration 218/218; <br>• e2e 80 suites, 12,922 checks, 0 failed. <br>The first attempts (4 Nov, 23:18 Cairo) failed only at hr-attendance (the 29 Oct DST date, §4) | — |
| 2 | The merged changes together | **PASS (D-1, D-2, D-3 fixed)** | §2. 21 new integration tests: 17 fail on the code before the fix, all pass after. Independent adversarial review of the fix: 13 findings, each re-checked by a skeptic. 8 were confirmed (1 medium, 7 low) and all 8 are fixed and tested (§3.3) | Shared free stock across held orders stays a pending owner decision (§2.4) |
| 3 | Server-side permissions | **PASS** | e2e: RBAC 250, accounting access 50, report access 100, DB security 36. Unit: every route's gate matches the snapshot. Integration: 47 refusal tests. No route or permission changed in the fix | — |
| 4 | Posting idempotency | **PASS** | 24 integration tests, plus the fix's: <br>• two closes of one PO at once: one passes and one is refused; <br>• two POs of one line closed at once: both pass, with one open suggestion; <br>• repeated and simultaneous re-syncs leave one open suggestion and one approval request; <br>• the unique index still refuses a second open request | — |
| 5 | Issued documents immutable | **PASS** | Unchanged by the fix | 1 legacy production invoice has no snapshot (by design) |
| 6 | Inventory reconciliation | **PASS** | No stock, cost or GL rule changed. The fix reads stock and writes only notifications and purchase suggestions. e2e reconciliation suites in §4 | — |
| 7 | Opening-balance controls | **PASS (code); BLOCKED for production use** | Unchanged; opening stock now also tells orders waiting for stock (§2.2) | Owner decisions AD-1–AD-6 (unchanged) and a second production user |
| 8 | Migrations | **PASS** | The fix adds no migration. The 6 migrations follow production's 95 in order. The supplier backfill was re-validated against production: before and after match exactly, and the rollback was tested (§5) | — |
| 9 | Deploy and rollback steps | **PASS** | Deploy SQL unchanged (same SHA-256 as rehearsed). The rollback to the previous release was tested on 4 Nov | PM2 boot persistence and credential rotation cannot be verified from here (BLOCKED). The production connection limit (§3.4) |

## 1. What the review had found (4 Nov)

- **D-1 (confirmed).** A held order could lose its procurement suggestion. `syncOrderSuggestions` subtracted the full quantity of every "ordered" request whatever became of its PO, and `closePurchaseOrder` never returned the requests.
- **D-2 (confirmed, low).** Grade B from grading after receipt, opening stock and upward receipt corrections did not run the awaiting-stock check.
- **D-3 (possible).** The check ran inside the receipt for up to 200 held orders.

## 2. The fix (`e5f70b2`)

### 2.1 D-1: procurement coverage

- **Only what is still coming counts.** A line's shortage is netted against `stillOnOrder` (`lib/purchasing/requests.ts`), which is:
  - what a live PO line has yet to deliver: ordered − accepted over posted receipts, the PO's own receiving rule;
  - plus what that line delivered that is still in quarantine (not expired, in the warehouse the order is judged against), held for a grading-loss approval. It is in the house, so it is not bought again.
  - A cancelled or closed PO brings nothing more. What was delivered and released is stock, not "on order".
- **Closing a PO releases its coverage, as cancelling does** (`releasePoCoverage`, `lib/purchasing/orders.ts`):
  - A request nothing was accepted against goes back to "approved", unlinked, so it can be sourced again. If the line already has another open request, it is cancelled instead (one open request per line).
  - A request the closed PO partly delivered stays "ordered" on it: that is what was bought, and the order is served by it at release. The PO brings nothing more.
  - Either way the order's suggestion is re-sized to the line's current uncovered quantity, once.
- **Re-sized when what a PO brings changes:**
  - a receipt against it is posted, corrected or voided. A void after the close also releases a request left with nothing accepted;
  - its delivery is graded after receipt;
  - one of its lots leaves quarantine, net (released, written off, voided).

  These re-sizes run right after the stock transaction commits, in their own transaction and outside its stock locks. A receipt therefore never waits for, deadlocks with or fails on a purchase request being decided at the same moment.
- **Raised on behalf of whoever saved the order.** A suggestion that a PO close, receipt or grading re-raises is raised for the order's creator, as at saving. The buyer who closed the PO can still approve it (four eyes); the audit row names who caused it.
- **Unchanged:**
  - the order keeps its lines, prices, PO reference and awaiting-stock status;
  - nothing is reserved, dispatched or bought automatically;
  - suggestions still need someone else's approval;
  - one open suggestion per line (unique index; the re-size takes each open request's lock, the release takes the order's).

### 2.2 D-2: one mechanism for every stock increase

- **Where the changes are reported.** Every stock movement goes through `postMovements`, which is the only writer of stock movements. It reports what it did to sellable stock to `lib/inventory/availability-changes.ts`. So does every reservation change (`lib/inventory/reservations.ts`, the only writer of reservations): reserve −, release +, consume +.
- **When the check runs.**
  - At the end of the transaction (`beforeCommit`, `lib/tx.ts`), still inside it, the products whose sellable availability rose net are re-checked once by `noteStockArrival`. The notices commit or roll back with the stock change.
  - When orders were waiting, the check runs once more after commit (`afterCommit`). Two transactions raising the same order at once (a cancelled order beside a receipt) each see only their own half before commit; the last of them to commit sees both.
  - Outside `inTx` the check runs at once. The two product-name mapping transactions now use `inTx`, so a mapping tells once, with its final state.
- **Paths covered.** The trace of every path (five tracers, then a completeness critic) found these. All now report the same way:
  - receipt;
  - upward receipt correction (previously missing);
  - grading after receipt, Grade B SKU (previously missing);
  - opening stock, direct or through an approved batch (previously missing);
  - quarantine and grading-hold release;
  - positive adjustment and count surplus, posted at approval (previously missing);
  - customer return, credit-note restock and undelivered trip goods (previously missing);
  - document reversal (previously missing);
  - reservation released: order cancelled, line reduced, under-loaded dispatch, re-mapped line (previously missing);
  - a lot's expiry corrected, or a quarantine location turned into a shelf (no movement; previously missing).
- **What never counts as sellable.** One rule (`isSellableStock`) is shared with `productAvailability`: waste, quarantine, the legacy Grade B location and expired lots never count.
- **What reports nothing.** Moves that only shift stock around net to zero: transfers, re-reservations, an issue against its own reservation, cost re-layering.
- **What the notice says.** It names everything that still stops the release: a product and its missing quantity, or why a line cannot be reserved. It is sent once per change, to the order's creator and to whoever may release it, never to the person who caused it. It reserves nothing and raises no suggestion.

### 2.3 D-3: receipt performance

**Measured, then fixed.** Local PostgreSQL behind a TCP proxy that adds network delay and counts round trips (`tests/load/pg-latency-proxy.mjs`, `tests/load/stock-arrival.load.ts`). The setup:
- 250 orders waiting on one product, then one receipt that covers them all, then 4 simultaneous receipts, while an unrelated read runs every 100 ms;
- a single database connection (`connection_limit=1`), as `lib/prisma.ts` describes production.

| Round trip | Before: covering receipt | After | Before: 4 at once | After: 4 at once | After: unrelated read waits at most |
|---|---|---|---|---|---|
| 0 ms | 727 ms, **3,039** queries, **only 200 of 250 told** | 118 ms, 79 queries, 250 told | 4 of 4, 2.4 s | 4 of 4, 0.4 s | 0.2 s |
| 2 ms | **failed** after 19.8 s | 434 ms | **0 of 4** | 4 of 4, 1.4 s | 0.8 s |
| 5 ms | **failed** after 19.7 s | 677 ms | **0 of 4** | 4 of 4, 2.3 s | 1.4 s |
| 10 ms | **failed** after 19.2 s | 1,426 ms | **0 of 4** | 4 of 4, 4.8 s | 3.3 s |
| 25 ms | **failed** after 18.2 s | 2,827 ms | **0 of 4** | 4 of 4, 10.2 s | 6.9 s |
| 50 ms | not run | 5,418 ms | — | **3 of 4** (§3.4) | 10 s |
| 10 ms, 5 connections | **failed** (20 s transaction timeout) | 1,757 ms | 0 of 4 | 4 of 4, 4.7 s | 0.05 s |

How to read the "After" column:
- The 79 queries include the re-check after commit. The receipt's own transaction runs about 57 of them; the re-check runs about 22 after commit, outside the receipt's locks.
- A plain receipt with nobody waiting costs 43–46 queries: 1.1 s at 10 ms, 2.3 s at 25 ms, 4.4 s at 50 ms.
- **1,000 waiting orders.** 87 queries, 1.9 s at 10 ms. All 1,000 told.
- **Every run** had 0 duplicate notifications, 0 reservations and 0 lines with a second open suggestion. Every order stayed held.

**What failed before:**
- one query chain per held order, a dozen or more round trips each, inside the receipt;
- a settings read (cache miss) inside a long transaction waited for a second connection the single-connection pool could not give;
- the 200-order cap silently skipped every order after the 200th.

**What changed:**
- **Batched check.** `assessOrdersStock` and `productsAvailability` load orders, units, packagings, stock and reservations in a fixed number of queries, using the same judgement (`planFor`) as the single-order path. `notifyMany` writes the notices in one insert per 500.
- **No cap.**
- **Settings reads go through the open transaction.** Inside an `inTx` transaction a settings cache miss is read through that transaction (`currentTx`).

The check stays in the transaction, so no notice is lost or sent for a receipt that failed, and the re-check after commit closes the race. The measurements showed no need for an asynchronous queue.

### 2.4 Behaviour to confirm (unchanged by the fix)

Each held order is judged against all free stock, so a suggestion is sized as if the order could take it. If another order takes that stock first, the held order's suggestion is not re-raised until the next event that re-sizes it: an edit, or a PO receipt, close or cancel. This is the pending decision "shared free stock across orders awaiting stock" (readiness §6.5). The fix narrows the gap without changing that policy.

## 3. Verification

### 3.1 Tests (local test databases only)

| Suite | Result |
|---|---|
| Typecheck, lint, production build | clean, clean, OK |
| Unit | 245 / 245 |
| Integration, fresh seeded database | **218 / 218** (197 existing + 21 new) |
| New: `tests/integration/procurement-coverage.test.ts` | 9 / 9 (see the list below) |
| New: `tests/integration/stock-arrival.test.ts` | 12 / 12 (see the list below) |
| Full e2e chain (fresh database, 5 Nov 11:23 Cairo) | **84 suites, 12,948 checks passed, 0 failed** (§4) |

The D-1 tests cover:
- a PO closed after full rejection;
- a PO closed after a partial receipt;
- a PO cancelled;
- several POs on one line;
- a receipt graded at intake and held;
- a held receipt rejected, voided, then the PO closed;
- a void after the close;
- two closes at once;
- retries and races.

The D-2 tests cover:
- Grade B from grading after receipt;
- opening stock, in and outside `inTx`;
- upward and downward corrections;
- an approved positive adjustment;
- waste only;
- a released reservation;
- lot expiry and location-type corrections;
- the notice content and the right SKU;
- two rises at once;
- a re-mapping telling once;
- concurrent receipts;
- 205 waiting orders.

### 3.2 Regression evidence

The 21 new tests were run against the code before the fix (`21652e7`): **17 fail, 4 pass**.
- 3 of the passes describe behaviour that was already right: cancelling a PO, the waste rule, one notice per person.
- The 4th is the concurrency guard. The race it guards against did not occur in that run.

For example, before the fix:
- a PO closed after a full rejection left the request "ordered" on the closed PO;
- a PO closed after 6 of 10 left no suggestion for the 4;
- grading, opening stock, an upward correction, an approved adjustment and a cancelled order told no one;
- a re-mapping told "partial" then "ready" for one change;
- 205 waiting orders: only 200 were told.

### 3.3 Independent review of the fix

Four reviewers (procurement coverage, the central mechanism, batched equivalence, regressions elsewhere) read the fix. A skeptic then tried to refute each finding.

**Confirmed and fixed:**
- two concurrent rises could both miss an order (medium): re-check after commit;
- two POs of one line closed at once could both reopen a request (low): the release takes the order's suggestion lock;
- the quarantine trigger counted gross moves and ran inside stock locks (low): net per lot, after commit;
- a lock-order inversion with name mapping, and one with the approval counter (low): PO-side re-sizes moved after commit;
- a receipt could fail on a purchase request being decided at the same time (low): after commit, plus the request locks;
- a mapping outside `inTx` told intermediate states (low): `inTx`;
- the notice could end "still missing:" with nothing listed (low): every shortfall is listed;
- a PO close was labelled "PO cancelled" on the timeline (low): labels corrected.

**Refuted, three of them still hardened:**
- the shared-stock limitation: it predates the fix and is documented (§2.4);
- the requester of re-raised suggestions: intended four-eyes routing. Changed anyway, so a single buyer can still act;
- a void after close: no wrong coverage. The request is released anyway;
- held-quarantine edge cases: no shipped path reaches them. The rule is tightened to non-expired lots in the order's warehouse anyway;
- net-zero moves on a supplier bill: they cannot reach the trigger.

### 3.4 Production connection limit (open risk, not changed)

- **Queueing.** With a single connection, simultaneous receipts queue behind each other. A plain receipt alone is about 45 round trips. At 50 ms, the fourth of 4 receipts at once waited past the 10 s pool timeout.
- **With 5 connections** every case above passes, and unrelated reads wait at most 0.05 s.
- **Not verified.** The connection limit and the VPS → Supabase round-trip time could not be read from here.
- **Approval needed.** Raising the limit is an infrastructure change and needs its own approval.

## 4. Full e2e chain and CI

**Local chain, fresh database** (`e5f70b2`):
- built 5 Nov 11:23 Cairo, then the database was rebuilt, migrated (101) and seeded;
- **84 of 84 suites ran**, all with exit code 0;
- **12,948 checks passed, 0 failed**;
- evidence: `release-gate-fixes-20261104/e2e-official-20261105/SUMMARY.txt`.

The overnight run scheduled for 00:02 never ran, because the session ended. This run replaces it.

**CI** (same commit, re-run after midnight): 80 e2e suites (the CI list), 12,922 checks, 0 failed; unit 245/245; integration 218/218.

`hr-attendance` passes on both. Its single failure on 4 Nov was the night shift of 29 Oct, the Egypt DST change date, which falls inside the relative test window only until 4 Nov. It is a calendar artefact of the test, not a product defect.

## 5. Supplier-category migration (83 suppliers)

**Production (read-only, 4 Nov):**
- 83 suppliers;
- all 83 id/code pairs of the migration exist, with none matched by id alone or by code alone;
- no `category` column yet;
- 95 migrations, latest `20261103130000_search_normalization`;
- fingerprints: pairs `b6d7e1d89d8b6f57303535839e5a0536`, rows `da8e5791466182cdb783b7e039873793`.

The local production rehearsal copy gives the same two fingerprints.

**On a copy of it**, with the deploy SQL (same SHA-256, `028f3c17…dc2b`, as the file rehearsed on 4 Nov):

| Step | Result |
|---|---|
| Before | 95 migrations, 83 suppliers, all columns md5 `993a0b26…` |
| Deploy | 101 migrations, latest `20261104170000_commercial_invoice_documents` |
| After | fruit 39, vegetable 44; 0 rows differ from the migration's lists; every other column unchanged (md5 `993a0b26…`) |
| Backfill run again | 0 rows changed. A second deploy is refused ("latest applied migration is not …") |
| Data rollback (set back to NULL only where the value is still the backfilled one) | 83 rows reverted, 0 classified, md5 `993a0b26…` (the starting state) |
| Schema | `prisma migrate status`: up to date. `prisma migrate diff`: no drift |

Application rollback: the previous release runs on the new schema (tested 4 Nov, readiness §2).

## 6. Remaining blockers before production

**Not code (owner or infrastructure):**
1. **Second production user.** Opening batches, the migration closure and bill variances need a second person.
2. **Opening decisions AD-1 to AD-6.** Posting opening balances in production is not authorised by this release.
3. **Company details** for documents (tax number, registry, address, legal form, capital, bank).
4. **ETA obligation.** Activating the ETA integration is the owner's compliance decision.
5. **PM2 boot persistence and credential rotation.** Not verifiable from here.
6. **Production connection limit** (§3.4).

**Workflow defaults to confirm:** shared free stock across held orders (§2.4), the custody defaults, Grade B as its own SKU, over-receipt tolerance on the accepted quantity.

**Code blockers:** none known.

Evidence: `UNITED_AUDIT_20261102/maturity/release-gate-fixes-20261104/` (load results before, after and final; the regression run on the old code; the supplier rehearsal; test logs).
