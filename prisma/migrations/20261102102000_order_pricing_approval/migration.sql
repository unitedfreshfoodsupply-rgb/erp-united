-- Remediation 2026-11: a line priced below its stock cost, or discounted above the
-- allowed limit, holds the order until someone else approves the price. Additive.
ALTER TABLE "Order" ADD COLUMN "pricingStatus" TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE "Order" ADD CONSTRAINT "Order_pricingStatus_known" CHECK ("pricingStatus" IN ('ok', 'pending_approval', 'rejected'));
