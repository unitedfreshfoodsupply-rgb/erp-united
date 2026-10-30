# UX transformation — audit, decisions, changes (Oct 2026)

Branch `ui/enterprise-ux` (from `perf/sprint-0-fixes`, itself from the production release
`8f01e96`). Nothing here has been deployed. No schema migration, no business-rule change, no
permission change other than one new read-only finance route and page (both `reports.finance`).

## 1. How the audit was done

- **Data.** A disposable local database filled with twelve weeks of realistic history by
  `scripts/dev/demo-data.ts`, which drives the application's own HTTP API (every document goes
  through the same validation, permissions and postings as on site): 8 customers, 4 suppliers,
  10 products, ~370 graded receipts, ~215 orders taken through prepare / load / dispatch /
  delivery, ~210 issued invoices, ~170 customer receipts, bills and supplier payments.
- **Sweep.** 33 routes × Arabic/English × desktop 1440 / phone 390, every tab clicked on desktop
  (266 screen states): full-page screenshots plus automated checks — console errors, failed
  requests, horizontal overflow, raw dictionary keys, UI text in the other language, unlabelled
  controls, unnamed buttons, touch targets.
- **Review.** Every main screen looked at in both languages, then the code behind each finding.

Baseline: **0 console errors, 0 failed requests, 0 page-level horizontal overflow** across all
states. The existing design system (tokens with checked contrast, shell, dialogs, status pills,
tabs, data-table classes; `DESIGN_SYSTEM.md` §1–8) was sound — this pass extends it rather than
replacing it.

## 2. Issue inventory (prioritised)

Impact: H = changes decisions or blocks work, M = slows or confuses, L = polish.
Status: ✅ done in this branch · ◐ partly · ⏭ next sprint · ✖ not a defect.

| # | Finding | Where | Impact | Effort | Risk | Status |
|---|---|---|---|---|---|---|
| U1 | No decision dashboard: management sees only tables; no trend, quality, aging or customer view | Management | H | M | L | ✅ `/management/overview` |
| U2 | Order customers shown in Arabic in the English UI (stored text, not the account's name) | Order cards, order page, load and production boards | M | S | L | ✅ |
| U3 | Production totals show Arabic product names in English | Production board | M | S | L | ✅ |
| U4 | Receiving chips show English supplier/product names in Arabic | Stock receiving | M | S | L | ✅ |
| U5 | Users admin: a tall card per user with five equal-weight buttons, red "Suspend" on every row; no search | Admin → Users | M | M | M (security UI) | ✅ rows + menu + search; same checks |
| U6 | No consistent identity: dark circle with raw first letters in the top bar only; profile page outside the app shell (no navigation), one long permission list | Shell, profile | M | S | L | ✅ Avatar, profile in shell, grouped permissions |
| U7 | ~180 fields with a placeholder as their only label (screen readers announce nothing useful) | 13 screens (journal entry, vehicles, suppliers, devices, opening stock, new order, ETA codes…) | M | M | L | ✅ 60+ fixed; ◐ a few remain (§6) |
| U8 | Compact controls (36px) on tablets/phones: segmented switches, filter pills, small buttons | Floor and desk screens on touch | M | S | L | ✅ 44px on touch, desk unchanged |
| U9 | Permission matrix: ✓/— read aloud as symbols, no header scopes, unkeyed fragments | Admin → Roles | L | S | L | ✅ |
| U10 | "Edit required quantity" link 20px tall | Order page | L | S | L | ✅ |
| U11 | Revoke-sessions action labelled "Logout" (reads like logging yourself out) | Admin → Users | M | S | L | ✅ "Sign out on all devices" |
| U12 | ETA list shows the buyer's Arabic legal name in English | ETA | — | — | — | ✖ the legal name submitted to the tax authority, correct as is |
| U13 | Permission codes visible next to labels in the matrix | Admin | — | — | — | ✖ intentional for administrators (label first, code small) |
| U14 | Supervisor "All" list very long | Command center | — | — | — | ✖ already bounded server-side (open + recent); long only because demo history was generated in one day |
| U15 | Management report margins negative in the demo | Management | — | — | — | ✖ demo artefact: dispatch (COGS) cannot be back-dated through the API, invoices were; costing verified correct (issue cost = intake cost) |
| U16 | Prep/load item rows show the product name as ordered (Arabic) in English | Floor boards | L | M | L | ⏭ needs the product's names on each item |
| U17 | Desk tables still hand-built in a few places (price lists, inventory valuation, attendance month) | Sales, stock, HR | L | M | L | ⏭ |
| U18 | Native date inputs follow the browser locale | All forms | L | M | M | ⏭ (would need a date picker; not worth a dependency now) |
| U19 | Bilingual dictionary on every page (~73 kB gzip) | All | M | M | M | ⏭ per-language split (Sprint 0 F-14) |
| U20 | Customer list as cards without balance / last order | Sales | L | M | L | ⏭ table with balance & exposure columns |

## 3. Design direction

The direction set in `DESIGN_SYSTEM.md` stays: meaning before decoration, one loud thing per
screen, density for desks and reach for floors, direction-agnostic layout. Added
(`DESIGN_SYSTEM.md` §9):

- **Charts that answer a question.** No library; validated palette; one axis; legend; tooltip
  by pointer, touch and keyboard; a table view for every chart; empty states that say why.
- **Identity.** One `Avatar` everywhere (initials, stable tone, no external service).
- **Row actions.** Primary action inline, the rest in an accessible `Menu`; destructive items
  red and still confirmed.
- **Touch.** A `coarse:` variant: 44px controls on touch pointers only.
- **Labels.** Every field has an accessible name (§9.5).

## 4. What changed (commits on `ui/enterprise-ux`)

| Commit | Change |
|---|---|
| `383fb01` | Local demo-data generator (disposable DB only, refuses otherwise) |
| `15d3bf3` | Performance overview: `lib/management/overview.ts` (8 aggregate queries in parallel, ~130 ms locally), `/api/management/overview`, `/management/overview`, charts module, management switch, nav link |
| `5cb9a12` | Avatar, Menu, users admin rows + search, profile inside the shell |
| `ad97e68` | Order customer and production product names in the UI language |
| `3c4cf18` | Accessible names for placeholder-only fields; 44px touch sizes; permission-matrix semantics; receiving chips localised |
| `4b49081` | Tests: overview RBAC/validation/consistency suite (in `test:e2e`), unit tests; RBAC snapshot (only the new route and page) |
| `b76dd56` | Remaining journal/order/statement/ETA labels; production names from any linked line |

### The dashboard — what each part answers

| Part | Question | Source |
|---|---|---|
| Headline tiles | How did this period go, against the previous one of the same length? | Net sales, net purchases, collections; receivables and payables with overdue; waste and grade-B rates at intake |
| Sales vs purchases by week | Are buying and selling moving together? | Issued invoices − credit notes; posted bills − debit notes (net, before tax) |
| Intake quality by week | How much of what we receive is sellable? | Receipts' good / grade B / waste (kg products only — boxes and kilograms do not add) |
| Top customers | Who matters this period? | Issued invoices by customer |
| Receivables / payables aging | Who owes, who is owed, how late? | The same aging reports as Sales and Purchasing |

The suite `tests/overview.test.ts` proves the dashboard never contradicts the detailed screens:
weekly sums = headline, net sales = management report revenue, receivables/payables = the aging
reports, and the comparison period equals that period's own figures.

## 5. Validation

- Typecheck, lint, dictionary integrity: clean. Unit 137/137 (incl. avatar initials and axis ticks).
- Integration 68/68. End-to-end: see the run recorded in the hand-over message (all suites, incl.
  the new overview suite and the security, session-isolation and profile-access suites).
- Sweep after the changes (270 states): 0 console errors, 0 failed requests, 0 overflow;
  unlabelled inputs 182 → 62 occurrences (48 → 18 screen states) before the last label commit;
  Arabic screens with English UI text 2 → 0. Touch sizing verified on a phone profile
  (coarse pointer: every compact control 44px).
- RBAC: no gate changed except the new `reports.finance` route/page (snapshot diff); the overview
  API refuses anonymous (401) and every role without `reports.finance` (403). The users-list
  redesign calls the same endpoints with the same `can()` checks, self/last-admin protections
  and confirmations; every action is still enforced by the server.

## 6. Remaining gaps → next sprint

1. Localise product names on prep/load item rows (U16) — add the product's names to order items.
2. Labels for the last controls without one (vehicle type, supplier type, HR document type, a
   few notes fields) — visible labels rather than aria-only.
3. Move the remaining hand-built tables to `.data-table` (U17) and give the customer list a
   table with balance and exposure (U20).
4. Per-language dictionary split (U19 / F-14) — the largest remaining payload win.
5. Operations dashboard (reports.view): on-time dispatch, shortage rate, preparation time per
   stage — data exists in the audit trail; not built here to keep this change finance-only.
