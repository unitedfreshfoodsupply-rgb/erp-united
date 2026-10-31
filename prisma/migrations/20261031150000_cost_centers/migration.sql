-- Cost centers: a reporting dimension on revenue and expense lines (expenses, service
-- bills, manual journals, depreciation of an asset assigned to one). Inventory valuation
-- and product cost are not touched. Additive.

CREATE TABLE "CostCenter" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "parentId" TEXT,
    "warehouseId" TEXT,
    "vehicleId" TEXT,
    "departmentId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostCenter_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CostCenter_kind_known" CHECK ("kind" IN ('warehouse', 'transport', 'vehicle', 'operations', 'department', 'administration', 'sales', 'other')),
    CONSTRAINT "CostCenter_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id")
);
CREATE UNIQUE INDEX "CostCenter_code_key" ON "CostCenter"("code");
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CostCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "CostCenter_no_delete" BEFORE DELETE ON "CostCenter" FOR EACH ROW EXECUTE FUNCTION sales_append_only();
ALTER TABLE "CostCenter" ENABLE ROW LEVEL SECURITY;

-- Where a cost center can come from.
ALTER TABLE "JournalLine" ADD COLUMN "costCenterId" TEXT;
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "JournalLine_costCenterId_idx" ON "JournalLine"("costCenterId");
ALTER TABLE "Expense" ADD COLUMN "costCenterId" TEXT;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierBillServiceLine" ADD COLUMN "costCenterId" TEXT;
ALTER TABLE "SupplierBillServiceLine" ADD CONSTRAINT "SupplierBillServiceLine_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAsset" ADD COLUMN "costCenterId" TEXT;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Journal lines stay append-only, the cost center included; a cost center sits only on a
-- revenue or expense line (balance-sheet accounts are not analysed by it).
CREATE OR REPLACE FUNCTION accounting_line_guard() RETURNS trigger AS $$
DECLARE acc record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'JournalLine is append-only' USING ERRCODE = 'restrict_violation'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."entryId", NEW."accountId", NEW."debit", NEW."credit", NEW."partyType", NEW."partyId", NEW."description", NEW."costCenterId") IS DISTINCT FROM (OLD."entryId", OLD."accountId", OLD."debit", OLD."credit", OLD."partyType", OLD."partyId", OLD."description", OLD."costCenterId") THEN
      RAISE EXCEPTION 'JournalLine is append-only (only the reconciliation mark may change)' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "postable", "active", "code", "type" INTO acc FROM "Account" WHERE "id" = NEW."accountId";
  IF NOT acc."postable" OR NOT acc."active" THEN
    RAISE EXCEPTION 'account % takes no postings', acc."code" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."costCenterId" IS NOT NULL AND acc."type" NOT IN ('revenue', 'expense') THEN
    RAISE EXCEPTION 'a cost center goes on revenue or expense lines only (account %)', acc."code" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
