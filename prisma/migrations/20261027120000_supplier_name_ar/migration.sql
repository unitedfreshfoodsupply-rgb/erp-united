-- Suppliers get an optional Arabic name, matching Customer/StockProduct (name = English,
-- nameAr = Arabic). Additive and nullable: existing rows are untouched.
ALTER TABLE "Supplier" ADD COLUMN "nameAr" TEXT;
