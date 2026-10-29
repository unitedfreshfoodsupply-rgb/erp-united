-- Add 'grading' to the InventoryDocument.type CHECK constraint
-- so deferred grading operations can create grading documents.

ALTER TABLE "InventoryDocument" DROP CONSTRAINT "InventoryDocument_type_known";
ALTER TABLE "InventoryDocument" ADD CONSTRAINT "InventoryDocument_type_known"
  CHECK (type = ANY (ARRAY[
    'transfer',
    'adjustment',
    'scrap',
    'customer_return',
    'supplier_return',
    'issue',
    'grading'           -- NEW: deferred produce grading
  ]));