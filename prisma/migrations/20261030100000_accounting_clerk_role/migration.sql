-- Role ACCOUNTING_CLERK: records customer receipts and supplier payments without the
-- financial visibility of accounting.view (lib/permissions.ts). Additive: nobody's role
-- changes; the role's permission rows come from `npm run db:sync-permissions`.
BEGIN;
ALTER TABLE "User" DROP CONSTRAINT "User_role_known";
ALTER TABLE "User" ADD CONSTRAINT "User_role_known"
  CHECK ("role" IN ('SUPER_ADMIN', 'SUPERVISOR', 'STOCK_CONTROLLER', 'PREPARER', 'LOADER', 'SALES', 'ACCOUNTANT', 'PURCHASER', 'ACCOUNTING_CLERK'));
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_role_known";
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_role_known"
  CHECK ("role" IN ('SUPER_ADMIN', 'SUPERVISOR', 'STOCK_CONTROLLER', 'PREPARER', 'LOADER', 'SALES', 'ACCOUNTANT', 'PURCHASER', 'ACCOUNTING_CLERK'));
COMMIT;
