# UNITED ERP — Design System & UX Notes

Status: implemented in the working tree (uncommitted), October 2026.
Scope: the web client only. No API, schema, permission or business-rule change was made for this work.

---

## 1. Current-state audit (before)

Measured on the running app (34 screenshots, Arabic + English, desktop 1440×900 and tablet 1024×768) and by reading the components.

| # | Problem | Where | Effect |
|---|---|---|---|
| 1 | Brand green `#2e8b57`-family text at **4.03:1**, amber warning text **3.18:1**, muted text **3.19:1** on white | global tokens | Fails WCAG AA (4.5:1) for body text — muted labels and warnings were the hardest to read on a tablet in a bright hall |
| 2 | One flat top row of every link a role can see (up to ~25 for admin) | `components/Nav.tsx` | Wrapped onto several lines / scrolled sideways; no sense of module; no "where am I" |
| 3 | `window.prompt` / `window.confirm` for 13 business actions (reverse receipt, delete attachment, change role, reconcile ETA UUID…) | 9 components | Unstyled browser chrome, no reason field validation, no RTL, could not be translated, Cancel vs OK order differs by browser |
| 4 | Emoji as status and icons (🔴 🟡 ⏸️ 🚚 🖨️ ⚠️…) inside components *and* dictionary strings | ~60 component lines, 91 dictionary strings | Render differently per OS; colour-only meaning; read aloud as "red circle" by screen readers |
| 5 | Heavy visual weight everywhere: `border-2`, `font-extrabold` on body text, `rounded-2xl` cards | most screens | Nothing stood out because everything shouted |
| 6 | Arabic text leaking into English | `lib/format.ts` (Today/Tomorrow), `lib/orderSummary.ts` (next action, shortage), `lib/liveAlerts.ts` (all floor toasts), `URGENCY_LABEL` | English operators saw Arabic on the cards they use most |
| 7 | Amount cells `dir="ltr"` + `text-end` | finance tables | In Arabic the numbers aligned right while their header aligned left |
| 8 | Physical `left`/`right`/`pl`/`mr`/`border-r` classes | search box, admin matrix, warnings | Search icon on the wrong side in English, sticky column on the wrong side |
| 9 | Tabs were filled pills with no overflow cue; 10 accounting tabs clipped silently | `stock/inventory/shared.tsx` (used by 11 screens), admin | Last tabs undiscoverable on a laptop |
| 10 | No `:focus-visible` style; no tabular figures | global CSS | Keyboard users lost focus; columns of amounts jittered |
| 11 | Bugs found while auditing: pipeline tile showed a raw key (`orders.status.ready-for-loading`); profile read-only notice used a non-existent colour token (`united-warning`) so it rendered unstyled | `PipelineFunnel`, `ProfileView` | Visible defects |
| 12 | "Void receipt" was a full-width red button equal in weight to "Grade" and "Edit" | stock receiving | The rare destructive action competed with the everyday one |

## 2. Reference board

Live sites `carbondesignsystem.com` and `polaris-react.shopify.com` were **blocked by this environment's network policy**, so references were read from the published token packages instead (exact versions, read locally):

| System | Package read | What we took | How we adapted it | What we avoided |
|---|---|---|---|---|
| IBM Carbon | `@carbon/layout@11.62.0`, `@carbon/type@11.70.0` | 2/4/8-based spacing (0.125–6 rem); control heights sm 2 rem / md 2.5 rem / lg 3 rem; dense, hairline data tables | Desk controls at 2.25–2.75 rem; tables with 1px row rules, quiet header band | Carbon's square corners and all-grey palette — too cold for a fresh-produce brand |
| GitHub Primer | `@primer/primitives@11.10.0` | Control sizes 1.5/1.75/2/2.5/3 rem; **coarse-pointer minimum target 2.75 rem (44px)**; 2px (0.125 rem) focus outline | 44px minimum on every floor (tablet) control; one global `:focus-visible` outline | Primer's blue accent — UNITED green carries the brand |
| Shopify Polaris | `@shopify/polaris-tokens@9.4.2` | Body 0.8125–0.875 rem; weights 450/550/650/700; radius 0.25–1.25 rem; tone vocabulary (info / success / warning / critical) | Weights capped at 600/700; radius 0.625–0.75 rem; five tones mapped to document states | Polaris' consumer-commerce softness and illustration-led empty states |

Principles adopted from the board:

1. **Meaning before decoration** — colour only ever repeats something already said in words or an icon shape.
2. **One loud thing per screen** — the primary action and the most urgent item; everything else is quiet.
3. **Density for desks, reach for floors** — finance/admin are dense tables; prep/load/receiving keep 44px targets and large type.
4. **Direction-agnostic layout** — logical properties only; arrows mirror; numbers never reorder.

## 3. Design direction & tokens

Identity: the existing UNITED logo and green family are kept. The logo's "U" mark (`public/brand/united-mark.png`, a crop of the existing logo, not a new drawing) is the app icon in the shell.

### Colour (`tailwind.config.js` → `united.*`)

| Token | Hex | Contrast on white | Use |
|---|---|---|---|
| `dark` (ink) | `#1F3D24` | 11.99:1 | Headings, body text, dark buttons |
| `green` (primary) | `#227C43` | 5.21:1 | Primary button, links, active nav/tab, "done" |
| `light` | `#9FCE5C` | decorative only | Logo accent; never text |
| `bg` | `#F5F7F4` | — | Page background |
| `surface` | `#FFFFFF` | — | Cards, tables |
| `subtle` | `#EEF2ED` | — | Table header band, skeletons, icon wells |
| `border` / `border-strong` | `#DFE5DE` / `#C3CDC2` | decorative | Card and row rules |
| `field` | `#879687` | 3.11:1 | Input borders (WCAG 1.4.11 needs 3:1 for control boundaries) |
| `muted` | `#5B6B5D` | 5.67:1 | Secondary text, labels |
| `warn` | `#B45309` | 5.02:1 (4.44:1 on `subtle` — keep warning text on white/cream) | Waiting, partial, due soon |
| `danger` | `#B42318` | 6.57:1 | Blocked, late, failed, destructive |
| `info` | `#1D5FA0` | 6.57:1 | New / approved, waiting for the normal next step |

Caution bars use `#E2A33B` (a non-text accent, always paired with an icon + words).

### Typography

- **IBM Plex Sans Arabic** (OFL, self-hosted via `@fontsource/ibm-plex-sans-arabic@5.3.0`, weights 400/500/600/700) for both scripts — one family keeps Arabic and Latin on the same x-height and weight, so mixed lines (customer names, order numbers) do not jump.
- Weights: 400 body, 500 labels, 600 emphasis/headings (`font-bold` maps to 600), 700 page titles and key figures.
- `font-variant-numeric: tabular-nums` globally so amount columns and counters do not jitter.

### Shape, elevation, motion

- Radius: controls 0.5 rem, cards 0.625–0.75 rem, pills full.
- Shadows: `card` (1px hairline lift), `card-hover`, `pop` (menus, toasts, dialogs). No glass, no gradients.
- Motion only where it carries state (dialog/toast enter, skeleton pulse, spinner); all disabled under `prefers-reduced-motion`.

## 4. Components

| Component | File | Notes |
|---|---|---|
| App shell | `components/Nav.tsx`, `app/globals.css` | Desk roles (more than 7 links across groups): fixed sidebar grouped by module with icons, breadcrumb "module / page", top bar with language, notifications, user menu. Below 1024px the sidebar becomes a native `<dialog>` drawer. Floor roles (prep/load): a single underlined tab row with 44px targets. The logout confirmation is a `Modal`. Logout logic is unchanged |
| Buttons | `globals.css` | `.btn-primary` / `.btn-secondary` (white + border) / `.btn-danger` (outline) / `.btn-danger-solid` (confirmation step only) / `.btn-ghost`; 44px, `.btn-sm` 36px |
| Fields | `globals.css` | `.field` 1px `field` border, focus ring, `aria-[invalid=true]` style; `.field-label` |
| Dialogs | `components/ui/Dialog.tsx` | `Modal` on native `<dialog>.showModal()`; `useDialogs().confirm/prompt` replace all 13 `window.*` calls. `tone: "danger"` puts initial focus on **Cancel**; `required` prompts cannot submit empty; `inputDir="ltr"` for UUIDs |
| Status | `components/ui/StatusPill.tsx`, `components/StatusBadge.tsx` | Dot + word, five tones; `DOC_STATUS_TONE` maps every document state once. Cancelled orders are struck through, not red |
| Tabs | `components/stock/inventory/shared.tsx` (`Tabs`) | ARIA tabs pattern (`tablist`/`tab`/`aria-selected`, roving tabindex, arrow keys mirrored in RTL, Home/End). Scrolls inside itself, fades the edge that still hides tabs, scrolls the active tab into view. Admin now uses it too |
| Data tables | `.data-table`, `.num` | Quiet header band, hairline rows, `tfoot` totals; `.num` = tabular, aligned to the **page's** inline end even though the cell is `dir="ltr"` |
| States | `components/States.tsx`, `Skeleton.tsx`, `AccessDenied.tsx`, `app/not-found.tsx` | Line icons in a neutral well (existing call sites keep passing their emoji; it is mapped to an icon), `role="status"` loading, `role="alert"` errors |
| Toasts | `components/ui/Toast.tsx` | Icon per kind, `role="status"` live region |
| Order card | `components/OrderCard.tsx` | Inline-start urgency bar (red = blocked/late, amber = soon/waiting/stalled), progress bar with ARIA, next action as the card's call to action with its owner. Still one link to the order |

## 5. Journeys

**Operations floor (prep / load / receiving, tablet).** Order cards read top-down: who → when → progress → what is short → what happens next and who owns it. Section headers carry a dot + count instead of an emoji. Item rows: shortages get a red start edge + icon. Receiving: "Grade" leads, "Edit" second, "Void receipt" is a quiet red text action at the end (it still requires a reason and a confirmation step, and its permission rules are untouched).

**Command center (supervisor).** Pipeline tiles are toggle buttons (`aria-pressed`) with a status dot; the health banner states the verdict, the reason, and the five counts behind it on one line; "Needs your attention now" is a ranked list with an icon + severity bar per reason and the recommended action as an arrow that mirrors in Arabic. Search uses a logical-side icon; quick filters show counts as badges.

**Accounting / purchasing (desk).** Tabs no longer clip silently. Trial balance and VAT summary use `.data-table`: aligned amount columns, totals in `tfoot`, the balanced/unbalanced verdict in colour + words, and the account drill-down is now a real button (keyboard reachable). Supplier aging and statement amounts align with their headers in both languages.

**Admin.** Shared tab bar; logical sticky column in the permission matrix; destructive user actions go through the in-app dialog.

## 6. Bilingual rules (RTL / LTR)

- Use `start/end`, `ps/pe`, `ms/me`, `border-s/e`, `rounded-s/e`, `text-start/end` — never `left/right` utilities.
- Directional icons (arrows) get `rtl:rotate-180`; back links use `ArrowLeft` + rotate.
- Codes, order numbers, plates, UUIDs and amounts are wrapped in `dir="ltr"`; separators (`·`) stay **outside** the LTR span so they sit next to the right word in Arabic.
- Amount cells: `dir="ltr"` + `.num` (aligned by page direction).
- Every new visible string is a dictionary key with `ar` and `en` (`scripts/check-dict-integrity.py`).
- Helpers that produce text take a `locale` argument (`friendlyDate`, `deliverySlot`, `nextAction`, `shortageSummary`) — Arabic stays the default so existing server-side callers are unchanged.

## 6a. Second pass (screens re-inspected)

Evidence came from 28 additional screenshots (HR, ledger, management, inventory, operations, approvals, daily report, ETA, profile — Arabic and English, desktop and tablet) and a scripted scan of 25 routes × 2 languages (every tab clicked) for text that is a raw dictionary key.

| Found | Change |
|---|---|
| Pages sat in different containers (`max-w-2xl/3xl/4xl/5xl mx-auto`), so narrow pages floated in the middle of the content area, out of line with the breadcrumb | Three containers: `.page-container` (desk, full width), `.page-narrow` (reading width), `.page-floor` (tablet boards). With the sidebar present all three align to the inline start; without it (floor roles) they centre |
| Page titles built ad hoc (`text-2xl font-extrabold`, back links, live badges each placed differently) | `components/ui/PageHeader.tsx`: back link, one h1, one-line purpose, actions at the inline end |
| Second-level filters rendered as a second row of identical underlined tabs (9 places) or as two half-width green buttons (Approvals) | `components/ui/Segmented.tsx`: a compact, visually subordinate switch with optional counts/badges |
| Toggles beside search boxes ("Low stock", "Inactive", "Include voided", receiving choices) each styled differently, state shown only by colour | `.chip` + `aria-pressed`: outlined off, filled on; the look is driven by the ARIA state |
| Management report: unlabelled date inputs, report switch drawn as buttons, figures coloured green for no reason, plain table | Labelled period, switch as a segmented nav with `aria-current`, colour only for wrong-way figures (red), `.data-table` with totals in `tfoot` |
| Daily report: emoji stage dots, a fifth KPI tile alone on a row, Arabic stage names in English, "2orders" | Dots from `ORDER_DOT`, five tiles in one row, localized stage names, spacing fixed |
| Ledger: one chip per product in a sideways strip (grows with the catalogue) | One labelled product picker |
| Audit log, order timeline, stock ledger: emoji event icons | `components/ui/EventIcon.tsx` maps each symbol to a line icon (library data unchanged, so print/server code is untouched) |
| Audit log: filter chips showed raw keys (`audit.filter.all`…), every non-order row said "updated the order", unlabelled dates | Keys added; non-order rows say what entity and what happened; labelled dates |
| Command center quick filters showed raw keys (`supervisor.quick.*`) | Keys added |
| **Prep/load item rows showed raw keys for Required / Prepared / Loaded / Left** | Keys added |
| "Management reports" switch linked to `/management/finance`, which does not exist | Links to `/management` |
| Profile read-only notice and several emoji in sales/purchasing/dispatch | Icons (`Landmark`, `Star`, `Snowflake`) with labels; plain words inside `<option>` |

Guard added: `tests/unit/ui-dictionary-keys.test.ts` fails when a component refers (in any form) to a dictionary key that does not exist — verified by planting a missing key and seeing it fail.

## 7. Remaining UX debt

- `lib/auditLabels.ts` / `lib/stockPresentation.ts` still store emoji as event symbols (rendered as icons on screen via `EventIcon`; the printed delivery document still prints them).
- The ★ default marker in price lists is a text star.
- Admin settings rows and the profile permission list show technical codes (e.g. `inventory.expiry_warning_days`) next to their labels — intentional for administrators, but the settings labels themselves are still Arabic-only.
- Required-field markers and inline validation are in place on the HR forms only; other forms still validate on submit.
- Integrity-check names on the accounting health tab come from the server in Arabic only.
- Operational settings labels are Arabic-only.
- Native date inputs follow the browser's locale format, not the app language.
- Many desk screens still use the older inline `font-extrabold` / `font-bold` spans inside cards; they now render at 600/700 via the weight remap, but have not been individually re-laid-out (cash flow, management reports, HR, sales invoices, ETA).
- Remaining hand-built `<table>`s (sales invoices, price lists, inventory, management, admin import) are not yet on `.data-table`.
- Trial balance shows credit balances in a red tint; accounting convention would keep them neutral (left unchanged pending the accounting office's view).

## 8. HR & Payroll UI roadmap (PROPOSED — not implemented)

Companion to `docs/erp/HR_PAYROLL_GAP_AUDIT.md` (schema §3, lifecycles §4, permissions §6, phases §9). Screens are listed in the phase that makes them possible. All of them use the components above: `PageHeader`, `Tabs`, `Segmented`, `.data-table`/`.num`, `StatusPill`, `Modal`/`useDialogs`, the `.page-*` containers, and the bilingual rules in §6.

### 8.1 Screens and journeys

| Phase | Screen | Primary user | Journey (what the user must be able to understand and do) |
|---|---|---|---|
| 1 | **Employee directory** (`/hr` → Employees, exists today) | HR, accounting | find a person, see status and department; salary and private columns appear only with the permission |
| 1 | **Employee profile** (`/hr/employees/:id`, new) | HR | tabs: Overview · Employment history (timeline of effective-dated rows) · Personal & bank (masked; "Reveal" is audited) · Documents (expiry badges) · Compensation · Leave · Attendance · Advances & statement · Payslips |
| 1 | **Departments & organisation** (exists; adds manager and a simple tree) | HR | who reports to whom; close a department only when empty |
| 2 | **Attendance register** (`/hr/attendance`) | HR / supervisor (tablet) | a month grid of employees × days with one status letter per cell; bulk entry for a day ("all present except…"); a cell opens a small form; draft / confirmed / locked shown per cell; filter by department; quick totals per employee (absences, OT minutes by class) |
| 2 | **Attendance corrections** | HR, approver | the request shows before → after for each field, the reason, and the payroll effect ("will adjust payroll of Nov 2026" when the day is locked) |
| 3 | **Leave** — requests, balances, approvals | employees (via HR), managers, HR | a balance card per leave type (ledger drill-down); request form shows the computed days and resulting balance before submit; approvers see team overlap for the same dates |
| 4 | **Compensation** (profile tab + change request) | HR, approver | current package as a component table; history as a dated list; a change shows old → new per component and the effective date, and goes to approval |
| 4 | **Statutory rules** (`/hr/settings/statutory`) | accountant | each rule set shows period, parameters, source reference and verification status; "Verify" needs a second person; unverified sets carry a warning pill |
| 5 | **Payroll workspace** (`/hr/payroll/:period`) | payroll preparer | the header shows the period, the run state (stepper: Draft → Calculated → Pending approval → Approved → Posted → Paid) and the totals; an **exceptions panel** first (errors block submit, warnings need acknowledgement); then the payslip table (employee, gross, deductions, recovery, net, status) with a row drill-down to lines and their explanations; actions limited to what the state and permission allow |
| 5 | **Approval review** | approver | the totals, the variance against the previous month per employee (sorted by absolute change), the exceptions acknowledged by the preparer, the calculation hash and who prepared it; Approve / Return (reason required); Approve is disabled with an explanation when the viewer prepared or submitted the run |
| 6 | **Posting review** | accounting | journal preview (accounts, debits, credits, parties) and posting date before "Post"; a closed period is explained instead of failing |
| 6 | **Payments** | accounting | pay all / pay selected / pay partially; the remaining amount per payslip is always visible; bank-file export; payment reversal with reason |
| 6 | **Employee payslip** (screen + bilingual print) | HR, employee (Phase 7) | earnings, deductions, recoveries, net entitlement, paid so far, remaining; Arabic and English print layouts using the existing print stylesheet |
| 7 | **Payroll reports & reconciliation** | accounting, owner | register by period and department; SI and tax schedules (formats per statutory decision S18); reconciliation panel mirroring the integrity checks (payroll ↔ GL per employee) |

### 8.2 UX conventions specific to HR & payroll

- **Confidential by default.** The API omits fields the viewer may not see, and the UI never shows an empty column in their place. Masked values (`•••• 1234`) offer "Reveal" only to permitted users; the reveal is audited and the value hides again on navigation.
- **No salary in notifications, toasts, tab titles or approval summaries.**
- **State is always visible.** Every run, request and payslip carries a `StatusPill`. Actions not allowed in the current state are hidden, not left as disabled buttons. A disabled action appears only when the viewer could act but something blocks it (e.g. self-approval), with the reason next to it.
- **Money:** EGP amounts use `.num` (tabular, aligned to the page's end); negative values carry a minus sign and words where they matter ("Owed to employee"); totals sit in `tfoot`.
- **Explain every computed figure.** A payslip line shows its quantity × rate (or the rule-set name and version) on hover/expand, in the user's language.
- **Irreversible steps** (Submit, Approve, Post, Pay, Reverse) use `Modal` with a summary of the consequence ("This posts 1 journal entry of EGP 214,500.00 dated 30/11/2026 to the ledger") and the focus on the safe action.
- **Tablet attendance entry** keeps 44px targets, a sticky employee column, and works one day at a time in portrait.
- **Dates:** periods appear as month names in the user's language plus the ISO code (`نوفمبر 2026 · 2026-11`); dates in tables are ISO in `dir="ltr"` spans, consistent with the rest of the product.
