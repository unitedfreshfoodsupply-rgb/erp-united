-- ===========================================================================
-- Inventory engine (ERP Phase 2).
--
-- The stock ledger is EXTENDED, not replaced. StockMovement stays append-only and
-- remains the only source of balances; it gains a bucket (warehouse + location +
-- lot), a document link and a cost. Quantities become exact decimals.
--
-- Data safety:
--   * Columns are RENAMED and converted in place — never dropped and re-added.
--   * The float -> decimal conversion is checked first: every stored value must be
--     exactly representable at 3 decimals (the service always rounded to 3 dp).
--     If one is not, the migration stops and changes nothing.
--   * Existing movements and receipts are placed in WH-MAIN / RECV, unlotted.
--     That bucket's balance equals each product's balance today, so no historic
--     number changes. Operators then move stock to the cold rooms with transfers.
-- ===========================================================================

DO $$
DECLARE bad integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "StorageLocation" WHERE id = 'loc_recv' AND "warehouseId" = 'wh_main') THEN
    RAISE EXCEPTION 'Location loc_recv (WH-MAIN/RECV) is missing — it is created by migration add_org_master_data. Nothing was changed.';
  END IF;

  SELECT count(*) INTO bad FROM "StockMovement"
  WHERE abs("quantityKg"::numeric - round("quantityKg"::numeric, 3)) > 0.0000001;
  IF bad > 0 THEN
    RAISE EXCEPTION 'StockMovement: % row(s) hold quantities with more than 3 decimals; converting would change them. Nothing was changed. See docs/erp/MIGRATIONS.md "inventory engine".', bad;
  END IF;

  SELECT count(*) INTO bad FROM "StockIntake"
  WHERE abs("receivedKg"::numeric - round("receivedKg"::numeric, 3)) > 0.0000001
     OR abs("rejectedKg"::numeric - round("rejectedKg"::numeric, 3)) > 0.0000001
     OR abs("goodKg"::numeric - round("goodKg"::numeric, 3)) > 0.0000001;
  IF bad > 0 THEN
    RAISE EXCEPTION 'StockIntake: % row(s) hold quantities with more than 3 decimals; converting would change them. Nothing was changed.', bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Products: inventory behaviour
-- ---------------------------------------------------------------------------
ALTER TABLE "StockProduct" ADD COLUMN "coldChain" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "costingMethod" TEXT NOT NULL DEFAULT 'avco',
ADD COLUMN "maxStockQty" DECIMAL(18,3),
ADD COLUMN "minStockQty" DECIMAL(18,3),
ADD COLUMN "removalStrategy" TEXT NOT NULL DEFAULT 'fefo',
ADD COLUMN "reorderPointQty" DECIMAL(18,3),
ADD COLUMN "shelfLifeDays" INTEGER,
ADD COLUMN "standardCost" DECIMAL(18,4);

-- ---------------------------------------------------------------------------
-- Receipts: base-unit decimals, put-away location, lot, cost
-- ---------------------------------------------------------------------------
ALTER TABLE "StockIntake" DROP CONSTRAINT "StockIntake_good_is_derived";
ALTER TABLE "StockIntake" RENAME COLUMN "receivedKg" TO "receivedQty";
ALTER TABLE "StockIntake" RENAME COLUMN "rejectedKg" TO "rejectedQty";
ALTER TABLE "StockIntake" RENAME COLUMN "goodKg" TO "goodQty";
ALTER TABLE "StockIntake"
  ALTER COLUMN "receivedQty" TYPE DECIMAL(14,3) USING round("receivedQty"::numeric, 3),
  ALTER COLUMN "rejectedQty" TYPE DECIMAL(14,3) USING round("rejectedQty"::numeric, 3),
  ALTER COLUMN "goodQty" TYPE DECIMAL(14,3) USING round("goodQty"::numeric, 3);
ALTER TABLE "StockIntake"
  ADD COLUMN "enteredQty" DECIMAL(14,3),
  ADD COLUMN "enteredUom" TEXT,
  ADD COLUMN "unitCost" DECIMAL(18,4),
  ADD COLUMN "warehouseId" TEXT NOT NULL DEFAULT 'wh_main',
  ADD COLUMN "locationId" TEXT NOT NULL DEFAULT 'loc_recv',
  ADD COLUMN "lotId" TEXT;
ALTER TABLE "StockIntake" ALTER COLUMN "warehouseId" DROP DEFAULT, ALTER COLUMN "locationId" DROP DEFAULT;
-- Exact now that the arithmetic is decimal (the old check needed a float tolerance).
ALTER TABLE "StockIntake" ADD CONSTRAINT "StockIntake_good_is_derived" CHECK ("goodQty" = "receivedQty" - "rejectedQty");

-- ---------------------------------------------------------------------------
-- Ledger: base-unit decimals in a (warehouse, location, lot) bucket
-- ---------------------------------------------------------------------------
ALTER TABLE "StockMovement" RENAME COLUMN "quantityKg" TO "quantity";
ALTER TABLE "StockMovement" ALTER COLUMN "quantity" TYPE DECIMAL(18,3) USING round("quantity"::numeric, 3);
ALTER TABLE "StockMovement"
  ADD COLUMN "warehouseId" TEXT NOT NULL DEFAULT 'wh_main',
  ADD COLUMN "locationId" TEXT NOT NULL DEFAULT 'loc_recv',
  ADD COLUMN "lotId" TEXT,
  ADD COLUMN "documentId" TEXT,
  ADD COLUMN "unitCost" DECIMAL(18,4);
ALTER TABLE "StockMovement" ALTER COLUMN "warehouseId" DROP DEFAULT, ALTER COLUMN "locationId" DROP DEFAULT;

-- CreateTable
CREATE TABLE "ProductPackaging" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "uomCode" TEXT NOT NULL,
    "qtyInBaseUnit" DECIMAL(18,6) NOT NULL,
    "barcode" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPackaging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLot" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "receivedDate" TEXT NOT NULL,
    "expiryDate" TEXT,
    "supplierId" TEXT,
    "unitCost" DECIMAL(18,4),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryDocument" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "reason" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "supplierId" TEXT,
    "payload" JSONB,
    "idempotencyKey" TEXT,
    "reversalOfId" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" TIMESTAMP(3),

    CONSTRAINT "InventoryDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReservation" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceLineId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "closedReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockValuationLayer" (
    "id" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "value" DECIMAL(18,4) NOT NULL,
    "remainingQty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "costSource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockValuationLayer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductPackaging_barcode_key" ON "ProductPackaging"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPackaging_productId_uomCode_key" ON "ProductPackaging"("productId", "uomCode");

-- CreateIndex
CREATE INDEX "StockLot_productId_expiryDate_idx" ON "StockLot"("productId", "expiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "StockLot_productId_lotNumber_key" ON "StockLot"("productId", "lotNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryDocument_number_key" ON "InventoryDocument"("number");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryDocument_idempotencyKey_key" ON "InventoryDocument"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryDocument_reversalOfId_key" ON "InventoryDocument"("reversalOfId");

-- CreateIndex
CREATE INDEX "InventoryDocument_type_status_idx" ON "InventoryDocument"("type", "status");

-- CreateIndex
CREATE INDEX "InventoryDocument_sourceType_sourceId_idx" ON "InventoryDocument"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "InventoryDocument_businessDate_idx" ON "InventoryDocument"("businessDate");

-- CreateIndex
CREATE INDEX "StockReservation_productId_warehouseId_status_idx" ON "StockReservation"("productId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX "StockReservation_sourceType_sourceId_idx" ON "StockReservation"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockValuationLayer_movementId_key" ON "StockValuationLayer"("movementId");

-- CreateIndex
CREATE INDEX "StockValuationLayer_productId_createdAt_idx" ON "StockValuationLayer"("productId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockIntake_lotId_key" ON "StockIntake"("lotId");

-- CreateIndex
CREATE INDEX "StockMovement_productId_locationId_lotId_idx" ON "StockMovement"("productId", "locationId", "lotId");

-- CreateIndex
CREATE INDEX "StockMovement_documentId_idx" ON "StockMovement"("documentId");

-- AddForeignKey
ALTER TABLE "StockIntake" ADD CONSTRAINT "StockIntake_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockIntake" ADD CONSTRAINT "StockIntake_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StorageLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockIntake" ADD CONSTRAINT "StockIntake_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "StockLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StorageLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "StockLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "InventoryDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPackaging" ADD CONSTRAINT "ProductPackaging_productId_fkey" FOREIGN KEY ("productId") REFERENCES "StockProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPackaging" ADD CONSTRAINT "ProductPackaging_uomCode_fkey" FOREIGN KEY ("uomCode") REFERENCES "UnitOfMeasure"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "StockProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDocument" ADD CONSTRAINT "InventoryDocument_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDocument" ADD CONSTRAINT "InventoryDocument_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDocument" ADD CONSTRAINT "InventoryDocument_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "InventoryDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "StockProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockValuationLayer" ADD CONSTRAINT "StockValuationLayer_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockValuationLayer" ADD CONSTRAINT "StockValuationLayer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "StockProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Valuation for history: every existing movement gets a layer at an UNKNOWN cost
-- (the old system recorded no prices). Value 0, flagged 'unknown', so reports can
-- say "this much stock has no cost yet" instead of inventing one.
-- ---------------------------------------------------------------------------
INSERT INTO "StockValuationLayer" ("id", "movementId", "productId", "quantity", "unitCost", "value", "remainingQty", "costSource", "createdAt")
SELECT 'svl_' || m."id", m."id", m."productId", m."quantity", 0, 0,
       CASE WHEN m."quantity" > 0 THEN m."quantity" ELSE 0 END, 'unknown', m."createdAt"
FROM "StockMovement" m;

-- ---------------------------------------------------------------------------
-- Integrity
-- ---------------------------------------------------------------------------
ALTER TABLE "StockProduct" ADD CONSTRAINT "StockProduct_removalStrategy_known" CHECK ("removalStrategy" IN ('fefo', 'fifo'));
ALTER TABLE "StockProduct" ADD CONSTRAINT "StockProduct_costingMethod_known" CHECK ("costingMethod" IN ('avco', 'fifo', 'standard'));
ALTER TABLE "StockProduct" ADD CONSTRAINT "StockProduct_shelfLife_positive" CHECK ("shelfLifeDays" IS NULL OR "shelfLifeDays" > 0);
ALTER TABLE "StockProduct" ADD CONSTRAINT "StockProduct_stock_levels_non_negative" CHECK (
  coalesce("minStockQty", 0) >= 0 AND coalesce("reorderPointQty", 0) >= 0 AND coalesce("maxStockQty", 0) >= 0
  AND coalesce("standardCost", 0) >= 0
);
ALTER TABLE "StockProduct" ADD CONSTRAINT "StockProduct_standard_cost_required" CHECK ("costingMethod" <> 'standard' OR "standardCost" IS NOT NULL);

ALTER TABLE "StockIntake" ADD CONSTRAINT "StockIntake_unitCost_non_negative" CHECK ("unitCost" IS NULL OR "unitCost" >= 0);
ALTER TABLE "StockIntake" ADD CONSTRAINT "StockIntake_entered_pair" CHECK (("enteredQty" IS NULL) = ("enteredUom" IS NULL) AND coalesce("enteredQty", 1) > 0);

ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_kind_known";
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_kind_known" CHECK ("kind" IN (
  'intake', 'intake_correction', 'intake_void', 'adjustment',
  'transfer_out', 'transfer_in', 'issue', 'customer_return', 'supplier_return', 'scrap'
));
ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_intake_link_matches_kind";
-- Every movement explains itself: receipt rows point at their receipt; everything
-- else points at its document; adjustments and scrap always carry a reason.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_source_matches_kind" CHECK (
  ("kind" IN ('intake', 'intake_correction', 'intake_void') AND "intakeId" IS NOT NULL AND "documentId" IS NULL)
  OR ("kind" = 'adjustment' AND "intakeId" IS NULL AND length(btrim(coalesce("reason", ''))) > 0)
  OR ("kind" = 'scrap' AND "intakeId" IS NULL AND "documentId" IS NOT NULL AND length(btrim(coalesce("reason", ''))) > 0)
  OR ("kind" IN ('transfer_out', 'transfer_in', 'issue', 'customer_return', 'supplier_return') AND "intakeId" IS NULL AND "documentId" IS NOT NULL)
);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_direction_matches_kind" CHECK (
  ("kind" IN ('intake', 'transfer_in', 'customer_return') AND "quantity" > 0)
  OR ("kind" IN ('intake_void', 'transfer_out', 'issue', 'supplier_return', 'scrap') AND "quantity" < 0)
  OR "kind" IN ('intake_correction', 'adjustment')
);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_unitCost_non_negative" CHECK ("unitCost" IS NULL OR "unitCost" >= 0);

ALTER TABLE "ProductPackaging" ADD CONSTRAINT "ProductPackaging_qty_positive" CHECK ("qtyInBaseUnit" > 0);

ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_number_not_blank" CHECK (length(btrim("lotNumber")) > 0);
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_dates" CHECK (
  "receivedDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND ("expiryDate" IS NULL OR ("expiryDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "expiryDate" >= "receivedDate"))
);
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_unitCost_non_negative" CHECK ("unitCost" IS NULL OR "unitCost" >= 0);

ALTER TABLE "InventoryDocument" ADD CONSTRAINT "InventoryDocument_type_known" CHECK ("type" IN
  ('transfer', 'adjustment', 'scrap', 'customer_return', 'supplier_return', 'issue'));
ALTER TABLE "InventoryDocument" ADD CONSTRAINT "InventoryDocument_status_known" CHECK ("status" IN
  ('pending_approval', 'posted', 'rejected', 'reversed'));
ALTER TABLE "InventoryDocument" ADD CONSTRAINT "InventoryDocument_posted_has_time" CHECK ("status" NOT IN ('posted', 'reversed') OR "postedAt" IS NOT NULL);
ALTER TABLE "InventoryDocument" ADD CONSTRAINT "InventoryDocument_date_format" CHECK ("businessDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
ALTER TABLE "InventoryDocument" ADD CONSTRAINT "InventoryDocument_reason_where_required" CHECK (
  "type" NOT IN ('adjustment', 'scrap') OR length(btrim(coalesce("reason", ''))) > 0
);

ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_qty_positive" CHECK ("quantity" > 0);
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_status_known" CHECK ("status" IN ('active', 'released', 'consumed'));
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_closed_has_time" CHECK ("status" = 'active' OR "closedAt" IS NOT NULL);
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_source_known" CHECK ("sourceType" IN ('order', 'manual'));
-- One active reservation per order line.
CREATE UNIQUE INDEX "StockReservation_one_active_per_line"
  ON "StockReservation" ("sourceType", "sourceId", "sourceLineId") WHERE "status" = 'active' AND "sourceLineId" IS NOT NULL;

ALTER TABLE "StockValuationLayer" ADD CONSTRAINT "StockValuationLayer_costSource_known" CHECK ("costSource" IN
  ('purchase', 'average', 'standard', 'fifo', 'lot', 'unknown'));
ALTER TABLE "StockValuationLayer" ADD CONSTRAINT "StockValuationLayer_cost_non_negative" CHECK ("unitCost" >= 0);
ALTER TABLE "StockValuationLayer" ADD CONSTRAINT "StockValuationLayer_remaining_bounds" CHECK (
  "remainingQty" >= 0 AND ("quantity" <= 0 AND "remainingQty" = 0 OR "quantity" > 0 AND "remainingQty" <= "quantity")
);

-- ---------------------------------------------------------------------------
-- The ledger rule, in the database: a write may never take a bucket below zero.
-- The service checks this under per-bucket locks; this trigger makes it true for
-- ANY writer (a script, a hand fix, a future code path). Additions are never
-- refused, so a bucket that is already negative from before can still be refilled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stock_bucket_never_negative() RETURNS trigger AS $$
DECLARE balance numeric;
BEGIN
  IF NEW."quantity" >= 0 THEN RETURN NEW; END IF;
  SELECT coalesce(sum("quantity"), 0) INTO balance FROM "StockMovement"
  WHERE "productId" = NEW."productId" AND "locationId" = NEW."locationId"
    AND "lotId" IS NOT DISTINCT FROM NEW."lotId";
  IF balance < 0 THEN
    RAISE EXCEPTION 'stock bucket would go negative (product %, location %, lot %): balance %',
      NEW."productId", NEW."locationId", coalesce(NEW."lotId", '-'), balance
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "StockMovement_bucket_never_negative"
AFTER INSERT ON "StockMovement"
FOR EACH ROW EXECUTE FUNCTION stock_bucket_never_negative();

-- Append-only, enforced: ledger and valuation rows cannot be updated or deleted
-- (FIFO consumption updates only remainingQty on a layer).
CREATE OR REPLACE FUNCTION stock_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'StockMovement is append-only: post a compensating movement instead' USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "StockMovement_append_only" BEFORE UPDATE OR DELETE ON "StockMovement"
FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();

CREATE OR REPLACE FUNCTION stock_valuation_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'StockValuationLayer is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."movementId" <> OLD."movementId" OR NEW."productId" <> OLD."productId" OR NEW."quantity" <> OLD."quantity"
     OR NEW."unitCost" <> OLD."unitCost" OR NEW."value" <> OLD."value" OR NEW."costSource" <> OLD."costSource" THEN
    RAISE EXCEPTION 'StockValuationLayer: only remainingQty may change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "StockValuationLayer_append_only" BEFORE UPDATE OR DELETE ON "StockValuationLayer"
FOR EACH ROW EXECUTE FUNCTION stock_valuation_append_only();

-- Report (not fail) buckets that are already negative from before Phase 1 fixed the
-- void/correction path, so they can be corrected with an adjustment.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT "productId", sum("quantity") AS bal FROM "StockMovement" GROUP BY 1 HAVING sum("quantity") < 0 LOOP
    RAISE NOTICE 'Product % has a negative balance of % — correct it with an adjustment.', r."productId", r.bal;
  END LOOP;
END $$;

ALTER TABLE "ProductPackaging" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockLot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockReservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockValuationLayer" ENABLE ROW LEVEL SECURITY;
