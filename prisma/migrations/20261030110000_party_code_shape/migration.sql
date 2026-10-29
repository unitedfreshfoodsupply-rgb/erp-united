-- Customer and supplier codes may come from the business's own records (data import) instead
-- of the generated CUS-/SUP- sequence: upper-case letters and digits with . _ - /, at most 40,
-- the same shape the import and the services validate. Generated codes still match; no row
-- changes. Widening only.
BEGIN;
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_code_shape";
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_code_shape" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$');
ALTER TABLE "Supplier" DROP CONSTRAINT "Supplier_code_shape";
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_code_shape" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$');
COMMIT;
