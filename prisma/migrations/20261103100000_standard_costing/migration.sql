-- Maturity 2026-11 (DEFECT-SC-01) — standard costing done properly.
--
-- A standard-cost product is carried in stock at its standard, always:
--  * a purchase-linked movement (receipt, receipt correction/void, supplier return,
--    provisional revaluation) keeps GRNI at the actual price; the difference between the
--    actual and the standard is a purchase price variance, kept on the valuation layer
--    ("priceVariance") and posted to the chart's PPV system account;
--  * changing the standard while stock is on hand revalues that stock: a
--    standard_cost_out / standard_cost_in pair per bucket, recorded in StandardCostChange.
--
-- Additive: one column on the valuation layer (default 0), one link column on the stock
-- ledger, one append-only history table, two movement kinds. Every CHECK replaced below is
-- a strict superset of itself — every existing row stays valid; nothing is rewritten.

-- 1. The purchase price variance carried by a valuation layer (standard products only).
ALTER TABLE "StockValuationLayer" ADD COLUMN "priceVariance" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "StockValuationLayer" ADD CONSTRAINT "StockValuationLayer_variance_only_at_standard"
  CHECK ("priceVariance" = 0 OR "costSource" = 'standard');

-- The layer stays append-only: priceVariance joins the columns that may never change.
CREATE OR REPLACE FUNCTION stock_valuation_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'StockValuationLayer is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."movementId" <> OLD."movementId" OR NEW."productId" <> OLD."productId" OR NEW."quantity" <> OLD."quantity"
     OR NEW."unitCost" <> OLD."unitCost" OR NEW."value" <> OLD."value" OR NEW."costSource" <> OLD."costSource"
     OR NEW."priceVariance" <> OLD."priceVariance" THEN
    RAISE EXCEPTION 'StockValuationLayer: only remainingQty may change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, extensions, pg_temp;

-- 2. The history of a product's standard cost (who, when, why, what it revalued).
CREATE TABLE "StandardCostChange" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "oldStandardCost" DECIMAL(18,4),
    "newStandardCost" DECIMAL(18,4) NOT NULL,
    "effectiveDate" TEXT NOT NULL,
    "onHandQty" DECIMAL(18,3) NOT NULL,
    "revaluation" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandardCostChange_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StandardCostChange_values" CHECK (
      "newStandardCost" > 0 AND ("oldStandardCost" IS NULL OR "oldStandardCost" > 0)
      AND "onHandQty" >= 0 AND length(btrim("reason")) > 0
      AND "effectiveDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    )
);
CREATE INDEX "StandardCostChange_productId_createdAt_idx" ON "StandardCostChange"("productId", "createdAt");
ALTER TABLE "StandardCostChange" ADD CONSTRAINT "StandardCostChange_productId_fkey" FOREIGN KEY ("productId") REFERENCES "StockProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Financial history: never edited, never deleted.
CREATE TRIGGER "StandardCostChange_append_only" BEFORE UPDATE OR DELETE ON "StandardCostChange" FOR EACH ROW EXECUTE FUNCTION sales_append_only();
ALTER TABLE "StandardCostChange" ENABLE ROW LEVEL SECURITY;
-- Supabase API roles get nothing (skipped where the roles do not exist: local, CI).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "StandardCostChange" FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- 3. The stock ledger: standard_cost_out / standard_cost_in pairs point at their change.
ALTER TABLE "StockMovement" ADD COLUMN "standardCostChangeId" TEXT;
CREATE INDEX "StockMovement_standardCostChangeId_idx" ON "StockMovement"("standardCostChangeId");
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_standardCostChangeId_fkey" FOREIGN KEY ("standardCostChangeId") REFERENCES "StandardCostChange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_kind_known";
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_kind_known" CHECK ("kind" IN
  ('intake', 'intake_correction', 'intake_void', 'adjustment',
   'transfer_out', 'transfer_in', 'issue', 'customer_return', 'supplier_return', 'scrap',
   'sorting_out', 'sorting_in', 'release_out', 'release_in', 'revaluation_out', 'revaluation_in',
   'standard_cost_out', 'standard_cost_in'));

ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_direction_matches_kind";
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_direction_matches_kind" CHECK (
  ("kind" IN ('intake', 'transfer_in', 'customer_return', 'sorting_in', 'release_in', 'revaluation_in', 'standard_cost_in') AND "quantity" > 0)
  OR ("kind" IN ('intake_void', 'transfer_out', 'issue', 'supplier_return', 'scrap', 'sorting_out', 'release_out', 'revaluation_out', 'standard_cost_out') AND "quantity" < 0)
  OR "kind" IN ('intake_correction', 'adjustment')
);

ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_source_matches_kind";
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_source_matches_kind" CHECK (
  ("kind" IN ('intake', 'intake_correction', 'intake_void') AND "intakeId" IS NOT NULL AND "documentId" IS NULL)
  OR ("kind" = 'adjustment' AND "intakeId" IS NULL AND length(btrim(coalesce("reason", ''))) > 0)
  OR ("kind" = 'scrap' AND "intakeId" IS NULL AND "documentId" IS NOT NULL AND length(btrim(coalesce("reason", ''))) > 0)
  OR ("kind" IN ('transfer_out', 'transfer_in', 'issue', 'customer_return', 'supplier_return') AND "intakeId" IS NULL AND "documentId" IS NOT NULL)
  OR ("kind" IN ('sorting_out', 'sorting_in') AND "intakeId" IS NOT NULL AND "documentId" IS NOT NULL AND length(btrim(coalesce("reason", ''))) > 0)
  OR ("kind" IN ('release_out', 'release_in') AND "intakeId" IS NULL AND "documentId" IS NOT NULL AND length(btrim(coalesce("reason", ''))) > 0)
  OR ("kind" IN ('revaluation_out', 'revaluation_in') AND "intakeId" IS NOT NULL AND "documentId" IS NULL AND "revaluationId" IS NOT NULL AND length(btrim(coalesce("reason", ''))) > 0)
  OR ("kind" IN ('standard_cost_out', 'standard_cost_in') AND "intakeId" IS NULL AND "documentId" IS NULL AND "standardCostChangeId" IS NOT NULL AND length(btrim(coalesce("reason", ''))) > 0)
);
-- Only standard-cost movements point at a standard cost change.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_standard_change_link_matches_kind"
  CHECK ("standardCostChangeId" IS NULL OR "kind" IN ('standard_cost_out', 'standard_cost_in'));
