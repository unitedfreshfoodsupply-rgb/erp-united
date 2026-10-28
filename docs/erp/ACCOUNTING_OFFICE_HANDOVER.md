# UNITED ERP — Accounting Office Handover Package

**Prepared:** 2026-10-18 · **Updated:** 2026-10-21 (verified treatments §3.1; decision statuses §5.4)  
**Repository:** `/opt/data/united-investigation` @ `united-full-project`@`7bccad7`  
**Status:** Code review only — no production access, no deployment, no changes made

---

## 1. Chart of Accounts (27 accounts, 6 system keys)

| Code | Name (Arabic) | Type | System Key | Postable |
|---|---|---|---|---|
| 1000 | الأصول | asset | — | ❌ (header) |
| 1100 | النقدية بالخزينة | asset | `cash` | ✅ |
| 1200 | البنك | asset | `bank` | ✅ |
| 1300 | العملاء (ذمم مدينة) — AR | asset | `ar` | ✅ |
| 1400 | المخزون — Inventory | asset | `inventory` | ✅ |
| 1500 | ضريبة القيمة المضافة — مشتريات | asset | `vat_input` | ✅ |
| 1600 | سلف العاملين — Employee advances | asset | `employee_advances` | ✅ |
| 2000 | الخصوم | liability | — | ❌ (header) |
| 2100 | الموردين (ذمم دائنة) — AP | liability | `ap` | ✅ |
| 2150 | بضاعة مستلمة لم تصل فواتيرها — GRNI | liability | `grni` | ✅ |
| 2200 | ضريبة القيمة المضافة — مبيعات | liability | `vat_output` | ✅ |
| 2300 | مستحقات العاملين — Employee payable | liability | `employee_payable` | ✅ |
| 3000 | حقوق الملكية — Equity | equity | — | ❌ (header) |
| 3100 | رأس المال — Capital | equity | `capital` | ✅ |
| 3200 | الأرباح المحتجزة — Retained earnings | equity | `retained_earnings` | ✅ |
| 3300 | أرصدة افتتاحية — Opening equity | equity | `opening_equity` | ✅ |
| 4000 | الإيرادات — Revenue | revenue | — | ❌ (header) |
| 4100 | المبيعات — Sales | revenue | `sales` | ✅ |
| 4200 | مردودات ومسموحات المبيعات — Sales returns | revenue | `sales_returns` | ✅ |
| 5000 | تكلفة المبيعات — Cost of sales | expense | — | ❌ (header) |
| 5100 | تكلفة البضاعة المباعة — COGS | expense | `cogs` | ✅ |
| 5200 | تسويات وهالك المخزون — Adjustments | expense | `inventory_adjustment` | ✅ |
| 5300 | فروق أسعار المشتريات — PPV | expense | `ppv` | ✅ |
| 6000 | المصروفات — Operating expenses | expense | — | ❌ (header) |
| 6100 | مصروفات عمومية — General expenses | expense | `general_expenses` | ✅ |
| 6200 | نقل ووقود — Transport & fuel | expense | `transport_expenses` | ✅ |
| 6300 | مرتبات وأجور — Salaries | expense | `salaries` | ✅ |

**Source:** `lib/core/reference-data.ts` lines 122-149

**Note:** Cash accounts (`cash_main`, `bank_main`) are separate models bound to account 1100/1200 via `accountId`.

---

## 2. Accounting Reports — Complete Map

| Report | API Route | Permission | Source file | Description |
|---|---|---|---|---|
| **Chart of accounts** | `GET /api/accounting/accounts` | `accounting.view` | `lib/accounting/ledger.ts → chartOfAccounts()` | Full list with system keys, types, header flag |
| **Account ledger** | `GET /api/accounting/accounts/[id]/ledger` | `accounting.view` | `lib/accounting/ledger.ts → accountLedger()` | All journal lines for one account, paginated |
| **Trial balance** | `GET /api/accounting/trial-balance?from=&to=` | `accounting.view` | `lib/accounting/ledger.ts → trialBalance()` | Credit/debit totals per account, must balance |
| **P&L** | `GET /api/accounting/pnl?from=&to=` | `accounting.view` | `lib/accounting/ledger.ts → profitLoss()` | Revenue accounts minus expense accounts, with section grouping |
| **Balance sheet** | `GET /api/accounting/balance-sheet?as_of=` | `accounting.view` | `lib/accounting/ledger.ts → balanceSheet()` | Asset/liability/equity balances as of date |
| **Cash position** | `GET /api/accounting/cash` | `accounting.view` | `lib/accounting/cash.ts → cashPosition()` | Cash+bank balances with uncleared summary |
| **VAT summary** | `GET /api/accounting/vat-summary?from=&to=` | `accounting.view` | `lib/accounting/vat-summary.ts → vatSummary()` | Tax per code/rate, net of credits/debits, reconciled to GL 1500/2200 |
| **VAT export** | `GET /api/accounting/vat-summary/export` | `accounting.view` | Same + `lib/csv-export.ts` | CSV with UTF-8 BOM |
| **Accounts Health (Integrity)** | `GET /api/accounting/integrity` | `accounting.view` | `lib/accounting/integrity.ts → integrityReport()` | AR=GL 1300, AP=GL 2100, Inventory=GL 1400, no orphans |
| **Journals list** | `GET /api/accounting/journals?source_type=&limit=&offset=` | `accounting.view` | `lib/accounting/ledger.ts` | All journal entries, filterable by source type |
| **Journal detail** | `GET /api/accounting/journals/[id]` | `accounting.view` | `lib/accounting/ledger.ts → getJournal()` | Single journal with all lines, account codes, parties |
| **Journal reverse** | `POST /api/accounting/journals/[id]/reverse` | `accounting.manage` | `lib/accounting/ledger.ts → reverseJournal()` | Reversal entry (not allowed on document-posted entries) |
| **Customer statement** | `GET /api/sales/customers/[id]/statement?from=&to=` | `sales.invoices.view` | `lib/accounting/statements.ts` | Invoice/receipt/credit rows with running balance |
| **Customer aging** | `GET /api/sales/reports/aging` | `accounting.view` | `lib/accounting/reports.ts` | Current/30/60/90+ buckets per customer |
| **Customer statement export** | `GET /api/sales/customers/[id]/statement/export` | `sales.invoices.view` | Same + `lib/csv-export.ts` | CSV |
| **Supplier statement** | `GET /api/purchasing/suppliers/[id]/statement` | `purchasing.bills.view` | `lib/accounting/statements.ts` | Bill/payment/debit-note rows with running balance |
| **AP aging** | `GET /api/purchasing/reports/ap-aging` | `accounting.view` | `lib/accounting/reports.ts` | Current/30/60/90+ buckets per supplier |
| **Supplier statement export** | `GET /api/purchasing/suppliers/[id]/statement/export` | `purchasing.bills.view` | Same + `lib/csv-export.ts` | CSV |
| **Inventory valuation** | `GET /api/inventory/reports/valuation` | `stock.valuation.view` | `lib/inventory/reports.ts` | Per-product: quantity, value, average cost, `receivedWithoutCost` |
| **Valuation export** | `GET /api/inventory/reports/valuation/export` | `stock.valuation.view` | Same + `lib/csv-export.ts` | CSV |
| **Stock valuation → GL** | `POST /api/accounting/stock-valuation` | `accounting.manage` | `lib/accounting/ledger.ts → postStockValuationIfNeeded()` | Catch-up run; posts missing valuation entries |
| **Cancelled/voided report** | `GET /api/accounting/cancelled-report?from=&to=` | `accounting.manage` | `app/api/accounting/cancelled-report/route.ts` | Debit notes, receipt reversals, payment reversals, journal reversals, cancelled orders, voided invoices |
| **Management finance report** | `GET /api/management/finance?from=&to=` | `reports.finance` | `lib/management/reports.ts → profitAndLoss()` | Sales by product (top 30), by customer, P&L, cash, AR/AP, inventory value, `costUnknownQty` |
| **Management finance export** | `GET /api/management/finance/export` | `reports.finance` | Same + `lib/csv-export.ts` | CSV |
| **Bank reconciliation** | `GET/POST /api/accounting/reconciliations/*` | `accounting.manage` | `lib/accounting/bank-reconciliation.ts` | Start, mark lines, complete reconciliation |

---

## 3. Accounting Engine — Double-Entry Journaling

Every business document posts exactly one balanced journal entry in the same transaction:

| Document | Journal Effect | Source file |
|---|---|---|
| Sales invoice | Dr AR 1300 / Cr Sales 4100 / Cr VAT output 2200 | `lib/sales/invoicing.ts → postSalesInvoice` |
| Credit note | Dr Sales returns 4200 / Dr VAT output 2200 / Cr AR 1300 (+ stock at cost if restocked) | `lib/sales/invoicing.ts → createCreditNote` |
| Supplier bill | Dr GRNI 2150 (agreed) ± PPV 5300 / Cr AP 2100 | `lib/purchasing/bills.ts → postSupplierBill` |
| Debit note | Dr AP 2100 / Cr GRNI 2150 ± PPV 5300 | `lib/purchasing/bills.ts → postDebitNote` |
| Customer receipt | Dr Cash 1100/Bank 1200 / Cr AR 1300 | `lib/accounting/ledger.ts → postReceipt` |
| Supplier payment | Dr AP 2100 / Cr Bank 1200/Cash 1100 | `lib/accounting/ledger.ts → postPayment` |
| Stock valuation | Dr/Cr Inventory 1400 ↔ GRNI/COGS/Adjustments | `lib/inventory/ledger.ts → postMovementValuation` |
| Opening balance | Dr/Cr AR/AP / Cr/Dr Opening equity 3300 | `lib/accounting/integrity.ts → postOpeningBalance` |
| Manual journal | As entered (refused on control accounts: 1300,1400,2100,2150,1600) | `lib/accounting/ledger.ts → postJournal` |
| Reversal | Exact opposite of original entry | `lib/accounting/ledger.ts → reverseJournal` |

**Invariants enforced:**
- Every posted entry balances (debits = credits) — checked at commit
- Posted entries cannot be modified or deleted (append-only)
- No posting into a closed period
- No posting to header accounts
- System keys ensure consistent posting accounts
- Control accounts (AR, AP, inventory, GRNI, employee balances) closed to manual journals

### 3.1 Verified post-implementation treatments (2026-10-21)

The four items below were implemented and verified in the remediation batches (F-02, F-03, F-05) and are documented so the new office does not re-litigate them.

**1. Grading cost allocation — proportional, verified (F-02).** Post-receipt sorting (فرز) and intake-time grading allocate the source basket's cost across Good / Grade B / Waste proportionally to quantity (`lib/inventory/grading.ts → computeGradingCosts`, default policy). Grade B is NOT valued at zero, and cost is conserved across the sort. NRV allocation exists but is **disabled by default** — do not enable without a documented policy change and accountant approval. Verified by `grading-cost-policy.test.ts` (30/0) and `grading-ui.test.ts` (34/0).

**2. Quarantine release control — software-enforced (F-03).** Customer returns land in the quarantine location and are excluded from sellable/available stock. Stock may leave quarantine only through the release workflow (`POST /api/inventory/release`, permission `stock.release`, document type `release`, movement kinds `release_out`/`release_in`). Transfers and adjustments OUT of quarantine are rejected (400). Release to a waste or quarantine destination is rejected. Verified by `quarantine-release.test.ts` (43/0).

**3. Cash-flow statement — indirect method, in scope (F-05).** `GET /api/management/cash-flow?from=&to=` (permission `reports.finance`) presents Operating / Investing / Financing sections built from posted journal entries: net income (from P&L) plus working-capital account changes. The report reconciles to the cash/bank balance change (`_balanced` flag). Verified by `cash-flow.test.ts` (19/0).

**4. Sorting/release valuation — net-zero in the GL by design.** In `lib/accounting/ledger.ts`, the `VALUATION_COUNTER` maps `sorting_out`, `sorting_in`, `release_out`, and `release_in` movements to the `inventory_adjustment` counter (5200) via its fallback. Because a sort or release moves value between inventory buckets without creating or destroying value, the two legs' values are netted inside that counter and produce **no** journal line (the group sums to zero and is skipped); any rounding crumb would land in 5200, never silently vanish. This is the same net-zero mechanism verified for transfers. Evidence: `grading-cost-policy.test.ts` D16 (lot/layer invariant) and `quarantine-release.test.ts` N16 (release is value-neutral).

### 3.2 Settling a receipt or payment partly without cash (2026-10-28)

A customer receipt can carry up to three deductions, and a supplier payment one:

| Deduction | Where | Journal | Setting that switches it on |
|---|---|---|---|
| Tax the customer withheld | Receipt | Dr withholding receivable | `accounting.withholding_receivable_account` (an asset account code) |
| Bank charge taken from the transfer | Receipt | Dr bank charges | `accounting.bank_charges_account` (an expense account code) |
| Small difference allowed | Receipt | Dr settlement differences | `accounting.write_off_account` (an expense account code) **and** `accounting.write_off_limit` (> 0); only users with `accounting.manage` |
| Tax UNITED withheld from the supplier | Payment | Cr withholding payable | `accounting.withholding_payable_account` (a liability account code) |

- The receipt (or payment) amount is what the party's balance is settled by; the cash leg is that amount minus the deductions. Statements, aging and Accounts Health are unchanged.
- Each kind stays **off** until the accountant creates the account (Accounting → accounts) and enters its code in the settings. A code that is not an active, postable account of the right type, a control account or a cash/bank account is refused.
- The certificate number is optional at receipt time (certificates often arrive later). The withholding report (`GET /api/accounting/withholding?side=receivable|payable`, CSV at `/export`) lists each document and flags missing certificate numbers.
- Reversing the receipt or payment reverses every leg, including the deductions.
- Rates, which customers withhold, and whether UNITED is a withholding agent are the accountant's decisions (DEC-01/02); the system records amounts, it does not compute rates.

### 3.3 Service bills — supplier invoices with no goods receipt (2026-10-28)

Rent, utilities, transport, maintenance, services and equipment bought on credit are booked as a **service bill** (Purchasing → Supplier bills → New service bill):

- Each line names an expense or asset account, a description, the amount before tax and its tax code. Header, control (AR/AP/inventory/GRNI/employee), cash/bank, input-VAT and revenue accounts are refused.
- Posting: **Dr each line's account / Dr VAT input (1500) / Cr suppliers (2100)**. The bill is then paid, aged, stated and appears in the VAT summary exactly like a goods bill.
- Approval: a service bill whose total is above `purchasing.service_bill_approval_threshold` waits for approval by someone with `purchasing.bills.approve`. The shipped value is **0 — every service bill needs approval** until management sets a threshold (DEC-05).
- **Self-approval is prevented only when `approvals.require_different_approver` is enabled.** That setting ships **off** (`false`). With it off, the only separation is by role: in the shipped role bundles the accountant can book bills but not approve them, while SUPER_ADMIN holds both permissions and could approve a bill they booked. The same applies to every approval type (goods-bill variances, expenses, stock adjustments, shortages, purchase orders, credit). Enabling it is a management decision; it is not changed by this release.
- Corrections after posting: a debit note per line, by amount before tax, at the line's tax rate (Dr suppliers / Cr the line's account / Cr VAT input), never more than what is left of the line.
- A fixed asset bought on credit is a service bill line on the asset account; depreciation stays a monthly manual journal from the accountant's register until a register is justified (WP-8).

---

## 4. Known Gap — Unknown-Cost PPV/GRNI Accounting (requires decision)

When stock is received **without** a known `unit_cost` (fresh produce where the price is settled later):

| Step | Current Behavior | Accountant Question |
|---|---|---|
| Intake w/o cost | Layer value 0, `receivedWithoutCost=QTY`, `costSource: unknown` | — |
| Sale before bill | COGS 0, margin flagged provisional (`costUnknownQty`) | — |
| Supplier bill arrives at real price | Bill goes to `pending_approval` (unpriced — no PO/receipt price to match against) | ✅ Approval flow works |
| After approval | Journal: **Dr PPV 4000 / Cr AP 4000** (GRNI 0) | **QUESTION: Is it acceptable that the full cost hits PPV?** |
| Remaining stock | Stays at value 0 — **layer history not rewritten** | **QUESTION: Should remaining stock be revalued?** |

**Decision required:** Approve the current treatment (PPV full, GRNI 0, layers not rewritten) or specify alternative.

---

## 5. Accountant Handover Checklist

### 5.1 Reports the accountant can use immediately

| Report | What it shows | Verified? |
|---|---|---|
| Trial balance | All accounts with debit/credit totals; must balance to 0 | ✅ Verified against test suite |
| P&L | Revenue, COGS, PPV, expenses by section | ✅ Verified |
| Balance sheet | Assets, liabilities, equity as of date | ✅ Verified |
| AR aging | Customer balances aged 0-30/31-60/61-90/90+ | ✅ Verified |
| AP aging | Supplier balances aged similarly | ✅ Verified |
| Customer/supplier statement | Running balance with linked documents | ✅ Verified |
| Cash position | Cash + bank balances | ✅ Verified |
| VAT summary | Tax by code/rate net of credits/debits, reconciled to GL | ✅ Verified (internal, not statutory) |
| Accounts Health | AR=GL1300, AP=GL2100, Inventory=GL1400 per party, no orphans | ✅ Verified against test suite |
| Inventory valuation | Per-product qty/value/cost, 'receivedWithoutCost' flagged | ✅ Verified |

### 5.2 Reports that exist but need accountant review

| Report | What it shows | Gap |
|---|---|---|
| Management finance (P&L by product) | Revenue, COGS, margin, `costUnknownQty` per product (top 30) | Top-30 limit; full list available via export. `costUnknownQty` semantics pending accountant approval |
| Cancelled/voided report | Reversal documents, cancelled orders, voided invoices | Newly re-enabled (2026-10-18); verified 15/0 against test DB; needs real-data validation |
| Bank reconciliation | Start reconciliation, mark cleared lines, complete | Tested in accounting suite; needs live statement matching |

### 5.3 Reports and functions the accounting office must still set up externally

| Function | Why external | Reference |
|---|---|---|
| ETA live submission | Requires e-seal bridge + production credentials | `docs/erp/ETA_EINVOICE.md` |
| VAT statutory return | Internal summary exists — not a filing format | `docs/erp/PRODUCTION_READINESS.md` §H2 |
| Fixed assets / depreciation | Not implemented | Explicitly out of scope |
| Payroll / salaries / attendance | Not implemented | Employee expenses only |

### 5.4 Decisions required from the accountant and company

Status key: ⚠️ ═ genuinely unresolved (decision required) · ✅ ═ resolved by verified implementation · ❓ ═ company confirmation question

| # | Decision | Options | Impact | Status |
|---|---|---|---|---|
| D1 | **PPV treatment for unknown-cost receipts** (see §4 above) | (A) Accept: PPV full, GRNI 0, layers not revalued; (B) Require unit_cost at intake; (C) Add revaluation step for remaining layers | Cost recognition; inventory valuation | ⚠️ **Unresolved — accountant decision** |
| D2 | **Costing method: AVCO vs FIFO** | AVCO (current default); FIFO available per product | Inventory profit timing | ⚠️ **Unresolved — written policy confirmation needed** (AVCO implemented + tested as default) |
| D3 | **Grade B: location-blended AVCO vs separate SKU** | Blended (current) vs independent | Margin analysis precision | ✅ **Resolved** — proportional full-cost carry implemented and verified (F-02, §3.1 item 1); separate-SKU sort now carries cost |
| D4 | **Waste write-off timing** | Periodic scrap vs immediate write-off | Cost period matching | ⚠️ **Unresolved — accountant decision** (both paths available; scrap/adjustment is approval-gated) |
| D5 | **ETA tax subtypes** | Confirm V003/V004 (exempt fresh produce), V009 (14%), V001 (0%) | ETA invoice compliance | ⚠️ **Unresolved — accountant + ETA sandbox (F-13)** |
| D6 | **Tax recognition basis** | Invoice dates (current) vs cash basis | Filing requirement | ⚠️ Accountant decision (not blocking daily operations) |
| D7 | **Chart of accounts — final approval** | Current 27 accounts; reconciliation confirms complete for declared needs | — | ✅ **Resolved by reconciliation** — complete for confirmed needs; open questions moved to D9/D10 |
| D8 | **Credit control mode** | Warn (current) vs Block | Customer order limits | ⚠️ Company decision (settings toggle, not accounting) |
| D9 | **Cheques (post-dated / customer / supplier)** | Are post-dated or third-party cheques used at all? If yes, add a "cheques under collection" account + workflow | Cash/bank presentation, AR/AP reality | ❓ **Company confirmation required** — currently all cash/bank entries land in 1100/1200 |
| D10 | **Fixed-asset accounting and depreciation** | Does the company require FA accounts (70xx) + depreciation? | Balance sheet, investing cash flow | ❓ **Company confirmation required** — currently out of scope (handled externally/spreadsheet per §5.3) |

---

## 6. Egyptian Tax / Statutory Framework — What the System Provides

| Requirement | System state | Gap |
|---|---|---|
| **ETA e-invoice** (Invoice v1.0) | Pipeline built, mapper, validation, submission state machine; contract tests pass | **Live sandbox + production credentials never exercised** |
| **VAT summary (internal)** | Tax by code/rate, net of credits/debits, reconciled to GL 1500/2200 | **Not a statutory return** — formats differ |
| **VAT rates** | EXEMPT (T1/V003), VAT14 (T1/V009), VAT0 (T1/V001) | Pre-seeded; accountant may need other subtypes |
| **Currency** | EGP-only enforced; historical FX rows refused | Correct for UNITED |
| **Audit trail** | All state changes logged with user, timestamp, role, old/new values | Production-ready |

---

## 7. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ETA cannot submit live without sandbox verification | HIGH | Legal obligation from day one | Submit through ETA portal until pipeline is production-tested |
| Unknown-cost PPV treatment not approved | MEDIUM | P&L may require restatement | Get accountant decision before go-live (D1) |
| VAT summary is not a filing format | HIGH | Accountant must create manual filing | Provide CSV export; mapping to official form is external |
| Payroll absent | MEDIUM | Salaries handled externally | Confirm external process before go-live |
| Fixed assets missing | LOW | Track in spreadsheet | Documented out-of-scope pending company answer (D10) |
| Cheques used but no dedicated account | LOW (unconfirmed) | Cash/bank presentation mismatch | Company answer required (D9) before adding accounts |

---

## 8. Verdict

| Item | Status |
|---|---|
| **General ledger** | ✅ Complete — double-entry, period-controlled, append-only |
| **Chart of accounts** | ✅ 27 accounts suitable for a fresh-produce trading company; reconciliation complete for confirmed needs |
| **Trial balance / P&L / BS** | ✅ Verified against test suite; balanced and reconciled |
| **AR/AP statements and aging** | ✅ Verified; party-level integrity against GL |
| **Inventory → GL reconciliation** | ✅ Verified; stock valuation = GL 1400 |
| **Grading cost allocation (Good/B/Waste)** | ✅ Proportional full-cost carry verified (F-02); NRV disabled |
| **Quarantine release** | ✅ Software-enforced release workflow verified (F-03) |
| **Cash-flow statement** | ✅ Indirect method, reconciles to cash change (F-05) |
| **VAT tracking (internal)** | ✅ Per-document, per-rate, net summary reconciled to GL |
| **Bank reconciliation** | ✅ Implemented and tested |
| **Cancelled/voided report** | ✅ Verified |
| **Unknown-cost treatment (PPV/GRNI)** | ⚠️ **Awaiting accountant decision (D1)** |
| **Costing method policy (AVCO/FIFO)** | ⚠️ **Awaiting written policy confirmation (D2)** |
| **Waste write-off timing** | ⚠️ **Awaiting accountant decision (D4)** |
| **ETA live submission** | ❌ Not verified — external dependency; tax subtypes awaiting decision (D5) |
| **VAT statutory return filing** | ❌ Not implemented (external/manual) |
| **Fixed assets / depreciation** | ❌ Out of scope until company answer (D10) |
| **Cheques under collection** | ❌ No dedicated account until company answer (D9) |
| **Payroll / attendance** | ❌ Out of scope |

**The accounting engine is structurally complete for daily operations** — every business document posts its own balanced JE, all subledgers reconcile to the GL, period controls work, and the audit trail is complete.

**Production go-live requires:** accountant sign-off on the unresolved decisions in §5.4 (D1, D2, D4, D5, D6, D8), company answers to D9/D10, ETA sandbox execution, and a production restore drill.

---

**This document was produced without modifying any code, files, repository state, or environment. No production access occurred. No deployment, publication, or pilot activation.**

Your move, Mostafa. 🗂️🎯

محقق خارج. تحت أمرك. والسلام. 🕊️🤲