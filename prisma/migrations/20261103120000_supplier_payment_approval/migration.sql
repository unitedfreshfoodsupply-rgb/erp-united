-- Maturity 2026-11 (ACC-04) — a supplier payment can wait for a second person.
--
-- Money leaving to a supplier was posted the moment it was recorded, by the same role that
-- keeps the supplier card and books the bills. With accounting.payment_approval on (the
-- default, like transfers and manual journals), a payment above the threshold is recorded as
-- a request first and posts only when someone other than the requester approves it.
-- Additive: one table. Nothing existing changes.

CREATE TABLE "SupplierPaymentRequest" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "cashAccountId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    -- What was asked: allocations, deductions and auto-allocation, re-validated at approval.
    "request" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "paymentId" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "requestedById" TEXT,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SupplierPaymentRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupplierPaymentRequest_status_known" CHECK ("status" IN ('pending_approval', 'posted', 'rejected')),
    CONSTRAINT "SupplierPaymentRequest_amount" CHECK ("amount" > 0),
    CONSTRAINT "SupplierPaymentRequest_date_format" CHECK ("date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    CONSTRAINT "SupplierPaymentRequest_posted_has_payment" CHECK (("status" = 'posted') = ("paymentId" IS NOT NULL))
);
CREATE UNIQUE INDEX "SupplierPaymentRequest_number_key" ON "SupplierPaymentRequest"("number");
CREATE UNIQUE INDEX "SupplierPaymentRequest_paymentId_key" ON "SupplierPaymentRequest"("paymentId");
CREATE UNIQUE INDEX "SupplierPaymentRequest_idempotencyKey_key" ON "SupplierPaymentRequest"("idempotencyKey");
CREATE INDEX "SupplierPaymentRequest_status_idx" ON "SupplierPaymentRequest"("status");
CREATE INDEX "SupplierPaymentRequest_supplierId_idx" ON "SupplierPaymentRequest"("supplierId");
ALTER TABLE "SupplierPaymentRequest" ADD CONSTRAINT "SupplierPaymentRequest_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPaymentRequest" ADD CONSTRAINT "SupplierPaymentRequest_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPaymentRequest" ADD CONSTRAINT "SupplierPaymentRequest_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "SupplierPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A request keeps what was asked; once decided it keeps its status; it is never deleted.
CREATE OR REPLACE FUNCTION supplier_payment_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SupplierPaymentRequest is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW."number", NEW."supplierId", NEW."cashAccountId", NEW."date", NEW."amount", NEW."method", NEW."request", NEW."requestedBy", NEW."idempotencyKey")
     IS DISTINCT FROM (OLD."number", OLD."supplierId", OLD."cashAccountId", OLD."date", OLD."amount", OLD."method", OLD."request", OLD."requestedBy", OLD."idempotencyKey") THEN
    RAISE EXCEPTION 'a payment request keeps what was asked' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'pending_approval' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'a decided payment request keeps its status' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION supplier_payment_request_guard() FROM PUBLIC;
CREATE TRIGGER "SupplierPaymentRequest_guard" BEFORE UPDATE OR DELETE ON "SupplierPaymentRequest" FOR EACH ROW EXECUTE FUNCTION supplier_payment_request_guard();

ALTER TABLE "SupplierPaymentRequest" ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "SupplierPaymentRequest" FROM %I', r);
    END IF;
  END LOOP;
END $$;
