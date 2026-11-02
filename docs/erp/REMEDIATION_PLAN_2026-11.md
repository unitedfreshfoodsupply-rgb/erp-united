# UNITED ERP — Remediation plan, November 2026

Baseline: `7991d66` (code `f6c7613`), branch `ui/enterprise-ux`, production on 77 migrations
(`20261031150000_cost_centers`). Work branch: `remediation/2026-11`. Source of findings:
`UNITED_ERP_Audit_Report_AR.html` (2 Nov 2026). Final backup verified before any change
(`~/UNITED_FINAL_BACKUP_20261102`, MANIFEST 12/12 OK, restore-tested).

## Protocol
- Additive only: new migrations, new columns/tables/constraints; no destructive DDL; no history rewrite.
- No silent fallbacks in money or stock paths. Where a policy is undecided, the default **blocks**
  the risky behaviour and the decision is recorded under "Decisions" below.
- Every fix gets a test. No assertion is weakened; tests that encoded a superseded rule are
  rewritten to assert the new rule, and the change is named in the commit message.
- Isolated environment only (local Postgres, `tests/_guard.ts`). Nothing touches production.

## Workstreams

| WS | Scope (finding IDs) | Owner | Migration range |
|---|---|---|---|
| WS1 Sales & stock integrity | New hard-stock order rule, strict dispatch (WF-01), per-line price (snapshot, override audit, below-cost/discount approval), KG/PCS precision, purchase requests linked to customer requests, open exception reconciliation | lead | `20261102100000`–`20261102109999` |
| WS2 Controls & customer data | CTL-01 segregation defaults + emergency self-approval, MIG-01 buyer tax identity, MIG-02 cutover reconciliation reports, L2 cash-box never negative | lead | `20261102110000`–`20261102119999` |
| WS3 Accounting | ACC-E1 provisional cost & revaluation, G1 asset sale on credit, G5 current/non-current, G2 collection follow-up list, G9 crate tracking decision | agent | `20261102120000`–`20261102129999` |
| WS4 ETA | ETA-01/02/03/11/12/13/14/19, canonical serializer, signature verification hooks, state machine | agent | `20261102130000`–`20261102139999` |
| WS5 HR & payroll | HR-03/04/05/06/07/10/11/12/17/19/20/22 (fail-closed where law unverified) | agent | `20261102140000`–`20261102149999` |
| WS6 Security & reliability | SEC-02 MFA (TOTP) for privileged roles, CSP, password policy, DB health check, ops runbooks (PM2, backups, monitoring) | agent | `20261102150000`–`20261102159999` |

Shared files (`prisma/schema.prisma`, `lib/permissions.ts`, `lib/core/settings-registry.ts`,
`lib/locale/*`): additive edits only, each workstream in its own block; the lead merges.

## Decisions taken as safe defaults (owner to confirm)
1. **Stock**: a confirmed order line must be mapped to a catalog product, use a unit the product
   carries, respect the unit's precision (KG 3 dp, PIECE integers), and be fully reserved at the
   moment it is confirmed. No shortfall is ever dispatched; `inventory.dispatch_issue_policy`
   keeps only `strict`. Unavailable quantities go to a Purchase Request, never to the order.
2. **Approvals**: `approvals.require_different_approver` defaults to **on**. A SUPER_ADMIN may
   approve their own request only when no other active user holds the approving permission,
   with a mandatory reason, an `emergency_self_approval` audit row and a notification.
3. **Thresholds** (all overridable in Settings): inventory adjustments and grading losses need
   approval above 0 (every non-zero one) via explicit `*_approval_required` switches defaulting on;
   manual journals and cash transfers need approval; line price below cost or discount above
   `sales.max_discount_pct` (default 10%) needs approval.
4. **Buyer tax identity**: the invoice buyer is the customer's billing legal entity when one is
   linked, else the card; a B2B customer (company/hotel/institution) with no 9-digit tax number
   cannot be invoiced.
5. **Cash**: cash and bank accounts never go negative through any posting path.
6. **Provisional cost**: receipts without a price must carry a provisional unit cost; the supplier
   bill revalues remaining layers and charges the sold portion's difference to COGS (not PPV).
7. **ETA**: stays disabled. Uncertain submissions can only leave `unknown` through an ETA lookup
   or a second-person reconciliation with the portal UUID.
8. **Payroll**: stays fail-closed until 2026 statutory values are entered and verified by two people.

## WS3 notes (accounting)

Migrations: `20261102120000_provisional_cost`, `20261102121000_customer_charges`,
`20261102122000_account_liquidity` (additive; the three CHECK constraints on `StockMovement`
kind/direction/source and `StockValuationLayer.costSource` are replaced by strict supersets).

**ACC-E1 provisional cost — built.**
- A receipt needs a cost: PO line → the receiver's `unit_cost` → the supplier's dated price
  (now recorded on the receipt) → otherwise an explicit `provisional_unit_cost` (> 0). With
  none of them the receipt is refused (400). A provisional receipt is flagged
  (`StockIntake.costProvisional`, layers `costSource = 'provisional'`); it is never an agreed
  price, so its bill line is "unpriced" and needs approval.
- When the bill posts, Δ = billed net − provisional value (accepted qty × provisional cost) is
  split by where the receipt's units are, read from the stock ledger per product (the receipt's
  lots, incl. a Grade-B SKU lot): on hand → Inventory (a `revaluation_out`/`revaluation_in`
  pair per bucket, counter GRNI, so layers and GL move together); issued (net of customer
  returns) → COGS; scrapped/adjusted → inventory adjustments; returned to the supplier before
  the bill → PPV (the debit note for that return credits it back). GRNI clears at provisional
  value + the inventory part. PPV stays only for variances against an agreed price. The
  receipt's lots move to the billed unit cost (a later return to the supplier leaves at it).
- Every split is a `StockRevaluation` row (never deleted; the movements point at it) + audit
  rows; the bill detail returns `revaluations`.
- Debit notes: an allowance (no goods back) on a provisional line changes that receipt's cost
  by the amount credited, split the same way; each row points at the bill row it reverses
  (`reversalOfId`). A debit note for the whole line therefore takes the bill's revaluation
  back exactly, together with the provisional base — nothing goes to PPV (decision: with no
  agreed price, what the supplier finally charges net is the cost). Goods sent back after the
  bill leave at the lot's billed cost — unchanged path, no variance.
- Reports: valuation report `provisionalQty/provisionalValue` per product + total;
  `GET /api/inventory/reports/provisional` (stock.valuation.view) lists receipts awaiting
  their bill; finance report `costProvisionalQty` per product and COGS including bill
  revaluations on the bill date; integrity check `provisional_cost_pending` (informational).
- Legacy `unknown` layers are untouched and still reported (`receivedWithoutCost`); a bill on
  such a receipt posts exactly as before (GRNI 0, net to PPV).
- Known limits: the split is by quantity (under the NRV grading policy Grade-B/waste carry
  different unit costs; the proportional default is exact). Standard-cost products are revalued
  like AVCO ones (their issues stay at standard cost — the pre-existing standard-costing drift).
  The UI receiving form asks for a provisional cost when there is no PO.

**G1 fixed-asset sale on credit — built.** `POST /api/assets/:id/dispose` takes `customer_id`
(+ optional `due_date`, default the customer's terms) instead of `cash_account_id`: Dr AR
(party = customer), Cr VAT output, gain/loss as for cash. The receivable is a `CustomerCharge`
(append-only) included in the customer's statement, aging, credit exposure and the AR
integrity check; it is settled by money received on account (applied to charges oldest-due
first in aging). Customer must be active and not on credit hold. The cash-flow statement moves
the uncollected price from investing to operating. Not done: an ETA e-invoice for the sale
(WS4 / tax adviser — gap register G1 "Legal"); asset-sale UI (API only, like disposals today).

**G5 current / non-current — built.** `Account.liquidity` (`current` | `non_current` | NULL).
Seeded by migration for the standard system accounts (current), the 1700 header and accounts
the asset register controls (non-current), and GL accounts behind cash boxes/banks (current);
new fixed-asset category accounts and cash/bank accounts get it at creation; other accounts
take their header's class or stay unclassified; settable on create/PATCH (asset/liability only,
system accounts cannot be unclassified). Balance sheet: current / non-current / unclassified
subtotals, `unclassifiedAccounts`, `classificationComplete`. Comparatives/ratios use current
assets ÷ current liabilities; unclassified balances are excluded and reported, never guessed.
Owner action: classify any loan or other non-system liability/asset account.

**G2 collection follow-up — built (read-only).** `GET /api/sales/reports/collections?as_of=`
(same gate as aging, `sales.invoices.view`): customers with overdue balances, each overdue
invoice / opening balance / charge with days overdue, buckets, money on account, last receipt,
credit limit/hold/terms and over-limit flag, ordered by oldest overdue. No messages are sent.

**Not built — decisions needed (gap register G4, G6, G7, G8, G9):**
- G9 crates/pallets: needs the classification decision first (returnable packaging as a fixed-asset
  category, or a consumable/stock item with deposits) — checklist C6. Nothing built.
- G8 budgets: needs the owner's budget structure (by account? cost center? month?). Comparatives
  against prior periods remain the substitute.
- G6 leases / impairment / revaluation of assets: auditor decision under EAS (IFRS 16-style
  lease accounting is usually not required for this SME); leases stay expensed as rent.
- G7 recurring/reversing accruals: not trivial (scheduler + templates); month-end accruals stay
  manual journals under the approval rule.
- G4 bank formats (MT940/CAMT): depends on the bank chosen; CSV matching remains.
