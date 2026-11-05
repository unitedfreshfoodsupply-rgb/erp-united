-- Master data (Nov 2026): a third supplier category, "other" (services and non-produce
-- suppliers: maintenance companies, contractors, landlords, asset vendors). The CHECK of
-- 20261104100000_supplier_category is widened, nothing else: no row changes, every existing
-- value ('vegetable', 'fruit', NULL) stays valid. Same name, so the constraint stays one.
ALTER TABLE "Supplier" DROP CONSTRAINT "Supplier_category_known";
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_category_known" CHECK ("category" IS NULL OR "category" IN ('vegetable', 'fruit', 'other'));
