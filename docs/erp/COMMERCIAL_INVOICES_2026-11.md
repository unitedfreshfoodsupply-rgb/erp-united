# Ordinary commercial invoices (November 2026)

UNITED issues and records ordinary commercial invoices on paper or PDF. ETA e-invoicing (signing, submission, UUIDs, acceptance and rejection) stays a separate integration that is not switched on. Nothing below creates or imitates an ETA document. The existing ETA code, and every document already sent to the ETA, is unchanged.

## 1. What existed and what this release adds

| Requirement | Before | Now |
|---|---|---|
| Sales invoice from a dispatched order, using the delivered quantities | COMPLETE (`createInvoiceFromOrder`: delivered quantities on a trip, loaded otherwise; refused with an open stock-issue exception) | unchanged |
| Numbering, issue date, due date from the payment terms, receivable posted once | COMPLETE (`issueInvoice`, `postSalesInvoice` in the same transaction; DB trigger `SalesInvoice_frozen`) | unchanged |
| Buyer frozen at issue | PARTIAL: name, tax number, address only | **complete snapshot** (`SalesInvoice.issueSnapshot`): the seller (company), the buyer's card (code, legal name, registry, phone, email, terms), the order, customer PO, delivery date, trip, and each line's product code |
| Draft shows the current master data, and what is missing | MISSING | **draft panel**: the company and customer exactly as issue will freeze them, the missing company fields, the buyer's identity check, and links to correct them on their own record |
| Draft editing | PARTIAL: reprice from the order, void and recover | **notes** editable on a draft (`PATCH /api/sales/invoices/:id`), audited with the old and new text. Lines stay tied to the order (delivered quantity, approved prices) |
| Corrections after issue | COMPLETE: credit notes (by quantity or the whole invoice), never an edit | unchanged |
| Supplier bill against PO and receipts, three-way match, variance approval | COMPLETE (`createBill` / `postBill` / `applyBillDecision`) | unchanged |
| Duplicate supplier invoice number | COMPLETE (unique per supplier among live bills) | unchanged, now covered by a test |
| Supplier frozen at posting | MISSING | **snapshot** (`SupplierBill.postSnapshot`): the supplier's card, UNITED as the buyer, and per line the product code, PO and receipt |
| Bill draft edits audited | PARTIAL: new value only | **previous and new** values in the audit row |
| A bill never creates a payment | COMPLETE | unchanged, now covered by a test |
| Supplier's original invoice attached | MISSING (no attachments on bills) | **attachments** on supplier bills (invoice, tax document, purchase document, delivery note) and on sales invoices (delivery note, customer PO, contract) |
| Sales invoice print | PARTIAL: titled "tax invoice" on every invoice, no product code, PO, trip, bank or signature | **reworked** (§3) |
| Supplier bill print | MISSING | **new** A4 print, Arabic and English (§3) |
| Company details for documents | PARTIAL: name, tax number, registry, address, phone, email | **plus** legal form, issued capital, bank account, IBAN and printed terms, and the missing ones listed on the company card |
| Links | PARTIAL: profiles list invoices and bills with open amounts; invoice → receipts | **plus** order → its invoice (and print), journal entry → its invoice or bill, bill line → PO and receipt, invoice → order |

## 2. Master data and the snapshot

- The company, customer and supplier records are the only editable copy of party details. Invoice and bill screens show them and link to them; they never edit them.
- A draft reads them live, so an approved change to a card shows on the draft at once.
- Issuing an invoice (or posting a bill) copies what the document needs into its snapshot, in the same UPDATE that freezes the row. The existing `SalesInvoice_frozen` and `SupplierBill_frozen` triggers then refuse any later change. Two CHECKs keep the snapshot off drafts.
- An invoice issued before this release has no snapshot. It prints the buyer columns it already froze, plus today's company record, and is marked `data-source="legacy"`. Production has one such invoice. Its row cannot be changed and is not back-filled.
- Every missing value stays empty. The documents never fill in a company detail, tax number, address, bank or legal text.

## 3. The printed documents

`/sales/invoices/:id/print` (issued only) and `/purchasing/bills/:id/print` (any status). `?lang=en` gives the English version of the same document.

- **Titles.**
  - A sales invoice is titled **"فاتورة مبيعات / Sales Invoice"**, with the line "commercial invoice — not submitted to the ETA e-invoicing system".
  - Only an invoice the ETA has actually received or accepted, with its real UUID, is titled "فاتورة ضريبية / Tax Invoice" and shows the ETA block.
  - No placeholder UUID, QR code or approval claim is ever printed.
- **Sales invoice content:**
  - logo, company and seller block: legal name, legal form, issued capital, tax number, registry, address, contact;
  - the buyer: legal name, code, tax number, registry, phone, address;
  - invoice number, date, time, due date and terms;
  - the sales order, customer PO, delivery date and trip;
  - lines with product code, quantity and unit, unit price, discount, net, tax (or "exempt") and total;
  - the tax summary; subtotal, discount, tax and grand total in EGP;
  - payment status (unpaid, partly paid, settled) with the receipts and the balance;
  - bank details, printed only when configured;
  - notes and the commercial terms;
  - signature lines: prepared by, authorised signature, and received by the customer.
- **Supplier bill content:**
  - "Purchase Invoice", marked as UNITED's record of the supplier's invoice; the original is an attachment;
  - the supplier as at posting, and UNITED as the buyer;
  - the supplier's invoice number and date, due date, terms, status and match;
  - the POs and receipts;
  - lines with code, receipt, PO, received and billed quantity, unit price against the agreed price, tax and total;
  - debit notes, payments and what is still owed;
  - the attachment list, with a warning when there is no copy of the supplier's invoice;
  - recorded, approved and posted by.
  - A bill not yet posted prints its state across the top.
- **A4 print:**
  - `components/print/DocumentPrintStyles` puts the page number ("صفحة 1 من 3" / "Page 1 of 3") and the document number in the page margin;
  - the line table's header repeats on every page;
  - rows and the totals block never split across pages;
  - the app's controls and the missing-details notice are never printed.
- **Verified with Chrome's print engine:**
  - a 60-line invoice printed on three A4 pages in Arabic and in English;
  - the header row was repeated on every page;
  - the totals, bank details, terms and signatures stayed together on the last page;
  - the bill printed on one page in each language.
  - Evidence: `UNITED_AUDIT_20261102/maturity/commercial-invoices-20261104/`.
- **PDF:** the browser's print to PDF. The pages are built for it, and no server-side PDF engine is added.

## 4. Permissions (existing RBAC, server-side)

| Action | Permission | Roles holding it today |
|---|---|---|
| View sales invoices, print them, read their attachments | `sales.invoices.view` | ACCOUNTANT, SALES, ACCOUNTING_CLERK, SUPER_ADMIN |
| Create a draft from an order, edit draft notes, reprice, void or recover a draft, issue, credit note, attach files | `sales.invoices.manage` | ACCOUNTANT, SUPER_ADMIN |
| View supplier bills, print them, read their attachments | `purchasing.bills.view` | ACCOUNTANT, PURCHASER, ACCOUNTING_CLERK, SUPER_ADMIN |
| Record a bill, edit a draft, post within tolerance, cancel a draft, debit note, attach files | `purchasing.bills.manage` | ACCOUNTANT, SUPER_ADMIN |
| Approve a bill with a variance or no agreed price | `purchasing.bills.approve` (approval engine; the submitter cannot approve) | SUPER_ADMIN |
| Company details printed on documents | `core.masterdata.manage` (field-level audit; the Admin page also needs `users.view`) | SUPER_ADMIN |

- Every write route goes through `requirePermission`, and every service through `assertPermission`. The tests check the refusals over HTTP and in the services: sales cannot edit or issue, the purchaser cannot record a bill, sales and the stock controller cannot open a bill, a preparer cannot open an invoice, the accountant cannot change the company record.
- Preparing and issuing an invoice are still one permission (`sales.invoices.manage`), as designed before. A separate "issue" permission (maker-checker) is a policy choice for the owner (§7).

## 5. Accounting (unchanged engine)

- **Sales invoice.** Issue posts Dr AR (customer) / Cr revenue (and output VAT when a product's tax code carries VAT) once.
  - A second issue is refused with 409 and posts nothing.
  - The customer's balance rises by the invoice exactly once, and ledger = sub-ledger.
  - Corrections go only through a credit note.
- **Supplier bill.** Posting posts Dr GRNI (or expense/asset for a service bill) / Cr AP once.
  - A second post is refused.
  - AP rises by the bill total exactly.
  - A debit note reduces it.
  - No payment is created.
  - Partial billing works by receipt: a receipt not yet billed stays billable.
- **Tax.** VAT is never applied automatically. Each product carries its sales tax code, `EXEMPT` by default (fresh produce, §6), and only a configured code adds tax.

## 6. Egyptian requirements (research, 4 Nov 2026)

Sources were read on the web on 4 Nov 2026. **[O]** means official text read directly; **[S]** means a secondary source (law-firm translation or reproduction). This is a summary of what the texts say, not tax advice.

**Verified requirements:**
- **Invoice data — Unified Tax Procedures Law 206/2020 Art. 37 [S]** ([Andersen translation](https://eg.andersen.com/wp-content/uploads/2025/09/Law-206-of-2020.pdf)). Every taxpayer issues an invoice on each sale, in an original and a copy, with:
  - serial numbers in issue-date order;
  - the date;
  - the seller's name, address and registration number;
  - the buyer's name, address and registration number where available;
  - a description of the goods, their value, the VAT category and amount, and the total.
  - Cancelled invoices are kept.
  - In the print and the services: all these fields are on the print, numbers are sequential (`nextDocumentNumber`), and voided drafts are never deleted.
  - The original/copy marking is not printed; it can be added if wanted.
- **E-invoicing.** The same Art. 37 requires invoices to be issued electronically.
  - The ETA states that every taxpayer has been obligated since 15 Dec 2022 [O] ([eta.gov.eg](https://eta.gov.eg/en/home)).
  - Decree 188/2023 [O] (Official Gazette 9 Apr 2023): from 1 Jul 2023, buyers on the e-invoice system prove costs and deduct VAT only with e-invoices.
  - **Consequence:** a paper or PDF commercial invoice does not take the place of the e-invoice. If UNITED is within the obligation, its registered customers cannot rely on it for costs or VAT. Switching on the ETA integration is therefore a compliance decision for the owner, not an option.
- **Fresh produce.** VAT Law 67/2016 exempt list, item 12, exempts "agricultural products sold as is" [O] ([ETA text](https://eta.gov.eg/sites/default/files/2024-02/Law-english-no.67-2016.pdf.pdf)), unchanged by Law 149/2026 [O].
  - VAT registration is required once taxable plus exempt sales reach EGP 500k (Art. 16) [O].
  - Whether graded or packed produce stays "as is" is not verified.
- **Company details on invoices:**
  - Commercial Registry Law 34/1976 Art. 5 [S]: trade name, registry office and number.
  - Companies Law 159/1981 Art. 6 [S]: name, legal form, head office and issued capital.
  - Law 206 Art. 26 [S]: the tax registration number on invoices.
  - All of these are fields on the company record now. The registry office goes in the registry field (for example "سجل تجاري القاهرة 12345").
- **A non-registrant charging VAT is an offence** (VAT Law Art. 68(8)) [O]. The system shows VAT only when a product's tax code carries it.
- **Corrections** (VAT Regulations Art. 26 and Art. 11(9)) [O]: credit and debit notes are dated, serially numbered and cite the original invoice's number and date. UNITED's credit and debit notes do (CN-/DN- numbers, linked to the invoice or bill).
  - ETA documents have their own cancellation and rejection windows; this release does not touch them.
- **Withholding** (Income Tax Law Art. 59; MD 380/2018) [S]: 1% on supplies above EGP 300, at payment, not on the invoice. This is already handled at payment (settlement deductions).
- **Retention** (Law 206 Art. 38) [S]: 5 years after the tax period.

**Not verified:**
- any self-billing or purchase-voucher route for buying from farmers who issue no invoice;
- the live ETA cancellation and rejection windows;
- what to call a document that was not submitted.

**UNITED's existing rule (kept):** an invoice cannot be issued to a business buyer without a 9-digit tax number on its card or legal entity, unless the legal entity is a person or foreigner with an ID (MIG-01).

## 7. Company configuration still missing in production

Read-only check on 4 Nov 2026: the production company record holds **only the legal name**. These fields are empty:
- tax registration number;
- commercial registry;
- address;
- phone;
- email;
- legal form and issued capital;
- bank details;
- invoice terms.

Every invoice printed today would show only the name. The draft panel, the company card (Admin → Company, Stores & Units) and the print screen list exactly what is missing. An administrator fills them in there; the change is audited field by field.

Decisions for the owner:
- **ETA obligation.** Confirm UNITED's registration status and obligation phase. Plan the ETA activation (the integration exists and is not switched on).
- **Segregation.** Decide whether issuing an invoice should need a second person (a new `sales.invoices.issue` permission). Today the accountant both prepares and issues.
- **Purchases without a supplier invoice.** Decide on purchases from farmers who issue no invoice (no verified official route; see §6).
- **Original and copy.** Decide whether to mark prints "original" and "copy".
