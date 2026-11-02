-- WS3 (remediation 2026-11) ACC-E1 — provisional receipt cost and revaluation by the bill.
-- Additive: a flag on the receipt, a revaluation record, a link from the stock ledger to it,
-- and two new movement kinds / two new valuation cost sources. The CHECK constraints below
-- are replaced by strict supersets of themselves (every row valid before stays valid);
-- nothing existing is rewritten — 'unknown' layers from before stay as they are, reported.

-- 1. The receipt says whether its cost is provisional (no price agreed when it arrived).
ALTER TABLE "StockIntake" ADD COLUMN "costProvisional" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StockIntake" ADD CONSTRAINT "StockIntake_provisional_has_cost" CHECK (NOT "costProvisional" OR ("unitCost" IS NOT NULL AND "unitCost" > 0));

-- 2. The revaluation record.
CREATE TABLE "StockRevaluation" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "billLineId" TEXT NOT NULL,
    "debitNoteId" TEXT,
    "intakeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "basisQty" DECIMAL(18,3) NOT NULL,
    "onHandQty" DECIMAL(18,3) NOT NULL,
    "provisionalUnitCost" DECIMAL(18,4) NOT NULL,
    "unitDelta" DECIMAL(18,6) NOT NULL,
    "delta" DECIMAL(18,2) NOT NULL,
    "inventoryDelta" DECIMAL(18,2) NOT NULL,
    "cogsDelta" DECIMAL(18,2) NOT NULL,
    "adjustmentDelta" DECIMAL(18,2) NOT NULL,
    "ppvDelta" DECIMAL(18,2) NOT NULL,
    "reversalOfId" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockRevaluation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockRevaluation_source_known" CHECK (
      ("sourceType" = 'supplier_bill' AND "debitNoteId" IS NULL AND "reversalOfId" IS NULL)
      OR ("sourceType" = 'debit_note' AND "debitNoteId" IS NOT NULL AND "reversalOfId" IS NOT NULL)
    ),
    CONSTRAINT "StockRevaluation_parts_add_up" CHECK ("delta" = "inventoryDelta" + "cogsDelta" + "adjustmentDelta" + "ppvDelta"),
    CONSTRAINT "StockRevaluation_quantities" CHECK ("basisQty" > 0 AND "onHandQty" >= 0 AND "onHandQty" <= "basisQty" AND "provisionalUnitCost" > 0),
    CONSTRAINT "StockRevaluation_date_format" CHECK ("date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
CREATE INDEX "StockRevaluation_billId_idx" ON "StockRevaluation"("billId");
CREATE INDEX "StockRevaluation_billLineId_idx" ON "StockRevaluation"("billLineId");
CREATE INDEX "StockRevaluation_debitNoteId_idx" ON "StockRevaluation"("debitNoteId");
CREATE INDEX "StockRevaluation_intakeId_idx" ON "StockRevaluation"("intakeId");
CREATE INDEX "StockRevaluation_productId_date_idx" ON "StockRevaluation"("productId", "date");
CREATE INDEX "StockRevaluation_reversalOfId_idx" ON "StockRevaluation"("reversalOfId");
-- A bill revalues each (line, product) once; a debit note reverses each once.
CREATE UNIQUE INDEX "StockRevaluation_once_per_bill_line" ON "StockRevaluation"("billLineId", "productId") WHERE "sourceType" = 'supplier_bill';
CREATE UNIQUE INDEX "StockRevaluation_once_per_debit_note" ON "StockRevaluation"("debitNoteId", "billLineId", "productId") WHERE "sourceType" = 'debit_note';
ALTER TABLE "StockRevaluation" ADD CONSTRAINT "StockRevaluation_billId_fkey" FOREIGN KEY ("billId") REFERENCES "SupplierBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockRevaluation" ADD CONSTRAINT "StockRevaluation_billLineId_fkey" FOREIGN KEY ("billLineId") REFERENCES "SupplierBillLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockRevaluation" ADD CONSTRAINT "StockRevaluation_debitNoteId_fkey" FOREIGN KEY ("debitNoteId") REFERENCES "DebitNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockRevaluation" ADD CONSTRAINT "StockRevaluation_intakeId_fkey" FOREIGN KEY ("intakeId") REFERENCES "StockIntake"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockRevaluation" ADD CONSTRAINT "StockRevaluation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "StockProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockRevaluation" ADD CONSTRAINT "StockRevaluation_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "StockRevaluation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Financial history: never deleted. (The service fills the posted inventory part in the
-- same transaction it creates the row, so updates are not blocked here.)
CREATE TRIGGER "StockRevaluation_no_delete" BEFORE DELETE ON "StockRevaluation" FOR EACH ROW EXECUTE FUNCTION sales_append_only();
ALTER TABLE "StockRevaluation" ENABLE ROW LEVEL SECURITY;

-- 3. The stock ledger: revaluation_out / revaluation_in pairs on a receipt's buckets, each
-- pointing at its receipt and its revaluation (the GL counter is GRNI, like the receipt).
ALTER TABLE "StockMovement" ADD COLUMN "revaluationId" TEXT;
CREATE INDEX "StockMovement_revaluationId_idx" ON "StockMovement"("revaluationId");
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_revaluationId_fkey" FOREIGN KEY ("revaluationId") REFERENCES "StockRevaluation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_kind_known";
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_kind_known" CHECK ("kind" IN
  ('intake', 'intake_correction', 'intake_void', 'adjustment',
   'transfer_out', 'transfer_in', 'issue', 'customer_return', 'supplier_return', 'scrap',
   'sorting_out', 'sorting_in', 'release_out', 'release_in', 'revaluation_out', 'revaluation_in'));

ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_direction_matches_kind";
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_direction_matches_kind" CHECK (
  ("kind" IN ('intake', 'transfer_in', 'customer_return', 'sorting_in', 'release_in', 'revaluation_in') AND "quantity" > 0)
  OR ("kind" IN ('intake_void', 'transfer_out', 'issue', 'supplier_return', 'scrap', 'sorting_out', 'release_out', 'revaluation_out') AND "quantity" < 0)
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
);
-- Only revaluation movements point at a revaluation.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_revaluation_link_matches_kind" CHECK ("revaluationId" IS NULL OR "kind" IN ('revaluation_out', 'revaluation_in'));

-- 4. Valuation layers: a receipt at a provisional cost, and the revalued side of a pair.
ALTER TABLE "StockValuationLayer" DROP CONSTRAINT "StockValuationLayer_costSource_known";
ALTER TABLE "StockValuationLayer" ADD CONSTRAINT "StockValuationLayer_costSource_known" CHECK ("costSource" IN
  ('purchase', 'average', 'standard', 'fifo', 'lot', 'unknown', 'provisional', 'revaluation'));
