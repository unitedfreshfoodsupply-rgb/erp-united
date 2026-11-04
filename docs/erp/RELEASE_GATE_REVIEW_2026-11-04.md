# Release-gate review — PR #1 (4 Nov 2026)

Read-only against production; nothing deployed or migrated. PR #1 is not merged.

The review started at PR head `5bfc42b155192d1c9c5f2bfb6b1f933d491c10a9` (verified on GitHub). This review added two commits:
- `74e69ba` — CI seeds the test database;
- the commit that adds this report and corrects the readiness document.

| # | Area | Result | Evidence | Open risk |
|---|---|---|---|---|
| 1 | PR head and CI | **PASS, CI not fully green yet** | Head verified. CI on `5bfc42b` failed in integration: 19 of 197, 9 of them already failing on `main` @ `04be32a`, all because CI ran them on an unseeded database. Reproduced locally: 178/197 unseeded, 197/197 seeded. Fixed in `74e69ba`. CI on `74e69ba`: everything passes through integration, then the e2e chain passes 21 suites and stops at `hr-attendance` | `hr-attendance` fails only on 3–4 Nov (Cairo): its night shift is 29 Oct, the night the clocks went back. It also fails on the base. Because the chain stops at it, CI ran 21 of 84 e2e suites today. Re-run CI on or after 5 Nov for a full chain |
| 2 | The merged changes together | **FAIL: 1 confirmed defect, plus 1 low and 1 possible** | Independent read of every shared function. Sellable stock, custody payments and reversals, opening versus custody, bill and invoice snapshots, and signature changes are consistent | See D-1 to D-3 |
| 3 | Server-side permissions | **PASS** | e2e: RBAC 250, accounting access 50, report access 100, DB security 36. Unit: every route's gate matches the snapshot. Integration: 47 refusal tests. New routes are gated (`sales.invoices.manage`, `purchasing.bills.view`) | — |
| 4 | Posting idempotency | **PASS** | 24 integration tests on once / retry / duplicate: issue twice → 409 with one journal; post twice → 409; one custody request or payment per key; one import per source row; one open suggestion per line (unique index) | — |
| 5 | Issued documents immutable | **PASS** | The snapshot is written in the same UPDATE that freezes the row (`SalesInvoice_frozen`, `SupplierBill_frozen`). Tests change the company, customer, supplier and product afterwards and the document is unchanged; a direct database update is refused | 1 legacy production invoice has no snapshot (by design, cannot be back-filled) |
| 6 | Inventory reconciliation | **PASS** | e2e: cost reconciliation 23, sales–stock integrity 77, business cycle 59, ledger audit 62/64, waste 68, grading 34/33/26. Integration: 20 reconciliation tests, including the custody chain (inventory raised once, GRNI 0, integrity checks green) | — |
| 7 | Opening-balance controls | **PASS (code); BLOCKED for production use** | Unit closure checks; integration lifecycle; e2e 34; DB triggers on 3900, exceptions and closure | Owner decisions AD-1–AD-6 and a second production user |
| 8 | Migrations | **PASS** | 6 migrations, in order after production's 95 (latest `20261103130000_search_normalization`). The schema only grows: new columns are nullable or defaulted, CHECKs widen, constraints relax. The one data change is the supplier-category backfill (approved D-1 list, matched by id and code; all 83 pairs exist in production, read-only). Account 3900 is free in production. Rehearsed on a production copy: applies, no drift, refuses a second run | — |
| 9 | Deploy and rollback steps | **PASS (one document correction)** | Deploy SQL and permission sync rehearsed on a production copy (the D-2 grant goes 0 → 1, idempotent). **Rollback tested:** the previous release `04be32a` on the new schema passes its own suites, 0 failures. Corrected: `permissions-sql.ts` prints SQL and must be redirected; the migration table now lists the supplier backfill | PM2 boot persistence and credential rotation cannot be verified from here (BLOCKED) |

## Defects found (not fixed: they need approval before the code changes)

- **D-1 (confirmed, operational, no money or stock effect).** A held order can lose its procurement suggestion.
  - `syncOrderSuggestions` subtracts the full quantity of every "ordered" request, whatever happened to its PO (`lib/purchasing/requests.ts:310-314`).
  - `closePurchaseOrder` never returns the requests (`lib/purchasing/orders.ts:355-367`). Cancel does, but it is refused once anything was received.
  - Scenario: the PO's delivery is rejected in full, then the PO is closed. The order is still short, and no suggestion is open.
  - The order stays safely held, but purchasing is not prompted.
  - Fix: net only what is still open on a live PO line, and return the requests when a PO closes, as cancel already does.
- **D-2 (confirmed, low; notifications only).** Grade B from sorting after receipt, opening stock and upward receipt corrections do not call `noteStockArrival`. Held orders for those products are not told the stock arrived; they can still be rechecked by hand.
- **D-3 (possible, needs a load test).** `noteStockArrival` runs inside the receipt transaction (20 s timeout) for up to 200 held orders. Many held orders on one product could slow or time out receipts on the remote database.
