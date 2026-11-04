# Implementation matrix — release candidate of 4 Nov 2026

Branch `feature/eta-customer-master-data`, based on `main` @ `04be32a` (production). One table per requirement set.
- **Before** is the state found by the targeted classification (file:line evidence in `UNITED_AUDIT_20261102/maturity/phased-opening-20261104/workflow-classification.json`).
- **Now** is the state after this branch.
- Items marked COMPLETE before were left unchanged.

## A. Phased opening balances and final closure

| Requirement | Before | Now | Where |
|---|---|---|---|
| Post supplier balances before the full legacy TB | MISSING (a one-batch opening had to balance) | COMPLETE: phase batches against the provisional clearing account 3900 | `lib/accounting/opening-batches.ts`, migration `…140000` |
| Clearing account kept apart, provisional, traced, zero at closure | MISSING | COMPLETE: DB trigger so that only opening entries post to 3900; trace per batch; closure check | `lib/accounting/opening-migration.ts` |
| Source evidence, ERP-code identity, category filter, exception register, idempotent import | MISSING | COMPLETE | same, plus `OpeningException` |
| Maker-checker, no self-approval, audit | COMPLETE (approval engine) | reused | — |
| Control center (in progress, awaiting approval, reconciliation required, ready, closed) | MISSING | COMPLETE | `components/accounting/OpeningMigrationView.tsx` |
| Closure: AP and AR = control accounts, inventory, fixed assets, TB, 3900 = 0, 3300 = 0, exceptions decided, 4 confirmations, second person | MISSING | COMPLETE | `closureChecks` (unit-tested) |
| Reports marked provisional until closure | MISSING | COMPLETE: TB, balance sheet, P&L and comparatives return `opening`; banner on screen | report routes |
| Supplier category: vegetable, fruit, other/services | PARTIAL (2 values) | COMPLETE | migration `…130000` |
| Rehearsal on a local copy of production | — | 11 suppliers posted (4,260,486.80); 41 exceptions open (11,667,096.00); integrity green | `PHASED_OPENING_MIGRATION_2026-11.md` §6 |

## B. Business workflows

| # | Requirement | Before | Now |
|---|---|---|---|
| 1a | Customer PO reference on the order | MISSING | COMPLETE (`Order.customerPoRef`) |
| 1b | Availability per line on entry | PARTIAL | COMPLETE (`assessOrderStock`) |
| 1c | Availability against sellable stock only | DEFECTIVE (Grade B and waste could count) | COMPLETE (Grade B location and waste excluded from sellable stock and picking) |
| 1d | All available → existing workflow | COMPLETE | unchanged |
| 1e | Shortage → saved as awaiting stock, nothing reserved | DEFECTIVE (409, nothing saved) | COMPLETE (`allow_shortage`, `stockStatus = awaiting_stock`) |
| 1f | Not prepared while awaiting; resumable | MISSING | COMPLETE (gate `stock_awaiting`; release resumes from the saved order) |
| 2a–2e | One linked procurement suggestion per short line, deduplicated, sized to the shortage | MISSING / PARTIAL | COMPLETE (purchase requests linked to the order line; a unique index) |
| 2f | Suggestion updated or closed on receipt, change or cancel | DEFECTIVE (a cancelled PO left a dead end) | COMPLETE |
| 2g–2h | Audit; recommendation only | PARTIAL | COMPLETE (existing four-eyes request → PO) |
| 3a–3d | Recheck on receipt, notify, covered vs outstanding, resume without re-entry | MISSING | COMPLETE, except the hook does not run on the sorting path (PARTIAL there) |
| 3e | No automatic dispatch or reservation | PARTIAL | COMPLETE (release runs the normal reservation) |
| 4a, 4f, 4g | PO reference, no duplicate receipt, stock ledger | COMPLETE | unchanged |
| 4d | Over-receipt measured on the accepted quantity | DEFECTIVE (Grade B and waste escaped the tolerance) | COMPLETE |
| 4e | Partial deliveries, outstanding quantity | PARTIAL (Grade B and waste stayed "outstanding") | COMPLETE (on the accepted quantity) |
| 4b, 4c, 4h | Supplier delivery-note number; responsible employee; PO → receipt → grading query | PARTIAL | PARTIAL (not changed; see C) |
| 5a | Graded once | PARTIAL (the same kilos could be graded twice) | COMPLETE (lock and cap on cumulative sorting) |
| 5c | Grade B its own SKU with its own price | DEFECTIVE | COMPLETE (Grade B product required, never the Grade A one) |
| 5d | Waste never sellable or transferable; in reports | DEFECTIVE | COMPLETE (waste and Grade B transfers refused; waste trend and valuation include sorting waste) |
| 5g | Cost not multiplied across outputs | DEFECTIVE (NRV counted rejected kilos) | COMPLETE |
| 5h | Purchase cost apart from selling price | COMPLETE | unchanged |
| 5b, 5e, 5f | Raw stock sellable before sorting; written year-end waste procedure; measurement difference | PARTIAL | PARTIAL (not changed; see C) |
| 6a, 6b, 6e, 6f, 6g, 6k | Stock issue document, order reference, no over-issue, no double deduction, ledger, discrepancies | COMPLETE | unchanged |
| 6j | Grade B and waste restrictions cannot be bypassed | DEFECTIVE | COMPLETE (1c/5d) |
| 6c, 6d, 6h, 6i, 6l | Issued quantity per line; issuing employee; ISS ↔ delivery link; supervisor override to dispatched; delivery confirmation off-trip | PARTIAL | PARTIAL (not changed; see C) |
| 7.1–7.4 | Custody advances on approval; supplier payments from custody; returns; statement; never a purchase or expense | PARTIAL / MISSING | COMPLETE (`lib/hr/custody.ts`, migration `…160000`) |
| 7.5 | Buyer ↔ category (Samah vegetables, Youssef fruit) | MISSING | COMPLETE (`Employee.purchasingCategory`; mismatch needs an audited override) |

## C. Commercial invoices (see `COMMERCIAL_INVOICES_2026-11.md`)

| Requirement | Before | Now |
|---|---|---|
| Sales invoice from delivered quantities, numbered, posted once, credit notes only after issue | COMPLETE | unchanged |
| Complete immutable snapshot at issue (seller, buyer card, order/PO/trip, product codes) | PARTIAL (buyer name, tax number, address) | COMPLETE |
| Draft reads master data live; shows the gaps; links to correct them | MISSING | COMPLETE |
| Draft editing with old/new audit | PARTIAL | COMPLETE (notes; lines follow the order) |
| Supplier bill against PO and receipts, duplicate number refused, posted once, debit notes, no payment created | COMPLETE | unchanged (now tested end to end) |
| Supplier snapshot at posting; product code, PO and receipt per line | MISSING | COMPLETE |
| Bill draft edits audited with the previous value | PARTIAL | COMPLETE |
| Attachments on bills and invoices | MISSING | COMPLETE |
| Sales invoice print: commercial title, nothing ETA-like unless real; codes, PO, trip, bank, terms, signatures; A4 multi-page | PARTIAL ("tax invoice" on every print) | COMPLETE |
| Supplier bill print, Arabic and English | MISSING | COMPLETE |
| Company legal form, capital, bank, terms; gaps named | PARTIAL | COMPLETE (fields; production still has to fill them) |
| Links: order → invoice, journal → invoice or bill, bill line → PO and receipt | PARTIAL | COMPLETE |
| Permissions enforced server-side | COMPLETE | unchanged; refusals tested |

## Not changed in this release (reasons)

| Item | Why it is left |
|---|---|
| 4b supplier delivery-note number field | A new receiving field; no defect. Proposed for the next release |
| 4c the receiving employee | Needs a user ↔ employee link decision |
| 4h one PO → receipt → grading trace query | Reporting work; the links exist in the data |
| 5b raw receipt counts as sellable before sorting | Changing what is sellable at the receiving location changes the floor workflow; needs the owner's decision |
| 5e written year-end waste review | A procedure document for the accountant (the mechanics exist) |
| 5f measurement difference between receipt and grading | A new movement type; needs an accounting decision |
| 6c, 6d, 6h issue quantity per line, issuer, issue ↔ delivery link | Traceability enhancements; no stock or money is wrong |
| 6i a supervisor override can dispatch past the shortage gate | Existing authorised override, audited; tightening it is a policy decision |
| 6l delivery confirmation for orders dispatched without a trip | Workflow decision (require trips, or a delivery note step) |
| 3 receipt hook on the sorting path | Known limitation of the new flow; the order can still be rechecked by hand |
