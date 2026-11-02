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
