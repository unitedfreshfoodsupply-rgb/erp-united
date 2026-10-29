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
| C1 | Waste awaiting write-off shown in Accounts Health (value and products); health labels localized. | `8d5bad6` | done |
| D1 | Payroll after approval: journal preview with every missing account; posting once; payments (partial / all, capped per payslip in the DB, idempotent, reversible); reversal of an unpaid posted run; bilingual payslip; payroll register CSV; generic bank list CSV; payroll reconciliation in Accounts Health. New permissions `hr.payroll.post`, `hr.payroll.pay`; setting `hr.payroll_net_pay_account` (empty = posting blocked). Engine: recoveries of posted runs are no longer double-counted. Migration `20261029100000_hr_payroll_posting` (drift 0). `hr-payroll` 143/143, `rbac` 248/248, HR suites, `flows`, `db-security` green. | `e342611` | done |
| E1 | Browser sweep, every nav page: AR 1440 px + EN 1024 px (56 page loads, 0 console errors, 0 HTTP 5xx, 0 horizontal overflow, 0 leaked dictionary keys). EN sweep of every tab: 478 visible Arabic strings → 200, the rest data. Fixed: settings, permissions, roles, ETA status/units, VAT names, UoM categories, dates, receipt reversal placeholder, cash-flow labels, payroll screens. | `15c75f1`, `ac80eff` | done |
| E2 | Cash-flow statement balanced only by coincidence (liability/equity sign, negated total) — fixed with whole-history balance check. Audit log: server-side search across who/what/why/values/ids, paging, HR/payroll entities. | `ac80eff`, `b1016f3` | done |
| F1 | Performance measured on a disposable copy grown to 20k orders / 300k audit rows / 20k journal entries: four order endpoints took 3.5–7.0 s (every order ever loaded on 3–5 s refreshes); bounded boards and today-scoped production → 158–321 ms; accounting/management/audit reads 12–124 ms; audit text search 0.7 s (documented). | `a9844d5`, `PERFORMANCE_AND_COST.md` | done |
| F2 | Cost review from measured drivers: polling bandwidth (board payloads served uncompressed by `next start`; gzip ≈ 36× smaller — deployment action), database growth per row, recurring items to confirm with host/plan; no vendor prices invented. | `PERFORMANCE_AND_COST.md` | done |
| G1 | Full regression on the final code (§4.2); a test date bug found and fixed (`19c2909`); migration rehearsals from empty and from the deployed branch; release checklist; handover. | `19c2909`, `538eac8`, this commit | done |
| R1 | Final security review. On a Supabase-style disposable database (roles `anon`/`authenticated`/`service_role` with Supabase's default grants, then this branch's migrations): no table or sequence privileges for the Data API roles, RLS on every table, 0 policies, no views, no `SECURITY DEFINER` functions; the app role reads. Gap found: functions kept PostgreSQL's default `EXECUTE` for `PUBLIC` — none callable today (all trigger functions) but any later function would be exposed at `/rpc`; revoked, with default privileges. Payroll reviewed: maker/checker by DB CHECK, one journal entry per run (unique source + advisory lock; new test: two parallel posts → one 200, one 409, one entry), payment cap trigger, reversal only without live payments, audit rows, statutory/account gating; ETA refuses without credentials. | `1699d9a` | done |
| R2 | Bilingual names: `Employee`, `Department`, `CashAccount` gain `nameAr` (name = English, nameAr = Arabic, as for customers/products/suppliers); HR forms take both; every list, picker, print and report shows the name in the UI language with the documented fallback. Codes removed from name labels in dropdowns and tables (customers, suppliers, products, locations, employees); kept in code columns, code fields, account pickers (accounting needs them), exports, API and audit. Sweep: 2,908 options on every tab AR/EN, none with a code beside the name. | `54b63fb` | done |
| R3 | Brand: the sidebar/print mark was a low-contrast crop with stray background — replaced by clean crops of the committed `public/logo-united.png` (mark; full lockup on the login page; app icon); no new mark drawn. Browser: 56 page loads AR 1440 / EN 1024 + phone drawer AR/EN + payslip and invoice prints: 0 console errors, 0 HTTP 5xx, 0 overflow, 0 leaked keys. | `0a1eca7` | done |
| R4 | Release validation on the final code (§4.2) and a rehearsal of the two new migrations on existing data (`RELEASE_2026_10_COMPLETION.md` §3 C). | local run 29 Oct | in progress |

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
| B-1 | S1 | Security | 7 tables without row-level security (`User`, `AuditLog`, `Order`, `OrderItem`, `CustomerGroup`, `CustomerGroupMember`, `CustomerLegalEntity`) + `_prisma_migrations`, against the documented posture "RLS on, no policies; Prisma bypasses; Supabase anon/PostgREST cannot read or write". On a Supabase project with default grants the public anon key could read password hashes and the audit log. | credential and data exposure | additive migration enabling RLS; grants to `anon`/`authenticated` revoked where those roles exist; test that every public table has RLS | migration on fresh + existing DB; unit/DB test; full regression | fixed (`c3a60e2`) |
| B-2 | S1 | Security | No `Permissions-Policy` header; CSP intentionally deferred (needs nonces) | browser feature abuse surface | add Permissions-Policy; CSP stays documented | header check | fixed (`c3a60e2`); CSP accepted (documented in `PRODUCTION_READINESS.md`) |
| B-3 | S2 | Tooling | `npm run lint` cannot run: `eslint` 10 is present only transitively and `eslint-config-next` is missing; CI does not lint | defects reach review unchecked | pin `eslint@8` + `eslint-config-next@14.2.35` as dev deps, fix findings | `npm run lint` in CI | fixed (`506dcb9`; defects it found: `9fe7cd2`) |
| B-4 | S2 | Several | Defects found by lint (see ledger B2) | wrong/blank figures, silent failures, lost edits | fixed | exports + grading-cost suites extended | fixed (`9fe7cd2`) |
| C-1 | S2 | Accounting | Payroll posts nothing to the ledger (6300 exists, unused) | salaries invisible in P&L and liabilities | Phase D (gated) | e2e: post once, reversal, period lock | fixed (D1) — live use needs the accountant's account mapping (X-3) |
| C-2 | S3 | Accounting | Integrity report has no payroll checks | payroll vs GL drift undetected | add checks with posting | integrity tests | fixed (D1): unposted/traceable cover payroll entries; owed net = net-salaries account |
| C-3 | S3 | Inventory | Waste stays valued until a scrap document is posted; no reminder of waste value pending write-off | inventory overstated until scrapped | surface "waste awaiting write-off" value in the stock dashboard/integrity report; policy stays with accountant | e2e | fixed (`8d5bad6`) |
| C-4 | S3 | Purchasing | Unknown-cost receipt → PPV, inventory layer stays at 0 (FULL_GAP_AUDIT §11.1) | margin distortion | accountant decision; behaviour documented | existing cost-reconciliation suite | blocked (accountant) |
| D-1 | S4 | Payroll | Journal preview + posting of approved runs | see C-1 | accounts from component mapping + a configured net-salaries account; refused when any mapping is missing, the period is closed or the run is not approved; one entry per run (existing unique source index) | e2e | fixed (D1) |
| D-2 | S4 | Payroll | Payments (partial, capped at net), bank payment file, mark paid | cannot pay through the system | payment + allocation with DB cap; generic CSV bank file (no bank-specific format invented) | e2e | fixed (D1); a bank's own upload format needs its specification (X-4) |
| D-3 | S4 | Payroll | Reversal of a posted run (no live payments) | no correction path after posting | reversal entry, status reversed, new run allowed | e2e | fixed (D1) |
| D-4 | S4 | Payroll | Payslip print (bilingual) and payroll register export | no employee/office document | print page + CSV register | browser + e2e | fixed (D1) |
| D-5 | S4 | Payroll | Statutory values (S1–S19) | runs block on missing rules | external input — accountant/HR enter and verify | existing tests prove blocking | blocked (external) |
| D-6 | S4 | Leave | Carry-over/expiry jobs, half days, encashment | manual adjustments needed | documented; adjustments cover it | — | accepted (P-decisions) |
| E-1 | S5 | UI | Screen-by-screen review not repeated since the second pass | regressions unseen | browser sweep AR/EN desktop/tablet of every nav page, console/network check, fix defects | screenshots + console log | fixed (E1); remaining Arabic in EN is stored data (journal/audit text, names) — accepted |
| E-2 | S5 | Audit log | Search/filter UI limited to preset filters (FULL_GAP_AUDIT P3) | slow investigations | add text/entity/date filters on the existing API | browser | fixed (`b1016f3`) |
| E-3 | S3 | Reports | Cash-flow statement did not balance when liabilities or equity moved; non-system liabilities (salaries, withholdings) fell to "financing" | wrong management figures | sign fixed; configuration-referenced accounts operating | cash-flow suite N8 | fixed (`ac80eff`) |
| F-1 | S6 | Performance | Never measured. Seen in code: the orders dashboard loads every order ever, with items, on each call (`lib/orders-service.ts` dashboard) | unknown headroom; dashboard cost grows with history | measure key endpoints on the seeded DB; add missing indexes where plans show sequential scans; bound the dashboard query | timings recorded | fixed (`a9844d5`); audit trigram index deferred (documented) |
| F-2 | S6 | Cost | Recurring cost not inventoried | — | cost review from deployment config: hosting, Supabase, storage, ETA, CI minutes; measured where possible, labelled estimates otherwise | doc | done (`PERFORMANCE_AND_COST.md`); JSON compression to verify on the host |
| G-1 | S2 | Release | Migration rehearsal from the deployed schema (`origin/united-full-project`) to HEAD, and from empty | failed cutover | rehearse both on disposable databases; record timings | drift = 0, suites green | done (`RELEASE_2026_10_COMPLETION.md` §3) |
| B-5 | S1 | Security | Public functions executable by `PUBLIC` (PostgreSQL default), so by the Data API roles; on Supabase new functions are also granted to `anon`/`authenticated` by default. All current functions are triggers (not callable), so nothing was exposed today | a future function would be callable with the public key | revoke from `PUBLIC` (+ `anon`/`authenticated`), default privileges too | `db-security` checks no function executable by `PUBLIC`/`anon`/`authenticated`; triggers still fire (flows, waste, payroll suites) | fixed (`1699d9a`) |
| B-6 | S1 | Payroll | Duplicate posting under concurrency was guarded (unique source index + lock) but untested | double salary expense | regression test: two simultaneous posts | `hr-payroll` | fixed (`1699d9a`, test only) |
| E-4 | S5 | Localization | Employees, departments and cash accounts had one name field (Arabic in practice), so English screens showed Arabic | mixed-language screens | `nameAr` column; both fields in HR forms; locale-aware display everywhere | unit (`namesForEdit`/`namesForSave`), HR suites, browser | fixed (`54b63fb`) |
| E-5 | S5 | UI | Codes and IDs shown next to names in ordinary dropdowns/tables (`CUS-…`, `SUP-…`, `EMP-…`, location codes) | cluttered pickers | names only; codes stay in code columns/fields, exports, API, audit | browser sweep of every option on every tab | fixed (`54b63fb`) |
| E-6 | S5 | Brand | Sidebar/print mark low-contrast with stray background | weak brand presentation | clean crops of the committed logo | screenshots login/sidebar/drawer/prints | fixed (`0a1eca7`) |
| X-1 | — | ETA | Live submission needs credentials and the e-seal bridge | legal obligation | external input; code complete and contract-tested | sandbox checklist | blocked (credentials) |
| X-2 | — | Accounting | Chart-of-accounts finalisation, tax subtypes, recognition basis (FULL_GAP_AUDIT §11) | — | accountant | — | blocked (accountant) |
| X-3 | — | Payroll | Account mapping for each pay component (expense; liability for withholdings and employer contributions) and the net-salaries liability account (setting `hr.payroll_net_pay_account`) | posting blocked until set | accountant enters them; the journal preview lists what is missing | — | blocked (accountant) |
| X-4 | — | Payroll | Bank upload format for salary transfers (if the bank requires one) | manual upload of the generic list | bank's file specification | — | blocked (bank) |

---

## 4. Handover (29 Oct 2026)

**Repository** `unitedfreshfoodsupply-rgb/erp-united`, branch `united-full-project`, local
HEAD in §4.1 — **not pushed** (27 commits ahead of `origin/united-full-project` = `37f9064`;
pushing and deploying await the owner's approval). History was never rewritten; the old
stash on `main` is untouched.

### 4.1 Commits since the deployed branch (oldest first)

Prior work committed at the start of this program (A2): `4c948a3`, `a5b4f24`, `be74c27`,
`3529c6b`, `1233261`, `ffb297a`, `48e28ba`, `22f99bd`, `4596cbe`, `ac579a9`.
This program: `e6a41fa` (benchmark + register) · `c3a60e2` (RLS) · `9fe7cd2` (defects found
by lint) · `506dcb9` (lint) · `17f6174` · `8d5bad6` (waste awaiting write-off) · `e342611`
(payroll posting/payments/reversal/payslips/register/bank list) · `7606dd0` · `ac80eff`
(cash-flow statement) · `b1016f3` (audit search) · `15c75f1` (English UI) · `4d5aa3f` ·
`a9844d5` (board performance) · `ab01c55` (performance & cost review) · `19c2909`
(flaky test date) · `538eac8` (release checklist) · this handover commit.

### 4.2 Verification on the final code

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | 0 errors |
| Lint (`next lint`, now in CI) | 0 findings (116 at the start of Phase B) |
| Unit (`test:unit`) | 121 / 121 |
| Integration (`test:integration`) | 68 / 68 |
| End-to-end chain (`test:reset` + `test:e2e`, as CI runs it) | 55 suites, 9,571 checks, 0 failed, exit 0 — incl. HR payroll 147, cash flow 22, orders 180, RBAC 248, DB security 4 |
| Schema drift (migrations vs `schema.prisma`) | none |
| Dictionary integrity | PASS |
| Migration rehearsal | from empty and from the deployed branch: both drift 0, row counts preserved (`RELEASE_2026_10_COMPLETION.md` §3) |
| Browser | 56 page loads AR 1440 / EN 1024: 0 console errors, 0 HTTP 5xx, 0 horizontal overflow; payroll, cash-flow and audit screens checked visually (screenshots kept in the session scratchpad, not committed) |
| Performance | 20k-order copy: order boards 3.5–7.0 s → 0.16–0.32 s (`PERFORMANCE_AND_COST.md`) |

### 4.3 Documents

`RELEASE_2026_10_COMPLETION.md` (migrations, release steps, rehearsal evidence, rollback,
inputs) · `PERFORMANCE_AND_COST.md` · `HR_PAYROLL_GAP_AUDIT.md` §0 · this file (ledger,
Odoo benchmark with sources, gap register) · `DEPLOYMENT.md`, `BACKUP_RESTORE.md`,
`CUTOVER.md` (unchanged procedures).

### 4.4 Still open (external input — the system refuses the action until provided)

X-1 ETA credentials and e-seal bridge · X-2 chart-of-accounts finalisation, tax subtypes ·
X-3 payroll account mapping and net-salaries account · X-4 bank upload format (optional) ·
D-5 statutory payroll rules with official sources, second-person verified · C-4 unknown-cost
receipt policy · HR role decisions (HR audit §12 P1–P3).

### 4.5 Verdict

**Ready to deploy, once the owner approves the push.** The code is complete for this
program's scope and verified as above. The release is additive, rehearsed on a copy of the
deployed schema, and fixes a defect live on the deployed branch (stock intake fails without
the Grade-B column migration).

**Not yet ready for live payroll, e-invoicing or statutory figures.** Those need the external
inputs in §4.4. Until each is provided the system refuses the action and says what is
missing; nothing is defaulted or invented.

Before go-live: run the release checklist on a restored copy of production data (§2 step 2),
confirm JSON compression on the host, and complete `CUTOVER.md`.
