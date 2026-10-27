# ETA e-invoicing readiness (Invoice v1.0)

*2026-10-08. Goal: make the existing UNITED invoice submittable to the Egyptian Tax
Authority (ETA) without changing how invoices are created, numbered, posted or printed.
ETA standardises the invoice **data** that is submitted (JSON/XML). It does not impose a
visual layout, so the UNITED invoice keeps its own design.*

> **Source note.** This environment's network policy blocks `eta.gov.eg` and
> `sdk.invoicing.eta.gov.eg`, so the field list below was mapped from the published
> Invoice v1.0 structure, not read live from the SDK pages. Every field name and rule
> marked ⚠ must be checked against
> [Invoice v1.0](https://sdk.invoicing.eta.gov.eg/documents/invoice-v1-0/) and
> [Submit documents](https://sdk.invoicing.eta.gov.eg/einvoicingapi/01-submit-documents/)
> before the first pre-production submission. The mapper is a single file
> (`lib/eta/mapper.ts`), so a correction is a one-file change.

## 1. What already exists (reused, not duplicated)

| ETA needs | Already in UNITED | Where |
|---|---|---|
| Issuer registration number, name | `Company.taxRegistrationNumber`, `legalName` | `Company` |
| Receiver registration number, name | Frozen on the invoice at issue: `buyerTaxId`, `buyerName` (source `Customer.taxRegistrationNo`) | `SalesInvoice` |
| `internalID` | Invoice number `INV-YYYY-#####`, set at issue, unique, never reused | `SalesInvoice.number` |
| `dateTimeIssued` | `issuedAt` (UTC timestamp at issue) | `SalesInvoice` |
| Line description, quantity, unit price | `description`, `quantity` (3 dp), `unitPrice` (4 dp) | `SalesInvoiceLine` |
| Line discount (rate + amount) | `discountPct`, `discount` | `SalesInvoiceLine` |
| Sales total / net / tax / line total | `gross`, `net`, `tax`, `total` (2 dp, computed at issue, immutable) | `SalesInvoiceLine` |
| Invoice totals | `gross`, `discountTotal`, `net`, `taxTotal`, `total` | `SalesInvoice` |
| Tax type / subtype per line | `TaxRate.etaType` / `etaSubtype` (+ `rate`), referenced by the line's `taxCode` | `TaxRate` |
| Line ↔ product | `SalesInvoiceLine.productId` → `StockProduct` (`sku` = internal code) | |
| Currency | `currencyCode` (EGP) | |
| Corrections | Credit notes (append-only, posted) | `CreditNote` |

## 2. What is missing for ETA (and only that)

| ETA field | Why it is missing | Added as |
|---|---|---|
| `issuer.address.branchID` | ETA's own branch code for the issuing branch; UNITED's branch `code` is internal | `EtaIssuerProfile.etaBranchId` |
| `taxpayerActivityCode` | The ETA/ISIC activity code UNITED is registered under | `EtaIssuerProfile.activityCode` |
| Issuer structured address: `country`, `governate`, `regionCity`, `street`, `buildingNumber` (+ optional postal code, floor, room, landmark, extra info) | `Company.address` is one free-text line (kept for print) | `EtaIssuerProfile` |
| `receiver.type` B / P / F | Not modelled. Derived as B when the customer has a registration number, P otherwise; F only when set explicitly | `EtaReceiverProfile.receiverType` (optional override) |
| `receiver.id` for a person (national ID) or foreigner | Not held. Needed for P above ETA's threshold ⚠ | `EtaReceiverProfile.receiverId` |
| Receiver structured address (mandatory for B) | `Customer.address/city/area` is free text for delivery | `EtaReceiverProfile` |
| Line `itemType` (GS1 / EGS) + `itemCode` | ETA-registered product codes do not exist yet | `EtaItemCode` (per product) |
| Line `unitType` | UNITED unit codes (`KG`, `CRATE`…) are internal; ETA uses its own unit-type code list ⚠ | `EtaUnitType` (per unit) |
| Digital signature | Requires UNITED's e-seal / USB token or HSM | External signer boundary (`ETA_SIGNER_URL`) |
| Submission state (submission id, UUID, long id, status, errors) | Not modelled | `EtaDocument` + append-only `EtaDocumentEvent` |
| API credentials | — | Environment only (`ETA_CLIENT_ID`, `ETA_CLIENT_SECRET`, …) |

All of these live in **separate `Eta*` tables**. No column was added to `SalesInvoice`,
`Customer`, `Company`, `Branch`, `StockProduct`, `UnitOfMeasure` or `TaxRate`.

**Needs confirmation, not missing.** `TaxRate.etaType/etaSubtype` were seeded in Phase 3:
- `EXEMPT` → T1 / V003
- `VAT14` → T1 / V009
- `VAT0` → T1 / V001

They come from ETA's public tax-subtype table but were never confirmed by UNITED's
accountant. This pass does not change them. The accountant must confirm them (in
particular **exempt V003 vs. non-taxable V004** for fresh produce) before going live.

## 3. Integration boundary

```
SalesInvoice (issued, immutable)      ← core domain, unchanged
      │  lib/eta/loader.ts   reads invoice + Company + Eta* profiles (read-only)
      ▼
EtaSource (plain data)
      │  lib/eta/mapper.ts   pure: EtaSource → ETA Invoice v1.0 JSON
      │  lib/eta/validate.ts pure: blocking errors + warnings, recomputes ETA totals
      ▼
ETA document JSON
      │  EtaSigner  (external signing bridge; never in the browser)
      │  EtaGateway (OAuth client-credentials + POST /api/v1/documentsubmissions)
      ▼
ETA submission id, UUID, long id, status
      │  lib/eta/service.ts  records the result on EtaDocument (+ event log)
      ▼
UNITED invoice screen / print view: shows the UUID and status
```

The invoice is never edited by this flow. ETA state is keyed to it
(`EtaDocument.sourceType + sourceId`, unique).

## 4. Idempotency (never two ETA submissions for one invoice)

* One `EtaDocument` per invoice (unique `sourceType, sourceId`). The claim is made under
  an advisory lock in its own transaction, **before** any network call.
* Only `pending`, `failed` (nothing reached ETA), `rejected` and `invalid` may be
  (re)submitted.
* `submitting` and `unknown` (a timeout after the request left) can only be resolved by
  **refresh / reconcile**, never by sending again.
* `submitted`, `valid` and `cancelled` return the existing state.
* Every attempt and result is appended to `EtaDocumentEvent`. Raw responses are kept;
  credentials and tokens never are.

## 5. Security

* Credentials only from the server environment (`lib/eta/config.ts`). They are never
  returned by an API. The status endpoint reports only which variable **names** are
  missing.
* `accounting.eta.view`: see ETA status, readiness and errors (ACCOUNTANT, SUPERVISOR;
  SUPER_ADMIN always).
* `accounting.eta.manage`: submit, refresh/reconcile, maintain ETA codes and profiles
  (ACCOUNTANT; SUPER_ADMIN always).
* Floor roles (preparer, loader, stock controller) and sales have neither. The customer
  invoice print shows the ETA UUID and status, never errors.

## 6. Prepared, not implemented

* **Credit notes — built (2026-10-28).** A UNITED credit note maps to `documentType` "c"
  with `references: [<the invoice's ETA UUID>]`; its lines are the credited quantities and
  amounts, each keeping its invoice line's product, unit, price and tax classification. It
  is refused (422, nothing signed or sent) until ETA has accepted the invoice it credits
  (`valid`, with a UUID). Submit / refresh / manual reconcile and the never-twice rules are
  the invoice's own (`EtaDocument.sourceType = credit_note`). API:
  `/api/eta/credit-notes/[id]` (+ `/submit`, `/refresh`, `/reconcile`); screen: the "Credit
  notes" tab on `/eta`. A credit note's last credit on a line is the exact remainder, so
  UNITED's re-pricing check is skipped for credit notes; ETA's own line arithmetic still
  applies. **Not yet exercised against the pre-production SDK** — confirm the `references`
  field and credit-note rules there (WP-3C).
* **Sales debit notes** (type "d"): UNITED issues none today (its debit notes are supplier
  documents), so none are mapped.
* **Cancellation / rejection** by ETA state API: `cancelled` status and `cancelledAt` exist;
  no action yet.
* **Retrieve document / status**: implemented for a known UUID (`refresh`).

## 7. Blockers for production submission

1. ETA portal registration: production and pre-production **client id / secret** (ERP
   system registration).
2. **Signing**: an e-seal (USB token / HSM) and a signing bridge reachable as
   `ETA_SIGNER_URL`. ETA requires the issuer signature.
3. **Issuer profile**: ETA branch id, activity code, structured address.
4. **Item codes** registered with ETA (EGS codes per product, or GS1) and approved.
5. **Unit-type mapping** from ETA's unit-type code list.
6. **Tax classification** confirmed by the accountant (§2), and the receiver
   person-ID threshold confirmed.
7. Receiver structured addresses for B2B customers.
8. **Rounding**: UNITED stores line amounts at 2 dp. ETA recomputes `quantity × unitValue`
   at 5 dp. Lines where these differ are reported as warnings. Check the outcome in
   pre-production before production.
9. Verify every field marked ⚠ against the SDK pages (see the source note above).
10. The accountant's reference invoice (requested earlier) to confirm the content
    expectations.

## 8. What was built (2026-10-08)

| Piece | File |
|---|---|
| ETA document types (v1.0) and the plain source shape | `lib/eta/types.ts` |
| Mapper, pure: UNITED invoice → ETA JSON (figures as invoiced, nothing invented) | `lib/eta/mapper.ts` |
| Validation, pure: issuer, receiver (B/P/F rules), lines, codes, tax classification, document type/version, internal id; recomputes UNITED's arithmetic and ETA's totals; rounding warnings | `lib/eta/validate.ts` |
| Configuration from the environment (names reported, values never) | `lib/eta/config.ts` |
| Transport: OAuth client credentials, submission, document state; signing bridge | `lib/eta/gateway.ts` |
| Service: readiness, idempotent submit, refresh, manual reconcile, setup | `lib/eta/service.ts` |
| API | `/api/eta`, `/api/eta/issuer`, `/api/eta/units/[code]`, `/api/eta/items/[productId]`, `/api/eta/receivers/[customerId]`, `/api/eta/invoices/[id]` (+ `/submit`, `/refresh`, `/reconcile`) |
| Screen (finance submits, supervisors follow) | `/eta` — `components/accounting/EtaView.tsx` |
| UNITED invoice print: own design, Arabic RTL / English (`?lang=en`), payment state, ETA identifiers when they are facts | `lib/sales/invoiceDocument.ts`, `app/sales/invoices/[id]/print/page.tsx` |
| Setting: person-id threshold (default 50,000 EGP, per ETA's published rule; to be confirmed) | `sales.eta_person_id_threshold` |

Tests:
- `tests/unit/eta-mapper.test.ts`: mapping, consistency, missing data.
- `tests/unit/eta-gateway.test.ts`: transport and secrets; no client import of server code.
- `tests/unit/invoice-document.test.ts`: print model.
- `tests/integration/eta-submission.test.ts`: duplicate protection, unknown/failed/rejected paths, invoice and ledger untouched, permanence.
- `tests/eta.test.ts`: permissions per role, no credentials in responses, safe refusal, print rendering.
