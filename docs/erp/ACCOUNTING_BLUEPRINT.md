# UNITED ERP — Accounting Blueprint

Status: **research and audit — no accounting feature was implemented for this document.**
Branch `ui/enterprise-ux` at the time of writing (`2f9e60c`). Evidence is the repository itself
(schema, migrations, services, routes, screens, tests) and, for the benchmark, the vendors' own
documentation sources.

Conventions used below:

- **Verified** — read in the code or the database, or proven by a test that ran green in the last
  full local regression (58 suites, 9,699 checks, 31 Oct 2026, isolated test database).
- **Assumption** — stated as such; needs confirmation.
- Paths are repository-relative. "DB" = a PostgreSQL trigger or constraint in `prisma/migrations`.

---

## 1. ERP benchmark

### 1.1 Sources

| Vendor | What was read | Access |
|---|---|---|
| Microsoft Dynamics 365 Finance | Official docs repository `MicrosoftDocs/Dynamics-365-Unified-Operations-Public`, `articles/finance/…`: `fixed-assets/set-up-fixed-assets.md`, `fixed-asset-acquisition-posting-accounts.md`, `fixed-asset-disposal-posting-accounts.md`, `fixed-asset-depreciation.md`, `depreciation-methods-conventions.md`, `acquire-assets-procurement.md`, `dispose-of-a-fixed-asset-as-scrap.md`, `general-ledger/financial-period-close-workspace.md`, `close-general-ledger-at-period-end.md`, `year-end-close.md`, `plan-chart-of-accounts.md`, `ledger-settlements.md`, `cost-accounting/cost-accounting-home-page.md`, `cash-bank-management/reconcile-bank-account.md` | Full text (raw GitHub) |
| Odoo 18 Accounting | Official docs repository `odoo/documentation` (branch 18.0), `content/applications/finance/accounting/…`: `vendor_bills/assets.rst`, `reporting/year_end.rst`, `reporting/analytic_accounting.rst`, `get_started/chart_of_accounts.rst`, `bank/reconciliation.rst`, `taxes.rst`, `payments.rst`, `customer_invoices/credit_notes.rst`, `get_started/multi_currency.rst` | Full text (raw GitHub) |
| Oracle Fusion Cloud Financials (Assets) | Official docs pages located by search: *Asset Categories* (25A `faias`), `FA_BOOKS` table (25A `oedmf`), *Books* view object (25C), *Implementing Assets* guide | **Search-result level only** — `docs.oracle.com` is outside this session's allowed network |
| SAP S/4HANA Finance (Asset Accounting) | SAP PRESS / SAP training (S4F17) / SAP Community material located by search | **Secondary sources only** — `help.sap.com` and `training.sap.com` are outside this session's allowed network |

To read SAP Help Portal and Oracle Docs directly, `help.sap.com` and `docs.oracle.com` must be
allowed in the session's network settings.

### 1.2 What the standard products have in common

| Area | Standard pattern (all four, unless noted) | Principle taken for UNITED |
|---|---|---|
| Module structure | GL; AR; AP; Cash & Bank; Fixed Assets; Tax; Cost/analytic accounting; Period close; Financial reporting — each subledger posts to GL control accounts | Keep subledgers authoritative and reconciled to GL control accounts (UNITED already does this for AR, AP, inventory, payroll) |
| Chart of accounts | Hierarchical accounts with type/category; posting vs. header accounts; control accounts reserved for subledgers (D365 *plan-chart-of-accounts*; Odoo *chart_of_accounts*: account **type** drives reports) | Keep the tree; add a reporting/cash-flow classification per account; protect control accounts from manual posting |
| Journals | Typed journals (sales, purchases, bank, cash, general); manual journals can require approval/workflow (D365 journal names; Odoo journals) | Source-typed entries already exist; add approval for **manual** journals above a threshold |
| Fixed assets | Asset master + **asset group/category** that defaults life, method and GL accounts; **books** (D365) / **depreciation areas** (SAP) / **asset books** (Oracle) track value; **posting profile** per book/group; acquisition from AP/PO; periodic depreciation run; transfer; disposal (sale/scrap) reverses cost and accumulated depreciation and posts gain/loss; capitalization threshold (D365); depreciation board in draft then posted (Odoo) | One book (statutory) is enough for UNITED; categories with default life/method/accounts; acquisition from supplier bills; monthly depreciation run; disposal with gain/loss |
| Opening / migration | Legacy asset transfer with original cost + accumulated depreciation at cut-over (SAP legacy data transfer; Odoo asset "already depreciated" amount; D365 acquisition + depreciation adjustment) | Import cost, dates, life and accumulated depreciation — never NBV alone |
| Period close | Period statuses, close checklist/workspace (D365 *financial-period-close-workspace*); lock dates (Odoo *Lock Everything*); year-end close transfers P&L to retained earnings (D365 *year-end-close*) | Add fiscal year, close checklist, controlled reopen, year-end closing entry |
| Bank | Statement import and matching rules (D365 advanced bank reconciliation; Odoo reconciliation models) | Manual matching exists; statement import is optional for UNITED's volume |
| Analytic | Analytic plans/accounts with mandatory/optional applicability by account prefix (Odoo); financial dimensions (D365); cost centers (SAP CO) | One dimension set (cost center + warehouse) applied to expense lines, not to inventory valuation |
| Controls | Audit trail, segregation of duties, approval workflows, posting restrictions, reversal instead of deletion | Already strong at the database level; add approvals for manual journals and period reopen |

---

## 2. UNITED accounting inventory and status

Status legend: **V** implemented and verified · **I** implemented but incomplete · **U** implemented
but not exposed in the UI · **R** present but incorrect or risky · **N** not implemented · **NA** not
applicable to UNITED · **D** requires a business decision.

### A. General ledger

| Capability | Status | Evidence |
|---|---|---|
| Chart of accounts (tree, type, header vs postable, system keys) | V | `prisma/schema.prisma` model `Account` (`parentId`, `type`, `postable`, `systemKey`); 27 accounts seeded by `prisma/migrations/20261008164713_accounting_core`, `…174750_connected_ledger`; create account `lib/accounting/ledger.ts` `createAccount` (`POST /api/accounting/accounts`) |
| Account types → statements | V | `balanceSheet`, `profitLoss` in `lib/accounting/ledger.ts`; routes `app/api/accounting/balance-sheet`, `pnl` |
| Cash-flow classification of accounts | **R** | `lib/management/reports.ts` `cashFlowReport`: accounts without a known system key or payroll/settings link fall back **by type** — a user-created current asset (e.g. prepaid rent) is reported as *investing*, a user-created accrued liability as *financing* |
| Journal entries (balanced, append-only) | V | DB `accounting_entry_balanced` (deferred constraint trigger: debit = credit = total), `accounting_line_guard` (no delete; only the reconciliation mark may change; account must be postable and active); `postJournal` |
| Journal types | I | Entries carry `sourceType` (sales_invoice, credit_note, supplier_bill, debit_note, customer_receipt, supplier_payment, expense, payroll_run, stock_valuation, manual, opening_balance…) and one numbering sequence `accounting.journal`; no journal-book entity (sales/purchases/bank journals as separate books) — adequate at UNITED's scale |
| Manual journals | V (no approval) | `createManualJournal` (`accounting.manage`), refuses control accounts; UI tab **Journals** |
| Reversing entries | V | `reverseJournal`; `JournalEntry.reversalOfId` unique |
| General ledger / account drill-down | V | `accountLedger`, `GET /api/accounting/accounts/[id]/ledger`; trial balance drill-down in UI |
| Trial balance | V | `trialBalance`; UI tab; integrity check "trial balance balanced" |
| Accounting periods (monthly) | V | Model `AccountingPeriod` (`YYYY-MM`, open/closed); DB `accounting_period_open` refuses postings into a closed period, serialised with an advisory lock (`…20261009140000_serialize_accounting_period_posting`); close in order (`closePeriod`) |
| Period reopen | **N** | No reopen path (`closePeriod` only); a posting error in a closed month can only be corrected in an open month |
| Fiscal year | **N** | No fiscal-year entity; periods are calendar months |
| Year-end closing entry (P&L → retained earnings) | **N** | `balanceSheet` computes net income live (`ledger.ts`, "Net income = -signedRevenue - signedExpense"); no closing entry, so the P&L accounts accumulate across years |
| Opening balances (GL) | I | Customers/suppliers (`PartyOpeningBalance`, `createOpeningBalance`), opening stock (`postOpeningStock`), both against `opening_equity`; cash, bank, loans, equity and other GL accounts only via a manual journal |
| Multi-currency | NA / D | `Currency` model exists; documents and the ledger are single-currency (EGP). Needed only if UNITED buys or sells in foreign currency |

### B. Accounts receivable

| Capability | Status | Evidence |
|---|---|---|
| Customer ledger (party on AR lines) | V | `JournalLine.partyType/partyId`; per-party reconciliation in `integrityReport` (`partyMismatches("customer")`) |
| Invoices, credit notes | V | `SalesInvoice`, `CreditNote`; `postSalesInvoice`, `postCreditNote`; suites `sales`, `uat`, `recover-invoice`, `reprice-invoice`, `returns-integrity` |
| Receipts, allocation, unapplied money, reversal | V | `createReceipt`, `allocateReceipt`, `reverseReceipt` (`lib/accounting/cash.ts`); DB `accounting_allocation_cap` (never allocate beyond the receipt); unapplied shown in aging |
| Settlement deductions (withholding, bank charges, write-off) | V | `ReceiptDeduction`, accounts from settings `accounting.*_account`; suite `settlement-deductions` (41 checks) |
| Customer refunds | V | `createCustomerRefund` |
| Credit limits and credit hold | V | `Customer.creditLimit`, `creditHold`; exposure `GET /api/sales/customers/[id]/exposure`; approval type `sales.credit` |
| Aging | V | `agingReport` (`lib/sales/invoicing.ts`), opening items age by their own due date |
| Customer statements | V | `GET /api/sales/customers/[id]/statement` |
| Overdue collections follow-up (dunning, reminders) | N | No reminder or collection-task model |

### C. Accounts payable

| Capability | Status | Evidence |
|---|---|---|
| Supplier bills (goods: 3-way match with GRNI and PPV; services: expense + input VAT) | V | `postSupplierBill` (`ledger.ts`: Dr GRNI agreed / Dr PPV difference / Dr VAT input / Cr AP); service lines; suites `purchasing`, `service-bills` (44 checks) |
| Debit notes | V | `DebitNote`, `postDebitNote` |
| Payments, allocation, advances (unallocated payments), reversal | V | `createPayment`, `allocatePayment`, `reversePayment`; AP aging shows money on account |
| Payables aging, due dates, supplier statements | V | `apAgingReport`; `GET /api/purchasing/suppliers/[id]/statement` |
| Bill approval | V | approval type `purchasing.bill` |
| Payment approval / payment runs | N / D | Payments post directly with `accounting.payments.manage` |

### D. Cash and bank

| Capability | Status | Evidence |
|---|---|---|
| Cash boxes and bank accounts | **I** | `CashAccount` model; only `cash_main` and `bank_main` exist (seeded); **no service or screen creates another cash box or bank account** |
| Receipts and payments by cash account | V | `CustomerReceipt.cashAccountId`, `SupplierPayment.cashAccountId` |
| Internal transfers (cash ↔ bank, bank ↔ bank) | **N** | No transfer document; only a manual journal |
| Bank reconciliation | I | `BankReconciliation` + marking journal lines (`startReconciliation`, `markReconciled`, `completeReconciliation`); no statement import or matching rules |
| Cash position | V | `cashPosition` |
| Cash-flow statement | **R** | Indirect method in `cashFlowReport`; classification risk above; the investing section can never show fixed-asset purchases because there are no fixed-asset accounts |

### E. Fixed assets — **not implemented**

No model, migration, service, route, permission, screen or test mentions fixed assets or
depreciation (`grep -i "fixed.?asset|depreciat"` over `prisma/`, `lib/`, `app/api/`, `components/` returns
nothing). The chart of accounts has no fixed-asset, accumulated-depreciation or depreciation-expense
account. Today a vehicle or a cold-room purchase could only be booked as a service-bill expense or
through a manual journal into a user-created account — with no register, no depreciation and no
disposal accounting. Requirements: §5.

### F. Tax and e-invoicing

| Capability | Status | Evidence |
|---|---|---|
| Tax rates and product tax codes | V | `TaxRate`; product tax classification (`sales.tax.manage`) |
| Input/output VAT accounts | V | `vat_input`, `vat_output` system accounts |
| VAT summary reconciled to the ledger | V | `lib/accounting/vat-summary.ts` (expected vs. posted, `reconciled` flag); UI tab |
| Withholding tax report | V | `withholdingReport` (`GET /api/accounting/withholding`) |
| ETA e-invoicing: invoices and credit notes | V | `lib/eta/*`, `EtaDocument`; ETA screen (invoices, credit notes, codes) |
| Customer debit notes to ETA | NA | UNITED issues no sales-side debit notes (debit notes are supplier-side) |
| Tax periods / filed-return lock | N | VAT summary is by date range; no record that a period was filed, no lock after filing |

### G. Cost and management accounting

| Capability | Status | Evidence |
|---|---|---|
| Inventory valuation (layers) posted to GL per movement | V | `StockValuationLayer`, `StockValuationPosting`, `postMovementValuation` / `postStockValuation`; inventory vs GL in `integrityReport` (rounding tolerance 0.005 per layer); suite `cost-reconciliation` (22 checks) |
| Grading cost policy (good / grade B / waste) | V | `lib/inventory/grading.ts`; suites `grading-cost-policy`, `grade-b-separate-sku`, `waste-not-sellable`; waste kept at cost in the waste location until written off (`integrityReport` "waste_pending") |
| COGS on dispatch, returns | V | dispatch issues post COGS; customer returns reverse (suite `uat`, `returns-integrity`) |
| Product and customer margin | V | `financeReport` (`lib/management/reports.ts`) |
| Cost centers / departments / analytic dimensions on journal lines | **N** | `JournalLine` has only `partyType/partyId`; `Department` exists for HR only; `Expense` has `accountId` and `cashAccountId` only |
| Transport cost per trip / per order | N | `Trip` has no cost fields; one `transport_expenses` account |
| Warehouse / storage cost allocation | N | — |
| Operational cost allocation to products or customers | N / D | Must not duplicate costs already in inventory valuation (§4) |

### H. Financial statements and reporting

| Report | Status | Evidence |
|---|---|---|
| Balance sheet | V (I) | `balanceSheet`; current-year earnings computed live (no year-end close) |
| Profit and loss | V | `profitLoss` (date range) |
| Comparative periods | I | P&L/balance sheet: single range; management overview compares with the previous period |
| Cash-flow statement | R | §2.D |
| Trial balance, GL, aging (AR/AP), VAT, withholding | V | as above |
| Fixed-asset register, depreciation schedule | N | §5 |
| Financial ratios | N | — |
| Drill-down from report to source | I | Trial balance → account ledger → journal; journal → source document link varies by source |
| Management dashboards | V | `/management/overview`, `/home` (this branch) |

### I. Configuration and controls

| Control | Status | Evidence |
|---|---|---|
| Balanced, immutable postings | V | DB triggers above; documents append-only (`sales_append_only` on receipts, payments, allocations) |
| Period lock | V | DB `accounting_period_open` |
| Audit trail | V | `writeAudit` on every posting service; `AuditLog`; audit screen |
| Permissions and segregation | V (I) | `accounting.view / manage / receipts.manage / payments.manage / periods.close / eta.*`; `ACCOUNTING_CLERK` role limited to receipts/payments; approvals require a different approver when the setting is on |
| Manual journal approval | **N** | `createManualJournal` posts immediately |
| Control-account protection | V | `createManualJournal` refuses AR, AP, inventory, GRNI, employee advances and employee payable (`CONTROL_ACCOUNTS` / `controlAccountMovedBy` in `lib/accounting/ledger.ts`; covered in `tests/flows.test.ts`, `tests/service-bills.test.ts`). VAT input/output stay open to manual journals — needed today for the monthly VAT settlement with the tax authority (no settlement document exists) |
| Duplicate prevention | V | idempotency keys and request fingerprints on receipts, payments, opening balances, intakes |
| Reversal procedure | V | reversals for journals, receipts, payments, payroll |
| Subledger ↔ GL reconciliation | V | `integrityReport`: trial balance, unposted documents, orphan entries, AR/AP totals and per party, inventory, GRNI (info), payroll, waste pending; UI "Health check" |

---

## 3. Missing functionality (consolidated)

1. **Fixed assets** — register, categories, depreciation, disposal, reports, opening import (§5).
2. **Fiscal year and year-end close** — fiscal-year entity, closing entry to retained earnings, opening of the next year.
3. **Controlled period reopen** — with reason, approval and audit.
4. **Cash and bank management** — create cash boxes and bank accounts; internal transfers; statement import (optional).
5. **Manual journal controls** — approval above a threshold; a VAT settlement document so VAT accounts can become control accounts too.
6. **Cash-flow classification** — explicit operating/investing/financing per account.
7. **Opening balance workflow** — staging, validation, one opening trial balance, approval, go-live lock (§6).
8. **Cost centers** — one analytic dimension on expense lines; transport and warehouse cost reporting.
9. **Comparative statements** and basic ratios.
10. **Tax period filing record** and lock.
11. **Collections follow-up** (reminders) — optional.

## 4. Risks and integrity gaps

| # | Risk | Severity | Evidence | Mitigation |
|---|---|---|---|---|
| R1 | Capital purchases (vehicles, cold rooms, scales) cannot be capitalised or depreciated; expensing them overstates costs in the month of purchase and understates assets | **High** (financial statements) | §2.E | Fixed-assets module (§5); until then a written policy on how to record them |
| R2 | P&L accounts never close into retained earnings; multi-year comparisons and the retained-earnings line rely on a live calculation | Medium | `balanceSheet` | Fiscal year + closing entry |
| R3 | A closed month cannot be reopened; corrections must go into a later month | Medium (controls work, flexibility missing) | `closePeriod` only | Controlled reopen with approval |
| R4 | VAT input/output accept manual journals (AR, AP, inventory, GRNI and employee accounts are already protected) — a mistyped VAT journal makes the VAT summary show "not reconciled" after the fact | Low | `CONTROL_ACCOUNTS` in `lib/accounting/ledger.ts`; `lib/accounting/vat-summary.ts` | VAT settlement document, then add VAT accounts to the control list |
| R5 | Cash-flow statement misclassifies user-created accounts by type | Medium | `cashFlowReport` default branch | Explicit classification per account |
| R6 | Only two cash/bank accounts possible without a database change | Medium (operational) | `CashAccount` seeded only | Cash/bank master screen |
| R7 | Openings are posted item by item into opening equity with no staging, no "opening equity must net to zero" check and no go-live lock | Medium | `createOpeningBalance`, `postOpeningStock` | §6 workflow |
| R8 | No cost dimension: transport, cold storage and grading labour cannot be analysed by warehouse, vehicle or department | Medium (management accounting) | `JournalLine`, `Expense` | Cost centers on expense lines only |
| R9 | Manual journals post without a second person | Low–Medium | approvals list in `lib/core/approvals.ts` has no journal type | Approval above a threshold |

No defect was found in the posting rules that were exercised by the regression suites (sales,
returns, purchasing with GRNI/PPV, service bills, settlements, payroll, stock valuation,
cost reconciliation). These are the strongest part of the system.

---

## 5. Fixed assets — detailed requirements

### 5.1 Scope for UNITED (assumption: typical assets of a produce distributor)

Delivery trucks and vans, refrigerated units, cold rooms, racking, scales, forklifts, crates and
pallets (pooled, see 5.6), computers and tablets, office furniture, leasehold improvements, land
and buildings if owned (land is not depreciated).

### 5.2 Data model (additive)

| Model | Key fields |
|---|---|
| `AssetCategory` | code, name/nameAr, default useful life (months), default method, default residual %, capitalization threshold, GL accounts: cost, accumulated depreciation, depreciation expense, gain on disposal, loss on disposal; `depreciable` (false for land) |
| `FixedAsset` | code (sequence), name/nameAr, category, status (`draft` → `in_service` → `fully_depreciated` → `disposed`), acquisition date, in-service date, acquisition cost, residual value, useful life (months), method, depreciation start, location (warehouse / branch / storage location), custodian (employee), supplier, source document (supplier bill line / journal), serial/plate number, notes, attachments |
| `AssetDepreciationLine` | asset, period (`YYYY-MM`), amount, accumulated after, NBV after, journal entry id (null while draft) |
| `AssetEvent` | asset, type (`acquisition`, `improvement`, `transfer`, `impairment`, `disposal_sale`, `disposal_scrap`, `revaluation` if adopted), date, amounts, from/to location or custodian, journal entry id, reason |
| `AssetCountSession` / `AssetCountLine` | physical verification: found / not found / wrong location / condition |

DB guards (same style as the ledger): asset events append-only; depreciation line unique per asset
and period; no depreciation after disposal; cost and accumulated depreciation never negative.

### 5.3 Depreciation

- Methods: **straight line** (default) and **declining balance** (only if the auditor requires it).
- Monthly run per period, creating draft lines, reviewed, then posted as **one journal entry per
  category** (lines per asset kept in `AssetDepreciationLine`). Posting is blocked in closed periods
  by the existing DB trigger.
- Pro-rata from the in-service month (policy decision: full month vs. day-based).
- Assets below the capitalization threshold are expensed (D365 pattern) — threshold is a decision.
- Land and assets under construction are not depreciated.
- Statutory vs. tax depreciation: one statutory book; Egyptian tax depreciation rates may differ —
  tax depreciation can be a report, not a second ledger book (decision with the tax adviser).

### 5.4 Postings (system keys to add: `fa_cost_<category>`, `fa_accum_<category>`, `fa_depr_expense`, `fa_disposal_gain`, `fa_disposal_loss`, `fa_clearing`)

| Event | Debit | Credit |
|---|---|---|
| Acquisition from a supplier bill (capital line) | Fixed asset cost (category) + VAT input | AP |
| Acquisition paid directly | Fixed asset cost | Cash / bank |
| Improvement (capitalised) | Fixed asset cost | AP / cash |
| Monthly depreciation | Depreciation expense | Accumulated depreciation (category) |
| Transfer between locations/custodians | — (no entry unless categories or cost centers differ; then cost and accumulated move between accounts/dimensions) | — |
| Disposal — sale | Cash / AR (proceeds) + accumulated depreciation + loss (if any) | Fixed asset cost + gain (if any) + VAT output (if taxable) |
| Disposal — scrap | Accumulated depreciation + loss | Fixed asset cost |
| Impairment (if adopted) | Impairment loss | Accumulated impairment / accumulated depreciation |
| Opening (migration) | Fixed asset cost (original cost) | Opening equity; and accumulated depreciation (Cr) against opening equity (Dr) |

Integrity check to add: Σ asset cost = GL fixed-asset cost accounts; Σ accumulated depreciation =
GL accumulated depreciation accounts; one depreciation line per in-service asset per closed period.

### 5.5 Integration

- **Purchasing / AP**: a service-bill line (or a new "capital" line type) flagged as an asset
  creates a draft asset with cost = net line amount; the bill posts to the asset cost account
  instead of an expense.
- **Cash & bank**: direct purchases and sale proceeds through receipts/payments.
- **Opening balances**: §6.
- **Financial statements**: new accounts under Assets → *Non-current assets*; cash-flow
  classification *investing* (R5 fix).
- **Cost centers**: depreciation expense carries the asset's cost center when §8 phase 5 lands.

### 5.6 Policy questions (decisions, §9)

Capitalization threshold; useful lives per category; method; residual values; pro-rata rule; crates
and pallets (pooled asset vs. expense vs. returnable packaging stock); revaluation (normally not
used under the cost model); who approves disposals.

### 5.7 Reports

Asset register (cost, accumulated depreciation, NBV, location, custodian); depreciation schedule
(forecast) and depreciation journal by period; additions and disposals for the period; asset
roll-forward (opening NBV + additions − depreciation − disposals = closing NBV); physical
verification differences.

---

## 6. Opening balances — migration design

### 6.1 What exists (verified)

| Item | Mechanism | Posts |
|---|---|---|
| Customer open items | `PartyOpeningBalance` per item with due date (`createOpeningBalance`; bulk import kind `opening_balances`) | Dr AR (party) / Cr opening equity |
| Supplier open items | same | Dr opening equity / Cr AP (party) |
| Opening stock | `postOpeningStock` (bulk import kind `opening_stock`) | Dr inventory (layers with cost) / Cr opening equity |
| Cash, bank, loans, equity, other GL | manual journal only | any accounts |

### 6.2 Target workflow

1. **Cut-over date** (one date; the last day before go-live) and a **go-live lock**: no business
   document dated before it except opening documents.
2. **Staging** (new `OpeningBatch` with lines by type: GL, customer items, supplier items, stock,
   fixed assets) — imported from the existing CSV/XLSX pipeline with the same preview and errors.
3. **Validation**: every line valid; customer items total = AR control balance in the opening TB;
   supplier items = AP; stock value = inventory; fixed-asset cost and accumulated depreciation =
   their GL accounts; cash/bank = statements; **opening trial balance debits = credits**; opening
   equity after all lines = the declared equity (capital + retained earnings), i.e. no residual.
4. **Approval** by a second person (approval type `accounting.opening`).
5. **Posting** in one transaction; the batch becomes read-only; the integrity report must be green
   immediately after.
6. **Corrections** only by a reversing opening adjustment with reason, before the first period close.

### 6.3 Fixed-asset opening (preserve history)

Per asset: category, code, name, acquisition date, in-service date, **original cost**, useful life,
method, residual value, **accumulated depreciation at cut-over**, location, custodian, serial/plate.
System derives: remaining life, NBV, next depreciation date; validates accumulated ≤ cost − residual,
in-service ≤ cut-over, category totals = GL. Posting: Dr cost / Cr opening equity; Dr opening equity /
Cr accumulated depreciation. Importing NBV alone is refused — it would lose the disposal gain/loss
basis and the register's cost history.

---

## 7. UNITED-specific integration review

| Flow | Accounting today | Verdict |
|---|---|---|
| Purchase order → intake → bill | Intake posts inventory vs GRNI at agreed cost; bill clears GRNI, difference to PPV, VAT input, AP | Verified (suites `purchasing`, `uat`); GRNI open balance shown as information |
| Intake grading (good / grade B / waste / rejected) | Waste and grade B handled by the grading cost policy; waste kept at cost until a scrap document writes it off | Verified (`grading-cost-policy`, `grade-b-separate-sku`, `waste-not-sellable`) — **do not** add a second waste-cost allocation in management accounting |
| Order dispatch → delivery → invoice | COGS at dispatch from valuation layers; rejected quantities returned; invoice posts revenue + VAT; receipts clear AR | Verified (`uat`, `scenarios`, `returns-integrity`) |
| Transport | Fuel/transport expenses through expenses or service bills to `transport_expenses` | Implemented without per-trip or per-vehicle analysis (cost centers needed) |
| Warehouse operating expenses | General/transport expense accounts | No cost center; no storage-cost analysis |
| Payroll | Posting, payments, liabilities; reconciled in integrity check | Verified (`hr-payroll`, integrity) |
| Inventory ledger ↔ GL | Integrity check with rounding tolerance | Verified (`cost-reconciliation`) |

Management accounting rule: cost centers and allocations are **reporting dimensions on expense
lines**; inventory valuation stays the single source of product cost. Product profitability = revenue
− COGS (existing) − optionally allocated operating costs shown as a separate management layer, never
posted back into inventory.

---

## 8. Proposed accounting navigation

Only items marked *available* exist today; *planned* items are shown disabled with "coming" until built.

| Section | Pages | State |
|---|---|---|
| **Financial overview** | Performance overview, home finance widgets | available |
| **General ledger** | Chart of accounts · Journal entries · Account ledger · Trial balance · Periods | available (fiscal year, reopen: planned) |
| **Receivables** | Customers' balances (aging) · Invoices · Credit notes · Receipts · Refunds · Statements | available (in Sales/Accounting; to be grouped) |
| **Payables** | Suppliers' balances (aging) · Bills · Debit notes · Payments · Refunds · Statements | available (in Purchasing/Accounting) |
| **Cash & banks** | Cash position · Cash boxes & banks · Transfers · Bank reconciliation | position and reconciliation available; master and transfers planned |
| **Fixed assets** | Register · Depreciation runs · Disposals · Reports | planned |
| **Taxes** | VAT summary · Withholding · E-invoicing (ETA) | available (filing record planned) |
| **Cost accounting** | Product & customer margin · Cost centers · Transport & warehouse costs | margin available; rest planned |
| **Financial reports** | Balance sheet · Profit & loss · Cash flow · Comparatives | available (comparatives planned; cash-flow fix R5) |
| **Opening balances** | Opening batch: import, validate, approve, post | partial (direct posting today) |
| **Configuration** | Accounting settings (deduction accounts, posting accounts) · Approval thresholds | partial |

Labels in both languages from the dictionary; no account codes or source-type codes as labels
(codes shown only as secondary tags, as already done for tax codes).

---

## 9. Decisions required from UNITED management

1. Capitalization threshold and useful life / method / residual per asset category.
2. Treatment of crates and pallets (asset pool, expense, or returnable packaging stock).
3. Fiscal year (calendar year assumed) and who may reopen a closed month.
4. Whether manual journals need approval, and the threshold.
5. Cost-center structure (warehouses, vehicles, departments) — and whether every expense must carry one.
6. Whether foreign-currency purchases or sales exist (multi-currency in or out of scope).
7. Bank statement import (formats from the banks used) or manual reconciliation only.
8. Opening cut-over date and the source of opening figures (Odoo / previous system / audited balances).
9. Whether VAT is settled monthly through a dedicated document (enables protecting the VAT accounts, R4).

---

## 10. Roadmap

| Phase | Scope | Complexity | Risk | Key acceptance criteria |
|---|---|---|---|---|
| **P1 Controls quick wins** | Cash-flow classification per account (R5, additive column with defaults); cash/bank master + internal transfers (R6); VAT settlement document (R4) | M | Low | Cash-flow totals unchanged for seeded accounts and correct for a new prepaid account; transfer posts Dr bank / Cr cash with both cash accounts reconciling; VAT settlement clears output − input to the authority payable and VAT accounts then refuse manual journals |
| **P2 Opening balance workflow** | Staging batch, validation, approval, single posting, go-live lock (§6) | M–L | Medium (one-time, high impact) | Opening TB balances; subledger totals = control accounts; integrity green after posting; batch immutable |
| **P3 Fixed assets** | Models, categories, register, acquisition from bills, depreciation run, disposal, reports, opening import (§5) | L | Medium | Roll-forward ties; integrity check for cost and accumulated depreciation; disposal gain/loss correct in tests; depreciation blocked in closed periods |
| **P4 Period & year-end** | Fiscal year, close checklist, controlled reopen with approval, year-end closing entry | M | Medium | Closing entry zeroes P&L into retained earnings; balance sheet unchanged; reopen audited and approved |
| **P5 Cost centers** | Dimension on expense/journal lines (optional/mandatory by account prefix), transport and warehouse cost reports | M | Low–Medium | No change to inventory valuation; reports reconcile to GL expense totals |
| **P6 Reporting** | Comparatives, ratios, tax filing record and lock, manual journal approval | S–M | Low | Comparatives equal two single-period runs; filed period refuses new tax documents |

For every phase: additive migrations only; new posting rules defined as debit/credit tables (as in
§5.4) before code; each phase adds its integrity check and an end-to-end suite; existing suites must
stay green; rollback = previous build (additive schema is ignored by it) plus `DROP` of new objects
only if explicitly required.

Affected areas per phase (indicative): `prisma/schema.prisma` + new migrations;
`lib/accounting/ledger.ts` (posting keys), new `lib/accounting/assets.ts`, `lib/accounting/opening.ts`;
routes under `app/api/accounting/*`; permissions `accounting.assets.view/manage`,
`accounting.opening.approve`, `accounting.periods.reopen`; `components/accounting/*`; integrity report;
`docs/erp/RBAC_MATRIX.md` and snapshot.
