# UNITED ERP — Completion Program: Progress Ledger, Odoo Benchmark and Gap Register

| | |
|---|---|
| Started | 28 Oct 2026, on `united-full-project` at `ac579a9` (prior work committed first — see §1) |
| Rules | No push, no deploy, no production data or migration, no real payment or tax submission. Statutory, tax, account-code and bank values are never invented: they are entered with a source and verified by a second person, and the action that would use them stays blocked until then. |
| Companion documents | `FULL_GAP_AUDIT.md` (18 Oct baseline), `HR_PAYROLL_GAP_AUDIT.md` (HR design + §0 implementation record), `ACCOUNTING_OFFICE_HANDOVER.md`, `PRODUCTION_READINESS.md`, `DEPLOYMENT.md`, `BACKUP_RESTORE.md` |

---

## 1. Progress ledger (newest last — read this first after a restart)

| # | Step | Commit / evidence | Status |
|---|---|---|---|
| A1 | Verified repo: root `/home/user/erp-united`, remote `origin` = `unitedfreshfoodsupply-rgb/erp-united`, branch `united-full-project`, HEAD was `ffb297a` (6 commits ahead of `origin`, 0 behind), one old stash on `main` left untouched. | `git status`, `git log origin/united-full-project..HEAD` | done |
| A2 | Committed the existing uncommitted work in reviewable units, staged from exact backups: M1/M2/H2 fixes → `48e28ba`; UI/localization second pass → `22f99bd`; HR register on existing schema + HR audit → `4596cbe`; HR/payroll phases 1–5 → `ac579a9`. The pre-HR commit was rebuilt in a temporary worktree from the backup patch and verified: typecheck clean, unit 121/121. | commits above | done |
| A3 | Odoo 19 documentation (text sources) fetched for inventory, purchase, sales, accounting, HR, payroll; benchmark in §2. | scratchpad only, cited by URL | done |
| A4 | Gap register §3. | this file | done |
| B1 | Row-level security on the 7 tables (+ `_prisma_migrations`) that lacked it; `anon`/`authenticated` privileges revoked where those roles exist; rehearsed on a disposable DB with Supabase-style grants (anon read password hashes before, permission denied after; owner connection unaffected). `db-security` suite (4) in the e2e chain. Permissions-Policy header. | `c3a60e2` | done |
| B2 | Lint made runnable (eslint 8.57.1 + eslint-config-next 14.2.35 pinned); 116 findings → 0; lint step in CI. The findings exposed 8 defects, fixed with regression checks where testable (finance export blank AR/AP totals, receipts list blank method, silent accounting failures, lost supplier price form, concurrent-edit overwrite on order lines, release button without permission, unaudited grading cost fallback, audit search 500 on a bad date). | `9fe7cd2`, `506dcb9` | done |
| B3 | Regression after Phase B: typecheck 0, lint 0, unit 121/121, build OK, full e2e chain 55 suites / 9,372 checks / 0 failed (exit 0), dictionary integrity PASS. | local run 28 Oct | done |

(Rows are appended as each phase completes.)

---

## 2. Benchmark: Odoo / established practice → UNITED

Sources are the official Odoo 19.0 documentation (`github.com/odoo/documentation`, branch `19.0`, read as text; no Odoo code was copied). Path prefix `content/applications/`. Facts from Odoo describe *Odoo's product*; UNITED-specific columns are this repository's behaviour.

| Area | Odoo / practice (source) | UNITED requirement | Current implementation | Gap | Decision |
|---|---|---|---|---|---|
| Inventory valuation | AVCO: average updated on each receipt, not on sales; FIFO tracks receipt layers (`finance/accounting/get_started/avg_price_valuation.rst`, `inventory_and_mrp/inventory/inventory_valuation.rst`) | Fresh produce, single warehouse, one valuation method per product | AVCO default with per-product method; stock ledger = GL 1400 (integrity report) | none | keep |
| Receiving in steps | 1/2/3-step receipts; 3-step puts goods in a quality area before stock (`…/daily_operations/receipts_three_steps.rst`) | Weigh → inspect → grade at the dock | Intake with grading into good / Grade B / waste locations and quarantine-release | none (UNITED's grading is richer than Odoo's QC step for produce) | keep |
| Scrap / waste | Scrap moves goods to a scrap location; valued scrap shows in P&L (`…/inventory_valuation/scrapped_inventory_valuation.rst`, `…/inventory_management/scrap_inventory.rst`) | Waste/هالك recorded at grading; written off | Waste kept valued in `loc_waste` until a scrap document writes it off to inventory adjustments | write-off timing is an accountant policy (FULL_GAP_AUDIT ODOO-01) | keep valued; scrap document already exists — §3 C-3 |
| Counts / adjustments | Cycle counts and count sheets (`…/inventory_management/cycle_counts.rst`, `count_products.rst`) | Periodic counts with approval over a threshold | Count/adjustment documents with approval engine | none | keep |
| Lots | Lot tracking for traceability (`…/product_tracking/lots.rst`) | Lot per intake for produce traceability | Daily lots `LOT-`, reservations, release | none | keep |
| Vendor bills | Bill control on ordered vs received quantities (`inventory_and_mrp/purchase/manage_deals/control_bills.rst`) | Bills matched to receipts; service bills without receipts | 3-way match with variance approval; service bills with input VAT (`48e28ba` tightened accounts) | unknown-cost receipts post PPV — accountant sign-off pending (FULL_GAP_AUDIT §11.1) | keep, decision documented |
| Credit notes | "Issuing a credit/debit note is the only legal method for canceling, refunding, or modifying a validated invoice" (`finance/accounting/customer_invoices/credit_notes.rst`) | Same | Posted invoices immutable; credit notes and debit notes; ETA credit-note submission | none | keep |
| Periods | Fiscal periods and year-end closing (`finance/accounting/reporting/year_end.rst`) | Monthly close | Accounting periods open/close, sequential; posting refused in closed periods | none | keep |
| Payroll posting | Payslips validated → journal entry (draft) → posted; "Employees cannot be paid until the journal entry is posted"; payment report (bank file) then "Mark as paid" (`hr/payroll/payslips.rst`, `hr/payroll/pay_runs.rst`) | Approved run → posted once → paid up to net, partial payments allowed | Phases 1–5: runs to approval; no posting/payment | posting, payment, bank file, payslip print, register, reversal | **build in Phase D, gated on accountant-configured accounts** |
| Payroll localization (Egypt) | Odoo ships an Egypt payroll localization with its own rates (`hr/payroll/payroll_localizations/egypt.rst`) | Rates must come from verified official sources | Rule-set framework, no values | values need the accountant (S6–S13) | keep blocked; never copy vendor rates |
| Attendance / overtime | Attendance kiosk/devices, overtime rules (`hr/attendances/*`) | Manual register + device seam | Built (phase 2) | none | keep |
| Time off | Types, allocations, accrual plans (`hr/time_off/*`) | Types, verified policies, ledger | Built (phase 3) | carry-over/expiry jobs, half days | documented open |

---

## 3. Gap register

Severity: **S1** security / data integrity / financial correctness · **S2** broken core workflow or missing accounting control · **S3** valuation/balance/report correctness · **S4** HR/payroll completeness · **S5** UI/UX/localization · **S6** performance/cost/lower priority.
Status: open · in progress · fixed (commit) · blocked (external input) · accepted (documented, no change).

| ID | Sev | Domain | Gap | Business impact | Fix | Test strategy | Status |
|---|---|---|---|---|---|---|---|
| B-1 | S1 | Security | 7 tables without row-level security (`User`, `AuditLog`, `Order`, `OrderItem`, `CustomerGroup`, `CustomerGroupMember`, `CustomerLegalEntity`) + `_prisma_migrations`, against the documented posture "RLS on, no policies; Prisma bypasses; Supabase anon/PostgREST cannot read or write". On a Supabase project with default grants the public anon key could read password hashes and the audit log. | credential and data exposure | additive migration enabling RLS; grants to `anon`/`authenticated` revoked where those roles exist; test that every public table has RLS | migration on fresh + existing DB; unit/DB test; full regression | open |
| B-2 | S1 | Security | No `Permissions-Policy` header; CSP intentionally deferred (needs nonces) | browser feature abuse surface | add Permissions-Policy; CSP stays documented | header check | fixed (`c3a60e2`); CSP accepted (documented in `PRODUCTION_READINESS.md`) |
| B-3 | S2 | Tooling | `npm run lint` cannot run: `eslint` 10 is present only transitively and `eslint-config-next` is missing; CI does not lint | defects reach review unchecked | pin `eslint@8` + `eslint-config-next@14.2.35` as dev deps, fix findings | `npm run lint` in CI | fixed (`506dcb9`; defects it found: `9fe7cd2`) |
| B-4 | S2 | Several | Defects found by lint (see ledger B2) | wrong/blank figures, silent failures, lost edits | fixed | exports + grading-cost suites extended | fixed (`9fe7cd2`) |
| C-1 | S2 | Accounting | Payroll posts nothing to the ledger (6300 exists, unused) | salaries invisible in P&L and liabilities | Phase D (gated) | e2e: post once, reversal, period lock | open |
| C-2 | S3 | Accounting | Integrity report has no payroll checks | payroll vs GL drift undetected | add checks with posting | integrity tests | open |
| C-3 | S3 | Inventory | Waste stays valued until a scrap document is posted; no reminder of waste value pending write-off | inventory overstated until scrapped | surface "waste awaiting write-off" value in the stock dashboard/integrity report; policy stays with accountant | e2e | open |
| C-4 | S3 | Purchasing | Unknown-cost receipt → PPV, inventory layer stays at 0 (FULL_GAP_AUDIT §11.1) | margin distortion | accountant decision; behaviour documented | existing cost-reconciliation suite | blocked (accountant) |
| D-1 | S4 | Payroll | Journal preview + posting of approved runs | see C-1 | accounts from component mapping + a configured net-salaries account; refused when any mapping is missing, the period is closed or the run is not approved; one entry per run (existing unique source index) | e2e | open |
| D-2 | S4 | Payroll | Payments (partial, capped at net), bank payment file, mark paid | cannot pay through the system | payment + allocation with DB cap; generic CSV bank file (no bank-specific format invented) | e2e | open |
| D-3 | S4 | Payroll | Reversal of a posted run (no live payments) | no correction path after posting | reversal entry, status reversed, new run allowed | e2e | open |
| D-4 | S4 | Payroll | Payslip print (bilingual) and payroll register export | no employee/office document | print page + CSV register | browser + e2e | open |
| D-5 | S4 | Payroll | Statutory values (S1–S19) | runs block on missing rules | external input — accountant/HR enter and verify | existing tests prove blocking | blocked (external) |
| D-6 | S4 | Leave | Carry-over/expiry jobs, half days, encashment | manual adjustments needed | documented; adjustments cover it | — | accepted (P-decisions) |
| E-1 | S5 | UI | Screen-by-screen review not repeated since the second pass | regressions unseen | browser sweep AR/EN desktop/tablet of every nav page, console/network check, fix defects | screenshots + console log | open |
| E-2 | S5 | Audit log | Search/filter UI limited to preset filters (FULL_GAP_AUDIT P3) | slow investigations | add text/entity/date filters on the existing API | browser | open |
| F-1 | S6 | Performance | Never measured. Seen in code: the orders dashboard loads every order ever, with items, on each call (`lib/orders-service.ts` dashboard) | unknown headroom; dashboard cost grows with history | measure key endpoints on the seeded DB; add missing indexes where plans show sequential scans; bound the dashboard query | timings recorded | open |
| F-2 | S6 | Cost | Recurring cost not inventoried | — | cost review from deployment config: hosting, Supabase, storage, ETA, CI minutes; measured where possible, labelled estimates otherwise | doc | open |
| G-1 | S2 | Release | Migration rehearsal from the deployed schema (`origin/united-full-project`) to HEAD, and from empty | failed cutover | rehearse both on disposable databases; record timings | drift = 0, suites green | open |
| X-1 | — | ETA | Live submission needs credentials and the e-seal bridge | legal obligation | external input; code complete and contract-tested | sandbox checklist | blocked (credentials) |
| X-2 | — | Accounting | Chart-of-accounts finalisation, tax subtypes, recognition basis (FULL_GAP_AUDIT §11) | — | accountant | — | blocked (accountant) |
