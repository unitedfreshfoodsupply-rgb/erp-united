-- Customer PO intake and awaiting-stock orders (Nov 2026). Additive only: nullable or
-- defaulted columns, CHECKs, indexes, one foreign key. No data is changed — every existing
-- order is 'ok' (the default) and has no PO reference; every existing purchase request
-- keeps a NULL order line (it was raised by hand).

-- The customer's own PO reference on the order (searchable).
ALTER TABLE "Order" ADD COLUMN "customerPoRef" TEXT;
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerPoRef_length" CHECK ("customerPoRef" IS NULL OR char_length("customerPoRef") BETWEEN 1 AND 100);
CREATE INDEX "Order_customerPoRef_idx" ON "Order"("customerPoRef");

-- An order saved with lines the stock cannot cover yet waits as 'awaiting_stock' (reserves
-- nothing, cannot leave "new") until it is re-checked and released.
ALTER TABLE "Order" ADD COLUMN "stockStatus" TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE "Order" ADD CONSTRAINT "Order_stockStatus_known" CHECK ("stockStatus" IN ('ok', 'awaiting_stock'));
CREATE INDEX "Order_stockStatus_idx" ON "Order"("stockStatus");

-- A procurement suggestion names the order line whose shortage raised it, and what the line
-- asked / what was sellable when it was sized (base unit).
ALTER TABLE "PurchaseRequest" ADD COLUMN "orderItemId" TEXT;
ALTER TABLE "PurchaseRequest" ADD COLUMN "requiredQty" DECIMAL(18,3);
ALTER TABLE "PurchaseRequest" ADD COLUMN "availableQty" DECIMAL(18,3);
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_requiredQty_nonnegative" CHECK ("requiredQty" IS NULL OR "requiredQty" >= 0);
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_availableQty_nonnegative" CHECK ("availableQty" IS NULL OR "availableQty" >= 0);
-- A line suggestion belongs to that line's order.
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_line_has_order" CHECK ("orderItemId" IS NULL OR "orderId" IS NOT NULL);
CREATE INDEX "PurchaseRequest_orderItemId_idx" ON "PurchaseRequest"("orderItemId");
-- Idempotent suggestions: one open (pending approval / approved) request per order line.
CREATE UNIQUE INDEX "PurchaseRequest_one_open_per_order_line" ON "PurchaseRequest"("orderItemId") WHERE "orderItemId" IS NOT NULL AND "status" IN ('pending_approval', 'approved');
