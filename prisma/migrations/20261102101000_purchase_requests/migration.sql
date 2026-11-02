-- Remediation 2026-11 (WF-01): demand the shelf cannot meet becomes a purchase request,
-- never a confirmed order line. Additive: one new table, its keys and its rules.
CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "productId" TEXT NOT NULL,
    "uomCode" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "customerId" TEXT,
    "orderId" TEXT,
    "customerReference" TEXT,
    "neededBy" TEXT,
    "notes" TEXT,
    "requestedById" TEXT,
    "requestedBy" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "purchaseOrderId" TEXT,
    "purchaseOrderLineId" TEXT,
    "fulfilledOrderId" TEXT,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseRequest_number_key" ON "PurchaseRequest"("number");
CREATE UNIQUE INDEX "PurchaseRequest_purchaseOrderLineId_key" ON "PurchaseRequest"("purchaseOrderLineId");
CREATE INDEX "PurchaseRequest_status_createdAt_idx" ON "PurchaseRequest"("status", "createdAt");
CREATE INDEX "PurchaseRequest_productId_idx" ON "PurchaseRequest"("productId");
CREATE INDEX "PurchaseRequest_customerId_idx" ON "PurchaseRequest"("customerId");
CREATE INDEX "PurchaseRequest_orderId_idx" ON "PurchaseRequest"("orderId");
CREATE INDEX "PurchaseRequest_purchaseOrderId_idx" ON "PurchaseRequest"("purchaseOrderId");
CREATE INDEX "PurchaseRequest_fulfilledOrderId_idx" ON "PurchaseRequest"("fulfilledOrderId");

ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "StockProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_fulfilledOrderId_fkey" FOREIGN KEY ("fulfilledOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_status_known"
  CHECK ("status" IN ('pending_approval', 'approved', 'rejected', 'cancelled', 'ordered', 'fulfilled'));
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_version_positive" CHECK ("version" >= 1);
-- Decided requests carry who and when; the requester never decides their own.
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_decided_attributed"
  CHECK ("status" IN ('pending_approval', 'cancelled') OR ("decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL));
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_decider_not_requester"
  CHECK ("decidedById" IS NULL OR "requestedById" IS NULL OR "decidedById" <> "requestedById");
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_ordered_linked"
  CHECK ("status" NOT IN ('ordered', 'fulfilled') OR ("purchaseOrderId" IS NOT NULL AND "purchaseOrderLineId" IS NOT NULL));
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_fulfilled_linked"
  CHECK ("status" <> 'fulfilled' OR "fulfilledOrderId" IS NOT NULL);
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_cancel_reasoned"
  CHECK ("status" <> 'cancelled' OR "cancelReason" IS NOT NULL);
