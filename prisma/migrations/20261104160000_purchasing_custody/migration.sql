-- Purchasing custody (عهدة شراء), Nov 2026. A buyer is given company money (an advance on
-- 1600 employee advances, party = employee), pays suppliers from it, and returns the rest.
--
-- Additive only: nullable or defaulted columns, one new request table, CHECKs, indexes. No row
-- is changed: every existing advance is a salary advance (the default), every existing
-- supplier payment keeps its cash account, and no employee has a purchasing category yet.
--
--  * Employee.purchasingCategory — which supplier category the buyer purchases for
--    ('vegetable' | 'fruit' | 'other'; NULL = not a buyer). Same values as Supplier.category.
--  * EmployeeTransaction.purpose — 'salary' (default: every existing row) or
--    'purchasing_custody' (an advance or a return of purchasing funds only), and a reference.
--  * EmployeeCustodyRequest — a custody advance waits here for a second person's approval
--    (approval type hr.custody_advance); the EmployeeTransaction and its journal are written
--    only when it is approved. EmployeeTransaction itself stays append-only.
--  * SupplierPayment / SupplierPaymentRequest — the money comes from EITHER a cash/bank account
--    OR an employee's custody (custodyEmployeeId): exactly one, enforced here.

-- Employee ------------------------------------------------------------------
ALTER TABLE "Employee" ADD COLUMN "purchasingCategory" TEXT;
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_purchasing_category_known" CHECK ("purchasingCategory" IS NULL OR "purchasingCategory" IN ('vegetable', 'fruit', 'other'));

-- EmployeeTransaction -------------------------------------------------------
-- A defaulted column: existing rows read 'salary' without being rewritten (no UPDATE fires).
ALTER TABLE "EmployeeTransaction" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'salary';
ALTER TABLE "EmployeeTransaction" ADD COLUMN "reference" TEXT;
ALTER TABLE "EmployeeTransaction" ADD CONSTRAINT "EmployeeTransaction_purpose_known" CHECK (
  "purpose" IN ('salary', 'purchasing_custody')
  AND ("purpose" = 'salary' OR "type" IN ('advance', 'advance_return'))
);
CREATE INDEX "EmployeeTransaction_employeeId_purpose_idx" ON "EmployeeTransaction"("employeeId", "purpose");

-- Custody advance requests ------------------------------------------------------
CREATE TABLE "EmployeeCustodyRequest" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "cashAccountId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL,
    "transactionId" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "requestedById" TEXT,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "EmployeeCustodyRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmployeeCustodyRequest_status_known" CHECK ("status" IN ('pending_approval', 'posted', 'rejected')),
    CONSTRAINT "EmployeeCustodyRequest_amount" CHECK ("amount" > 0),
    CONSTRAINT "EmployeeCustodyRequest_number_format" CHECK ("number" ~ '^CST-[0-9]{4}-[0-9]{5,}$'),
    CONSTRAINT "EmployeeCustodyRequest_date_format" CHECK ("date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    CONSTRAINT "EmployeeCustodyRequest_posted_has_transaction" CHECK (("status" = 'posted') = ("transactionId" IS NOT NULL)),
    -- Segregation of duties, also in the database: whoever asked never decides.
    CONSTRAINT "EmployeeCustodyRequest_decider_not_requester" CHECK ("decidedById" IS NULL OR "requestedById" IS NULL OR "decidedById" <> "requestedById")
);
CREATE UNIQUE INDEX "EmployeeCustodyRequest_number_key" ON "EmployeeCustodyRequest"("number");
CREATE UNIQUE INDEX "EmployeeCustodyRequest_transactionId_key" ON "EmployeeCustodyRequest"("transactionId");
CREATE UNIQUE INDEX "EmployeeCustodyRequest_idempotencyKey_key" ON "EmployeeCustodyRequest"("idempotencyKey");
CREATE INDEX "EmployeeCustodyRequest_status_idx" ON "EmployeeCustodyRequest"("status");
CREATE INDEX "EmployeeCustodyRequest_employeeId_idx" ON "EmployeeCustodyRequest"("employeeId");
ALTER TABLE "EmployeeCustodyRequest" ADD CONSTRAINT "EmployeeCustodyRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeCustodyRequest" ADD CONSTRAINT "EmployeeCustodyRequest_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeCustodyRequest" ADD CONSTRAINT "EmployeeCustodyRequest_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "EmployeeTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A request keeps what was asked; once decided it keeps its status; it is never deleted.
CREATE OR REPLACE FUNCTION employee_custody_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'EmployeeCustodyRequest is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW."number", NEW."employeeId", NEW."cashAccountId", NEW."date", NEW."amount", NEW."reference", NEW."requestedById", NEW."requestedBy", NEW."idempotencyKey")
     IS DISTINCT FROM (OLD."number", OLD."employeeId", OLD."cashAccountId", OLD."date", OLD."amount", OLD."reference", OLD."requestedById", OLD."requestedBy", OLD."idempotencyKey") THEN
    RAISE EXCEPTION 'a custody request keeps what was asked' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'pending_approval' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'a decided custody request keeps its status' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION employee_custody_request_guard() FROM PUBLIC;
CREATE TRIGGER "EmployeeCustodyRequest_guard" BEFORE UPDATE OR DELETE ON "EmployeeCustodyRequest" FOR EACH ROW EXECUTE FUNCTION employee_custody_request_guard();

ALTER TABLE "EmployeeCustodyRequest" ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "EmployeeCustodyRequest" FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- Supplier payments from custody ------------------------------------------------
-- The cash account becomes optional only together with a CHECK that exactly one source is
-- named; every existing row names a cash account and no custodian, so it passes unchanged.
ALTER TABLE "SupplierPayment" ADD COLUMN "custodyEmployeeId" TEXT;
ALTER TABLE "SupplierPayment" ALTER COLUMN "cashAccountId" DROP NOT NULL;
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_one_source" CHECK (("cashAccountId" IS NULL) <> ("custodyEmployeeId" IS NULL));
CREATE INDEX "SupplierPayment_custodyEmployeeId_idx" ON "SupplierPayment"("custodyEmployeeId");
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_custodyEmployeeId_fkey" FOREIGN KEY ("custodyEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierPaymentRequest" ADD COLUMN "custodyEmployeeId" TEXT;
ALTER TABLE "SupplierPaymentRequest" ALTER COLUMN "cashAccountId" DROP NOT NULL;
ALTER TABLE "SupplierPaymentRequest" ADD CONSTRAINT "SupplierPaymentRequest_one_source" CHECK (("cashAccountId" IS NULL) <> ("custodyEmployeeId" IS NULL));
CREATE INDEX "SupplierPaymentRequest_custodyEmployeeId_idx" ON "SupplierPaymentRequest"("custodyEmployeeId");
ALTER TABLE "SupplierPaymentRequest" ADD CONSTRAINT "SupplierPaymentRequest_custodyEmployeeId_fkey" FOREIGN KEY ("custodyEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The request guard (20261103120000) now also keeps the custodian as asked. Same rules otherwise.
CREATE OR REPLACE FUNCTION supplier_payment_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SupplierPaymentRequest is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW."number", NEW."supplierId", NEW."cashAccountId", NEW."custodyEmployeeId", NEW."date", NEW."amount", NEW."method", NEW."request", NEW."requestedBy", NEW."idempotencyKey")
     IS DISTINCT FROM (OLD."number", OLD."supplierId", OLD."cashAccountId", OLD."custodyEmployeeId", OLD."date", OLD."amount", OLD."method", OLD."request", OLD."requestedBy", OLD."idempotencyKey") THEN
    RAISE EXCEPTION 'a payment request keeps what was asked' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'pending_approval' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'a decided payment request keeps its status' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION supplier_payment_request_guard() FROM PUBLIC;
