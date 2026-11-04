# Customer and supplier master data: one source of truth (November 2026)

Branch `feature/eta-customer-master-data`, based on `main` at `04be32a`. Local only: not pushed, not deployed, no production write. One new migration (`20261104100000_supplier_category`) is written and tested locally; it is **not** applied to production.

## 1. Short answer

- **Parties are read live, by id.** Customers and suppliers are referenced by id. Screens join the master record at read time, so an edit reaches them at once. There is no server-side cache of party data.
- **The e-invoice (ETA) receiver was the exception, and the cause of the re-entry.** It is fixed: the receiver comes from the customer's legal entity, is edited only in the customer record, and the ETA screen is read-only (§4, §6.1).
- **Every remaining copy is classified (§2) and handled (§3).** Legal snapshots stay frozen. The order's stored customer name is now an operational snapshot: open-order screens read the customer card, and the name is frozen at dispatch for the documents that leave with the truck.
- **Suppliers have one editor and a structured category.** One service edits every supplier field, with the permission rule inside it. The vegetable/fruit category is a closed attribute, backfilled for the 83 imported suppliers from the import files' provenance, never from names (§6.2).

## 2. Field ownership and every copy

**Canonical owners:**
- **Customer card** (`Customer`): code, display names, legal names, tax number, contact, credit, price list, active.
- **Customer legal entity** (`CustomerLegalEntity`, linked by `Customer.legalEntityId`): the legal and tax identity, the structured tax address and the ETA receiver type/id. One legal entity can serve several branches of the same company.
- **Supplier** (`Supplier`): every supplier attribute, including the category.

Legend:
- **Live**: read through the id when shown.
- **Operational snapshot**: written by a business event, read by the documents of that event, and never edited by hand.
- **Cache**: a derived value that is re-computed at defined points.
- **Legal snapshot**: frozen when the document is issued or posted, by law or for audit; database triggers enforce it where noted.
- **Retired**: no longer written.

| Field(s) | Owner | Other places stored | Classification of each copy |
|---|---|---|---|
| Customer name, Arabic name | Customer | `Order.customerName`; `CustomerAlias` canonical rows | **Order: operational snapshot.** For an unmapped order it is the intake text, the only name there is. For a mapped order it is the card's name (Arabic first), written at mapping and frozen again at dispatch. Every open-order screen reads the card live (§3). Documents of a dispatched or cancelled order read the stored name. **Alias: maintained index**, re-claimed in the same transaction on rename |
| Customer legal name, tax number | Customer card, or its active legal entity | `SalesInvoice.buyerName`, `buyerTaxId` | **Legal snapshot** at issue (trigger `sales_invoice_frozen`) |
| Customer free-text address | Customer card / legal entity | `SalesInvoice.buyerAddress` | **Legal snapshot** at issue |
| ETA receiver type, personal id, structured address | **Legal entity** | `EtaReceiverProfile` (per customer) | **Retired**: read only as a fallback for a customer with no active legal entity, never written. Production holds 0 rows |
| Same, as sent to ETA | Legal entity at signing time | `EtaDocument.signedPayload`, `EtaDocumentEvent.detail` | **Legal snapshot** per submission; the events table is append-only |
| Payment terms | Customer | `SalesInvoice.dueDate` | **Legal snapshot** at issue (issue date + terms). The invoice print now derives the printed terms from it (§3) |
| Credit limit, hold | Customer | `Order.creditStatus/creditNote` | **Cache**: re-evaluated at each order gate and edit, not when credit terms change (decision M-3) |
| Price list | Customer | `OrderItemPrice.priceListId/unitPrice` | **Operational snapshot**: the commercial price at pricing time |
| Supplier names, contact, tax, address, category | Supplier | none (POs, bills, payments, debit notes, refunds, intakes, requests and RFQs hold only `supplierId`) | — |
| Supplier payment terms, currency | Supplier | `PurchaseOrder.paymentTermsDays/currencyCode`; `SupplierBill.dueDate`; `SupplierPrice.currencyCode` | **Operational snapshots** of each document. The bill due date follows the live supplier terms while the bill is a draft, then is frozen at posting (**legal snapshot**) |
| Party name in ledger narrative | Customer / Supplier | `JournalEntry.description` | **Legal snapshot** (append-only ledger trigger) |
| Party name in approvals, notifications, audit | Customer / Supplier | `ApprovalRequest.title/summary`, `Notification.*`, `AuditLog.old/newValue`, `InventoryDocument.reason`, `OperationalException.description` | **Historical text** of an event, kept as recorded |
| Who signed for a delivery | Delivery | `TripStop.receiverName` | **Delivery fact**, not master data |
| Party identity in the ledger | Customer / Supplier / Employee | `JournalLine.partyType/partyId`, `PartyOpeningBalance.partyId`, `OpeningBatchLine.data.party_id` | **Id reference**: polymorphic, without a database foreign key. Checked by the integrity report (`party_references`, §6.4) |

A structural test (`tests/integration/master-data-propagation.test.ts`) lists every column in the schema named like a party attribute. It fails if a new one appears outside the reviewed set: `Order.customerName`, `SalesInvoice.buyerName/buyerTaxId/buyerAddress`, `TripStop.receiverName`.

## 3. Screens and modules: current data or history

**Current views: read the master record live, in the reader's language.**

| Screen / service | Before | Now |
|---|---|---|
| Picking sheet (`lib/picking-sheet.ts`) | Stored order name | Customer card (Arabic first; both names sent for the reader) |
| Trips: plannable orders, stops, delivery screen (`lib/operations/trips.ts`, `OperationsView`) | Stored order name | Customer card |
| Stock-issue exceptions (`lib/inventory/dispatch.ts`), operational exceptions (`lib/operations/exceptions.ts`) | Stored order name | Customer card |
| Delayed-orders report (`lib/reports/definitions.ts`) | Stored order name, one column | Customer card, as an Arabic/English column pair (the screen shows the reader's; exports carry both) |
| Live order alerts (`lib/liveAlerts.ts`) | Stored order name | Customer card in the UI language. The toast is built when it is shown and never stored, so it is a current view |
| Order screens, supervisor board, invoicing queue, profiles | Already live-first (`orderCustomerName`) | Unchanged |

**Documents: current while the order is open, history once it has left.**

| Document | Rule |
|---|---|
| Picking, dispatch and delivery prints (`app/orders/[orderId]/print/*`) | An open order prints the customer card as it is now, in the print's language. A dispatched or cancelled order prints the name stored on the order. Dispatch freezes that name to the card's name at that moment, with an audit row, so a reprint matches the copy that left with the truck (`orderDocumentCustomerName`) |
| Invoice print: payment-terms label (`lib/sales/invoiceDocument.ts`) | An issued invoice prints the terms it was issued with (due date − issue date), never the customer's terms of today. A draft prints the current terms, which issue will apply |
| Issued invoice, ETA document | Legal snapshot, shown as stored |

**History: kept as recorded.**

The audit view, cancelled-documents report, GL and cash-movement narratives, price-exceptions report, approval and notification text, and exception descriptions all record what was true at the event.

## 4. Root cause of the ETA re-entry

1. **The data lived in two places.** The ETA receiver lived on the customer's legal entity (`CustomerLegalEntity`: structured address, receiver type and id) and also in a separate ETA-module table (`EtaReceiverProfile`).
2. **The ETA screen only knew its own copy.** Its Setup tab (`EtaView.ReceiverRow`) read and wrote only `EtaReceiverProfile`. Nothing filled it from the customer record, so every invoiced customer appeared empty and marked ✗, and the user was asked to type the data again.
3. **For linked customers, that typing changed nothing.** For a customer with a legal entity, the payload used the legal entity and ignored what was typed (`loadEtaSource`). It even used an **inactive** legal entity, unlike invoice issue.
4. **The customer record had no editor for these fields.** The legal entity's structured address had no editing screen, only an API.
5. **The wrong people held the permission.** The accountant who sees the ETA gaps holds `accounting.eta.manage` but not `sales.customers.manage`, so the ETA copy was their only way in.
6. **History was not stable.** After submission, the ETA screen rebuilt the document from current data, so an accepted invoice could show a different receiver.

## 5. Architecture

- **One owner per attribute.**
  - The customer card holds commercial identity and contact.
  - Its legal entity holds legal and tax identity, including everything ETA needs.
  - The supplier record holds all supplier data.
  - No module keeps an editable copy.
- **Reference by id everywhere.** Display through live joins. Names are never used as keys; the only name matching is the intake integration's alias table, which resolves to an id.
- **Three states for documents:**
  - *Current master*: always live.
  - *Draft or open*: built from the current master each time it is shown or recalculated. The ETA draft is rebuilt on every view until signing. An open order's documents show the current card.
  - *Issued, posted or dispatched*: a snapshot frozen at that event. The invoice buyer is frozen at issue, by trigger. The ETA document is the signed payload, shown as stored. The order's customer name is frozen at dispatch.
- **Edits in the owner's screen only, under the owner's permission, audited field by field.** Other modules show what is missing and link to the owner's screen.
- **Server-side enforcement.** Every master-data service asserts its permission itself, whatever route reaches it.

## 6. Implementation on this branch

### 6.1 ETA receiver from the customer record (commit `3d56cf9`, no migration)

| Change | Files |
|---|---|
| One pure rule for the ETA receiver: active legal entity → retired profile (fallback only) → none, with field-by-field gaps | `lib/eta/receiver.ts` (new) |
| The ETA payload, setup list and invoice state use the rule. An inactive legal entity is no longer used. A signed document is shown as stored. Receiver errors link to the customer record. Writing a receiver profile is refused (409 `eta.receiver-profile-retired`, with the edit link) | `lib/eta/service.ts` |
| Customer e-invoice identity: read with `sales.customers.view` or `accounting.eta.view`; create-and-link a legal entity from the card in one audited transaction with `sales.customers.manage`. Editing an existing legal entity uses the existing versioned, field-audited API | `lib/sales/customers.ts`, `app/api/sales/customers/[id]/eta-identity/route.ts` (new) |
| Customer page: "Tax and e-invoice identity" card, showing the canonical receiver and the missing fields; edit/create only with `sales.customers.manage` | `components/profiles/EtaIdentityCard.tsx` (new), `CustomerProfile.tsx` |
| ETA setup screen: the receiver list is read-only from the customer record, with gaps and a link (or a note when the user lacks the customer permission) | `components/accounting/EtaView.tsx` |

`EtaReceiverProfile` is kept; it was neither dropped nor migrated. Production has 0 rows. Dropping it needs a reviewed migration (**decision M-4**).

### 6.2 Suppliers: one editor, a structured category (M-5, M-6)

| Change | Files |
|---|---|
| `Supplier.category`: nullable, `vegetable` or `fruit`, database CHECK `Supplier_category_known`, indexed. NULL means not classified yet | `prisma/schema.prisma`, `prisma/migrations/20261104100000_supplier_category/` |
| Backfill of the 83 suppliers imported on 1 Nov 2026, from the import files' own provenance: SUP-00001–00039 fruit (39), SUP-00040–00083 vegetables (44). Each row is matched by internal id **and** code, only where no category is set, so on any other database nothing changes. Nothing is inferred from names. Verified on a copy of production: 39 + 44, none misplaced (production list fingerprint `9add9330e8d35799403874970e56481a`) | same migration |
| **One supplier editor**, `updateSupplierMaster`, used by the supplier profile, the purchasing route and the stock route alike. The rule lives in the service:<br>• name, phone, notes and active need `purchasing.suppliers.manage` or `stock.manage_suppliers`<br>• every other field (category, type, Arabic name, tax data, contact, terms, lead time, currency) needs `purchasing.suppliers.manage`<br>• a request touching any field the actor may not edit is refused whole (403)<br>Each save is versioned (409 on a stale version) and audits each changed field: `supplier_updated` for identity fields, `supplier_terms_changed` for the rest. Today's rights are unchanged | `lib/purchasing/suppliers.ts`, `lib/stock-service.ts`, `app/api/purchasing/suppliers/[id]/route.ts` (PATCH: either permission; the service decides the fields) |
| Supplier profile: one edit form for the whole record. Fields the user may not edit are shown disabled with a note, and are never sent. Category in the profile facts, the list (column and filter, including "unclassified") and the create form | `components/purchasing/PurchasingView.tsx` |
| **D-1:**<br>• a supplier created through purchasing or the data import must be classified (vegetable or fruit); the import has a required `category` column<br>• only the stock gate's quick add creates an unclassified supplier, with a warning saying purchasing must classify it<br>• the unclassified are shown in a banner on the supplier list (with a filter), a callout on the profile and a tag in the stock list<br>• classifying needs `purchasing.suppliers.manage`<br>• a classified supplier cannot be made unclassified again<br>Unclassified suppliers fall in no category: the list's category filter and the opening-balance reconciliation take only `vegetable` or `fruit`. No other report or workflow uses the category yet | `lib/purchasing/suppliers.ts`, `app/api/admin/data-import/route.ts`, `components/purchasing/PurchasingView.tsx`, `components/stock/master/SuppliersPanel.tsx` |
| **D-2:** STOCK_CONTROLLER gains `purchasing.suppliers.view`: the supplier directory and profile (identity, contacts, terms, receipts, history), read-only. Money stays behind `purchasing.bills.view`, `purchasing.prices.view` and `stock.valuation.view`, which the role does not hold. Its existing stock permission still edits name, phone, notes and active, as before | `lib/permissions.ts` (synced by `db:sync-permissions`) |
| Stock setup panel: quick add and activate/deactivate stay. Each name links to the supplier's profile for users who can open it | `components/stock/master/SuppliersPanel.tsx` |
| List filter `?category=vegetable\|fruit\|none`; an unknown value filters nothing | `lib/purchasing/suppliers.ts`, `app/api/purchasing/suppliers/route.ts` |

### 6.3 Orders: current customer, frozen at dispatch (M-1); invoice print terms (M-2)

| Change | Files |
|---|---|
| Two name rules:<br>• `storedOrderCustomerName`: the card's Arabic name, else its name; used at mapping and at dispatch<br>• `orderDocumentCustomerName`: the live card for an open order, the stored name once dispatched or cancelled | `lib/locale/names.ts` |
| Dispatch freezes `Order.customerName` to the card's current name in the dispatch transaction, with an `order_edited` audit row (old → new). Trips dispatch through the same path. Unmapped orders are not touched | `lib/orders-service.ts` |
| Picking sheet, trips, exception queues, delayed-orders report and live alerts read the card (table in §3) | `lib/picking-sheet.ts`, `lib/operations/trips.ts`, `lib/inventory/dispatch.ts`, `lib/operations/exceptions.ts`, `lib/reports/definitions.ts`, `lib/liveAlerts.ts`, `components/production/PickingSheet.tsx`, `components/operations/OperationsView.tsx`, `components/stock/inventory/InventoryView.tsx` |
| Order prints use `orderDocumentCustomerName` | `app/orders/[orderId]/print/{picking,dispatch,delivery}/page.tsx` |
| Invoice print terms from the frozen due date | `lib/sales/invoiceDocument.ts` |

### 6.4 Party references (M-7)

The polymorphic party ids are kept. The integrity report gains a read-only check, `party_references` (`danglingPartyReferences`). Every `JournalLine` and `PartyOpeningBalance` party id must point to an existing customer, supplier or employee, and an unknown party type is listed too. On opening balances the database already refuses an unknown party type (CHECK `PartyOpeningBalance_values`).

**Correction to the previous revision:** it said the integrity report "covers orphans". No such check existed until this change.

### 6.5 Strings and access documents

- Arabic and English labels for the category, the editor note and the new integrity check.
- English entries for the new server message.
- RBAC snapshot regenerated: the supplier PATCH route now accepts either permission, while the service still limits what each permission may change.

Files: `lib/locale/dictionary.ts`, `lib/locale/server-messages.data.ts`, `docs/erp/RBAC_MATRIX.md`, `docs/erp/rbac-snapshot.json`.

## 7. Tests (local test databases, synthetic data; nothing sent to ETA, nothing written to production)

| Suite | Result |
|---|---|
| `tests/unit/eta-receiver.test.ts`: precedence, inactive legal entity, legacy fallback, tax number rule, gaps for B/P/F, payload mapping | 9/9 |
| `tests/unit/supplier-category-migration.test.ts` (new): exactly 39 fruit (SUP-00001–39) and 44 vegetable (SUP-00040–83) rows, 83 distinct ids and codes, guarded by `category IS NULL` and matched on id and code, a CHECK on the two values, no other write, no name matching | 3/3 |
| `tests/unit/invoice-document.test.ts`: an issued invoice prints its issue-time terms after the customer's terms change (Arabic and English); a draft prints the current terms | 6/6 |
| `tests/integration/master-data-canonical.test.ts`: ETA receiver from the customer record, RBAC, create-and-link, signed documents unchanged, issued invoices frozen by trigger | 7/7 |
| `tests/integration/master-data-propagation.test.ts`: customer and supplier renames reach current views, never issued invoices; structural check of party-attribute columns | 3/3 |
| `tests/integration/supplier-master.test.ts` (new):<br>• category set, edited, cleared and filtered<br>• an unknown value is refused by the service (Arabic message with its English translation) and by the database CHECK<br>• stock may edit identity fields only, through either entry point; a mixed request is refused whole<br>• a viewer is refused<br>• purchasing edits the whole record<br>• a stale version is refused with nothing written<br>• one audit row per changed field, under the right action<br>• earlier audit rows unchanged by a rename | 3/3 |
| `tests/integration/order-customer-name.test.ts` (new):<br>• after a customer rename, every current view shows the new card name in Arabic and English (picking sheet, trip planning, both exception queues, the delayed-orders report)<br>• an unmapped order keeps its intake text<br>• documents follow the open/dispatched rule<br>• the rename writes nothing to any order<br>• the `party_references` check is present and clean, and finds a dangling id (in a rolled-back transaction) | 2/2 |
| `tests/picking-sheet.test.ts` (end to end, extended):<br>• a rename reaches the sheet<br>• dispatch freezes the name, audited old → new<br>• a rename after dispatch does not reach the delivery-note reprint<br>• an open order's delivery note shows the current name in Arabic and English | see §7.1 |
| Whole unit suite | 230/230 |
| Whole integration suite, on a freshly migrated and seeded test database | 179/179 |
| Typecheck, lint | clean |

### 7.1 End to end and browser (feature build, local server, fresh test database)

The test database was built from the migrations (96, including the category migration), seeded, and reset with `tests/reset-db.ts`. The reset turns off the MFA requirement on the test database only.

| Suite | Result |
|---|---|
| Picking sheet (with the rename, freeze and delivery-note checks above) | 39/39 |
| Purchasing (the supplier master through the HTTP routes: the stock controller is refused commercial terms, a stale version gets 409) | 126/126 |
| Stock (the stock supplier routes through the one editor) | 153/153 |
| Product master (the stock supplier panel) | 123/123 |
| Orders | 186/186 |
| Sales | 199/199 |
| Connected flows | 69/69 |
| E-invoicing (ETA) | 35/35 |
| Customer groups and legal entities | 47/47 |
| Report access | 100/100 |
| Security (every handler × every role, against the regenerated RBAC snapshot) | 70/70 |

Run order matters: the orders suite expects a freshly reset database, and the ETA suite needs an invoice issued by the suites before it, as in the standard `test:e2e` chain.

**Not done: the visual browser check of the new supplier form.** Signing the browser in needs a session credential for a seeded user, and this session may not handle one. The form's behaviour is covered by the purchasing, stock and product-master suites and the integration tests above. Its Arabic/English layout has not been looked at.

## 8. Decisions

| # | Decision | Status |
|---|---|---|
| M-1 | Order customer name on open-order screens and documents | **Done** (§6.3) |
| M-2 | Invoice print terms beside the frozen due date | **Done** (§6.3) |
| M-3 | Credit status of open orders after a credit-terms change | **Kept as is, verified** (owner, 4 Nov). A terms change re-evaluates nothing by itself: no status change, approval request or notification. Each gate (creation, leaving "new", an edit) judges on the current hold, terms, limit and exposure; a hold clears by withdrawing the request, never by auto-approval. Test `tests/integration/credit-reevaluation.test.ts` |
| M-4 | `EtaReceiverProfile` | **Kept** (owner, 4 Nov); no destructive migration. The ETA workflow uses the customer and legal-entity record (§6.1) |
| M-5 | One supplier editor | **Done** (§6.2), with today's rights kept |
| M-6 | Vegetable/fruit category on suppliers | **Done locally** (§6.2). The migration was verified on a fresh database and a production copy; it needs the owner's go-ahead to run in production |
| M-7 | Party ids without a foreign key | **Done** (§6.4): kept polymorphic, checked by the integrity report |
| D-1 | Category on creation | **Done** (owner, 4 Nov): required on normal creation, temporarily unclassified only from the stock quick add. **Open:** non-produce suppliers (a landlord, maintenance, an asset vendor) must also pick vegetable or fruit under this rule |
| D-2 | Stock Controller and the supplier profile | **Done** (owner, 4 Nov): read-only profile access, no new editing or financial permission |
