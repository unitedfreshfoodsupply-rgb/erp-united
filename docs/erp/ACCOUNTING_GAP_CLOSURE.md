# Accounting gap closure — implementation report

Branch `ui/enterprise-ux`. Everything below was built and tested **locally, against an isolated
test database** (PostgreSQL 16 on 127.0.0.1, `UNITED_TEST_DB=1`). **Nothing was deployed, and no
production database, migration or data was touched.** Status words used:

- **Implemented**: code, migration and screen exist on the branch.
- **Tested**: an automated suite exercises it and passed locally.
- **Verified**: tested *and* cross-checked against the ledger (integrity report / reconciliation).
- **Pending business approval**: the mechanism exists, but the policy value is a management decision
  and ships switched off or empty.
- **Pending production deployment**: everything here (see §13).

> An independent adversarial verification followed this report: `ACCOUNTING_VERIFICATION.md`.
> It lists the defects found (D1–D17) and their fixes, the ledger audit, the migration rehearsal
> and the configuration checklist.

## 1. Blueprint findings (from `ACCOUNTING_BLUEPRINT.md`) and their status

| Blueprint item | Status | Where |
|---|---|---|
| R1 Fixed assets missing | Implemented · tested · verified | §4.5 |
| R2 No fiscal year / year-end closing entry | Implemented · tested · verified | §4.4 |
| R3 No controlled period reopen | Implemented · tested | §4.4 |
| R4 VAT accounts open to manual journals / no VAT settlement | Implemented · tested · verified | §4.2 |
| R5 Cash-flow classification guessed from account type | Implemented · tested · verified | §4.1 |
| R6 Only two cash/bank accounts, no transfers | Implemented · tested · verified | §4.1 |
| R7 Opening balances without staging, TB check or approval | Implemented · tested · verified | §4.6 |
| R8 No cost centers | Implemented · tested · verified | §4.7 |
| R9 Manual journals without a second person | Implemented · tested (policy off by default) | §4.3 |
| P6 Comparative statements, ratios | **Not implemented** (see §11) | — |
| Tax-period lock | Implemented (VAT return locks its period) | §4.2 |

## 2. Additional gaps discovered during implementation

| # | Gap found | Severity | Resolution |
|---|---|---|---|
| A1 | Seven money forms (receipts, payments, refunds, bank reconciliation, expenses, employee advances, payroll payment) hard-coded the two seeded cash accounts, so a new cash box or bank could never be used | High | Shared `CashAccountSelect` fed by the API (`components/accounting/CashAccountSelect.tsx`) |
| A2 | No chart-of-accounts screen (accounts only via API) | Medium | Chart tab: tree, create, rename, classify, retire (`components/accounting/ChartView.tsx`) |
| A3 | Cash-flow statement counted only the two seeded cash accounts as cash | High (any new bank would show as an investing outflow) | All `CashAccount` GL accounts are cash (`lib/management/reports.ts`) |
| A4 | Journal source types used by payroll had no screen labels; new types would have shown raw codes | Low | Labels for every source type (`AccountingView` + dictionary) |
| A5 | The year-end, VAT-settlement and opening-batch entries were not covered by the "every entry has a source" integrity check | Medium | Traceability rules added for every new source type (`lib/accounting/integrity.ts`) |
| A6 | HR approval types showed their Arabic label in the English approvals inbox | Low | English labels added |
| A7 | The asset permission keys broke the database rule "permission group = key prefix" — `db:sync-permissions` would have failed in production | **High (deployment blocker)** | Renamed `accounting.assets.view/manage`; caught by the test reset |
| A8 | Four e2e suites computed "today" in UTC while the server books on the Cairo day: they failed between 22:00 and 00:00 UTC | Test defect | Switched to `tests/_days.ts` `todayBiz()` (service-bills, settlement-deductions, cost-reconciliation, db-constraints) |
| A9 | `FixedAsset` CHECK refused scrapping an asset that was never placed in service | Defect (in new code, before release) | Constraint corrected in the unreleased migration |
| A10 | Depreciation runs unique per month made a late-registered asset impossible to depreciate for that month | Design defect (new code) | Several runs per month allowed; uniqueness is per asset-month (DB) |
| A11 | Asset sold with VAT would have broken the VAT summary reconciliation | Medium | VAT summary includes disposal VAT |
| A12 | Cash-flow statement would have shown an asset sale's cost (not its proceeds) under investing | Medium | Disposal adjustment lines move it (`disposal_noncash` / `disposal_proceeds`) |

## 3. Gaps closed — summary

All nine blueprint risks (R1–R9) and the twelve additional gaps above are closed in code and tests.
Open items are listed in §11.

## 4. Implemented features and workflows

### 4.1 Cash and bank management; cash-flow classification (`lib/accounting/treasury.ts`, `lib/management/reports.ts`)
- **Cash boxes and banks.** Each cash box or bank account gets its own GL account (1101–1199 cash,
  1201–1299 banks) and can be created, edited, deactivated or reactivated. It can only be
  deactivated at a zero balance with no open reconciliation, and the GL account is retired with it.
- **Transfers.** A transfer posts Dr destination / Cr source; a bank fee, if any, posts Dr bank
  charges / Cr source.
  - Idempotent, and serialised per source account: a cash box never goes below zero.
  - Optional approval above a threshold, decided by a different person.
  - Can be reversed once.
  - A DB guard keeps a transfer's accounts, amounts and date fixed.
- **Cash-flow statement.** Every account carries `cashFlowCategory` (operating, investing or
  financing), inherited from its header. The statement classifies by it and flags unclassified
  accounts instead of guessing. Year-end closing entries are left out of its balance snapshots.

### 4.2 VAT returns (`lib/accounting/vat-returns.ts`)
- **Filing** a period:
  - Posts Dr VAT output / Cr VAT input (up to the output) / Cr VAT payable. Excess input VAT stays as
    a credit carried forward.
  - Requires the period's VAT summary to reconcile.
  - Returns must be contiguous, with no overlap.
- **Paying** posts Dr VAT payable / Cr cash or bank.
- **Voiding** the latest unpaid return reverses its settlement.
- **Filed-period lock.** While a return is live, no VAT line may post inside its period. This is
  enforced in `postJournal` and by the DB trigger `vat_period_lock`.
- **Control accounts.** VAT input, output and payable are control accounts, so manual journals are
  refused on them.
- **Integrity check:** VAT payable equals the unpaid returns.

### 4.3 Manual journal approval (`lib/accounting/ledger.ts`)
- **Settings.** `accounting.manual_journal_approval` and its threshold, both **off by default**.
- **When on**, a journal above the threshold becomes a `JournalRequest`:
  - It waits for someone else holding `accounting.journals.approve` and is never approved by its
    requester.
  - On approval it is re-checked and posted.
  - On rejection or withdrawal nothing posts.
  - It is idempotent, and a DB guard prevents edits.
- **Journal form** hides control accounts.

### 4.4 Fiscal years, year-end close, controlled reopen (`lib/accounting/fiscal-years.ts`)
- **Closing a year** (once it has ended, and with every other month of it closed):
  1. Posts stock valuation and the last month's depreciation.
  2. Posts one entry on the last day, bringing revenue and expense to zero against retained
     earnings.
  3. Closes the last month.
- **Closing entries in reports.** P&L, finance report, cash flow and the cost-centre report leave
  closing entries out.
- **Reopening a month or a year** is a request:
  - It needs a reason of at least 10 characters.
  - It is decided by a different person holding `accounting.periods.reopen` (Super Admin by default).
  - Reopening a year reverses its closing entry. Only the latest closed year can be reopened.
  - A month can be reopened only while its year is open.
  - The reopen count, who and why are kept on the period, and every step is audited.

### 4.5 Fixed assets (`lib/accounting/fixed-assets.ts`, `/assets`)
- **Categories** carry an explicit policy and their own cost and accumulated-depreciation accounts
  under 1700:
  - method: straight line, or declining balance switching to straight line;
  - useful life, residual %, start in the same month or the next month, capitalisation threshold;
  - the accounts are owned by the register, so no manual journal or ordinary bill line can post to
    them.
- **Acquisition:**
  - from a supplier service-bill capital line (the bill posts Dr cost / Cr AP + input VAT), or
  - for cash (Dr cost / Cr cash).
  - Below the threshold the purchase is refused as an asset.
- **Other events:**
  - placed in service;
  - improvement (prospective);
  - change of estimate;
  - transfer between warehouses, custodians, vehicles or cost centres (no entry);
  - supplier allowance through a debit note (cost goes down).
- **Disposal** (sale with optional VAT, or scrap) charges catch-up depreciation to the month before
  the disposal, then posts the gain or loss.
- **Monthly depreciation:**
  - One entry per run, with one line per asset and month (unique in the database).
  - Missed months are caught up.
  - Closing a month or a year runs it first.
- **Reports and checks:**
  - register with book value, per-asset history and forward schedule;
  - roll-forward per category, tied to the GL;
  - integrity check: register = GL.
- **DB guards:**
  - assets are never deleted, and a disposed asset is final;
  - accumulated depreciation only grows;
  - events, runs and lines are append-only.

### 4.6 Opening balance batch (`lib/accounting/opening-batches.ts`)
- **Staged lines:**
  - GL balances;
  - customer and supplier open items;
  - stock at unit cost;
  - assets with their original cost, accumulated depreciation, dates and life.
- **Validation.** The batch is checked as one opening trial balance: debits = credits, with nothing
  left in opening equity.
- **Submission and approval.** Submitting freezes the lines (DB). A different person holding
  `accounting.opening.approve` posts it once, in one transaction.
- **After the initial batch:**
  - only one initial batch can ever post;
  - the direct opening forms are closed;
  - only approved correction batches can change opening figures.
- **Input.** Lines are entered on a form, or pasted from a spreadsheet.

### 4.7 Cost centres (`lib/accounting/cost-centers.ts`)
- **Master data.** A cost-centre master organised as a tree (warehouse, transport, vehicle,
  operations, department, administration, sales, other).
- **Journal lines.** A cost centre can sit only on revenue and expense lines and is fixed once
  posted (DB).
- **Where it comes from:**
  - expenses;
  - service-bill expense lines and their debit notes;
  - manual journals;
  - depreciation and disposal results of an assigned asset.
- **Required setting.** `accounting.cost_center_required` is **off by default**.
- **Report.** Revenue and expenses per centre, with unallocated amounts shown. Its totals equal the
  P&L.

## 5. Changed modules and architecture
- **New services** under `lib/accounting/`:
  - `treasury.ts`, `vat-returns.ts`, `fiscal-years.ts`, `fixed-assets.ts`, `opening-batches.ts`,
    `cost-centers.ts`;
  - `control-accounts.ts`: the pure control-account rules shared by server and forms.
- **Changed:**
  - `ledger.ts`: system keys, source types, `costCenterId` on lines, account edit, control rules,
    journal requests, depreciation at month close, capital-line hooks;
  - `integrity.ts`: new checks and traceability; party opening in-transaction;
  - `vat-summary.ts`, `management/reports.ts`;
  - `purchasing/bills.ts`, `purchasing/service-accounts.ts`;
  - `hr/service.ts` (expense cost centre), `inventory/documents.ts` (opening stock in-transaction);
  - `core/approvals.ts` + `approval-handlers.ts`: six new approval types;
  - `core/settings-registry.ts`: six settings;
  - `core/sequences.ts`: seven sequences;
  - `permissions.ts`: five permissions;
  - `audit.ts`: eleven entity types.
- **Pattern kept.** Every posting goes through `postJournal` inside the document's own transaction.
  Every new money document is append-only or guarded by a DB trigger, has RLS enabled, and uses
  `SET search_path` with execute revoked on its functions. Approvals reuse the existing engine. No
  new dependency or background job was added.
- **Screens:**
  - Accounting tabs: Cash & Banks, Chart of Accounts, Cost Centres, VAT returns (in the VAT tab),
    Periods & fiscal years, Opening batch, plus the pending journal requests list;
  - a new `/assets` page with a nav link;
  - capital lines and cost centres on service bills, and cost centres on the expense and manual
    journal forms.
- **Size.** `git diff --stat f99e97e..8b8f73f`: 104 files, +7,514 / −275.

## 6. Database migrations (all additive)

| Migration | What it does | Data touched | Rollback (old build ignores all of it) |
|---|---|---|---|
| `20261031100000_cash_bank_and_cash_flow` | `Account.cashFlowCategory`, `controlledBy`; 5 accounts (1700 header, 2250 VAT payable, 4300, 6400, 6500); `CashAccount` bank fields + unique `accountId`; `CashTransfer` + guard; journal source-type CHECK widened | INSERT 5 accounts; UPDATE `cashFlowCategory` of the seeded system/header accounts only | Drop new table/columns; restore old CHECK |
| `20261031110000_vat_returns_and_journal_approval` | `VatReturn` + guard, no-overlap trigger, `vat_period_lock` on journal lines; `JournalRequest` + guard | none | Drop triggers/tables |
| `20261031120000_fiscal_years` | `FiscalYear` + guard; reopen columns on `AccountingPeriod` | none | Drop table/columns |
| `20261031130000_fixed_assets` | `AssetCategory`, `FixedAsset` (+guard), `AssetEvent`, `DepreciationRun`, `AssetDepreciationLine` (append-only, unique asset-month); capital-line columns on service-bill lines | none | Drop tables/columns |
| `20261031140000_opening_batches` | `OpeningBatch` (+guard, one posted initial), `OpeningBatchLine` (frozen once submitted) | none | Drop tables |
| `20261031150000_cost_centers` | `CostCenter`; `costCenterId` on journal lines, expenses, service-bill lines, assets; `accounting_line_guard` replaced by a superset (cost centre immutable, P&L lines only) | none | Drop columns/table; restore previous guard body |

Together with the two migrations already on this branch, production would go from 69 to **77**
migrations.

## 7. Test suites executed and results
See §14 (filled from the final full run). New suites:
- `treasury` (67 checks)
- `vat-returns` (48)
- `fiscal-year` (39)
- `fixed-assets` (60)
- `cost-centers` (27)
- `opening-batch` (43)

Each was also re-run on the same database to prove repeatability. Browser journeys: 17, including
every new screen in Arabic and English and a tablet viewport.

## 8. Accounting reconciliation evidence (local)
- After each suite, the integrity report is green: trial balance, unposted, traceability, AR, AP,
  inventory, fixed assets, VAT payable and payroll.
- Fixed assets register = GL for every category. The roll-forward ties: opening + additions −
  depreciation − disposals = closing.
- A VAT return's settlement leaves VAT output at zero and VAT input equal to the credit carried
  forward. VAT payable equals the unpaid returns.
- The opening batch nets opening equity to zero. After posting, AR, AP, inventory and fixed assets
  each equal their subledger.
- The cost-centre report's totals equal the P&L for the same range.
- The cash-flow statement balances against the change in every cash/bank account, including after
  transfers, an asset sale and a year-end close.

## 9. End-to-end business cycle evidence
- **Asset bought on a supplier bill.** Capital line → approval → bill posts Dr cost / Cr AP + VAT
  → draft asset → placed in service → monthly run (Dr depreciation / Cr accumulated) → improvement
  → allowance via debit note → GL = register (`tests/fixed-assets.test.ts` §3–8).
- **Sale.** Catch-up depreciation → Dr bank + accumulated + loss / Cr cost + VAT output → VAT
  summary reconciles → cash flow shows the proceeds under investing.
- **Year-end close.** Revenue and expense → retained earnings; balance sheet and trial balance
  balance; P&L still shows the year → approved reopen reverses it (`tests/fiscal-year.test.ts`).
- **VAT.** Taxed invoice and bills → return → payment from bank → lock → void
  (`tests/vat-returns.test.ts`).
- **Go-live.** GL + customers + suppliers + stock + assets → opening trial balance → approval →
  posted → statements, aging, stock and register reconcile → correction batch
  (`tests/opening-batch.test.ts`).
- **Cost centres.** Expense, bill, journal reallocation and depreciation → per-centre report = P&L
  (`tests/cost-centers.test.ts`).

## 10. Performance and cost
- **No new infrastructure.** No new dependency, background job or paid service.
- **Depreciation** is one query per in-service asset at run time. It is user-triggered or runs at
  month close, so nothing is scheduled.
- **New indexes** on every new foreign key used for lookups: cost centre on journal lines, asset
  category and status, depreciation period, and transfers by account.
- **Report queries are unchanged in shape.** The P&L and cash flow gain one `sourceType` filter.

## 11. Remaining issues and business decisions

**Business decisions.** Each mechanism is built; the policy needs management's decision before it
is switched on or filled in:
1. **Manual journal approval:** on or off, and the threshold. Off by default.
2. **Transfer approval:** on or off, and the threshold. Off by default.
3. **Cost centre structure,** and whether a cost centre is required on expenses. Off by default; no
   centres are seeded.
4. **Fixed-asset policy per category:** life, method, residual, capitalisation threshold, start
   rule.
   - No category is seeded; the screen offers suggestions that only pre-fill the form.
   - Includes how crates and pallets are treated.
5. **Fiscal-year start month.** Default January.
6. **Who reopens periods and approves opening balances.** Super Admin by default.
   - Both always need a person other than the requester, so production needs at least two
     finance users.
7. **Opening cut-over date** and the source of the figures.
8. **VAT return frequency.** Any contiguous period is accepted.
9. **Foreign currency.** Out of scope; documents remain EGP.

**Follow-up after the independent verification (`ACCOUNTING_VERIFICATION.md`):**

Implemented since:
- comparative statements and financial ratios;
- bank-statement import with matching;
- reversing a depreciation run;
- payroll posting by cost centre (department → cost centre link);
- physical asset counts.

Not implemented, and why:
- **Asset sale on credit, or as an e-invoice to ETA.** This is a tax and legal decision; see
  verification §6.
- **Dunning, multi-currency, bank formats other than CSV.** Out of scope.

The full configuration checklist (what management must decide) is in verification §7.

## 12. Commits (branch `ui/enterprise-ux`)
`215f4a8` treasury · `e0b9686` VAT returns + journal approval · `a1246a4`, `d904b12` fiscal years ·
`7a2e5e5` fixed assets · `9d2b8f9` opening batch · `8b8f73f` cost centres · `69e3ed7` report, labels, journeys, test-clock fixes · `5d5744d` asset
idempotency · plus the commit recording these results.

## 13. Production migration and deployment instructions (NOT executed — needs approval)
1. **Read-only preflight.** Run `psql "$DATABASE_URL" -f scripts/ops/gap-closure-preflight.sql`.
   Every section must show 0 rows.
   - It checks the five account codes and system keys the release creates, the parent header
     accounts, one cash account per GL account, no half-applied objects, the migration history
     and the journal source types.
   - Also check that `SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;`
     returns 69.
2. **Back up first.** Confirm the latest Supabase backup and take a logical dump (see
   `RELEASE_ENTERPRISE.md` §4).
3. **Build** the branch head in a new release directory on the VPS.
4. **Migrate:** run `npx prisma migrate deploy`. Expect 8 to apply, then confirm with
   `migrate status`.
5. **Sync permissions:** run `npm run db:sync-permissions`. This adds 5 permissions; the Super
   Admin holds them automatically.
6. **Trial-port start and switch,** as in `RELEASE_ENTERPRISE.md` §5. Keep the old PM2 app stopped,
   not deleted.
7. **Post-deploy checks:**
   - Accounting → Health check is green.
   - The Cash & Banks tab lists the existing accounts with their balances.
   - The `/assets` page opens empty.
   - The VAT tab shows "no returns yet".
8. **Rollback.**
   - **Application only.** This is always possible: the old build runs on the new schema, because
     every change is additive and the widened CHECK and the replaced line guard accept everything
     the old build writes.
   - **Schema back to 71.** Only before the new features hold data: run
     `psql -1 -f scripts/ops/gap-closure-rollback.sql`. The script refuses, and changes nothing,
     once they do.
     - It was rehearsed on scratch databases: the schema comes back identical to a fresh 71 and
       the data is unchanged (`scripts/ops/rehearse-gap-closure.sh`; verification §5).

## 14. Final local validation (1 Nov 2026, isolated test database — not production)

| Run | Result |
|---|---|
| Type check (`tsc --noEmit`), lint (`next lint` scope: app, components, lib) | clean |
| Unit (`npm run test:unit`) | 138 passed, 0 failed |
| Integration (`npm run test:integration`) | 68 passed, 0 failed |
| E2E chain from a reset database (`npm run test:e2e`) | 65 suites, 10,835 checks, 0 failed (the last three suites re-run after the final build; see note) |
| Browser journeys (`scripts/dev/ui-journeys.mjs`) | 17 passed, 0 failed (desktop AR/EN, tablet, phone) |
| Dictionary integrity, server-message translations | pass |
| Schema vs migrations (`prisma migrate diff --exit-code` on a fresh shadow database) | no drift |

Note: the chain ran first against the build before the asset idempotency change (`5d5744d`); the
fixed-assets suite then failed exactly on the new replay check (a second asset was bought), which is
what the change fixes. After rebuilding, fixed-assets (60), cost-centers (27) and opening-batch (43)
passed, followed by the chain's final reset.
