-- Fixed assets: categories (policy + GL accounts), the register, its events, monthly
-- depreciation runs and lines, and capital lines on supplier service bills. Additive.

CREATE TABLE "AssetCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "depreciable" BOOLEAN NOT NULL DEFAULT true,
    "method" TEXT NOT NULL DEFAULT 'straight_line',
    "usefulLifeMonths" INTEGER NOT NULL,
    "residualPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "decliningRate" DECIMAL(5,2),
    "depreciationStart" TEXT NOT NULL,
    "capitalizationThreshold" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "assetAccountId" TEXT NOT NULL,
    "accumulatedAccountId" TEXT,
    "expenseAccountId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetCategory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AssetCategory_values" CHECK ("method" IN ('straight_line', 'declining_balance') AND "depreciationStart" IN ('same_month', 'next_month')
      AND "usefulLifeMonths" BETWEEN 1 AND 1200 AND "residualPercent" BETWEEN 0 AND 100 AND "capitalizationThreshold" >= 0
      AND ("method" <> 'declining_balance' OR ("decliningRate" > 0 AND "decliningRate" <= 100))
      AND (NOT "depreciable" OR ("accumulatedAccountId" IS NOT NULL AND "expenseAccountId" IS NOT NULL)))
);
CREATE UNIQUE INDEX "AssetCategory_code_key" ON "AssetCategory"("code");
CREATE UNIQUE INDEX "AssetCategory_assetAccountId_key" ON "AssetCategory"("assetAccountId");
CREATE UNIQUE INDEX "AssetCategory_accumulatedAccountId_key" ON "AssetCategory"("accumulatedAccountId");
ALTER TABLE "AssetCategory" ADD CONSTRAINT "AssetCategory_assetAccountId_fkey" FOREIGN KEY ("assetAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssetCategory" ADD CONSTRAINT "AssetCategory_accumulatedAccountId_fkey" FOREIGN KEY ("accumulatedAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssetCategory" ADD CONSTRAINT "AssetCategory_expenseAccountId_fkey" FOREIGN KEY ("expenseAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "FixedAsset" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "categoryId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "acquisitionDate" TEXT NOT NULL,
    "inServiceDate" TEXT,
    "cost" DECIMAL(18,2) NOT NULL,
    "residualValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "usefulLifeMonths" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "decliningRate" DECIMAL(5,2),
    "depreciationStart" TEXT NOT NULL,
    "accumulated" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "openingAccumulated" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "openingMonthsUsed" INTEGER NOT NULL DEFAULT 0,
    "warehouseId" TEXT,
    "location" TEXT,
    "custodianEmployeeId" TEXT,
    "vehicleId" TEXT,
    "supplierId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "serialNumber" TEXT,
    "plateNumber" TEXT,
    "notes" TEXT,
    "disposedDate" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FixedAsset_values" CHECK ("status" IN ('draft', 'in_service', 'disposed') AND "method" IN ('straight_line', 'declining_balance')
      AND "depreciationStart" IN ('same_month', 'next_month') AND "sourceType" IN ('supplier_bill', 'cash', 'opening')
      AND "cost" >= 0 AND "residualValue" >= 0 AND "accumulated" >= 0 AND "accumulated" <= "cost" AND "openingAccumulated" >= 0 AND "openingMonthsUsed" >= 0
      AND "usefulLifeMonths" BETWEEN 1 AND 1200
      AND ("status" <> 'in_service' OR "inServiceDate" IS NOT NULL) AND (("status" = 'disposed') = ("disposedDate" IS NOT NULL)))
);
CREATE UNIQUE INDEX "FixedAsset_number_key" ON "FixedAsset"("number");
CREATE INDEX "FixedAsset_categoryId_idx" ON "FixedAsset"("categoryId");
CREATE INDEX "FixedAsset_status_idx" ON "FixedAsset"("status");
-- A bill line buys at most one asset.
CREATE UNIQUE INDEX "FixedAsset_source_key" ON "FixedAsset"("sourceType", "sourceId") WHERE "sourceId" IS NOT NULL;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "AssetCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_custodianEmployeeId_fkey" FOREIGN KEY ("custodianEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An asset is never deleted, and a disposed asset never changes again.
CREATE OR REPLACE FUNCTION fixed_asset_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FixedAsset is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD."status" = 'disposed' THEN RAISE EXCEPTION 'a disposed asset is final' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW."number", NEW."categoryId", NEW."sourceType", NEW."sourceId", NEW."openingAccumulated", NEW."openingMonthsUsed") IS DISTINCT FROM (OLD."number", OLD."categoryId", OLD."sourceType", OLD."sourceId", OLD."openingAccumulated", OLD."openingMonthsUsed") THEN
    RAISE EXCEPTION 'an asset keeps its number, category and source' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Accumulated depreciation only grows — except when a run is reversed, and then only down
  -- to exactly what the asset's live (non-reversed) depreciation lines add up to.
  IF NEW."accumulated" < OLD."accumulated" AND NEW."status" <> 'disposed'
     AND NEW."accumulated" <> NEW."openingAccumulated" + coalesce((SELECT sum("amount") FROM "AssetDepreciationLine" WHERE "assetId" = NEW."id" AND NOT "reversed"), 0) THEN
    RAISE EXCEPTION 'accumulated depreciation only grows' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION fixed_asset_guard() FROM PUBLIC;
CREATE TRIGGER "FixedAsset_guard" BEFORE UPDATE OR DELETE ON "FixedAsset" FOR EACH ROW EXECUTE FUNCTION fixed_asset_guard();

CREATE TABLE "AssetEvent" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "costDelta" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "accumulatedDelta" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "proceeds" DECIMAL(18,2),
    "taxCode" TEXT,
    "taxRate" DECIMAL(5,2),
    "tax" DECIMAL(18,2),
    "gainLoss" DECIMAL(18,2),
    "cashAccountId" TEXT,
    "details" JSONB,
    "entryId" TEXT,
    "reason" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AssetEvent_type_known" CHECK ("type" IN ('acquisition', 'improvement', 'cost_adjustment', 'placed_in_service', 'transfer', 'disposal', 'opening', 'estimate_change', 'count'))
);
CREATE INDEX "AssetEvent_assetId_idx" ON "AssetEvent"("assetId");
CREATE INDEX "AssetEvent_type_date_idx" ON "AssetEvent"("type", "date");
ALTER TABLE "AssetEvent" ADD CONSTRAINT "AssetEvent_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FixedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssetEvent" ADD CONSTRAINT "AssetEvent_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssetEvent" ADD CONSTRAINT "AssetEvent_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "AssetEvent_append_only" BEFORE UPDATE OR DELETE ON "AssetEvent" FOR EACH ROW EXECUTE FUNCTION sales_append_only();

CREATE TABLE "DepreciationRun" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "entryId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedBy" TEXT,
    "reversalReason" TEXT,
    "reversalEntryId" TEXT,

    CONSTRAINT "DepreciationRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DepreciationRun_values" CHECK ("period" ~ '^\d{4}-\d{2}$' AND "total" > 0 AND "lineCount" > 0),
    CONSTRAINT "DepreciationRun_reversal_complete" CHECK (("reversedAt" IS NULL) = ("reversalEntryId" IS NULL) AND ("reversedAt" IS NULL) = ("reversalReason" IS NULL))
);
CREATE UNIQUE INDEX "DepreciationRun_number_key" ON "DepreciationRun"("number");
-- A month may run more than once (an asset placed in service after its first run); what
-- is unique is one depreciation per asset and month (AssetDepreciationLine below).
CREATE INDEX "DepreciationRun_period_idx" ON "DepreciationRun"("period");
CREATE UNIQUE INDEX "DepreciationRun_entryId_key" ON "DepreciationRun"("entryId");
CREATE UNIQUE INDEX "DepreciationRun_reversalEntryId_key" ON "DepreciationRun"("reversalEntryId");
ALTER TABLE "DepreciationRun" ADD CONSTRAINT "DepreciationRun_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DepreciationRun" ADD CONSTRAINT "DepreciationRun_reversalEntryId_fkey" FOREIGN KEY ("reversalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A run is permanent; the only change it ever takes is being reversed, once.
CREATE OR REPLACE FUNCTION depreciation_run_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DepreciationRun is permanent' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD."reversedAt" IS NOT NULL THEN RAISE EXCEPTION 'a reversed depreciation run is final' USING ERRCODE = 'restrict_violation'; END IF;
  IF (NEW."id", NEW."number", NEW."period", NEW."date", NEW."total", NEW."lineCount", NEW."entryId", NEW."createdById", NEW."createdBy", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."number", OLD."period", OLD."date", OLD."total", OLD."lineCount", OLD."entryId", OLD."createdById", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'a depreciation run keeps what it posted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION depreciation_run_guard() FROM PUBLIC;
CREATE TRIGGER "DepreciationRun_guard" BEFORE UPDATE OR DELETE ON "DepreciationRun" FOR EACH ROW EXECUTE FUNCTION depreciation_run_guard();

CREATE TABLE "AssetDepreciationLine" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "runId" TEXT,
    "disposalEventId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "accumulatedAfter" DECIMAL(18,2) NOT NULL,
    "entryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AssetDepreciationLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AssetDepreciationLine_values" CHECK ("period" ~ '^\d{4}-\d{2}$' AND "amount" > 0 AND "accumulatedAfter" > 0 AND (("runId" IS NULL) <> ("disposalEventId" IS NULL)))
);
-- One live depreciation per asset per month, whatever posted it (a reversed run's lines
-- step aside so the month can be depreciated again).
CREATE UNIQUE INDEX "AssetDepreciationLine_assetId_period_key" ON "AssetDepreciationLine"("assetId", "period") WHERE NOT "reversed";
CREATE INDEX "AssetDepreciationLine_assetId_period_idx" ON "AssetDepreciationLine"("assetId", "period");
CREATE INDEX "AssetDepreciationLine_runId_idx" ON "AssetDepreciationLine"("runId");
ALTER TABLE "AssetDepreciationLine" ADD CONSTRAINT "AssetDepreciationLine_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FixedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssetDepreciationLine" ADD CONSTRAINT "AssetDepreciationLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DepreciationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssetDepreciationLine" ADD CONSTRAINT "AssetDepreciationLine_disposalEventId_fkey" FOREIGN KEY ("disposalEventId") REFERENCES "AssetEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssetDepreciationLine" ADD CONSTRAINT "AssetDepreciationLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Append-only; the one change allowed is a run's line being marked reversed (with its run,
-- never a disposal's catch-up line).
CREATE OR REPLACE FUNCTION depreciation_line_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AssetDepreciationLine is append-only' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD."reversed" OR NOT NEW."reversed" OR OLD."runId" IS NULL
     OR (NEW."id", NEW."assetId", NEW."period", NEW."runId", NEW."disposalEventId", NEW."amount", NEW."accumulatedAfter", NEW."entryId", NEW."createdAt")
        IS DISTINCT FROM (OLD."id", OLD."assetId", OLD."period", OLD."runId", OLD."disposalEventId", OLD."amount", OLD."accumulatedAfter", OLD."entryId", OLD."createdAt") THEN
    RAISE EXCEPTION 'AssetDepreciationLine is append-only (a run line may only be marked reversed)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "DepreciationRun" r WHERE r."id" = NEW."runId" AND r."reversalEntryId" IS NOT NULL) THEN
    RAISE EXCEPTION 'a line is reversed only with its run' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;
REVOKE EXECUTE ON FUNCTION depreciation_line_guard() FROM PUBLIC;
CREATE TRIGGER "AssetDepreciationLine_guard" BEFORE UPDATE OR DELETE ON "AssetDepreciationLine" FOR EACH ROW EXECUTE FUNCTION depreciation_line_guard();

-- Supplier service bills: a line may buy a new asset of a category, or improve an asset.
ALTER TABLE "SupplierBillServiceLine" ADD COLUMN "assetCategoryId" TEXT;
ALTER TABLE "SupplierBillServiceLine" ADD COLUMN "assetName" TEXT;
ALTER TABLE "SupplierBillServiceLine" ADD COLUMN "improvesAssetId" TEXT;
ALTER TABLE "SupplierBillServiceLine" ADD CONSTRAINT "SupplierBillServiceLine_capital" CHECK ("assetCategoryId" IS NULL OR "improvesAssetId" IS NULL);
ALTER TABLE "SupplierBillServiceLine" ADD CONSTRAINT "SupplierBillServiceLine_assetCategoryId_fkey" FOREIGN KEY ("assetCategoryId") REFERENCES "AssetCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierBillServiceLine" ADD CONSTRAINT "SupplierBillServiceLine_improvesAssetId_fkey" FOREIGN KEY ("improvesAssetId") REFERENCES "FixedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AssetCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FixedAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DepreciationRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetDepreciationLine" ENABLE ROW LEVEL SECURITY;
