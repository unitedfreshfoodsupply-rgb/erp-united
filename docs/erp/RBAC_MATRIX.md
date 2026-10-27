# RBAC matrix

Generated from the code by `npx tsx scripts/rbac/matrix.ts` — do not edit by hand.
Enforcement is verified end to end by `tests/security.test.ts` (every handler × every role that lacks its permission).

## Roles × permissions

| Permission | SUPER_ADMIN | SUPERVISOR | STOCK_CONTROLLER | PREPARER | LOADER | SALES | ACCOUNTANT | PURCHASER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `orders.view` — عرض الأوردرات | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| `orders.create` — إنشاء أوردر | ✓ | ✓ |  |  |  | ✓ |  |  |
| `orders.edit` — تعديل أوردر | ✓ | ✓ |  |  |  |  |  |  |
| `orders.approve` — اعتماد الفروقات | ✓ | ✓ |  |  |  |  |  |  |
| `orders.prepare` — تجهيز | ✓ | ✓ |  | ✓ |  |  |  |  |
| `orders.load` — تحميل | ✓ | ✓ |  |  | ✓ |  |  |  |
| `orders.dispatch` — تأكيد خروج العربية | ✓ | ✓ |  |  | ✓ |  |  |  |
| `stock.view` — عرض المخزون | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| `stock.receive` — تسجيل استلام | ✓ | ✓ | ✓ |  |  |  |  |  |
| `stock.sort` — تعديل الفرز | ✓ | ✓ | ✓ |  |  |  |  |  |
| `stock.adjust` — تسوية المخزون | ✓ | ✓ | ✓ |  |  |  |  |  |
| `stock.manage_products` — إدارة أصناف المخزون | ✓ | ✓ | ✓ |  |  |  |  |  |
| `stock.manage_suppliers` — إدارة الموردين | ✓ | ✓ | ✓ |  |  |  |  |  |
| `stock.transfer` — تحويل بين الأماكن | ✓ | ✓ | ✓ |  |  |  |  |  |
| `stock.reserve` — حجز مخزون | ✓ | ✓ | ✓ |  |  |  |  |  |
| `stock.approve_adjustments` — اعتماد تسويات المخزون | ✓ | ✓ |  |  |  |  |  |  |
| `stock.valuation.view` — عرض تكلفة وقيمة المخزون | ✓ | ✓ |  |  |  |  | ✓ |  |
| `reports.view` — عرض التقارير | ✓ | ✓ |  |  |  |  |  |  |
| `reports.finance` — تقارير الإدارة المالية | ✓ |  |  |  |  |  | ✓ |  |
| `audit.view` — عرض سجل المراجعة | ✓ | ✓ |  |  |  |  | ✓ |  |
| `users.view` — عرض المستخدمين | ✓ |  |  |  |  |  |  |  |
| `users.create` — إنشاء مستخدم | ✓ |  |  |  |  |  |  |  |
| `users.edit` — تعديل مستخدم | ✓ |  |  |  |  |  |  |  |
| `users.disable` — إيقاف/تفعيل مستخدم | ✓ |  |  |  |  |  |  |  |
| `users.change_role` — تغيير الدور | ✓ |  |  |  |  |  |  |  |
| `settings.manage` — إدارة الصلاحيات | ✓ |  |  |  |  |  |  |  |
| `core.masterdata.view` — عرض البيانات الأساسية | ✓ |  |  |  |  |  |  |  |
| `core.masterdata.manage` — إدارة البيانات الأساسية | ✓ |  |  |  |  |  |  |  |
| `sales.customers.view` — عرض العملاء | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `sales.customers.manage` — إدارة العملاء | ✓ | ✓ |  |  |  | ✓ |  |  |
| `sales.pricing.view` — عرض الأسعار | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `sales.pricing.manage` — إدارة الأسعار | ✓ |  |  |  |  | ✓ |  |  |
| `sales.price_override` — تعديل سعر أوردر | ✓ |  |  |  |  | ✓ |  |  |
| `sales.quotations.view` — عرض عروض الأسعار | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `sales.quotations.manage` — إدارة عروض الأسعار | ✓ |  |  |  |  | ✓ |  |  |
| `sales.invoices.view` — عرض الفواتير | ✓ |  |  |  |  | ✓ | ✓ |  |
| `sales.invoices.manage` — إصدار الفواتير | ✓ |  |  |  |  |  | ✓ |  |
| `sales.tax.manage` — إدارة التصنيف الضريبي | ✓ |  |  |  |  |  | ✓ |  |
| `sales.credit.manage` — إدارة الائتمان | ✓ |  |  |  |  |  | ✓ |  |
| `purchasing.suppliers.view` — عرض الموردين | ✓ | ✓ |  |  |  |  | ✓ | ✓ |
| `purchasing.suppliers.manage` — إدارة الموردين (التجاري) | ✓ |  |  |  |  |  | ✓ | ✓ |
| `purchasing.prices.view` — عرض أسعار الشراء | ✓ | ✓ |  |  |  |  | ✓ | ✓ |
| `purchasing.prices.manage` — إدارة أسعار الموردين | ✓ |  |  |  |  |  |  | ✓ |
| `purchasing.rfq.manage` — طلبات عروض الأسعار | ✓ |  |  |  |  |  |  | ✓ |
| `purchasing.orders.view` — عرض أوامر الشراء | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| `purchasing.orders.manage` — إدارة أوامر الشراء | ✓ |  |  |  |  |  |  | ✓ |
| `purchasing.orders.approve` — اعتماد أوامر الشراء | ✓ |  |  |  |  |  | ✓ |  |
| `purchasing.bills.view` — عرض فواتير الموردين | ✓ |  |  |  |  |  | ✓ | ✓ |
| `purchasing.bills.manage` — تسجيل فواتير الموردين | ✓ |  |  |  |  |  | ✓ |  |
| `accounting.view` — عرض الحسابات | ✓ |  |  |  |  |  | ✓ |  |
| `accounting.manage` — إدارة الحسابات | ✓ |  |  |  |  |  | ✓ |  |
| `accounting.receipts.manage` — تحصيل من العملاء | ✓ |  |  |  |  |  | ✓ |  |
| `accounting.payments.manage` — سداد للموردين | ✓ |  |  |  |  |  | ✓ |  |
| `accounting.periods.close` — قفل الفترات المحاسبية | ✓ |  |  |  |  |  | ✓ |  |
| `accounting.eta.view` — متابعة الفاتورة الإلكترونية | ✓ | ✓ |  |  |  |  | ✓ |  |
| `accounting.eta.manage` — إرسال الفاتورة الإلكترونية | ✓ |  |  |  |  |  | ✓ |  |
| `hr.employees.manage` — إدارة الموظفين | ✓ |  |  |  |  |  | ✓ |  |
| `hr.expenses.submit` — تسجيل المصروفات | ✓ | ✓ |  |  |  |  | ✓ |  |
| `hr.expenses.approve` — اعتماد المصروفات | ✓ |  |  |  |  |  |  |  |
| `hr.advances.manage` — سلف ومستحقات الموظفين | ✓ |  |  |  |  |  | ✓ |  |
| `integrations.manage` — إدارة التكاملات | ✓ |  |  |  |  |  |  |  |
| `operations.trips.manage` — تخطيط الرحلات والأسطول | ✓ | ✓ |  |  |  |  |  |  |
| `purchasing.bills.approve` — اعتماد فروق فواتير الموردين | ✓ |  |  |  |  |  |  |  |

## Pages

| Page (permission) | مدير النظام | مشرف | مراقب المخزون | تجهيز | تحميل | مبيعات | حسابات | مشتريات |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `/prep` التجهيز (`orders.prepare`) | ✓ | ✓ |  | ✓ |  |  |  |  |
| `/load` التحميل (`orders.load`) | ✓ | ✓ |  |  | ✓ |  |  |  |
| `/production` إنتاج النهارده (`orders.view`) | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| `/production/sheet` شيت التجهيز الموحد (`orders.view`) | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| `/operations` التوزيع (`orders.view`) | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| `/supervisor` مركز التحكم (`reports.view`) | ✓ | ✓ |  |  |  |  |  |  |
| `/supervisor/exceptions` نواقص التجهيز (`reports.view`) | ✓ | ✓ |  |  |  |  |  |  |
| `/supervisor/report` تقرير اليوم (`reports.view`) | ✓ | ✓ |  |  |  |  |  |  |
| `/supervisor/audit` سجل المراجعة (`audit.view`) | ✓ | ✓ |  |  |  |  | ✓ |  |
| `/approvals` الموافقات (`orders.approve` / `stock.approve_adjustments` / `sales.credit.manage` / `purchasing.orders.approve` / `purchasing.bills.approve` / `hr.expenses.approve`; page open to all, filters itself) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/sales` العملاء (`sales.customers.view`) | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `/purchasing` المشتريات (`purchasing.orders.view`) | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| `/accounting` الحسابات (`accounting.view`) | ✓ |  |  |  |  |  | ✓ |  |
| `/eta` الفاتورة الإلكترونية (`accounting.eta.view`) | ✓ | ✓ |  |  |  |  | ✓ |  |
| `/hr` الموظفين والمصروفات (`hr.expenses.submit`) | ✓ | ✓ |  |  |  |  | ✓ |  |
| `/management` تقارير الإدارة (`reports.finance`) | ✓ |  |  |  |  |  | ✓ |  |
| `/management/operations` أداء التشغيل (`reports.view`) | ✓ | ✓ |  |  |  |  |  |  |
| `/stock` المخزون (`stock.view`) | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| `/stock/inventory` إدارة المخزون (`stock.view`) | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| `/stock/entries` الاستلامات (`stock.receive`) | ✓ | ✓ | ✓ |  |  |  |  |  |
| `/stock/ledger` سجل الحركات (`stock.view`) | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| `/stock/setup` دليل الأصناف (`stock.view`) | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| `/admin` الإدارة (`users.view`) | ✓ |  |  |  |  |  |  |  |

## API

| Method | Path | Gate | SUPER_ADMIN | SUPERVISOR | STOCK_CONTROLLER | PREPARER | LOADER | SALES | ACCOUNTANT | PURCHASER |
|---|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| GET | `/api/accounting/accounts/[id]/ledger` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/accounts` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/accounts` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/balance-sheet` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/cancelled-report` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/cash` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/customer-refunds` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/customer-refunds` | `accounting.payments.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/customers/[id]/open-invoices` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/integrity` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/journals/[id]/reverse` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/journals/[id]` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/journals` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/journals` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/opening-balances` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/opening-balances` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/opening-stock` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/payments/[id]/allocate` | `accounting.payments.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/payments/[id]/reverse` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/payments` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/payments` | `accounting.payments.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/periods/[code]/close` | `accounting.periods.close` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/periods` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/pnl` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/receipts/[id]/allocate` | `accounting.receipts.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/receipts/[id]/reverse` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/receipts` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/receipts` | `accounting.receipts.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/reconciliations/[id]/complete` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/reconciliations/[id]/mark` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/reconciliations/[id]` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/reconciliations` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/stock-valuation` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/supplier-refunds` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/supplier-refunds` | `accounting.receipts.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/suppliers/[id]/open-bills` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/accounting/sync` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/trial-balance` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/vat-summary/export` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/vat-summary` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/withholding/export` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/accounting/withholding` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/admin/data-import` | `users.view` + per import type: `accounting.manage`, `purchasing.prices.manage`, `purchasing.suppliers.manage`, `sales.credit.manage`, `sales.customers.manage`, `sales.pricing.manage`, `sales.tax.manage`, `stock.manage_products` | · | · | · | · | · | · | · | · |
| POST | `/api/admin/data-import` | `users.view` + per import type: `accounting.manage`, `purchasing.prices.manage`, `purchasing.suppliers.manage`, `sales.credit.manage`, `sales.customers.manage`, `sales.pricing.manage`, `sales.tax.manage`, `stock.manage_products` | · | · | · | · | · | · | · | · |
| POST | `/api/admin/integrations/[id]/revoke` | `integrations.manage` | ✓ |  |  |  |  |  |  |  |
| GET | `/api/admin/integrations` | `integrations.manage` | ✓ |  |  |  |  |  |  |  |
| POST | `/api/admin/integrations` | `integrations.manage` | ✓ |  |  |  |  |  |  |  |
| PATCH | `/api/admin/master/[entity]/[id]` | `core.masterdata.manage` | ✓ |  |  |  |  |  |  |  |
| POST | `/api/admin/master/[entity]` | `core.masterdata.manage` | ✓ |  |  |  |  |  |  |  |
| GET | `/api/admin/master` | `core.masterdata.view` | ✓ |  |  |  |  |  |  |  |
| GET | `/api/admin/overview` | `users.view` | ✓ |  |  |  |  |  |  |  |
| PATCH | `/api/admin/settings/[key]` | `settings.manage` | ✓ |  |  |  |  |  |  |  |
| GET | `/api/admin/settings` | `settings.manage` | ✓ |  |  |  |  |  |  |  |
| GET | `/api/admin/users/[id]/permissions` | `users.view` | ✓ |  |  |  |  |  |  |  |
| POST | `/api/admin/users/[id]/permissions` | `settings.manage` | ✓ |  |  |  |  |  |  |  |
| GET | `/api/admin/users/[id]` | `users.view` | ✓ |  |  |  |  |  |  |  |
| PATCH | `/api/admin/users/[id]` | per field: role → `users.change_role`, active → `users.disable`, name/username/password → `users.edit` | · | · | · | · | · | · | · | · |
| POST | `/api/admin/users/[id]/sessions/revoke` | `users.disable` | ✓ |  |  |  |  |  |  |  |
| GET | `/api/admin/users` | `users.view` | ✓ |  |  |  |  |  |  |  |
| POST | `/api/admin/users` | `users.create` | ✓ |  |  |  |  |  |  |  |
| POST | `/api/approvals/[id]/decide` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/api/approvals` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/api/attachments/[id]/download` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| DELETE | `/api/attachments/[id]` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/api/attachments` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| POST | `/api/attachments` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/api/audit` | `audit.view` | ✓ | ✓ |  |  |  |  | ✓ |  |
| POST | `/api/auth/login` | public | · | · | · | · | · | · | · | · |
| POST | `/api/auth/logout` | public | · | · | · | · | · | · | · | · |
| GET | `/api/auth/me` | public | · | · | · | · | · | · | · | · |
| GET | `/api/core/reference` | any of `core.masterdata.view`, `stock.view`, `orders.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| POST | `/api/eta/credit-notes/[id]/reconcile` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/eta/credit-notes/[id]/refresh` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/eta/credit-notes/[id]` | `accounting.eta.view` | ✓ | ✓ |  |  |  |  | ✓ |  |
| POST | `/api/eta/credit-notes/[id]/submit` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/eta/invoices/[id]/reconcile` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/eta/invoices/[id]/refresh` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/eta/invoices/[id]` | `accounting.eta.view` | ✓ | ✓ |  |  |  |  | ✓ |  |
| POST | `/api/eta/invoices/[id]/submit` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |
| PUT | `/api/eta/issuer` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |
| PUT | `/api/eta/items/[productId]` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |
| PUT | `/api/eta/receivers/[customerId]` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/eta` | `accounting.eta.view` | ✓ | ✓ |  |  |  |  | ✓ |  |
| PUT | `/api/eta/units/[code]` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/health` | public | · | · | · | · | · | · | · | · |
| POST | `/api/hr/departments` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |
| PATCH | `/api/hr/employees/[id]` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/hr/employees/[id]/statement` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/hr/employees` | `hr.expenses.submit` | ✓ | ✓ |  |  |  |  | ✓ |  |
| POST | `/api/hr/employees` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/hr/expense-accounts` | `hr.expenses.submit` | ✓ | ✓ |  |  |  |  | ✓ |  |
| GET | `/api/hr/expenses` | `hr.expenses.submit` | ✓ | ✓ |  |  |  |  | ✓ |  |
| POST | `/api/hr/expenses` | `hr.expenses.submit` | ✓ | ✓ |  |  |  |  | ✓ |  |
| POST | `/api/hr/transactions` | `hr.advances.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/integrations/orders/[externalId]` | integration key with scope `orders.status` only | · | · | · | · | · | · | · | · |
| POST | `/api/inventory/adjustments` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |
| POST | `/api/inventory/documents/[id]/reverse` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/inventory/documents` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| POST | `/api/inventory/exceptions/[id]/resolve` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/inventory/exceptions` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| PATCH | `/api/inventory/lots/[id]` | `stock.sort` | ✓ | ✓ | ✓ |  |  |  |  |  |
| POST | `/api/inventory/products/[id]/packagings` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/inventory/products/[id]` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| PATCH | `/api/inventory/products/[id]/settings` | any of `stock.manage_products`, `accounting.manage` | ✓ | ✓ | ✓ |  |  |  | ✓ |  |
| POST | `/api/inventory/release` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/inventory/reports/expiring` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| GET | `/api/inventory/reports/valuation/export` | `stock.valuation.view` | ✓ | ✓ |  |  |  |  | ✓ |  |
| GET | `/api/inventory/reports/valuation` | `stock.valuation.view` | ✓ | ✓ |  |  |  |  | ✓ |  |
| POST | `/api/inventory/reservations/[id]/release` | `stock.reserve` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/inventory/reservations` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| POST | `/api/inventory/reservations` | `stock.reserve` | ✓ | ✓ | ✓ |  |  |  |  |  |
| POST | `/api/inventory/returns` | `stock.receive` | ✓ | ✓ | ✓ |  |  |  |  |  |
| POST | `/api/inventory/scrap` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/inventory/stock` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| POST | `/api/inventory/transfers` | `stock.transfer` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/management/cash-flow` | `reports.finance` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/management/finance/export` | `reports.finance` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/management/finance` | `reports.finance` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/management/operations` | `reports.view` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/notifications/read` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/api/notifications` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| PATCH | `/api/operations/drivers/[id]` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/operations/drivers` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/operations/exceptions/[id]/assign` | `orders.approve` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/operations/exceptions/[id]/resolve` | `orders.approve` | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/operations/exceptions` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| POST | `/api/operations/exceptions` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| GET | `/api/operations/fleet` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| POST | `/api/operations/stops/[id]/delivery` | `orders.dispatch` | ✓ | ✓ |  |  | ✓ |  |  |  |
| POST | `/api/operations/trips/[id]/cancel` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/operations/trips/[id]/depart` | `orders.dispatch` | ✓ | ✓ |  |  | ✓ |  |  |  |
| POST | `/api/operations/trips/[id]/dispatch` | `orders.dispatch` | ✓ | ✓ |  |  | ✓ |  |  |  |
| POST | `/api/operations/trips/[id]/loaded` | `orders.load` | ✓ | ✓ |  |  | ✓ |  |  |  |
| GET | `/api/operations/trips/[id]` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| PUT | `/api/operations/trips/[id]` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/operations/trips/[id]/start-loading` | `orders.load` | ✓ | ✓ |  |  | ✓ |  |  |  |
| GET | `/api/operations/trips/plannable` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/operations/trips` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| POST | `/api/operations/trips` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |
| PATCH | `/api/operations/vehicles/[id]` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/operations/vehicles` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/orders/[id]/approve` | `orders.approve` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/orders/[id]/assign` | `orders.approve` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/orders/[id]/cancel` | `orders.edit` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/orders/[id]/clone` | `orders.create` | ✓ | ✓ |  |  |  | ✓ |  |  |
| POST | `/api/orders/[id]/items/[itemId]/load` | `orders.load` | ✓ | ✓ |  |  | ✓ |  |  |  |
| POST | `/api/orders/[id]/items/[itemId]/prepare` | `orders.prepare` | ✓ | ✓ |  | ✓ |  |  |  |  |
| PATCH | `/api/orders/[id]/items/[itemId]/price` | `sales.price_override` | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/orders/[id]/items/[itemId]/required` | `orders.edit` | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/orders/[id]/pricing` | `sales.pricing.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/orders/[id]/reopen` | `orders.edit` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/orders/[id]/reprice` | `sales.price_override` | ✓ |  |  |  |  | ✓ |  |  |
| GET | `/api/orders/[id]` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| PATCH | `/api/orders/[id]` | `orders.edit` | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/orders/[id]/status` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| GET | `/api/orders` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| POST | `/api/orders` | integration key, or `orders.create` | ✓ | ✓ |  |  |  | ✓ |  |  |
| GET | `/api/production/daily` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| GET | `/api/production/daily/sheet` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| POST | `/api/purchasing/bills/[id]/cancel` | `purchasing.bills.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/purchasing/bills/[id]/debit-notes` | `purchasing.bills.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/purchasing/bills/[id]/post` | `purchasing.bills.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/purchasing/bills/[id]` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ |
| PUT | `/api/purchasing/bills/[id]` | `purchasing.bills.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/purchasing/bills` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ |
| POST | `/api/purchasing/bills` | `purchasing.bills.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/purchasing/orders/[id]/cancel` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |
| POST | `/api/purchasing/orders/[id]/close` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |
| GET | `/api/purchasing/orders/[id]` | `purchasing.orders.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| PUT | `/api/purchasing/orders/[id]` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |
| POST | `/api/purchasing/orders/[id]/send` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |
| POST | `/api/purchasing/orders/[id]/submit` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |
| GET | `/api/purchasing/orders` | `purchasing.orders.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| POST | `/api/purchasing/orders` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |
| GET | `/api/purchasing/products/[id]/prices` | `purchasing.prices.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ |
| GET | `/api/purchasing/receiving` | `stock.receive` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/purchasing/reports/ap-aging` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ |
| POST | `/api/purchasing/rfqs/[id]/award` | `purchasing.rfq.manage` | ✓ |  |  |  |  |  |  | ✓ |
| POST | `/api/purchasing/rfqs/[id]/cancel` | `purchasing.rfq.manage` | ✓ |  |  |  |  |  |  | ✓ |
| POST | `/api/purchasing/rfqs/[id]/quotes` | `purchasing.rfq.manage` | ✓ |  |  |  |  |  |  | ✓ |
| GET | `/api/purchasing/rfqs/[id]` | any of `purchasing.rfq.manage`, `purchasing.prices.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ |
| POST | `/api/purchasing/rfqs/[id]/send` | `purchasing.rfq.manage` | ✓ |  |  |  |  |  |  | ✓ |
| GET | `/api/purchasing/rfqs` | any of `purchasing.rfq.manage`, `purchasing.prices.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ |
| POST | `/api/purchasing/rfqs` | `purchasing.rfq.manage` | ✓ |  |  |  |  |  |  | ✓ |
| GET | `/api/purchasing/suppliers/[id]/billable` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ |
| PATCH | `/api/purchasing/suppliers/[id]/contacts/[contactId]` | `purchasing.suppliers.manage` | ✓ |  |  |  |  |  | ✓ | ✓ |
| POST | `/api/purchasing/suppliers/[id]/contacts` | `purchasing.suppliers.manage` | ✓ |  |  |  |  |  | ✓ | ✓ |
| GET | `/api/purchasing/suppliers/[id]/prices` | `purchasing.prices.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ |
| POST | `/api/purchasing/suppliers/[id]/prices` | `purchasing.prices.manage` | ✓ |  |  |  |  |  |  | ✓ |
| GET | `/api/purchasing/suppliers/[id]` | `purchasing.suppliers.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ |
| PATCH | `/api/purchasing/suppliers/[id]` | `purchasing.suppliers.manage` | ✓ |  |  |  |  |  | ✓ | ✓ |
| GET | `/api/purchasing/suppliers/[id]/statement/export` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ |
| GET | `/api/purchasing/suppliers/[id]/statement` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ |
| GET | `/api/purchasing/suppliers` | `purchasing.suppliers.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ |
| POST | `/api/purchasing/suppliers` | `purchasing.suppliers.manage` | ✓ |  |  |  |  |  | ✓ | ✓ |
| GET | `/api/reports/daily` | `reports.view` | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/sales/catalog` | any of `sales.quotations.view`, `sales.pricing.view`, `purchasing.orders.view`, `purchasing.rfq.manage`, `purchasing.prices.view` | ✓ | ✓ | ✓ |  |  | ✓ | ✓ | ✓ |
| GET | `/api/sales/customer-groups` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/sales/customer-groups` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |
| POST | `/api/sales/customers/[id]/aliases` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |
| PATCH | `/api/sales/customers/[id]/contacts/[contactId]` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |
| POST | `/api/sales/customers/[id]/contacts` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |
| PATCH | `/api/sales/customers/[id]/credit` | `sales.credit.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/sales/customers/[id]/exposure` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| GET | `/api/sales/customers/[id]/history` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| PATCH | `/api/sales/customers/[id]/price-list` | `sales.pricing.manage` | ✓ |  |  |  |  | ✓ |  |  |
| GET | `/api/sales/customers/[id]` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| PATCH | `/api/sales/customers/[id]` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |
| GET | `/api/sales/customers/[id]/statement/export` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  |
| GET | `/api/sales/customers/[id]/statement` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  |
| DELETE | `/api/sales/customers/aliases/[aliasId]` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |
| POST | `/api/sales/customers/map` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |
| GET | `/api/sales/customers` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/sales/customers` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |
| GET | `/api/sales/customers/unmapped` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/sales/invoices/[id]/credit-notes` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/sales/invoices/[id]/issue` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/sales/invoices/[id]/recover` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/sales/invoices/[id]/reprice` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/sales/invoices/[id]` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  |
| POST | `/api/sales/invoices/[id]/void` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/sales/invoices` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  |
| POST | `/api/sales/invoices` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |
| GET | `/api/sales/invoices/to-invoice` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  |
| PATCH | `/api/sales/legal-entities/[id]` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |
| GET | `/api/sales/legal-entities` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/sales/legal-entities` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |
| POST | `/api/sales/price-lists/[id]/prices` | `sales.pricing.manage` | ✓ |  |  |  |  | ✓ |  |  |
| GET | `/api/sales/price-lists/[id]` | `sales.pricing.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| PATCH | `/api/sales/price-lists/[id]` | `sales.pricing.manage` | ✓ |  |  |  |  | ✓ |  |  |
| GET | `/api/sales/price-lists` | `sales.pricing.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/sales/price-lists` | `sales.pricing.manage` | ✓ |  |  |  |  | ✓ |  |  |
| PATCH | `/api/sales/products/[id]/tax` | `sales.tax.manage` | ✓ |  |  |  |  |  | ✓ |  |
| POST | `/api/sales/quotations/[id]/convert` | `sales.quotations.manage` | ✓ |  |  |  |  | ✓ |  |  |
| GET | `/api/sales/quotations/[id]` | `sales.quotations.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| PUT | `/api/sales/quotations/[id]` | `sales.quotations.manage` | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/sales/quotations/[id]/transition` | `sales.quotations.manage` | ✓ |  |  |  |  | ✓ |  |  |
| GET | `/api/sales/quotations` | `sales.quotations.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/sales/quotations` | `sales.quotations.manage` | ✓ |  |  |  |  | ✓ |  |  |
| GET | `/api/sales/reports/aging` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  |
| GET | `/api/sales/tax-rates` | `sales.pricing.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| GET | `/api/settings/operational` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| POST | `/api/stock/adjustments` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/stock/audit` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| GET | `/api/stock/dashboard` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| GET | `/api/stock/intakes/[id]` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| PATCH | `/api/stock/intakes/[id]` | `stock.sort` | ✓ | ✓ | ✓ |  |  |  |  |  |
| POST | `/api/stock/intakes/[id]/sort` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |
| POST | `/api/stock/intakes/[id]/void` | `stock.sort` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/stock/intakes` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| POST | `/api/stock/intakes` | `stock.receive` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/stock/ledger` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| DELETE | `/api/stock/products/[id]/aliases/[aliasId]` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |
| POST | `/api/stock/products/[id]/aliases` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |
| PATCH | `/api/stock/products/[id]` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/stock/products/coverage` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| POST | `/api/stock/products/mapping` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |
| DELETE | `/api/stock/products/mapping` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |
| POST | `/api/stock/products/resolve` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| GET | `/api/stock/products` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| POST | `/api/stock/products` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |
| PATCH | `/api/stock/suppliers/[id]` | `stock.manage_suppliers` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/stock/suppliers` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |
| POST | `/api/stock/suppliers` | `stock.manage_suppliers` | ✓ | ✓ | ✓ |  |  |  |  |  |
| GET | `/api/supervisor/intelligence` | `reports.view` | ✓ | ✓ |  |  |  |  |  |  |

`·` = decided per field / public; see the gate column.
