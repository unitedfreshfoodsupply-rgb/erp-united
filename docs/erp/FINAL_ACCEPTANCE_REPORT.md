# UNITED ERP — Final acceptance and operational readiness report

Branch `ui/enterprise-ux` · 1 November 2026.

**Scope of the evidence.**
- Local verification only: an isolated PostgreSQL 16 test cluster and a production build of the
  branch.
- **Nothing was deployed, and no production database, migration or data was touched.**
- Production deployment needs the owner's separate approval
  (`PRODUCTION_DEPLOYMENT_RUNBOOK.md`).

**Companion documents.**

| Deliverable | File |
|---|---|
| 1. Final acceptance report | this file |
| 2. Complete accounting gap register | `ACCOUNTING_GAP_REGISTER.md` |
| 3. Business configuration checklist | `BUSINESS_CONFIGURATION_CHECKLIST.md` |
| 4. Production deployment runbook | `PRODUCTION_DEPLOYMENT_RUNBOOK.md` |
| 5. Rollback runbook | `ROLLBACK_RUNBOOK.md` |
| 6. Final test evidence | §8 below; the verification detail is in `ACCOUNTING_VERIFICATION.md` |
| 7. GitHub commit hashes | §9 |
| 8. GO / NO-GO recommendation | §10 |

---

## 1. Repository state

| Check | Result |
|---|---|
| Current branch | `ui/enterprise-ux` |
| Head | See §9: the acceptance commit on top of `fb5f55c`, pushed. |
| Pushed | Local `HEAD` = `origin/ui/enterprise-ux` after the final push |
| Working tree | Clean after the final commit |
| Protected branches | `main` = `e1bd657`, `united-full-project` = `37f9064`: unchanged (checked with `git ls-remote`) |
| Unfinished implementation | None in the branch. No TODO/FIXME in the accounting, assets, payroll-posting or report modules. |
| Items outside the branch, deliberately left as they are | (1) One old local stash on `main`, "wip i18n on outdated main (superseded by united-full-project)". It predates this work, is not part of it, and was not applied.<br>(2) `single-flight-guards.patch` in the session scratchpad: a client-side double-click guard for 9 screens, set aside earlier by instruction ("do not blindly apply"). It no longer applies cleanly. Server-side idempotency keys and locks already guarantee that a double click posts once (adversarial suite §1–§4), so it is a UX nicety, not a correctness item.<br>(3) Older scratch patches are historical working files, already applied or superseded. |

---

## 2. Accounting completeness review

For each area: what exists, how it reconciles, and the evidence.

| Area | Status | Reconciles with | Evidence |
|---|---|---|---|
| Chart of accounts | Complete.<br>• Headers and postable accounts.<br>• System keys for every control account.<br>• Cash-flow class per account.<br>• Control accounts cannot be posted by hand. | — | flows §3 (a manual journal to AR → 400); adversarial §8 |
| General ledger | Complete. Balanced entries are enforced by the application and by deferred DB constraints. Lines are append-only. Numbers are unique. Reversals are by document. | Trial balance | ledger-audit §1–§2 |
| Trial balance | Complete | Raw Σ debit = Σ credit; reported movements = raw | ledger-audit §3 |
| Accounts receivable | Complete: invoices, credit notes, receipts (allocation, deductions, reversal), refunds, opening items, aging, statements | Customer statement = Σ AR lines by party; integrity AR = subledger | ledger-audit §5; business-cycle §1, §5, §6, §12 |
| Accounts payable | Complete: goods and service bills, debit notes, payments (withholding), refunds, opening items | Supplier statement = Σ AP lines by party | ledger-audit §5; business-cycle §1, §3, §6 |
| Cash and bank | Complete: cash boxes and bank accounts, transfers (fee, approval, reversal) | Cash-flow closing cash = raw balance | treasury 67/67; adversarial §1–§2 |
| Bank reconciliation | Complete: tick lines, CSV statement import with matching, resume, completes only at zero difference under lock | Cleared balance summed in the DB | analysis §3 |
| VAT | Complete: input and output VAT on all documents, VAT summary, returns (settlement, payment, void, period lock), control accounts | Return figures = settlement lines = ledger; summary reconciled | vat-returns 48/48; ledger-audit §7; business-cycle §10 |
| Fixed assets | Complete: categories, purchase (cash or bill), placing in service, improvement, transfer, change of estimate, disposal (gain/loss, VAT), opening assets, counts | Register cost and accumulated = GL per account and per asset | fixed-assets 60/60; ledger-audit §6; business-cycle §8 |
| Depreciation | Complete: straight-line and declining (with switch), monthly run, catch-up, close-time run, **run reversal** | Run total = lines = expense posted | ledger-audit §6; adversarial §4–§4b |
| Cost centres | Complete: on expense, service-bill, manual-journal, depreciation and **payroll** lines; reversals keep the cost centre | Report totals = P&L | cost-centers 27/27; hr-payroll; adversarial §10 |
| Opening balances | Complete: one approved initial batch, approved correction batches, stock rounding as the ledger | Opening equity nets to 0; subledgers seeded | opening-batch 43/43; business-cycle §1 |
| Fiscal years | Complete: preview, close (also when the last month is closed), reopen with approval | Closed year: P&L nets to 0; closing = stated result | fiscal-year 42/42; ledger-audit §8 |
| Period closing / reopening | Complete: ordered close, postings refused after close (app and DB), reopen only through approval by another person | No posting after a close | uat §12; business-cycle §11; ledger-audit §8 |
| P&L | Complete (year-end entries excluded) | Raw revenue and expenses | ledger-audit §3 |
| Balance sheet | Complete | Raw signed totals; balanced | ledger-audit §3; business-cycle §12 |
| Cash flow | Complete: indirect method, explicit classes, disposal and opening adjustments | Δ cash = sections; closing cash = raw | ledger-audit §4 |
| Comparative statements | Complete: prior period or prior year, variance | Each side = raw | analysis §2 |
| Financial ratios | Complete on a **stated basis** (no current/non-current split; gap register G5) | Current ratio = raw on that basis | analysis §2 |

**Operations with their accounting effect verified, document by document.** Every one of these
is tested against a stated journal effect:
- receipts, including graded receipts, corrections and voids;
- dispatch and COGS; delivery rejections; invoices; credit notes with goods back;
- supplier returns and debit notes with goods out;
- adjustments, scrap, transfers between locations (no value change), quarantine;
- expenses; payroll run, payment and reversal.

The test suites are `flows`, `uat`, `returns-integrity`, `grading-cost-policy`, `lot-adjustment`,
`hr-payroll` and `business-cycle`.

**Remaining accounting limitations.** These are stated explicitly in the gap register:
- G1 asset sale as an e-invoice;
- G3 multi-currency;
- G5 current/non-current split;
- G6 leases, impairment and revaluation;
- G7 recurring accruals;
- G8 budgets;
- L1 void of a graded receipt (refused);
- L2 cash box negative via payments;
- L3 payroll cost centre at posting;
- L4 month-end depreciation date;
- L6 operational segregation of duties off by default;
- L9 ETA not yet run against pre-production with real credentials.

---

## 3. UNITED business workflows, verified end to end

`tests/business-cycle.test.ts` is one realistic month of UNITED, run against the API. After each
step it reads the GL with its own SQL and checks that **only** the expected accounts moved, by
the expected amounts.

| # | Operation | Expected ledger effect, verified |
|---|---|---|
| 1 | Opening balances: customer 3000, supplier 2000, through an approved batch. The preparer cannot approve. | AR +3000, AP −2000, retained earnings −1000, opening equity 0. Statements show the openings. |
| 2 | 1000 kg tomatoes @ 6.00 received and graded: 800 good, 150 Grade B (own SKU), 50 waste | Inventory +6000 / GRNI −6000. Waste sits in the WASTE location. Valuation = 6000. A graded receipt cannot be voided in place (refused; books unchanged). |
| 3 | Supplier bill matched to the receipt | Bill 6000 (all accepted). GRNI for the receipt nets to 0. PPV 0. |
| 4 | Supplier payment 5000 with 50 withheld | AP +5000, bank −4950, WHT payable −50 |
| 5 | Sale: order 300 kg @ 10 → reserve → prepare → trip → load → dispatch → 290 accepted, 10 rejected → invoice | Dispatch: COGS +1800 / inventory −1800. Rejection: inventory +60 / COGS −60. Invoice: AR + total, sales −2900, VAT − tax. |
| 6 | Collection with a 15 bank charge; 1000 of the opening collected in cash | AR − total; bank + (total − 15); bank charges +15. AR −1000, cash +1000. Statement 2000. |
| 7 | Sales return 20 kg with goods back | AR − total; sales returns +200; VAT back; inventory +120 / COGS −120 |
| 8 | Purchase return 30 kg with goods out | AP + total; inventory −180 |
| 9 | Stock count: 5 kg short | Inventory −30; adjustments expense +30 |
| 10 | A 12,000 scale bought by bank; this month's depreciation | Asset +12000, bank −12000, no expense. Depreciation expense +200, accumulated −200. Book value 11,800. |
| 11 | Bank → cash transfer 1000 | Bank −1000, cash +1000, no P&L |
| 12 | VAT for the month | Summary reconciled. Output and input VAT = ledger. Cannot be filed before the period ends. |
| 13 | Month-end close, then controlled reopen | Earlier months closed in order. The month closes. A posting into it gets 409. P&L is frozen. The reopen needs a reason and is refused for the requester (403); someone else approves and the month opens. |
| 14 | Statements | TB balances; BS balances; cash flow balanced; comparatives = P&L; the year-end preview equals the year's result (and refuses until the year ends); statements = GL lines; integrity green |

**Result: 54/54.** The independent ledger audit over the resulting database passed **55/55**.

**Not repeated in this suite, because each has its own suite in the same chain:**
- **The actual year-end close and reopen:** `fiscal-year`, on 2015, with a result.
- **Filing, paying and voiding a VAT return:** `vat-returns`, on past periods; filing needs an
  ended period.
- **Payroll:** `hr-payroll`, including cost centres.
- **Post-receipt sorting:** `sorting`, `grading-cost-policy`.

---

## 4. Defects found in this phase (and fixed)

| # | Defect | Severity | Fixed by |
|---|---|---|---|
| D18 | A graded receipt's bill cleared only the good quantity. 20 % of the receipt (Grade B + waste) stayed in GRNI forever, or became a price variance. | **High** for UNITED: every graded intake. | Bill defaults to and matches the accepted quantity; the bill screen shows the breakdown. |
| D19 | NRV grading with waste "expensed at grading": the waste loss was never posted (GRNI short, no expense). | Medium; NRV is off by default. | Waste loss posted at intake (Dr adjustments / Cr GRNI). |
| D20 | A VAT return could be filed on its period's last day. | Low | The period must have ended. |

They were found by the business-cycle suite and by reading the grading code that the suite
pointed at. Earlier phases' defects D1–D17 are in `ACCOUNTING_VERIFICATION.md`.

---

## 5. Remaining limitations

These are summarised in §2. The full register, with impact, risk, recommendation and whether
each blocks go-live, is in `ACCOUNTING_GAP_REGISTER.md`.

**Items that block a specific use:**
- **L9:** ETA e-invoicing must not be switched on before the pre-production run with UNITED's
  credentials.
- **Decisions before go-live:** C9/L2 cash-box rule; L6/C16 segregation of duties; C10 finance
  users; the rest of the configuration checklist.

---

## 6. Configuration

See `BUSINESS_CONFIGURATION_CHECKLIST.md`:
- 30+ settings and master-data decisions;
- each with its technical default, a recommended value, and the impact of leaving it unchanged;
- no policy has been switched on.

---

## 7. Deployment readiness

| Item | State |
|---|---|
| Migrations | 8 additive migrations (69 → 77), reviewed one by one (`ACCOUNTING_VERIFICATION.md` §5). |
| Preflight | `scripts/ops/gap-closure-preflight.sql` (read-only) |
| Backup and restore verification | Runbook §2 (dump + restore check on a scratch database) |
| Deployment sequence | Runbook §3–§8 |
| Rollback | Rollback runbook:<br>• application-only (always possible);<br>• script (rehearsed);<br>• restore. |
| Rehearsal | Scratch databases with demo data:<br>• rollback → identical to fresh-71, data unchanged;<br>• forward → identical to fresh-77, data unchanged. |
| Permissions | 5 new ones, seeded by `db:sync-permissions`. Super Admin holds them. Finance users must be created (C10). |
| Downtime | About 1–2 minutes at the switch. Migration takes seconds, in a quiet window. |
| Production compatibility | **Not verified against production.** The preflight must be run read-only there first. |

---

## 8. Final test evidence (local, isolated database, production build)

| Run | Result |
|---|---|
| TypeScript, ESLint | clean |
| Unit | 138 passed, 0 failed |
| Integration (fresh database) | 68 passed, 0 failed |
| Full e2e chain from reset (`test:e2e`) | **70 suites, 11,226 checks, 0 failed**. The chain ends with `analysis` 47, `adversarial` 66, `ledger-audit` 62, `business-cycle` 54, then `ledger-audit` again 64. |
| UI journeys (demo data, Arabic and English) | **20 passed, 0 failed** |
| Schema drift | none |
| Migration rehearsal | Identical schemas both ways, data unchanged, preflight empty. No migration changed in this phase, so the rehearsal from `fb5f55c` stands. |

**What the evidence does not cover:**
- production data or production performance;
- ETA pre-production submission;
- load beyond the parallel-request scenarios in the adversarial suite.

---

## 9. GitHub commits (branch `ui/enterprise-ux`)

| Commit | Content |
|---|---|
| `215f4a8` | Treasury |
| `e0b9686` | VAT returns + journal approval |
| `a1246a4`, `d904b12` | Fiscal years |
| `7a2e5e5` | Fixed assets |
| `9d2b8f9` | Opening batch |
| `8b8f73f` | Cost centres |
| `69e3ed7` | Report, labels, journeys, test-clock fixes |
| `5d5744d` | Asset idempotency |
| `ff7d5ba` | Gap-closure results |
| `fb5f55c` | Independent adversarial verification: D1–D17, audit suites, remaining gaps |
| `f6c7613` | Final acceptance: D18–D20, business-cycle suite, acceptance package |
| this commit (docs only) | Records `f6c7613` here. **The code under acceptance is `f6c7613`**; the commit after it changes only this table. |

---

## 10. GO / NO-GO recommendation

**Recommendation: CONDITIONAL GO for a controlled production deployment** of this release (the
code and the 8 migrations), once the conditions below are met.

**NO-GO for using the following until their condition is met:**
- **ETA e-invoicing activation:** until the pre-production run with UNITED's credentials (L9).
- **Approval-gated finance work** (period reopen, opening-batch approval, approval-gated journals
  and transfers): until two finance users exist (C10).

**Why GO, technically:**
- Every accounting area reconciles with its ledger, proven by independent SQL.
- A realistic UNITED month runs end to end with the exact expected journal effects.
- 20 defects were found across the verification and acceptance phases, and all are fixed with
  tests.
- The migrations are additive and rehearsed both ways. The application can always be rolled
  back alone.
- The full regression is green.

**Conditions before the deployment window (all are owner or finance actions; none is code):**
1. Approve the deployment itself. This report is not an approval.
2. Run the read-only preflight on production; it must show 0 rows. Then take and verify the
   backup (runbook §2–§3).
3. Plan two finance users (C10). Decide C16 (segregation of duties) and C9 (cash-box rule).

**Conditions before finance starts using the new features (configuration, not deployment):**
- Approve the business configuration checklist (C1–C18).
- Create cost centres and asset categories.
- Prepare and approve the opening batch.
- Health check green afterwards.

**What would change this to NO-GO:**
- the preflight returns rows that cannot be resolved;
- the backup or restore check fails;
- a red Health check on the trial port.
