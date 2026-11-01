# UNITED ERP — Independent adversarial verification of the accounting gap closure

Branch `ui/enterprise-ux`. Date: 1 November 2026. The final acceptance (D18–D20, the business-cycle
suite, runbooks, GO/NO-GO) is in `FINAL_ACCEPTANCE_REPORT.md`. Scope: everything added by the gap-closure
mission (`ACCOUNTING_GAP_CLOSURE.md`) and the paths it touches.

**Where the evidence comes from.** Everything here was run locally on an isolated PostgreSQL 16
test cluster and a production build of the branch. Nothing was deployed, and nothing was read
from or written to the production database. No migration was run against production.

**How the review was done.** I did not re-run the earlier tests and call it verified. The review
had four parts:
1. **Code review.** I re-read the new code paths with three questions in mind: what is read
   outside the lock, what can two requests do at once, and what does the database refuse.
2. **An independent ledger audit.** A new suite, `tests/ledger-audit.test.ts`, recomputes the
   books from the tables with its own SQL. It reuses no application code.
3. **An adversarial suite.** `tests/adversarial.test.ts` covers concurrency, duplicates, invalid
   input and unauthorised calls.
4. **A migration rehearsal.** The rollback was rehearsed forward and back on scratch databases
   (`scripts/ops/rehearse-gap-closure.sh`).

---

## 1. Findings — every defect found, and what was done

Severity reflects business impact if it had shipped.

| # | Defect (found by) | Severity | Concrete failure | Fix | Evidence |
|---|---|---|---|---|---|
| D1 | **VAT return filing race** (review). The return read the VAT balances outside its transaction and lock. | High | A service bill posted between that read and the filing would sit in a "filed" period without being in the return. | Every posting with a VAT line now takes the VAT-return lock. The preview is computed inside the filing transaction, after the lock. | adversarial §5: four bills race the filing; the return equals the ledger afterwards. |
| D2 | **Deadlock: VAT filing vs VAT postings** (review). Filing took the VAT lock and then the month lock; postings take the month lock and then the VAT lock. | High | Deadlock: PostgreSQL aborts one side and the user gets a 500. | Filing and voiding now lock the month first, in the same order as every posting. | adversarial §5: no 500 and no deadlock. |
| D3 | **Deadlock: depreciation run or disposal vs month close** (review). Depreciation took its own lock and then the month lock; closing a month takes the month lock and then the depreciation lock. | High | Deadlock on a busy month-end. | The depreciation run, disposal and run reversal lock the month first. | adversarial §6: 8 postings, a depreciation run and the close of the same month at once — no 500. |
| D4 | **Year-close race** (review). The year-close preview was read before the last month was locked. Separately, reopening a month did not take the fiscal-year lock. | High | (a) A posting into the last month during the close would be missing from the closing entry, leaving P&L balances in a closed year. (b) A month could reopen inside a year being closed, giving a closed year with an open month. | The close takes the fiscal-year lock, then the last month's lock, then reads inside the transaction. Reopening a month takes the same two locks in the same order. | ledger-audit §8: every closed year's P&L nets to 0 and no closed year has an open month. adversarial §7: three parallel closes give one 200 and two 409s. |
| D5 | **The year could not close once its last month was closed** (review). | Medium | The normal routine (close December, then close the year) demanded a two-person reopen of December. | The close opens the last month, posts the closing entry and closes it again, in one locked transaction. The preview shows a note instead of a blocker. | fiscal-year test §2 (42/42). |
| D6 | **VAT return impossible after its month was closed** (review). The settlement was always dated on the period's last day. | Medium | Months are normally closed before the return is filed, so filing failed with "period closed". | The settlement is dated the filing day when the period's month is closed. | Code path; `vat-returns` 48/48. |
| D7 | **Cash flow: openings counted as cash flows** (review). | Medium | A cut-over inside the range reported the opening cash as a financing inflow, and opening stock and receivables as operating movements. | Opening entries (opening balances, opening batches, anything against opening equity) now count in the opening position. A year-to-date result brought in by an opening is taken back out as a non-cash adjustment. The screen notes how many openings fell inside the range. | ledger-audit §4: opening cash = raw balance before the range + cash brought in by openings, and the statement balances. |
| D8 | **Opening batch: a cent lost on fractional stock** (review). Validation rounded each line to cents; the stock ledger rounds Σ(qty × cost at 4 dp) once. | Low–Medium | Three lines of 1.333 × 0.3333: validation said 1.32 and the ledger posted 1.33. That left 0.01 in opening equity, and the batch was "balanced" but was not. | Validation values lines exactly as the stock ledger does. | opening-batch test: fractional lines added; inventory +1251.33 and opening equity nets to 0. |
| D9 | **Reversals dropped the cost centre** (review). This affected manual-journal, payroll-run, payroll-payment and transfer reversals; the payroll-payment reversal also dropped the employee. | Medium | A reversed journal left its cost in the centre and put the reversal under "unallocated", so the cost-centre report was wrong. | Every reversal copies the cost centre (and the party). | adversarial §10: the centre nets to 0. ledger-audit §2: each reversal mirrors its original by account, cost centre and party. |
| D10 | **An absurd amount gave a 500** (adversarial). | Low | `99999999999999999999` overflowed numeric(18,2). | A numeric overflow is answered 400. The treasury amounts are capped at 12 digits. | adversarial §8. |
| D11 | **A lost optimistic-lock race gave a 500** (review). | Low | A `version`-guarded update losing a race (Prisma P2025) surfaced as a server error. | Answered 409 with "changed by someone else — refresh". | adversarial §3/§4 (parallel decisions and disposals all get clean 409s). |
| D12 | **Voiding a nil VAT return gave a 500** (adversarial). | Medium | The app allowed voiding a nil return (auto-"paid" because nothing is due). The DB guard and the `VatReturn_paid` CHECK refused it. | The guard allows paid → voided only when payable is 0 and there is no payment entry. Voiding clears `paidAt`/`paidBy`. | adversarial §5: the nil return is voided, 200. |
| D13 | **Bank reconciliation could complete with a difference** (review). The difference was checked outside the lock. | Medium | Completing while someone un-ticks a line marked an unbalanced reconciliation as complete. | The check and the completion run under the account's reconciliation lock. | analysis §3: completion races an un-tick, and a completed reconciliation always balances. |
| D14 | **Reconciliation cleared balance came from a page of 1,000 lines** (review). | Medium | With more than 1,000 lines, the cleared balance and difference were wrong. | Summed in the database. | Code path; analysis §3. |
| D15 | **An open reconciliation could not be resumed** (review). | Medium (UX) | After a reload the open reconciliation was unreachable, and starting a new one was refused (409). | Added `GET /api/accounting/reconciliations`. The screen lists open ones with a "Resume" button. | analysis §3. |
| D16 | **A garbage statement balance gave a 500** (adversarial). | Low | `"abc"` reached the Decimal constructor. | Validated: 400. | analysis §3. |
| D17 | **Statement re-import ticked a second line** (found by the new test before release). | Medium | Importing the same statement twice matched an already-claimed statement line to another book line of the same amount. | Lines already ticked in this reconciliation stay in the matching pool and claim their statement line ("already cleared"). | analysis §3. |

**Test-fixture issues (not application defects), kept separate:**
- **Transfer reversals and `reversalOfId`.** My first adversarial test expected transfer
  reversals to set `reversalOfId`. The database rule ties `reversalOfId` to
  `sourceType = 'reversal'`, and document reversals are linked by their own columns
  (`CashTransfer.reversalEntryId`, `VatReturn.voidEntryId`, `DepreciationRun.reversalEntryId`).
  I kept the rule. The audit now checks those links.
- **Integration suite run order.** It needs a fresh database: once an initial opening batch is
  posted, direct opening stock is correctly refused.
- **Rehearsal harness bugs** (mine): the shadow `DIRECT_URL`, and a fingerprint query on a wrong
  table name, which had made "data unchanged" vacuous. Both are fixed before the evidence below.

**Reviewed and kept as designed (documented, not changed):**
- **A cash box never goes negative.** This is enforced for transfers, transfer reversals, asset
  purchases and VAT payments. Supplier payments, expenses and refunds paid from a cash box do not
  check it.
  - Whether to enforce it everywhere is policy C9 below. Banks may go overdrawn.
  - The ledger audit reports any negative cash box. There were none on the test data.
- **Opening-batch lines have no idempotency key.** A double click adds a line twice to a *draft*.
  The draft is reviewed line by line, lines can be removed, and posting needs a second person.
  Accepted.
- **Opening accumulated depreciation.** It must be the figure through the cut-over month;
  depreciation continues from the month after.
- **Balance-sheet API totals are unsigned.** The ledger audit checks the signed figures and that
  liabilities are a net credit.

---

## 2. Independent accounting audit (`tests/ledger-audit.test.ts`, 65 checks)

The audit recomputes everything with its own SQL and compares it with what the application
reports. The chain it follows is:

**source document → journal → trial balance → P&L → balance sheet → cash flow → subledgers**

| Area | What is proven |
|---|---|
| Entries | Every entry has Σ debit = Σ credit = its stated total. Every line is one-sided, positive, non-zero and at most two decimals. Journal numbers are unique. No document is posted twice (sourceType, sourceId). No line sits on a header account. |
| Reversals | Each reversal is the exact negative of its original, by account, cost centre and party. This covers journal reversals, transfer reversals, VAT voids, year-reopen reversals and depreciation-run reversals. No entry is reversed twice. |
| TB / P&L / BS | Over the whole ledger Σ debit = Σ credit. The year-to-date trial balance movements equal raw. P&L revenue, expenses and net equal raw. Assets = liabilities + equity + unclosed result. The reported totals equal raw (signed). |
| Cash flow | Closing cash = the raw balance of every cash and bank account. Opening cash = the raw balance before the range plus the cash brought in by openings. The three sections add up to the change in cash. Cash-flow net income = P&L net income. |
| Subledgers | Every AR/AP line names a party of the right kind. For the 5 largest customers and suppliers, the document-based statement equals Σ of their GL lines. Inventory GL equals the posted valuation layers, within the per-entry rounding cent. Every valued stock movement reached the ledger. |
| Fixed assets | Per asset account, GL = Σ cost not disposed; per accumulated account, GL = −Σ accumulated. Each asset's accumulated = opening accumulated + its live depreciation lines. No asset is below its residual value, and no asset-month is depreciated twice. Each run's total = its lines = the expense it posted. A reversed run has every line set aside, and its reversal took back exactly its expense. |
| VAT | For every live return, the settlement lines equal its figures, and output − input used = payable and input − used = carry-forward. No two returns overlap. No VAT line entered a period after its return was filed. |
| Periods / years | Nothing was posted into a month after it was last closed. A closed year has no open month and its revenue/expense nets to 0. The closing entry moved exactly the stated result into retained earnings. |
| Dimensions / traceability | Cost centres appear only on revenue/expense lines. Every entry of the new sources points at an existing document. Each posted opening batch's own entries balance. |

Result: **65 passed, 0 failed**. The run was on the database left by the whole accounting and
adversarial chain, and was run twice.

---

## 3. Adversarial scenarios (`tests/adversarial.test.ts`, 64–66 checks)

| Scenario | Expectation, verified |
|---|---|
| 6 parallel transfers of 300 out of a 1,000 cash box | Exactly 3 go through and 3 get 409; the box ends at 100. |
| The same transfer submitted 5 times at once, one idempotency key | One transfer and one entry; every answer names it. |
| 4 parallel reversals of one transfer | One 200, three 409, one reversing entry. |
| One approval decided 3 times at once | One 200, two 409, one journal. |
| 5 parallel depreciation runs for one month | One 201, four 409; one run; one line per asset-month. |
| 3 parallel disposals | One succeeds, two 409; one disposal event. |
| Reverse a depreciation run | Refused while a later month stands (409). Needs a 10+ character reason (400). Sales is refused (403). Two parallel requests give one 200 and one 409. The asset returns to its live lines. The reversing entry mirrors the original. The month can run again. |
| The database refuses, by hand: | un-reversing a line; lowering accumulated depreciation; marking a line reversed without its run. |
| VAT filing racing 4 bill approvals in its period | No 500 or deadlock. The return equals the ledger. Every bill either posted first or was refused (409). A nil return can be voided (200). |
| 8 postings + a depreciation run + the month's close at once | No 500 or deadlock. The month is closed and nothing landed after the close. |
| 3 parallel closes of one fiscal year | One 200, two 409; closed once. |
| Invalid input: negative, zero, 3 decimals, `1e3`, 20 digits, 30 Feb, unknown account, unbalanced, debit+credit on one line, header account, AR or VAT account directly, negative cost, in-service before purchase, future or garbage month, reversed or unended VAT range, lower-case code, bad date | 21/21 refused with a 4xx and no 500. |
| Sales and floor users on all 17 new write endpoints | All 403. No session gives 401. The floor reads no accounting register. |
| A reversal keeps the cost centre | The centre nets to 0. |
| Afterwards | The integrity check is green. |

---

## 4. Cross-module integration

The modules are exercised by the e2e chain, which runs from a database reset, plus the suites
above:
- sales (orders, invoices, credit notes, ETA);
- purchasing (bills, service bills, debit notes);
- inventory (intake, grading, FEFO, quarantine, waste, valuation);
- customer and supplier accounts and statements;
- receipts, payments and refunds, including deductions;
- returns;
- payroll (run, post, pay, reverse, now with cost centres);
- reports and dashboards (management finance, cash flow, home, overview).

Results are in §8.

**Payroll and cost centres (new).** Payroll posting splits each component's expense by the cost
centre linked to the employee's department.
- Nothing is allocated unless an accountant links a cost centre to a department.
- The `hr-payroll` suite checks that the moved employee's cost carries the centre and that no
  other line does.

---

## 5. Database and migration safety (8 migrations, none applied to production)

Production holds 69 migrations. The branch adds 8 (local total 77).

| Migration | Kind | Review |
|---|---|---|
| `20261030130000_fk_indexes` | 9 plain indexes on FK columns | Additive. Built inside the migration transaction, which locks writes on those tables briefly; the production volume is small. Rollback: drop the indexes. |
| `20261030131000_function_search_path` | `ALTER FUNCTION … SET search_path` × 35 | Function bodies are unchanged. None is SECURITY DEFINER. |
| `20261031100000_cash_bank_and_cash_flow` | Columns on Account and CashAccount; 5 accounts; CashTransfer; source-type CHECK widened | The CHECK is a superset, so existing rows validate. The account INSERT uses `ON CONFLICT (id)` only, so a user-created account with code 1700/2250/4300/6400/6500 would fail it: **preflight §1**. The new unique `CashAccount.accountId`: **preflight §3**. |
| `20261031110000_vat_returns_and_journal_approval` | VatReturn, JournalRequest, `vat_period_lock` on JournalLine | The lock trigger is inert while no return exists. **Edited in this verification:** the guard now lets a nil return be voided (D12). |
| `20261031120000_fiscal_years` | FiscalYear; 4 reopen columns on AccountingPeriod | Defaults apply to existing periods (`reopenCount` 0). |
| `20261031130000_fixed_assets` | Asset tables; capital columns on service-bill lines | **Edited in this verification**, which is acceptable because no environment but the local test DB has it: (a) run reversal columns and guards; (b) the per asset-month unique index made partial (`WHERE NOT reversed`); (c) the asset guard accepts a decrease only to exactly the live lines; (d) the `count` event type. |
| `20261031140000_opening_batches` | OpeningBatch(+Line) | One posted initial batch, enforced by a partial unique index. |
| `20261031150000_cost_centers` | CostCenter; `costCenterId` on 4 tables; `accounting_line_guard` replaced | Compared line by line with the original (`20261008164713`): every original rule is kept, plus the cost-centre rule. |

- **FKs and constraints.** Every new FK is `ON DELETE RESTRICT`. RLS is enabled on every new
  table (checked by the `db-security` suite). Every new function pins `search_path` and has
  PUBLIC execute revoked.
- **Permission seeding.** It is not done by migration. `npm run db:sync-permissions` adds the 5
  permissions. The group = key-prefix rule was verified by the reset.
- **Schema drift.** `prisma migrate diff` (migrations → schema) shows **no difference**.

**Rehearsal** (`scripts/ops/rehearse-gap-closure.sh`, scratch databases `united_test_rb*` only):

| Step | Result |
|---|---|
| Fresh database at 71 (before the release) and at 77 (with it) | Applied. |
| 77 + seed + demo traffic (1,015 entries, 2,030 lines, 219 invoices, 1,580 stock movements) | Loaded. |
| Rollback (`scripts/ops/gap-closure-rollback.sql`) | Schema is **identical** to fresh-71. Data fingerprint (md5 of accounts, entries, lines, cash accounts, periods + counts) is **unchanged**. |
| Preflight (`scripts/ops/gap-closure-preflight.sql`) on the rolled-back DB | **0 rows** (no conflict). |
| `prisma migrate deploy` again | Schema is **identical** to fresh-77; data **unchanged**. |
| Rollback on a DB where the new features hold data | **Refused** ("122 rows were written by the new features — roll back the application only"); nothing changed. |

**The rollback position for production.**
- Before the new features are used, the database can go back to 71 with the rollback script.
- Once they are used, roll back the application only. The old build runs on the new schema,
  because every change is additive and the replaced CHECK and guard accept everything the old
  build writes.

---

## 6. Remaining gaps — implemented in this round, or justified

| Gap | Decision | What was built |
|---|---|---|
| Comparative statements + ratios | **Implemented** (read-only, low risk) | Accounting → "Comparatives & ratios".<br>• P&L and balance sheet against the prior period or the same range last year, with variance and %.<br>• Ratios: gross and net margin, current, quick and cash ratios, liabilities ÷ equity, working capital, receivable, inventory and payable days.<br>• The basis is printed on screen: the chart has no current/non-current split, so liabilities are all taken as current.<br>• `tests/analysis.test.ts` checks every figure against raw SQL, including the leap-day range. |
| Bank statement import + matching | **Implemented** (no schema change) | Paste CSV (date, amount, reference).<br>• Matching: same amount, nearest date within ±3 days; the reference breaks ties.<br>• Two equally good candidates are left to the accountant, and nothing is guessed.<br>• Preview ticks nothing. Re-import is idempotent.<br>• Plus fixes D13–D16. |
| Depreciation correction / reversal | **Implemented** | Reverse a whole run, with the guards above. Corrections otherwise stay prospective (change of estimate). |
| Payroll cost-centre integration | **Implemented** | Department → cost centre link, applied at posting. It uses the employee's department at posting time. |
| Physical asset counts | **Implemented** | Assets → "Physical count".<br>• Records found, condition and location per asset as an append-only event, with idempotency.<br>• Report flags: never counted, missing, damaged, unusable, elsewhere.<br>• **Nothing is written off by a count.** Disposal stays a decision with a reason. |
| Asset sale on credit / as an e-invoice to ETA | **Not implemented — business, legal and tax decision** | A fixed-asset sale to a registered business should be a tax invoice through ETA, with the item coded (GS1/EGS). That needs a sales-invoice line type for "asset sale" that the e-invoice pipeline accepts, and the tax adviser's confirmation of the code and treatment. Disposal for cash or bank, with output VAT, stays as built. |
| Collections follow-up (dunning), multi-currency, bank file formats other than CSV (MT940/CAMT.053), storing statement lines | Out of scope / later | Documented. |

---

## 7. Configuration checklist — what management must decide (nothing is switched on silently)

Every setting below ships at the default shown. None was changed by this work.

| # | Setting / data | Default | Decision needed | Effect when set |
|---|---|---|---|---|
| C1 | `accounting.fiscal_year_start_month` | 1 (January) | Fiscal year start | Fiscal-year bounds; fixed per year once a year exists. |
| C2 | `accounting.manual_journal_approval` (+ `_threshold`) | off (0) | On/off and amount | Journals above the threshold wait for a second person holding `accounting.journals.approve` (ACCOUNTANT holds it). |
| C3 | `accounting.transfer_approval` (+ `_threshold`) | off (0) | On/off and amount | Transfers above the threshold wait for approval. |
| C4 | `accounting.cost_center_required` | off | Whether expenses must name a centre | Expenses and manual journal expense lines without a centre are refused. |
| C5 | Cost centres and department links | none seeded | Structure (warehouses, fleet, vehicles, departments) | Reporting dimension; payroll allocation only for linked departments. |
| C6 | Asset categories (life, method, residual, start rule, accounts) | none seeded | Policy per category, capitalisation threshold, crates/pallets | Capitalisation and depreciation. |
| C7 | `accounting.bank_charges_account` | empty | Account for transfer fees and bank charges | A transfer with a fee is refused until it is set. |
| C8 | `purchasing.service_bill_approval_threshold` | 0 (every service bill needs approval) | Amount | Service bills under it post at once. |
| C9 | Cash box negative balance | enforced only on transfers, asset purchases and VAT payment | Enforce on every cash payment? | Would need a change to payments and expenses (not built). |
| C10 | Who holds `accounting.periods.reopen`, `accounting.opening.approve` | Super Admin | Named people | Both always need a second person: production needs ≥ 2 finance users. |
| C11 | Opening cut-over date and source figures | — | Date and sign-off of the opening trial balance | One initial batch only. |
| C12 | VAT return frequency | any contiguous period | Monthly (usual in Egypt) | Returns must be contiguous. |
| C13 | Cash-flow class of user-created balance-sheet accounts | unclassified (shown under operating, flagged) | Classify each | Report accuracy. |
| C14 | `accounting.withholding_*_account`, `accounting.write_off_*`, `hr.payroll_net_pay_account` | empty / 0 | Accounts and limit | The features that need them refuse until set. |
| C15 | Statement matching tolerance | ±3 days (per request, 0–15) | Bank practice | Matching only. |

---

## 8. Regression (local, isolated database, production build of the branch head)

| Run | Result |
|---|---|
| TypeScript `tsc --noEmit` | clean |
| ESLint `next lint` | no warnings or errors |
| Unit (`test:unit`) | **138 passed, 0 failed** (includes server-message translations and the RBAC snapshot, which was regenerated for the new routes) |
| Integration (`test:integration`, fresh database) | **68 passed, 0 failed** |
| Full e2e chain from reset (`test:e2e`, 68 suites, ending with `analysis`, `adversarial`, `ledger-audit`) | **68 suites, 11,108 checks, 0 failed** |
| UI journeys (`scripts/dev/ui-journeys.mjs`, demo data) | **20 passed, 0 failed** (J18 comparatives AR/EN, J19 statement import, J20 asset count + run reversal) |
| Schema drift (`prisma migrate diff` migrations → schema) | no difference |
| Migration rehearsal (`scripts/ops/rehearse-gap-closure.sh`) | rollback → identical to fresh-71, data unchanged; forward → identical to fresh-77, data unchanged; preflight 0 rows |
| Ledger audit (independent SQL) | 65/65 on the accounting chain's database (run twice); 62/62 within the full chain |

**About the test fixtures.** Several suites open and close old months and years on the isolated
database (2014–2016 and 2001-01). They do this only after `assertTestDatabase()` and only when
`UNITED_TEST_DB=1` is set, and the chain ends with a reset.

---

## 9. Limits of this evidence

- **Concurrency.** It was exercised with parallel HTTP requests against one Next.js process and
  one PostgreSQL 16 server. Production (Supabase PG17 through a pooler) was not load-tested here.
  The locks are transaction-scoped advisory locks plus row locks, which behave the same through
  the pooler in transaction mode.
- **Production compatibility.** The preflight queries must be run read-only on production before
  migrating. They were run only on the rehearsal databases.
- **The ratios** are as good as the chart's classification (C13 and the current/non-current
  basis).
