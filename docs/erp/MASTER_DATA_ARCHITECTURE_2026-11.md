# Customer and supplier master data: one source of truth (November 2026)

Branch `feature/eta-customer-master-data`, based on `main` at `04be32a`. Local only: not pushed, not deployed, no migration, no production write.

## 1. Short answer

- **Most of the system already reads parties live.** Customers and suppliers are referenced by id. Almost every screen joins the master record at read time, so an edit reaches it at once. There is no server-side cache of party data.
- **The e-invoice (ETA) receiver was the exception, and the cause of the re-entry.** The ETA screen kept its own editable copy (`EtaReceiverProfile`), which nothing ever filled from the customer record. For customers with a legal entity, the payload ignored that copy anyway. That is fixed on this branch: the receiver now comes from the customer's legal entity, it is edited only in the customer record, and the ETA screen is read-only.
- **The remaining copies are listed in §3.** They are either legal or historical snapshots that must not follow edits, or one operational copy (`Order.customerName`). Each has a recommendation; none was changed beyond what §6 lists.

## 2. Field ownership matrix

**Canonical owners:**
- **Customer card** (`Customer`): code, display names, legal names, tax number, contact, credit, price list, active.
- **Customer legal entity** (`CustomerLegalEntity`, linked by `Customer.legalEntityId`): the legal and tax identity, the structured tax address and the ETA receiver type/id. One legal entity can serve several branches of the same company.
- **Supplier** (`Supplier`): every supplier attribute.

Legend: **Live** = read through the id at display time. **Legal snapshot** = frozen when the document is issued or posted, by law or by audit. **Operational copy** = written at creation, not refreshed. **Retired** = no longer written.

| Field(s) | Owner | Other places stored | Classification of each copy |
|---|---|---|---|
| Customer name, Arabic name | Customer | `Order.customerName` (intake text; or the card name at creation); `CustomerAlias` canonical rows | Order: **operational copy**, shown live-first in most screens, stored-only in some (§3). Alias: **maintained index**, re-claimed in the same transaction on rename |
| Customer legal name, tax number | Customer card, or its active legal entity | `SalesInvoice.buyerName`, `buyerTaxId` | **Legal snapshot** at issue (trigger `sales_invoice_frozen`) |
| Customer free-text address | Customer card / legal entity | `SalesInvoice.buyerAddress` | **Legal snapshot** at issue |
| ETA receiver type, personal id, structured address | **Legal entity** | `EtaReceiverProfile` (per customer) | **Retired** on this branch: read only as a fallback for a customer with no active legal entity, never written. Production holds 0 rows |
| Same, as sent to ETA | Legal entity at signing time | `EtaDocument.signedPayload`, `EtaDocumentEvent.detail` | **Legal snapshot** per submission; the events table is append-only |
| Payment terms, credit limit, hold | Customer | `SalesInvoice.dueDate`; `Order.creditStatus/creditNote` | Due date: **legal snapshot**. Credit status: **cached judgement**, re-evaluated on order edits, not on a credit-terms change (§3) |
| Price list | Customer | `OrderItemPrice.priceListId/unitPrice` | **Commercial snapshot** at pricing time |
| Supplier names, contact, tax, address | Supplier | none (POs, bills, payments, debit notes, refunds, intakes, requests and RFQs hold only `supplierId`) | — |
| Supplier payment terms, currency | Supplier | `PurchaseOrder.paymentTermsDays/currencyCode`; `SupplierBill.dueDate`; `SupplierPrice.currencyCode` | **Document snapshots**. The bill due date is computed from the live supplier terms while the bill is a draft, then frozen |
| Party name in ledger narrative | Customer / Supplier | `JournalEntry.description` | **Immutable ledger text** (append-only trigger) |
| Party name in approvals, notifications, audit | Customer / Supplier | `ApprovalRequest.title/summary`, `Notification.*`, `AuditLog.old/newValue`, `InventoryDocument.reason`, `OperationalException.description` | **Historical text** of an event |
| Who signed for a delivery | Delivery | `TripStop.receiverName` | **Delivery fact**, not master data |
| Party identity in the ledger | Customer / Supplier | `JournalLine.partyType/partyId`, `PartyOpeningBalance.partyId`, `OpeningBatchLine.data.party_id` | **Id reference**, polymorphic, without a database foreign key |

A structural test (`tests/integration/master-data-propagation.test.ts`) lists every column in the schema named like a party attribute. It fails if a new one appears outside the reviewed set: `Order.customerName`, `SalesInvoice.buyerName/buyerTaxId/buyerAddress`, `TripStop.receiverName`.

## 3. Screens and modules still reading a copy

| Screen / service | Reads | Classification | Recommendation |
|---|---|---|---|
| Picking sheet (`lib/picking-sheet.ts:81,134`); delivery note, dispatch and picking prints (`app/orders/[orderId]/print/*` → `PrintHeader`) | `Order.customerName` | Operational copy | Read live `customerAccount` first, stored name as fallback, for open orders (the helper `orderCustomerName` already exists). Keep the stored name on reprints of dispatched orders (a delivery document) — **decision M-1** |
| Trips: plannable orders, stops, exceptions (`lib/operations/trips.ts:456,477`); stock-issue exceptions (`lib/inventory/dispatch.ts:194`); delayed-orders report (`lib/reports/definitions.ts:523-529`) | `Order.customerName` | Operational copy | Live-first, as above (M-1) |
| Audit view, cancelled-documents report, live alerts, GL and cash-movement narratives, price-exceptions report | Stored event text | Historical | Keep: they record what was true at the event |
| Invoice print: payment-terms label (`lib/sales/invoiceDocument.ts:76`) | Live terms beside a frozen due date | Inconsistency | Print the frozen due date only, or the terms as of issue (M-2) |
| Credit status on open orders (`lib/sales/credit.ts`) | Cached judgement | Cache with incomplete invalidation | Re-evaluate open orders when credit terms change (M-3) |
| ETA invoice state (`etaState`) | **Before:** rebuilt from today's data even after submission. **Now:** the signed payload | Fixed on this branch | — |
| ETA setup screen | **Before:** its own editable receiver copy. **Now:** read-only from the customer record | Fixed on this branch | — |

## 4. Root cause of the ETA re-entry

1. **The data lived in two places.** The ETA receiver lived on the customer's legal entity (`CustomerLegalEntity`: structured address, receiver type and id) and also in a separate ETA-module table (`EtaReceiverProfile`).
2. **The ETA screen only knew its own copy.** Its Setup tab (`EtaView.ReceiverRow`) read and wrote only `EtaReceiverProfile`. Nothing filled it from the customer record, so every invoiced customer appeared empty and marked ✗, and the user was asked to type the data again.
3. **For linked customers, that typing changed nothing.** For a customer with a legal entity, the payload used the legal entity and ignored what was typed (`loadEtaSource`). It even used an **inactive** legal entity, unlike invoice issue.
4. **The customer record had no editor for these fields.** The legal entity's structured address had no editing screen, only an API.
5. **The wrong people held the permission.** The accountant who sees the ETA gaps holds `accounting.eta.manage` but not `sales.customers.manage`, so the ETA copy was their only way in.
6. **History was not stable.** After submission, the ETA screen rebuilt the document from current data, so an accepted invoice could show a different receiver.

## 5. Recommended architecture

- **One owner per attribute.** Customer card for commercial identity and contact. Its legal entity for legal and tax identity, including everything ETA needs. Supplier for supplier data. No module keeps an editable copy.
- **Reference by id everywhere.** Display through live joins. Names are never used as keys; the only name matching is the intake integration's alias table, which resolves to an id.
- **Three states for documents:**
  - *Current master* — always live.
  - *Draft* — built from the current master each time it is shown or recalculated. The ETA draft is rebuilt on every view until signing.
  - *Issued/posted* — legal snapshot frozen by database triggers. The invoice buyer is frozen at issue. The ETA document is the signed payload, shown as stored.
- **Edits in the owner's screen only, under the owner's permission, audited field by field.** Other modules show what is missing and link to the owner's screen.
- **Server-side enforcement.** Every master-data service asserts its permission itself, whatever route reaches it.

## 6. Implementation on this branch (additive, no migration)

| Change | Files |
|---|---|
| One pure rule for the ETA receiver: active legal entity → retired profile (fallback only) → none; plus field-by-field gaps | `lib/eta/receiver.ts` (new) |
| ETA payload, setup list and invoice state use it. An inactive legal entity is no longer used. A signed document is shown as stored. Receiver errors carry a link to the customer record. The receiver-profile write is refused (409 `eta.receiver-profile-retired`, with the edit link) | `lib/eta/service.ts` |
| Customer e-invoice identity: read (`sales.customers.view` or `accounting.eta.view`) and **create-and-link a legal entity from the card** in one transaction (`sales.customers.manage`, audited). Editing an existing legal entity uses the existing versioned, field-audited API | `lib/sales/customers.ts`, `app/api/sales/customers/[id]/eta-identity/route.ts` (new) |
| Customer page: "Tax and e-invoice identity" card — shows the canonical receiver and the missing fields; edit/create only with `sales.customers.manage` | `components/profiles/EtaIdentityCard.tsx` (new), `CustomerProfile.tsx` |
| ETA setup screen: receiver list read-only from the customer record, with gaps and a link (or a note when the user lacks the customer permission) | `components/accounting/EtaView.tsx` |
| Supplier rename/phone/active: permission now asserted in the service, not only in the route | `lib/stock-service.ts` |
| Arabic/English strings; English for the 2 new server messages; RBAC snapshot (2 new routes) | `lib/locale/*`, `docs/erp/RBAC_MATRIX.md`, `docs/erp/rbac-snapshot.json` |

`EtaReceiverProfile` is kept: it was not dropped or migrated. Production has 0 rows. Dropping it would need a reviewed migration (**decision M-4**).

## 7. Tests (local test database, synthetic data; nothing sent to ETA)

| Suite | Result |
|---|---|
| `tests/unit/eta-receiver.test.ts` (new): precedence, inactive legal entity, legacy fallback, tax number rule, gaps for B/P/F, payload mapping | 9/9 |
| `tests/integration/master-data-canonical.test.ts` (new): missing fields named with an edit link; retired editor refuses and writes nothing; RBAC (ETA role reads, cannot edit; clerk cannot read); create-and-link from the card with audit; an edit changes the next ETA draft but not a signed document; rename and legal-name change reach new documents, never issued ones (DB trigger); inactive legal entity ignored | 7/7 |
| `tests/integration/master-data-propagation.test.ts` (new): customer rename reaches invoice list, search, statement and aging with field audit while the issued invoice keeps its buyer; supplier rename reaches supplier lists and PO list, refused without permission, audited; structural check of party-attribute columns | 3/3 |
| Whole unit suite | 225/225 |
| Whole integration suite | 174/174 |
| E2E (local server, feature build): ETA | 35/35 |
| E2E: customer groups and legal entities | 47/47 |
| Typecheck, lint | clean |
| Browser (feature build, local): customer card in Arabic (RTL) and English (LTR); create-and-link through the form; ETA list read-only (0 inputs), showing the new address | checked |

## 8. Decisions and next steps (not implemented)

| # | Decision | Recommendation |
|---|---|---|
| M-1 | Order customer name on open-order screens and prints | Live-first for open orders; stored name kept on documents of dispatched orders |
| M-2 | Invoice print shows the live payment-terms label beside the frozen due date | Print the frozen due date only |
| M-3 | Credit status of open orders after a credit-terms change | Re-evaluate open orders in the same transaction |
| M-4 | Drop `EtaReceiverProfile` | After deployment, if production still has 0 rows: a reviewed migration that drops the table and its retired route |
| M-5 | Supplier attributes are split between stock (`stock.manage_suppliers`: name, phone, notes, active) and purchasing (`purchasing.suppliers.manage`: the rest). No screen can rename a supplier | One supplier editor in purchasing for all fields, under one permission (or both), field-audited |
| M-6 | Vegetable/fruit segment is not stored on suppliers | A structured segment attribute on `Supplier` (an additive column and a reviewed migration), set from the import files' provenance (SUP-00001–39 fruit, SUP-00040–83 vegetables) after the owner confirms |
| M-7 | `JournalLine.partyId` / `PartyOpeningBalance.partyId` have no foreign key | Keep (polymorphic); the integrity report covers orphans |
