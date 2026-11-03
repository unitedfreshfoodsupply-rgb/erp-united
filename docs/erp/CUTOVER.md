# Cutover from Odoo — what must be verified

> **Opening balances: superseded (3 November 2026).** Customer, supplier, stock and GL opening balances go through one opening batch that a second person approves, not through the CSV import or a manual journal described below (the direct path is off by default and closes once the batch posts). See `OPENING_BALANCES_READINESS_2026-11.md` for the method, the template and the workflow.

*2026-10-09. Data-integrity and cutover readiness audit. CSV/XLSX import tooling is
available for core masters, dated prices, opening balances and opening stock. Direct
Odoo workbook mapping, full product configuration import, and reconciliation on the
company's real export are not yet verified. This document says what the cutover
must set up, prove and decide, with the exact check for each item. The cutover is
**go** only when every check in section 5 passes.*

## 1. What a fresh production database already contains (audited)

A database built from the migrations alone (42 migrations in this checkout), with no seed (the state of production
after `prisma migrate deploy`), was inspected:

| Already present (from migrations) | Missing — must be set up at cutover |
|---|---|
| 1 company shell, 1 branch, 1 warehouse (`wh_main`) | Company legal name, **tax registration number**, address |
| Locations COLD-1, COLD-2 (cold rooms), RECV (receiving), DISP (dispatch) | A quarantine location, only if management chooses it |
| 12 units; EGP is the only permitted ledger and business-document currency | Confirm company base currency is EGP; imported USD/EUR transactions must be reconciled or excluded before cutover |
| Tax classes EXEMPT (T1/V003), VAT14 (T1/V009), VAT0 (T1/V001) | The accountant's confirmation of these classes |
| Chart of accounts (27 accounts), cash accounts `cash_main`, `bank_main` | Any additional bank accounts (sub-accounts) |
| — | **Permissions:** `npm run db:sync-permissions` (63 permissions, role bundles) |
| — | **One active default price list** (sales pricing needs it) |
| — | Users: production keeps its **existing** users; at least one active SUPER_ADMIN |
| — | Accounting periods: created automatically on first posting |

**Never run the demo seed on production.** It creates test accounts with password `1234`.
The seed refuses a Supabase database unless `ALLOW_DEMO_SEED=1`; never set it.

There is no first-administrator bootstrap for an *empty* database. Production already
has users, so this does not block the cutover, but a brand-new environment would need one
created by hand.

## 2. Cut-off rules (decide before the cutover day)

1. **Cut-off date and time.** The last document in Odoo and the first in UNITED. Opening
   balances are dated the cut-off day.
2. **Goods received but not billed in Odoo** (Odoo's GRNI): settle them in Odoo before the
   cut-off, or carry them as the supplier's opening balance. Never both. GRNI (2150) is a
   control account; manual journals cannot touch it.
3. **Open sales orders** not yet dispatched: re-enter them in UNITED. Do not migrate them
   as documents.
4. **Open purchase orders** not yet received: re-create them in UNITED (with their prices)
   so receipts are costed from the PO.
5. **Customer and supplier balances:** one opening balance per party per open Odoo
   document (with its original due date) if aging detail matters; otherwise one per party.
   The posting date stays on the cut-off day while an item's due date may be earlier.
   Receipts and payments after cutover can be allocated to these imported open items so
   the aging buckets follow their remaining balance.
6. **Stock:** one opening-stock line per product and lot (quantity, unit cost, expiry,
   location), from a physical count on cut-off day, valued at Odoo's cost.
7. **Cash, bank and capital:** one manual journal on the cut-off day. Receivables,
   payables, inventory and GRNI are refused in manual journals by design.
8. **ETA:** invoices issued in UNITED after the cut-off are submitted to ETA through the
   ETA portal (or Odoo) until UNITED's ETA integration is production-verified.
9. **Tax timing:** the current internal summary follows invoice/bill dates and posted
   documents. Cash-basis tax adjustments are not implemented; the accountant must
   confirm the basis required for UNITED's filings.
10. **Purchase-price differences:** stock receipts use PO cost and bill differences post
    to PPV (5300); they do not revalue individual lots. The accountant must approve this
    inventory valuation policy before cutover.

## 3. Master data to load (before opening balances)

| Data | Where | Integrity rule to respect |
|---|---|---|
| Customers | Admin → تحميل بيانات البداية (CSV/XLSX) or `/sales` | Upload supports identity/contact, external reference, payment terms, credit limit/hold and price-list code. Credit and price-list fields require finance/pricing permissions and reason fields. Codes unique and immutable; B2B customers need their 9-digit tax registration number. |
| Suppliers | Admin → تحميل بيانات البداية (CSV/XLSX) or `/purchasing` | Payment terms per supplier |
| Products | Admin → تحميل بيانات البداية (CSV/XLSX) or `/stock/setup` | Upload loads identity, SKU, category, base unit, stock tracking and tax class. Use product-settings for costing (finance permission), shelf life, cold-chain, FEFO/FIFO and stock levels. |
| Packaging | Admin → تحميل بيانات البداية → وحدات تعبئة الأصناف (CSV/XLSX), or per product | Crate/carton weights are imported or configured per product, never globally. |
| Price list | `/sales` then Admin → تحميل بيانات البداية (CSV/XLSX) | Create list and assign it to customers first; exactly one active default |
| Opening balances and stock | Admin → تحميل بيانات البداية (CSV/XLSX) or accounting/inventory screens | Preview rejects invalid rows; opening stock posts as one document. Reconcile totals and individual parties/lots before go-live. |
| Users | `/admin` | One role each; disable, never delete |

## 4. Verification checks (exact)

### 4.1 Database and deployment

```sql
-- every migration applied, none rolled back
SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;  -- 42 (every migration directory in prisma/migrations)
-- permissions synced
SELECT count(*) FROM "Permission";                                   -- 63
-- an administrator exists
SELECT count(*) FROM "User" WHERE role = 'SUPER_ADMIN' AND active;   -- ≥ 1
-- company identity
SELECT "legalName", "taxRegistrationNumber" FROM "Company" WHERE active;  -- 9-digit number present
-- exactly one default price list
SELECT count(*) FROM "PriceList" WHERE "isDefault" AND active;        -- 1
```

- `npx prisma migrate status` reports up to date.
- `GET /api/health` returns `{"status":"ok"}`.
- **No demo account:** signing in as each of `admin, sara, hossam, ahmed, mostafa, mona,
  karim, omar` with password `1234` must fail (401). Production passwords are at least
  8 characters.

### 4.2 Before opening balances (empty books)

- `/accounting` → سلامة الحسابات: every check ok.
- Trial balance: zero.
- `restore-check fingerprint`: zero stock, zero AR/AP.

### 4.3 After opening balances and opening stock

| Check | Must equal |
|---|---|
| Each customer's statement closing balance | Odoo's balance for that customer |
| AR aging total, and GL 1300 | Odoo receivables total |
| Each supplier's statement | Odoo's balance for that supplier |
| AP aging total, and GL 2100 | Odoo payables total |
| Each product's on-hand quantity (`/stock/inventory`) | The cut-off physical count |
| Valuation report total, and GL 1400 | Odoo inventory value at cut-off |
| GL 1100 / 1200 | Odoo cash / bank at cut-off |
| Trial balance | Balanced, and equal to Odoo's trial balance at cut-off (account by account, after mapping) |
| Accounts Health | Every check ok: nothing unposted, no orphan entries, AR/AP/inventory = GL per party |
| Inventory Health (`restore-check fingerprint`) | 0 mismatches, 0 negative balances |

### 4.4 First live day (smoke test with real documents)

1. Receive one real delivery against a PO:
   - stock up;
   - GL Dr 1400 / Cr 2150 at the PO cost;
   - PO progress updated.
2. Run one order through preparation, loading, dispatch and invoice:
   - COGS posted at dispatch;
   - invoice journal Dr 1300 / Cr 4100 (/ Cr 2200 for VAT lines).
3. Record one customer receipt and one supplier payment: statements and aging update.
4. Print one invoice (Arabic and English): figures equal the invoice.
5. Accounts Health and Inventory Health still ok at end of day.

### 4.5 Backup

- The first production backup has been taken (`pg_dump`), and point-in-time recovery is
  enabled.
- **One restore drill against a production backup**, performed with `BACKUP_RESTORE.md`
  into a separate database or Supabase branch:
  - `db-compare` shows 0 differing;
  - the fingerprints are identical;
  - both healths are ok.

## 5. Go / no-go

**Go** only if all of these hold:
- Every check in 4.1–4.3 passes.
- The production restore drill (4.5) passes.
- The accountant has signed the decisions in section 2 and the opening trial balance.
- Odoo has been set read-only for the migrated scope after cut-off.

**No-go (stay on Odoo, investigate)** if any of these happen:
- Any Accounts Health check fails.
- Any party's statement differs from Odoo.
- Stock on hand differs from the count.
- The opening trial balance differs from Odoo's.
