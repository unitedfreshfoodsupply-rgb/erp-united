-- The boards read open orders plus orders closed in the last days (lib/orders-service.ts
-- boardScope / productionScope); "closed recently" is found by updatedAt.
BEGIN;
CREATE INDEX "Order_updatedAt_idx" ON "Order"("updatedAt");
COMMIT;
