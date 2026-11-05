-- Ordinary commercial invoices (Nov 2026): what an issued sales invoice and a posted supplier
-- bill print is frozen with the document, and the company's printable details are configured
-- in its master record. Additive only: no existing row is changed.
--
-- * SalesInvoice.issueSnapshot — the seller, the buyer's code and contact, the order's
--   references (order, customer PO, delivery, trip) and each line's product code, as they were
--   at issue. Written in the same UPDATE that issues the invoice, so the existing
--   "SalesInvoice_frozen" trigger keeps it unchanged afterwards. Invoices issued before this
--   release have none and print from the buyer columns they already froze.
-- * SupplierBill.postSnapshot — the supplier (code, names, tax and registry numbers, address,
--   contact), the buyer (the company) and each line's product code, PO and receipt, as they were
--   when the bill posted. Frozen afterwards by "SupplierBill_frozen".
-- * Company: its legal form and issued capital (Companies Law 159/1981 Art. 6 lists them for
--   invoices), bank details and the commercial terms printed on invoices. Nothing is printed
--   for a field that is not configured.

ALTER TABLE "SalesInvoice" ADD COLUMN "issueSnapshot" JSONB;
ALTER TABLE "SupplierBill" ADD COLUMN "postSnapshot" JSONB;

ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_issueSnapshot_object" CHECK ("issueSnapshot" IS NULL OR jsonb_typeof("issueSnapshot") = 'object');
ALTER TABLE "SupplierBill" ADD CONSTRAINT "SupplierBill_postSnapshot_object" CHECK ("postSnapshot" IS NULL OR jsonb_typeof("postSnapshot") = 'object');
-- A draft has no snapshot: it shows the current master data until it is issued / posted.
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_snapshot_at_issue" CHECK ("issueSnapshot" IS NULL OR "status" <> 'draft');
ALTER TABLE "SupplierBill" ADD CONSTRAINT "SupplierBill_snapshot_at_post" CHECK ("postSnapshot" IS NULL OR "status" = 'posted');

ALTER TABLE "Company" ADD COLUMN "legalForm" TEXT;
ALTER TABLE "Company" ADD COLUMN "issuedCapital" TEXT;
ALTER TABLE "Company" ADD COLUMN "bankName" TEXT;
ALTER TABLE "Company" ADD COLUMN "bankAccountName" TEXT;
ALTER TABLE "Company" ADD COLUMN "bankAccountNumber" TEXT;
ALTER TABLE "Company" ADD COLUMN "iban" TEXT;
ALTER TABLE "Company" ADD COLUMN "invoiceTerms" TEXT;
ALTER TABLE "Company" ADD CONSTRAINT "Company_invoice_fields" CHECK (
  ("legalForm" IS NULL OR length("legalForm") BETWEEN 1 AND 120)
  AND ("issuedCapital" IS NULL OR length("issuedCapital") BETWEEN 1 AND 60)
  AND ("bankName" IS NULL OR length("bankName") BETWEEN 1 AND 120)
  AND ("bankAccountName" IS NULL OR length("bankAccountName") BETWEEN 1 AND 160)
  AND ("bankAccountNumber" IS NULL OR "bankAccountNumber" ~ '^[0-9A-Za-z -]{4,40}$')
  AND ("iban" IS NULL OR "iban" ~ '^EG[0-9]{27}$')
  AND ("invoiceTerms" IS NULL OR length("invoiceTerms") BETWEEN 1 AND 1500)
);
