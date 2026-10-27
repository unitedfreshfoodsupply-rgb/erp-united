-- Service bills: a supplier bill whose lines are expense or asset accounts (rent,
-- utilities, transport, services, equipment) instead of goods receipts, with input VAT.
-- Additive: every existing bill is a goods bill.

ALTER TABLE "SupplierBill" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'goods';
ALTER TABLE "SupplierBill" ADD CONSTRAINT "SupplierBill_kind_check" CHECK ("kind" IN ('goods', 'service'));

CREATE TABLE "SupplierBillServiceLine" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "taxCode" TEXT NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "net" DECIMAL(18,2) NOT NULL,
    "tax" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "SupplierBillServiceLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupplierBillServiceLine_amounts_check" CHECK ("net" > 0 AND "tax" >= 0 AND "total" = "net" + "tax")
);

CREATE TABLE "DebitNoteServiceLine" (
    "id" TEXT NOT NULL,
    "debitNoteId" TEXT NOT NULL,
    "serviceLineId" TEXT NOT NULL,
    "net" DECIMAL(18,2) NOT NULL,
    "tax" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "DebitNoteServiceLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DebitNoteServiceLine_amounts_check" CHECK ("net" > 0 AND "tax" >= 0 AND "total" = "net" + "tax")
);

CREATE UNIQUE INDEX "SupplierBillServiceLine_billId_lineNo_key" ON "SupplierBillServiceLine"("billId", "lineNo");
CREATE INDEX "DebitNoteServiceLine_debitNoteId_idx" ON "DebitNoteServiceLine"("debitNoteId");
CREATE INDEX "DebitNoteServiceLine_serviceLineId_idx" ON "DebitNoteServiceLine"("serviceLineId");

ALTER TABLE "SupplierBillServiceLine" ADD CONSTRAINT "SupplierBillServiceLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "SupplierBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierBillServiceLine" ADD CONSTRAINT "SupplierBillServiceLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DebitNoteServiceLine" ADD CONSTRAINT "DebitNoteServiceLine_debitNoteId_fkey" FOREIGN KEY ("debitNoteId") REFERENCES "DebitNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DebitNoteServiceLine" ADD CONSTRAINT "DebitNoteServiceLine_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "SupplierBillServiceLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same rules as goods lines: editable while the bill is a draft, frozen once posted or
-- cancelled; allowances are permanent.
CREATE TRIGGER "SupplierBillServiceLine_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "SupplierBillServiceLine"
FOR EACH ROW EXECUTE FUNCTION purchasing_bill_line_frozen();
CREATE TRIGGER "DebitNoteServiceLine_append_only" BEFORE UPDATE OR DELETE ON "DebitNoteServiceLine"
FOR EACH ROW EXECUTE FUNCTION sales_append_only();

-- Row-level security like the other money tables (no policies: only the server's own
-- connection reads them). Also covers the settlement-deduction tables added just before.
ALTER TABLE "SupplierBillServiceLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DebitNoteServiceLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReceiptDeduction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentDeduction" ENABLE ROW LEVEL SECURITY;
