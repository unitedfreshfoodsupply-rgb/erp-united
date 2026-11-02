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

## WS5 notes

Branch `worktree-agent-a5411137205dab44b` (on top of `410c87e`). Migration
`20261102140000_hr_ws5_payroll_remediation` (additive; three CHECKs replaced by supersets, new
tightening constraints `NOT VALID`). No statutory value is coded or seeded: every rate stays a
verified `StatutoryRuleSet`, and every test uses labelled TEST VALUES.

| ID | Status | What changed (code · test) |
|---|---|---|
| HR-01 | Unchanged (configuration) | Production still needs verified 2026 rule sets — now **including `eg_other_levies`** — and `hr.payroll_net_pay_account`. |
| HR-02 | Open (legal) | Threshold semantics of the high-income tables unverified; no change. |
| HR-03 | FIXED | Pay with no verified `eg_other_levies` set is blocking `rule_missing` like SI and tax (`payroll-engine.ts`). `hr-payroll` §4, §6. |
| HR-04 | FIXED | Insurable wage 0 → blocking `insurable_wage_zero` unless the package is `insuranceExempt` with a reason (approved with the package; DB CHECK). Warning `insurable_wage_differs` when the wage ≠ the insurable components. `hr-payroll` §13. |
| HR-05 | FIXED behind a flag / legal decision open | `period_method: cumulative_ytd` (opt-in per tax rule set; default stays `annualised_monthly`): YTD base from posted payslips of the calendar year, projected by month number, minus tax already withheld, floored at 0 with a warning. Which method the ETA requires is for the accountant. `hr-payroll` §17. |
| HR-06 | FIXED | `verifiedRuleFor` falls back to a retired (once verified) set that covers the whole period; later periods are not covered. Two retired sets over one period → none (fail closed). `hr-payroll` §13. |
| HR-07 | FIXED | Correction runs (`POST /api/hr/payroll/runs/:id/corrections`, idempotency key, one open per run): recalculated month minus what posted runs of the month carry; signed `correction` lines; an employee's negative difference goes to employee advances (negative recovery), never paid; approval by another person; posted through the payroll posting path on the posting date; the corrected run cannot be reversed while a correction stands. `hr-payroll` §15. |
| HR-08 | PARTIAL | Posting a correction run marks the month's pending retro attendance corrections `applied`. No automatic warning list on the next run. |
| HR-09 | Not in scope | — |
| HR-10 | FIXED (rule unverified) | `POST /api/hr/leave/rollover {leave_type_id, year}`: expiry of carried days past `carryOverExpiryMonths` (FIFO against days taken), then year-end close (`expiry`) and carry-over up to `carryOverMaxDays` (`carry_over`); idempotent; nothing deleted; refused when the policy has no cap. Law 14/2025 carry rules still to be confirmed. `hr-leave` §9. |
| HR-11 | FIXED (in settlements) | `LeaveType.encashable`; a final settlement pays the unused balance × the `pay_proration` daily rate (`leave_encashment` component) and writes an `encashment` ledger entry when posted (restored by an adjustment if the settlement is reversed). Periodic (non-termination) encashment not built. `hr-payroll` §14. |
| HR-12 | FIXED (entitlements are HR input) | Termination in the month blocks the regular run (`terminated_in_period`, then `settlement_pending`) until a final settlement is posted; then the regular payslip is empty (`paid_by_settlement`). `POST /api/hr/payroll/settlements`: run type `final_settlement` — pay to the last day, encashment, manual items with reasons (notice etc.), open-advance recovery (default the open balance), statutory lines; approved by someone else; posted/paid/printed/exported like any run. Legal entitlements (notice, compensation) are not computed. `hr-payroll` §14. |
| HR-13 | FIXED (not an official form) | `GET /api/hr/payroll/remittance?period=&format=csv`: per employee insurable wage, SI employee/employer, taxable base, tax, levies from posted runs of the month; national ID / insurance number / tax registration only with `hr.private.view` (fields already existed in `EmployeePrivateInfo`). `hr-payroll` §16. |
| HR-14 | FIXED | Posting splits each employee's cost across cost centers by days in each department (employment history); the last share takes the rounding. `hr-payroll` §10 (test rewritten: transfer effective on the 16th). |
| HR-15/16 | Not a gap | — |
| HR-17 | FIXED (cap unverified) | `EmployeeAdvancePlan` per advance (approved by another person, DB CHECK): instalments deducted automatically per regular payslip, limited to the open advance and to setting `hr.advance_recovery_max_pct` (default 10 %, **needs legal confirmation**) unless the approved plan allows more; a manual recovery above the cap blocks (`recovery_exceeds_cap`); on-account salary is exempt; in a settlement the excess is a warning (the settlement's approval decides). `hr-payroll` §17. |
| HR-18 | Not in scope | — |
| HR-19 | FIXED | Unpaid deductions capped at the month's fixed pay (`unpaid_capped`); a negative net stays blocking. Plain `absent` follows setting `hr.payroll_absent_policy` (default `deduct`, flagged `absent_deducted`; `warn` keeps the old behaviour). `hr-payroll` §17. |
| HR-20 | FIXED (termination day) / NOSI rule open | The termination row's date is the **last working day**: paid, attendance and leave allowed (`onPayroll` in `attendance.ts`), employee joins that month's run. SI partial-month rule still unverified. |
| HR-21 | Residual | Correction runs post on their posting date (the corrected month may be closed). |
| HR-22 | FIXED | Preparer/submitter can neither approve, post nor pay a run; NULL actor ids are refused (service), and the DB enforces it (`PayrollRun_segregation`, payment trigger). Payment and run reversal by the preparer remain an owner decision (P1–P3). `hr-payroll` §10, §11, §18. |
| HR-23 | Partial | Branch tests now cover levies, insurable wage 0, retired rules, termination, YTD, caps; golden figures with real 2026 values still need the accountant. |

Also fixed (coordinator item): Cairo DST in attendance (`attendance-calc.ts`): ambiguous autumn
times resolve to the first occurrence (a last-out: first occurrence after the first-in);
nonexistent spring times typed by a person are refused (400); worked time is real elapsed time.
Unit tests on both 2026 transitions (`tests/unit/hr-cairo-dst.test.ts`).

**Blocked by legal decisions (fail-closed or defaulted, to confirm):** tax period method (HR-05),
high-income threshold reading (HR-02), advance recovery cap 10 % (HR-17), carry-over / expiry
rule under Law 14/2025 (HR-10), end-of-service entitlements (notice, compensation — entered as
items, HR-12), NOSI joining/leaving-month rule (HR-20), remittance forms and frequencies (HR-13),
settlement tax on one-off amounts (annualised; flagged `settlement_tax_annualised`).

**Not done / follow-ups:** UI screens for settlements, corrections, advance plans, rollover and
the remittance report (API only; the only UI change is the `leave_encashment` role in the
component form, `components/hr/PayrollView.tsx`); a correction of a settled leaver (reverse and
recompute the settlement instead); the guard that refuses reversing a settlement the month's
regular run relies on is implemented but not exercised by a suite (settlement reversal itself is).
