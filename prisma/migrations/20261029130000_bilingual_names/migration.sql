-- Employees, departments and cash/bank accounts get a separate Arabic name, following the
-- schema's convention (name = English, nameAr = Arabic; lib/locale/names.ts picks by locale).
-- Additive and nullable. The two cash accounts the system seeds were created with Arabic in
-- `name`; when they still carry exactly the seeded text, it moves to nameAr and `name` gets
-- the English label. Any other row is untouched (an existing single name keeps showing in
-- both languages until someone enters the other one).
BEGIN;
ALTER TABLE "Employee" ADD COLUMN "nameAr" TEXT;
ALTER TABLE "Department" ADD COLUMN "nameAr" TEXT;
ALTER TABLE "CashAccount" ADD COLUMN "nameAr" TEXT;
UPDATE "CashAccount" SET "nameAr" = "name", "name" = 'Main cash' WHERE "id" = 'cash_main' AND "name" = 'الخزينة الرئيسية' AND "nameAr" IS NULL;
UPDATE "CashAccount" SET "nameAr" = "name", "name" = 'Bank account' WHERE "id" = 'bank_main' AND "name" = 'الحساب البنكي' AND "nameAr" IS NULL;
COMMIT;
