# UNITED ERP — Remediation register, November 2026

Branch `integration/2026-11` (from `7991d66`). Source of findings: the 2 Nov 2026 audit
(`UNITED_ERP_Audit_Report_AR.html`). Nothing is deployed: **no item is production-verified**.
"Verified" below means: implemented, covered by a named test that passed on a fresh,
isolated database (full run in §Evidence), and — where data could be affected — rehearsed
on a restored copy of the production database.

Status values: **FIXED** (implemented and verified in isolation; not production-verified) ·
**PARTIAL** · **BLOCKED** (business/legal decision or external dependency) · **OWNER** (an
operational action only the owner can take) · **N/A** (not applicable to UNITED).

## 1. Audit findings

| ID | Sev | Finding | Status | Implementation (main files) | Verification |
|---|---|---|---|---|---|
| CTL-01 | P1 | One user, segregation off by default | FIXED (code) / OWNER (users) | `lib/core/settings-registry.ts` defaults on (different approver, adjustment, grading-loss, manual journal, transfer, price exception); `lib/core/approvals.ts` emergency self-approval only when no other approver, reasoned + audited + broadcast; direct opening entries closed | sales-stock-integrity §7/§10/§12; workflow; stock; treasury; vat-returns; adversarial. Owner must create the second person |
| WF-01 | P1 | Lenient dispatch, revenue without COGS, text-only resolution | FIXED | `lib/sales/stock-commitment.ts` (hard reservation), `lib/inventory/dispatch.ts` (strict; reconciliation `issue_now` / approved `close_no_movement`), `lib/sales/invoicing.ts` (blocked while an exception is open), settings narrowed | sales-stock-integrity §2–9, §13; inventory §11/§13; waste; self-reservation; shortage |
| MIG-01 | P1 | Buyer tax id only from the card | FIXED (code) / OWNER (8 customers) | `resolveBuyerIdentity` in `lib/sales/invoicing.ts`: card → linked legal entity → P/F with id; else 409 `buyer_tax_id_missing` | sales-stock-integrity §13; rehearsal: 100/108 production customers resolve with no data change; plan for the 8 kept privately |
| MIG-02 | P1 | Cutover incomplete | PARTIAL (tooling FIXED; data OWNER) | `lib/accounting/cutover.ts`, `GET /api/accounting/cutover-readiness`; opening batch refuses stock already posted directly | rehearsal on production copy lists the real blockers (company tax no., opening batch, 8 customers, open exception, single user) |
| ACC-E1 | P1 | Unknown-cost receipt → whole bill to PPV | FIXED | WS3: receipts need agreed, supplier, received or explicit provisional cost; `lib/purchasing/revaluation.ts` splits the bill difference on hand → inventory, sold → COGS, scrapped → adjustments; reversal exact | provisional-cost (new) |
| ETA-01 | P1 | "Not received" resend of an uncertain submission | FIXED (code) / BLOCKED (live) | WS4: lookup by submission/internalID after a 15-min window, or two-person decision with evidence | eta; integration eta-submission (assertion rewritten to the safe rule) |
| ETA-02/03 | P1/P2 | 4xx / receiver rejection resendable | FIXED | 422 → unknown; `receiver_rejected` keeps UUID; DB UUID guard | eta, integration |
| ETA-05 | P1 | B2B buyer without tax id | FIXED | see MIG-01 | sales-stock-integrity §13 |
| ETA-06/07 | P1/P2 | No serializer, no signature checks | PARTIAL / BLOCKED | canonical serializer (SDK sample byte-exact); CAdES structural + crypto checks; certificate chain BLOCKED (needs real e-seal); bridge not built | unit eta-serialize, eta-signature |
| ETA-08..15, 19 | P2/P3 | rounding, SDK paths, token reuse, cross-check, evidence, portal filings, pending view, env guard | FIXED (code) | `lib/eta/**`, migrations 130000/131000/131500 | eta, integration, unit |
| ETA-04, 16–18, 24–25 | P2/P1 | cancel/decline flows; thresholds; V003/V004; asset-sale e-invoice; no sandbox run; interim portal filing | BLOCKED | needs pre-production account, tax adviser, finance confirmation | — |
| HR-01 | P1 | No statutory rules in production | OWNER | fail-closed retained; two-person verification of rule sets | hr-payroll |
| HR-03/04/06/07/10/11/12/17/19/20/22, HR-14 | P1–P3 | levy omitted; insurable 0; retired sets; corrections; carry-over/expiry; encashment; final settlement; advances cap; unpaid cap; joiner/leaver; segregation; dept split | FIXED (code), several BLOCKED for legal values | WS5 `lib/hr/**`, migration 140000 | hr, hr-foundation, hr-attendance, hr-leave, hr-payroll |
| HR-02/05/13 | P2 | tax threshold reading; YTD method; remittance forms | PARTIAL / BLOCKED (legal) | YTD available behind a rule-set flag; remittance summary + CSV, "not an official form" | hr-payroll |
| HR-08/09/15/16/18 | P3 | retro warnings; half day; bank formats; self-service; devices | N/A now / PARTIAL | unchanged except DST fix | — |
| SEC-01 | P1 | Public repos, unprotected main | OWNER | runbook §7 checklist | — |
| SEC-02 | P2 | No MFA, no CSP | FIXED | WS6: TOTP MFA (required for SUPER_ADMIN/ACCOUNTANT), recovery codes, CSP with nonce, password policy, bcrypt 12, session cap 24 h, SameSite=Strict | mfa (new), web-security (new), security, rbac, session suites |
| OPS-01 | P1 | Backups, monitoring, health | PARTIAL (code FIXED, ops OWNER) | `/api/health` checks DB; `/api/health/deep`; `scripts/ops/backup-pg-dump.sh`, `verify-restore.sh`; `OPERATIONS_RUNBOOK.md` | web-security; local restore test |
| REL-01 | P2 | Deployment record out of date | OWNER | deployment plan requires recording build hash and switch | — |
| ACC-L2 | P2 | Cash box may go negative | FIXED | DB: per-account lock + deferred check (`20261102110000`, `111000`) for every posting path; `allowOverdraft` per account (default off) | sales-stock-integrity §14; treasury; business-cycle (funded first) |
| DATA-01 | P2 | Test cycle in production | OWNER | reconciliation of the open exception in deployment plan §2.6 | — |
| OPS-02 | P3 | Legacy backup schemas in production | OWNER | final backup holds them; DROP script prepared, not executed | — |
| PERF-01 | P3 | 75 unindexed FKs | N/A now | — | — |
| G1 | P2 | Asset sale on credit | FIXED | WS3: Dr AR (customer), `CustomerCharge`, aging/statement | fixed-assets |
| G2 | P3 | Collection follow-up | FIXED (list) | `GET /api/sales/reports/collections` | WS3 tests |
| G5 | P2 | Current/non-current | FIXED | `Account.liquidity`; unclassified reported, never guessed | analysis, comparatives |
| G3 | P3 | Multi-currency | N/A (EGP only by decision) | — | — |
| G4, G6, G7, G8, G9 | P2/P3 | Bank formats; leases; recurring accruals; budgets; crates | BLOCKED (business decision; see REMEDIATION_PLAN WS3 notes) | — | — |
| L1 | P3 | Graded receipt void | N/A (refused by design) | — | grading suites |
| L3 | P3 | Payroll cost centre after transfer | FIXED (day split) | WS5 | hr-payroll |
| L4, L5, L8 | P3 | depreciation date; opening duplicates; VAT period | FIXED earlier (re-verified) | — | fixed-assets, opening-batch, vat-returns |
| L6 | P1 | Segregation off | FIXED | see CTL-01 | — |
| L7 | P3 | NRV policy | N/A (policy: proportional default) | — | grading-cost |
| L9 | P1 | ETA readiness | BLOCKED | see ETA | — |
| Waste | P2 | Waste stays valued in inventory (audit report was wrong to say it is expensed under the default policy) | FIXED | health check fails on waste older than the month; month close refused while waste is valued (`accounting.close_requires_waste_writeoff`) | business-cycle (scraps before close) |

## 2. New business requirements (mission §3–5)

| Requirement | Status | Implementation | Verification |
|---|---|---|---|
| Hard stock availability on order lines (UI + server, every path) | FIXED | stock-commitment (create, quantity edit, reopen, undispatch, clone, quotation, integration API, product mapping); no other code path creates lines (repository sweep) | sales-stock-integrity §2–6, §9, §13b; product-master; integrations |
| Available-to-sell definition | FIXED | sellable on hand (not quarantine/waste/expired) − active reservations, per product, under the availability lock | §1, §4, §12, waste |
| Concurrency | FIXED | per-product advisory locks in one global order | §4 (two concurrent orders: exactly one succeeds) |
| No lenient dispatch | FIXED | strict always | §13, inventory §11 |
| Purchase requests for unavailable demand | FIXED | `PurchaseRequest` (approval by someone else → PO → receive/grade → stock-checked fulfilment order) | §11 |
| Per-line price, snapshot, override audit, below-cost/discount approval | FIXED | `setAgreedLinePriceInTx`, `lib/sales/price-exceptions.ts`, `Order.pricingStatus` | §10; §13a: order line → invoice → statement → partial credit note → ledger |
| KG decimals / PIECE whole, controlled units | FIXED | unit precision from the UoM catalogue on create/edit/PR | §5 |
| Order entry UX (availability, units, price, totals, PR action, RTL) | FIXED (built; browser check in §Evidence) | `components/supervisor/CreateOrderForm.tsx`, `/api/orders/entry/*` | — |

## 3. Defects found and fixed during the remediation itself

| # | Defect | Found by | Fix |
|---|---|---|---|
| D1 | REVOKE before the functions exist (fresh DB fails) | production rehearsal | 103000 trimmed; new 111000 |
| D2 | Product mapping rewrote dispatched/invoiced history and bypassed stock | repository sweep | live orders only; line-scoped commitment |
| D3 | Quarantine release lost cost when it released all valued stock | grading-cost D12 | release_in carries release_out cost |
| D4 | Three segregation defaults still false | sales-stock-integrity §7 | defaults true |
| D5 | RLS / PUBLIC EXECUTE / search_path on new objects | db-security | 103000, 111000, 131000, 131500 |
| D6 | Error `code` dropped when no details | sales-stock-integrity §13 | always returned |
| D7 | Live order hold releasable by hand | test-migration review | refused (409) |
| D8 | Below-zero adjustment accepted as a request | test-migration review | refused at request |
| D9 | DST ambiguity in attendance (pre-existing baseline failure) | baseline run | WS5 |

## Evidence

| Run | Commit | Result |
|---|---|---|
| Baseline (before any change), shared DB | 410c87e (= 7991d66 code) | e2e 11,132 passed / 1 failed (DST, pre-existing); unit 138/0 |
| Final run 1, fresh DB | 30bb95c | e2e 11,864 / 6 failed; integration 43 / 36; lint 2 errors — every failure root-caused (§Failures) |
| **Final run 2, fresh DB** | **317b57f** | **91 migrations from zero, migrate diff empty, typecheck 0, lint 0, build 0, unit 177/0, integration 79/0, e2e 12,198 passed / 0 failed across 74 suite runs** |
| Production rehearsal (restored 2 Nov dump) | 290a3c7+ (same migration set) | 77 → 91 clean; 139/139 existing tables byte-identical; accounts health all ok; cutover blockers = real production gaps |
| Rollback rehearsal (old build on new schema) | 7991d66 build | 10 suites green; 3 refuse at the new DB rules (expected, data-safe) |
| Browser check (built app, test DB) | 317b57f | Arabic RTL order entry: availability, unavailable state, keep-available, PR action, typed price, line/order totals 2,250.00; order saved with 50 kg reserved and manual price 45 |

### Failures in final run 1 and their root causes
| Failure | Classification | Fix |
|---|---|---|
| documents "sandbox CSP" | **Production defect** (WS6 middleware overwrote the download sandbox CSP) | 13b0377 |
| lint (2) | Production code hygiene | 317b57f |
| integration 36 | Test fixtures predating the merged rules (cost, tax id, direct opening, approvals) | 317b57f |
| operations crash, hr-payroll advances, analysis loan, provisional-cost revenue | Test scenarios from separately developed branches meeting each other's rules (cost required, cash never negative, journal approval, buyer tax id) | 317b57f |

Logs: `/Users/ok/UNITED_AUDIT_20261102/evidence/` (private) — `baseline-e2e-20261102/`,
`final-regression-20261102/`, `final-regression-run2-20261102/`, `production-migration-rehearsal-20261102.md`.

### Decisions recorded during verification
- A standard-cost product must be received with a cost like any other (previously a
  price-less receipt at standard left GRNI uncleared on billing). Production uses AVCO only.
