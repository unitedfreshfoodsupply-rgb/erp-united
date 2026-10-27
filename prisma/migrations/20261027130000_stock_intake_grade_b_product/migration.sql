-- StockIntake.gradeBProductId (the separate Grade-B SKU a sorted receipt's grade-B
-- output goes to) was added to schema.prisma in the grading release without a
-- migration. A database built by `prisma migrate deploy` therefore lacked the column,
-- and every default-select StockIntake query failed with P2022.
--
-- Additive and nullable: no existing row changes. Written idempotently because an
-- environment synced with `prisma db push` may already have the column/constraint.
-- This is exactly what `prisma migrate diff --from-migrations … --to-schema-datamodel …`
-- generates, plus the IF NOT EXISTS guards.
ALTER TABLE "StockIntake" ADD COLUMN IF NOT EXISTS "gradeBProductId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockIntake_gradeBProductId_fkey') THEN
    ALTER TABLE "StockIntake"
      ADD CONSTRAINT "StockIntake_gradeBProductId_fkey"
      FOREIGN KEY ("gradeBProductId") REFERENCES "StockProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
