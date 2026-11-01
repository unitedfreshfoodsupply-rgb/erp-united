# UNITED ERP — Accounting gap register (final acceptance)

Branch `ui/enterprise-ux`, 1 November 2026. Every item that is not fully implemented, or that
depends on a business decision, is listed here. Nothing below is counted as complete in the
acceptance report.

**How to read the "Blocks production?" column:**
- **No:** the system can go live without it.
- **Decision before go-live:** a setting or policy must be decided, not built.
- **Yes:** go-live must wait for it.

## A. Not implemented

| # | Item | Status | Business impact | Accounting / legal risk | Recommended solution | Blocks production? |
|---|---|---|---|---|---|---|
| G1 | Sale of a fixed asset on credit, or as an ETA e-invoice | Not built.<br>A disposal is collected in cash or bank, and output VAT is posted. | Selling a vehicle or fridge to a registered business on credit needs a workaround (a manual sales invoice). | **Legal:** a sale of an asset to a registered business is a taxable supply. It may need an e-invoice through ETA with the right item code. A cash disposal posts VAT correctly but does not send an e-invoice. | Tax adviser to confirm the treatment and the item code (GS1/EGS). Then add an "asset sale" line type to sales invoices that runs the disposal accounting. | **No** — asset sales are rare. Until then, ask the tax adviser for each one. |
| G2 | Collections follow-up (dunning letters, reminders) | Not built. Aging and statements exist. | Reminders stay manual. | None (no posting). | Later phase. | No |
| G3 | Multi-currency | Not built. Every document is EGP; foreign-currency suppliers and customers are refused. | Imports or exports in USD/EUR cannot be booked. | None while trade is EGP only. | Build when needed (revaluation, FX gain/loss). | No (UNITED trades in EGP) |
| G4 | Bank statement formats other than CSV (MT940 / CAMT.053); storing statement lines | CSV paste with matching is built. The statement itself is not kept; the reconciliation keeps which book lines cleared. | The accountant exports CSV from online banking. | Low. The reconciliation is evidenced by the ticked lines and the balances. | Add the bank's export format when the bank is chosen. | No |
| G5 | Current / non-current split in the chart of accounts | Not modelled. Ratios treat all liabilities as current, and current assets as all assets except fixed assets. The basis is printed on screen. | Current, quick and cash ratios are conservative readings. | Presentation only. The statements are unaffected. | If loans are long-term, add a "non-current" flag on accounts (small change) and split the balance sheet. | No |
| G6 | Long-term / IFRS 16 leases, impairment, revaluation of assets | Not built. Assets are at cost less depreciation. | Leases are expensed as paid (rent). | For an SME under Egyptian Accounting Standards this is usually acceptable. Confirm with the auditor. | Auditor decision. | No |
| G7 | Accruals and prepayments automation (recurring and reversing journals) | Not built. They are posted as manual journals (approval optional). | Month-end accruals are typed by hand. | Low, given manual-journal approval (C2) and period close. | A recurring-journal template feature later. | No |
| G8 | Budget vs actual | Not built. Comparatives against prior periods exist. | No budget variance report. | None. | Later phase. | No |
| G9 | Physical count of crates and pallets as returnable packaging | Not modelled separately from fixed assets and stock. | Crate deposits and losses are tracked outside the ERP. | Low. | A decision first: asset category or consumable (checklist C6). | Decision before go-live (classification only) |

## B. Implemented, with a stated limitation

| # | Item | Status | Business impact | Risk | Recommended solution | Blocks production? |
|---|---|---|---|---|---|---|
| L1 | A graded receipt (Grade B or waste) cannot be voided in place | The void is **refused**: the stock went to three places. Nothing is half-done (business-cycle test §2). | A wrong graded receipt is corrected by a supplier return (debit note with goods out) and a stock adjustment, not by voiding. | None: refused, not corrupted. | Teach the correction route. If voids are frequent, build a graded void that takes back from all three buckets. | No |
| L2 | A cash box may go negative through supplier payments, expenses and refunds | Enforced only for transfers, transfer reversals, asset purchases and VAT payments. | A cashier can record paying more cash than the box holds. | The cash count would show it. The ledger audit reports any negative box. | Decide C9. If "never negative", extend the same lock check to payments, expenses and refunds (small change). | Decision before go-live |
| L3 | Payroll cost centre = the employee's department **at posting time** | Built. A transfer during the month moves the whole month's cost. | Minor misallocation in a month with transfers. | Management reporting only. | Accept, or split by days in each department later. | No |
| L4 | The current month's depreciation is dated the month's last day | By design. A P&L "to today" before month end does not show it. | Mid-month reports exclude the month's depreciation until month end. | None. | Run depreciation at month end (the month close does it automatically). | No |
| L5 | Opening-batch lines have no idempotency key | A double click adds a line twice to a **draft**. | Visible in the line list. Removable. Two-person approval before posting. | Low. | Accept. | No |
| L6 | Approval engine segregation of duties | Accounting approvals (manual journals, period/year reopen, opening batch, transfers) always refuse self-approval. **Other** approvals (shortages, adjustments, POs, expenses, bills) follow `approvals.require_different_approver`, which is **off** by default. | One person can request and approve operational approvals. | **Internal control:** an auditor will expect segregation. | Turn C16 on once there are enough approvers. | Decision before go-live |
| L7 | NRV grading policy (non-default) | Built and now posts its waste loss at intake (D19 fixed in this phase). The policy is **off** (proportional is the default). | — | Changing the policy changes product margins. | Keep proportional unless management approves NRV with a price list in place (C17). | No |
| L8 | VAT return period | Any contiguous period that has **ended** (from this phase: a period ending today can no longer be filed today). | — | — | File monthly (C12). | Decision before go-live |
| L9 | ETA production submission | Built and validated against the specification. **Not submitted to production ETA** in any test (no production credentials used). | E-invoicing goes live only after the ETA pre-production run. | **Legal:** e-invoicing obligation. | Follow `ETA_SANDBOX_EXECUTION_CHECKLIST.md` with UNITED's real credentials before switching it on. | **Yes, for e-invoicing only.** The ERP can run with ETA off while invoices are issued as today. |

## C. Business decisions (policy, not code) — see `BUSINESS_CONFIGURATION_CHECKLIST.md`

Fiscal-year start; manual-journal and transfer approval; cost-centre structure; asset
categories and capitalisation threshold; bank charges, withholding and write-off accounts; net
salaries account; service-bill and adjustment thresholds; cash-box rule; finance users and
approvers; opening cut-over date; VAT frequency; cash-flow classification of new accounts;
segregation of duties; grading policy.

## D. Defects found and fixed in the final acceptance phase

| # | Defect | Fix | Evidence |
|---|---|---|---|
| D18 | **A graded receipt's bill cleared only the good quantity.** The receipt credited GRNI for everything accepted (good + Grade B + waste: 1000 kg × 6 = 6000), but the bill defaulted to and matched only the 800 kg good (4800). So 1200 stayed in GRNI forever, or went to price variance if the full weight was billed. | The bill defaults to and matches the **accepted** quantity (received − rejected), as the receipt valued it. The bill screen shows the grading breakdown. What the supplier is not paid for is recorded as *rejected* at receipt. | business-cycle §3: bill 6000; GRNI for the receipt nets to 0; PPV 0. |
| D19 | **NRV grading with waste "expensed at grading": the waste loss was computed but never posted.** GRNI was short by the loss and the expense never appeared. | The intake posts Dr inventory adjustments / Cr GRNI for the waste loss, in the same transaction. Traceable (stock valuation, `intake-waste|<receipt>`). | Code path. Default policy unaffected. Regression green. |
| D20 | **A VAT return could be filed for a period ending today.** This was inconsistent with year close, which requires the year to have ended. | The period must have ended. | business-cycle §10. |
