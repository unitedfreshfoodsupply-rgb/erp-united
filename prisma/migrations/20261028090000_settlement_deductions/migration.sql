-- Settlement deductions: the part of a customer receipt settled without cash (tax the
-- customer withheld, a bank charge, an approved small difference) and tax withheld
-- from a supplier payment. Additive; existing receipts and payments have none.

CREATE TABLE "ReceiptDeduction" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" TEXT,

    CONSTRAINT "ReceiptDeduction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReceiptDeduction_kind_check" CHECK ("kind" IN ('withholding', 'bank_charge', 'write_off')),
    CONSTRAINT "ReceiptDeduction_amount_check" CHECK ("amount" > 0)
);

CREATE TABLE "PaymentDeduction" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" TEXT,

    CONSTRAINT "PaymentDeduction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentDeduction_kind_check" CHECK ("kind" IN ('withholding')),
    CONSTRAINT "PaymentDeduction_amount_check" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "ReceiptDeduction_receiptId_kind_key" ON "ReceiptDeduction"("receiptId", "kind");
CREATE UNIQUE INDEX "PaymentDeduction_paymentId_kind_key" ON "PaymentDeduction"("paymentId", "kind");

ALTER TABLE "ReceiptDeduction" ADD CONSTRAINT "ReceiptDeduction_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "CustomerReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceiptDeduction" ADD CONSTRAINT "ReceiptDeduction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentDeduction" ADD CONSTRAINT "PaymentDeduction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "SupplierPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentDeduction" ADD CONSTRAINT "PaymentDeduction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Money documents are permanent: a deduction is corrected by reversing its receipt or
-- payment, like the allocations beside it.
CREATE TRIGGER "ReceiptDeduction_append_only" BEFORE UPDATE OR DELETE ON "ReceiptDeduction" FOR EACH ROW EXECUTE FUNCTION sales_append_only();
CREATE TRIGGER "PaymentDeduction_append_only" BEFORE UPDATE OR DELETE ON "PaymentDeduction" FOR EACH ROW EXECUTE FUNCTION sales_append_only();

-- Deductions never reach the full amount: some of the money must actually move.
CREATE OR REPLACE FUNCTION accounting_deduction_cap() RETURNS trigger AS $$
DECLARE used numeric; cap numeric;
BEGIN
  IF TG_TABLE_NAME = 'ReceiptDeduction' THEN
    SELECT coalesce(sum("amount"), 0) INTO used FROM "ReceiptDeduction" WHERE "receiptId" = NEW."receiptId";
    SELECT "amount" INTO cap FROM "CustomerReceipt" WHERE "id" = NEW."receiptId";
  ELSE
    SELECT coalesce(sum("amount"), 0) INTO used FROM "PaymentDeduction" WHERE "paymentId" = NEW."paymentId";
    SELECT "amount" INTO cap FROM "SupplierPayment" WHERE "id" = NEW."paymentId";
  END IF;
  IF used >= cap THEN RAISE EXCEPTION 'deducted % of %', used, cap USING ERRCODE = 'check_violation'; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ReceiptDeduction_cap" AFTER INSERT ON "ReceiptDeduction" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_deduction_cap();
CREATE CONSTRAINT TRIGGER "PaymentDeduction_cap" AFTER INSERT ON "PaymentDeduction" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_deduction_cap();
