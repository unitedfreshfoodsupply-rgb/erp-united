# RBAC matrix

Generated from the code by `npx tsx scripts/rbac/matrix.ts` — do not edit by hand.
Enforcement is verified end to end by `tests/security.test.ts` (every handler × every role that lacks its permission).

## Roles × permissions

| Permission | SUPER_ADMIN | SUPERVISOR | STOCK_CONTROLLER | PREPARER | LOADER | SALES | ACCOUNTANT | PURCHASER | ACCOUNTING_CLERK |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `orders.view` — عرض الأوردرات | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| `orders.create` — إنشاء أوردر | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| `orders.edit` — تعديل أوردر | ✓ | ✓ |  |  |  |  |  |  |  |
| `orders.approve` — اعتماد الفروقات | ✓ | ✓ |  |  |  |  |  |  |  |
| `orders.prepare` — تجهيز | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| `orders.load` — تحميل | ✓ | ✓ |  |  | ✓ |  |  |  |  |
| `orders.dispatch` — تأكيد خروج العربية | ✓ | ✓ |  |  | ✓ |  |  |  |  |
| `stock.view` — عرض المخزون | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `stock.receive` — تسجيل استلام | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `stock.sort` — تعديل الفرز | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `stock.adjust` — تسوية المخزون | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `stock.manage_products` — إدارة أصناف المخزون | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `stock.manage_suppliers` — إدارة الموردين | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `stock.transfer` — تحويل بين الأماكن | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `stock.reserve` — حجز مخزون | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `stock.approve_adjustments` — اعتماد تسويات المخزون | ✓ | ✓ |  |  |  |  |  |  |  |
| `stock.valuation.view` — عرض تكلفة وقيمة المخزون | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| `reports.view` — عرض التقارير | ✓ | ✓ |  |  |  |  |  |  |  |
| `reports.finance` — تقارير الإدارة المالية | ✓ |  |  |  |  |  | ✓ |  |  |
| `audit.view` — عرض سجل المراجعة | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| `users.view` — عرض المستخدمين | ✓ |  |  |  |  |  |  |  |  |
| `users.create` — إنشاء مستخدم | ✓ |  |  |  |  |  |  |  |  |
| `users.edit` — تعديل مستخدم | ✓ |  |  |  |  |  |  |  |  |
| `users.disable` — إيقاف/تفعيل مستخدم | ✓ |  |  |  |  |  |  |  |  |
| `users.change_role` — تغيير الدور | ✓ |  |  |  |  |  |  |  |  |
| `settings.manage` — إدارة الصلاحيات | ✓ |  |  |  |  |  |  |  |  |
| `core.masterdata.view` — عرض البيانات الأساسية | ✓ |  |  |  |  |  |  |  |  |
| `core.masterdata.manage` — إدارة البيانات الأساسية | ✓ |  |  |  |  |  |  |  |  |
| `sales.customers.view` — عرض العملاء | ✓ | ✓ |  |  |  | ✓ | ✓ |  | ✓ |
| `sales.customers.manage` — إدارة العملاء | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| `sales.pricing.view` — عرض الأسعار | ✓ | ✓ |  |  |  | ✓ | ✓ |  |  |
| `sales.pricing.manage` — إدارة الأسعار | ✓ |  |  |  |  | ✓ |  |  |  |
| `sales.price_override` — تعديل سعر أوردر | ✓ |  |  |  |  | ✓ |  |  |  |
| `sales.quotations.view` — عرض عروض الأسعار | ✓ | ✓ |  |  |  | ✓ | ✓ |  |  |
| `sales.quotations.manage` — إدارة عروض الأسعار | ✓ |  |  |  |  | ✓ |  |  |  |
| `sales.invoices.view` — عرض الفواتير | ✓ |  |  |  |  | ✓ | ✓ |  | ✓ |
| `sales.invoices.manage` — إصدار الفواتير | ✓ |  |  |  |  |  | ✓ |  |  |
| `sales.tax.manage` — إدارة التصنيف الضريبي | ✓ |  |  |  |  |  | ✓ |  |  |
| `sales.credit.manage` — إدارة الائتمان | ✓ |  |  |  |  |  | ✓ |  |  |
| `purchasing.suppliers.view` — عرض الموردين | ✓ | ✓ |  |  |  |  | ✓ | ✓ | ✓ |
| `purchasing.suppliers.manage` — إدارة الموردين (التجاري) | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| `purchasing.prices.view` — عرض أسعار الشراء | ✓ | ✓ |  |  |  |  | ✓ | ✓ |  |
| `purchasing.prices.manage` — إدارة أسعار الموردين | ✓ |  |  |  |  |  |  | ✓ |  |
| `purchasing.rfq.manage` — طلبات عروض الأسعار | ✓ |  |  |  |  |  |  | ✓ |  |
| `purchasing.orders.view` — عرض أوامر الشراء | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `purchasing.orders.manage` — إدارة أوامر الشراء | ✓ |  |  |  |  |  |  | ✓ |  |
| `purchasing.orders.approve` — اعتماد أوامر الشراء | ✓ |  |  |  |  |  | ✓ |  |  |
| `purchasing.bills.view` — عرض فواتير الموردين | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |
| `purchasing.bills.manage` — تسجيل فواتير الموردين | ✓ |  |  |  |  |  | ✓ |  |  |
| `accounting.view` — عرض الحسابات | ✓ |  |  |  |  |  | ✓ |  |  |
| `accounting.manage` — إدارة الحسابات | ✓ |  |  |  |  |  | ✓ |  |  |
| `accounting.receipts.manage` — تحصيل من العملاء | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| `accounting.payments.manage` — سداد للموردين | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| `accounting.periods.close` — قفل الفترات المحاسبية | ✓ |  |  |  |  |  | ✓ |  |  |
| `accounting.periods.reopen` — إعادة فتح الفترات والسنوات | ✓ |  |  |  |  |  |  |  |  |
| `accounting.journals.approve` — اعتماد القيود اليدوية | ✓ |  |  |  |  |  | ✓ |  |  |
| `accounting.opening.approve` — اعتماد الأرصدة الافتتاحية | ✓ |  |  |  |  |  |  |  |  |
| `assets.view` — عرض الأصول الثابتة | ✓ |  |  |  |  |  | ✓ |  |  |
| `assets.manage` — إدارة الأصول الثابتة | ✓ |  |  |  |  |  | ✓ |  |  |
| `accounting.eta.view` — متابعة الفاتورة الإلكترونية | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| `accounting.eta.manage` — إرسال الفاتورة الإلكترونية | ✓ |  |  |  |  |  | ✓ |  |  |
| `hr.employees.manage` — إدارة الموظفين | ✓ |  |  |  |  |  | ✓ |  |  |
| `hr.expenses.submit` — تسجيل المصروفات | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| `hr.expenses.approve` — اعتماد المصروفات | ✓ |  |  |  |  |  |  |  |  |
| `hr.advances.manage` — سلف ومستحقات الموظفين | ✓ |  |  |  |  |  | ✓ |  |  |
| `hr.employees.view` — عرض ملفات الموظفين | ✓ |  |  |  |  |  | ✓ |  |  |
| `hr.private.view` — عرض البيانات الشخصية للموظفين | ✓ |  |  |  |  |  |  |  |  |
| `hr.private.manage` — تعديل البيانات الشخصية للموظفين | ✓ |  |  |  |  |  |  |  |  |
| `hr.attendance.record` — تسجيل الحضور | ✓ | ✓ |  |  |  |  |  |  |  |
| `hr.attendance.approve` — اعتماد تصحيح الحضور | ✓ |  |  |  |  |  |  |  |  |
| `hr.leave.request` — تسجيل طلبات الإجازة | ✓ |  |  |  |  |  | ✓ |  |  |
| `hr.leave.approve` — اعتماد الإجازات | ✓ |  |  |  |  |  |  |  |  |
| `hr.leave.configure` — إعداد أنواع وسياسات الإجازات | ✓ |  |  |  |  |  |  |  |  |
| `hr.compensation.view` — عرض المرتبات | ✓ |  |  |  |  |  | ✓ |  |  |
| `hr.compensation.manage` — اقتراح تعديل المرتبات | ✓ |  |  |  |  |  | ✓ |  |  |
| `hr.payroll.prepare` — تجهيز المرتبات | ✓ |  |  |  |  |  | ✓ |  |  |
| `hr.payroll.approve` — اعتماد المرتبات | ✓ |  |  |  |  |  |  |  |  |
| `hr.payroll.view` — عرض المرتبات المحسوبة | ✓ |  |  |  |  |  | ✓ |  |  |
| `hr.payroll.post` — ترحيل المرتبات | ✓ |  |  |  |  |  | ✓ |  |  |
| `hr.payroll.pay` — صرف المرتبات | ✓ |  |  |  |  |  | ✓ |  |  |
| `hr.statutory.manage` — القواعد القانونية للمرتبات | ✓ |  |  |  |  |  | ✓ |  |  |
| `integrations.manage` — إدارة التكاملات | ✓ |  |  |  |  |  |  |  |  |
| `operations.trips.manage` — تخطيط الرحلات والأسطول | ✓ | ✓ |  |  |  |  |  |  |  |
| `purchasing.bills.approve` — اعتماد فروق فواتير الموردين | ✓ |  |  |  |  |  |  |  |  |

## Pages

| Page (permission) | مدير النظام | مشرف | مراقب المخزون | تجهيز | تحميل | مبيعات | مدير الحسابات | مشتريات | موظف حسابات |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `/home` الرئيسية (`users.view` / `reports.view` / `reports.finance` / `sales.customers.view` / `purchasing.orders.view` / `accounting.view` / `accounting.receipts.manage` / `accounting.payments.manage` / `stock.view` / `hr.employees.view`) | ✓ | ✓ | ✓ |  |  | ✓ | ✓ | ✓ | ✓ |
| `/prep` التجهيز (`orders.prepare`) | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| `/load` التحميل (`orders.load`) | ✓ | ✓ |  |  | ✓ |  |  |  |  |
| `/production` إنتاج النهارده (`orders.view`) | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| `/production/sheet` شيت التجهيز الموحد (`orders.view`) | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| `/operations` التوزيع (`orders.view`) | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| `/supervisor` مركز التحكم (`reports.view`) | ✓ | ✓ |  |  |  |  |  |  |  |
| `/supervisor/exceptions` نواقص التجهيز (`reports.view`) | ✓ | ✓ |  |  |  |  |  |  |  |
| `/supervisor/report` تقرير اليوم (`reports.view`) | ✓ | ✓ |  |  |  |  |  |  |  |
| `/supervisor/audit` سجل المراجعة (`audit.view`) | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| `/approvals` الموافقات (`orders.approve` / `stock.approve_adjustments` / `sales.credit.manage` / `purchasing.orders.approve` / `purchasing.bills.approve` / `hr.expenses.approve` / `hr.attendance.approve` / `hr.leave.approve` / `hr.payroll.approve`; page open to all, filters itself) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/sales` العملاء (`sales.customers.view`) | ✓ | ✓ |  |  |  | ✓ | ✓ |  | ✓ |
| `/purchasing` المشتريات (`purchasing.orders.view`) | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `/accounting` الحسابات (`accounting.view` / `accounting.receipts.manage` / `accounting.payments.manage`) | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| `/eta` الفاتورة الإلكترونية (`accounting.eta.view`) | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| `/hr` الموظفين والمصروفات (`hr.expenses.submit`) | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| `/hr/attendance` الحضور والانصراف (`hr.attendance.record` / `hr.attendance.approve` / `hr.employees.manage`) | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| `/hr/leave` الإجازات (`hr.leave.request` / `hr.leave.approve` / `hr.leave.configure`) | ✓ |  |  |  |  |  | ✓ |  |  |
| `/hr/payroll` المرتبات (`hr.compensation.view` / `hr.compensation.manage` / `hr.payroll.prepare` / `hr.payroll.view` / `hr.payroll.approve` / `hr.payroll.post` / `hr.payroll.pay` / `hr.statutory.manage`) | ✓ |  |  |  |  |  | ✓ |  |  |
| `/management/overview` لوحة الأداء (`reports.finance`) | ✓ |  |  |  |  |  | ✓ |  |  |
| `/management` تقارير الإدارة (`reports.finance`) | ✓ |  |  |  |  |  | ✓ |  |  |
| `/management/operations` أداء التشغيل (`reports.view`) | ✓ | ✓ |  |  |  |  |  |  |  |
| `/stock` المخزون (`stock.view`) | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `/stock/inventory` إدارة المخزون (`stock.view`) | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `/stock/entries` الاستلامات (`stock.receive`) | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `/stock/ledger` سجل الحركات (`stock.view`) | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `/stock/setup` دليل الأصناف (`stock.view`) | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `/admin` الإدارة (`users.view`) | ✓ |  |  |  |  |  |  |  |  |

## API

| Method | Path | Gate | SUPER_ADMIN | SUPERVISOR | STOCK_CONTROLLER | PREPARER | LOADER | SALES | ACCOUNTANT | PURCHASER | ACCOUNTING_CLERK |
|---|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| GET | `/api/accounting/accounts/[id]/ledger` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| PATCH | `/api/accounting/accounts/[id]` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/accounts` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/accounts` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/balance-sheet` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/cancelled-report` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| PATCH | `/api/accounting/cash-accounts/[id]` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/cash-accounts` | any of `accounting.view`, `accounting.receipts.manage`, `accounting.payments.manage`, `hr.expenses.submit`, `hr.advances.manage`, `hr.payroll.pay` | ✓ | ✓ |  |  |  |  | ✓ |  | ✓ |
| POST | `/api/accounting/cash-accounts` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/cash` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/customer-refunds` | any of `accounting.view`, `accounting.payments.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| POST | `/api/accounting/customer-refunds` | `accounting.payments.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| GET | `/api/accounting/customers/[id]/open-invoices` | any of `accounting.view`, `accounting.receipts.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| GET | `/api/accounting/integrity` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/journal-requests/[id]/cancel` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/journal-requests` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/journals/[id]/reverse` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/journals/[id]` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/journals` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/journals` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/opening-balances` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/opening-balances` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/opening-stock` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/payments/[id]/allocate` | `accounting.payments.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| POST | `/api/accounting/payments/[id]/reverse` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/payments` | any of `accounting.view`, `accounting.payments.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| POST | `/api/accounting/payments` | `accounting.payments.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| POST | `/api/accounting/periods/[code]/close` | `accounting.periods.close` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/periods` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/pnl` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/receipts/[id]/allocate` | `accounting.receipts.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| POST | `/api/accounting/receipts/[id]/reverse` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/receipts` | any of `accounting.view`, `accounting.receipts.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| POST | `/api/accounting/receipts` | `accounting.receipts.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| POST | `/api/accounting/reconciliations/[id]/complete` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/reconciliations/[id]/mark` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/reconciliations/[id]` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/reconciliations` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/stock-valuation` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/supplier-refunds` | any of `accounting.view`, `accounting.receipts.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| POST | `/api/accounting/supplier-refunds` | `accounting.receipts.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| GET | `/api/accounting/suppliers/[id]/open-bills` | any of `accounting.view`, `accounting.payments.manage` | ✓ |  |  |  |  |  | ✓ |  | ✓ |
| POST | `/api/accounting/sync` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/transfers/[id]/reverse` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/transfers` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/transfers` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/trial-balance` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/vat-returns/[id]/pay` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/vat-returns/[id]/void` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/vat-returns/preview` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/vat-returns` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/accounting/vat-returns` | `accounting.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/vat-summary/export` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/vat-summary` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/withholding/export` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/accounting/withholding` | `accounting.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/admin/data-import` | `users.view` + per import type: `accounting.manage`, `purchasing.prices.manage`, `purchasing.suppliers.manage`, `sales.credit.manage`, `sales.customers.manage`, `sales.pricing.manage`, `sales.tax.manage`, `stock.manage_products` | · | · | · | · | · | · | · | · | · |
| POST | `/api/admin/data-import` | `users.view` + per import type: `accounting.manage`, `purchasing.prices.manage`, `purchasing.suppliers.manage`, `sales.credit.manage`, `sales.customers.manage`, `sales.pricing.manage`, `sales.tax.manage`, `stock.manage_products` | · | · | · | · | · | · | · | · | · |
| POST | `/api/admin/integrations/[id]/revoke` | `integrations.manage` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/admin/integrations` | `integrations.manage` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/admin/integrations` | `integrations.manage` | ✓ |  |  |  |  |  |  |  |  |
| PATCH | `/api/admin/master/[entity]/[id]` | `core.masterdata.manage` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/admin/master/[entity]` | `core.masterdata.manage` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/admin/master` | `core.masterdata.view` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/admin/overview` | `users.view` | ✓ |  |  |  |  |  |  |  |  |
| PATCH | `/api/admin/settings/[key]` | `settings.manage` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/admin/settings` | `settings.manage` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/admin/users/[id]/permissions` | `users.view` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/admin/users/[id]/permissions` | `settings.manage` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/admin/users/[id]` | `users.view` | ✓ |  |  |  |  |  |  |  |  |
| PATCH | `/api/admin/users/[id]` | per field: role → `users.change_role`, active → `users.disable`, name/username/password → `users.edit` | · | · | · | · | · | · | · | · | · |
| POST | `/api/admin/users/[id]/sessions/revoke` | `users.disable` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/admin/users` | `users.view` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/admin/users` | `users.create` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/approvals/[id]/decide` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/api/approvals` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/api/attachments/[id]/download` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| DELETE | `/api/attachments/[id]` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/api/attachments` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| POST | `/api/attachments` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/api/audit` | `audit.view` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/auth/login` | public | · | · | · | · | · | · | · | · | · |
| POST | `/api/auth/logout` | public | · | · | · | · | · | · | · | · | · |
| GET | `/api/auth/me` | public | · | · | · | · | · | · | · | · | · |
| GET | `/api/core/reference` | any of `core.masterdata.view`, `stock.view`, `orders.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| POST | `/api/eta/credit-notes/[id]/reconcile` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/eta/credit-notes/[id]/refresh` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/eta/credit-notes/[id]` | `accounting.eta.view` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/eta/credit-notes/[id]/submit` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/eta/invoices/[id]/reconcile` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/eta/invoices/[id]/refresh` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/eta/invoices/[id]` | `accounting.eta.view` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/eta/invoices/[id]/submit` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| PUT | `/api/eta/issuer` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| PUT | `/api/eta/items/[productId]` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| PUT | `/api/eta/receivers/[customerId]` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/eta` | `accounting.eta.view` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| PUT | `/api/eta/units/[code]` | `accounting.eta.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/health` | public | · | · | · | · | · | · | · | · | · |
| GET | `/api/home` | any of `users.view`, `reports.view`, `reports.finance`, `sales.customers.view`, `purchasing.orders.view`, `accounting.view`, `accounting.receipts.manage`, `accounting.payments.manage`, `stock.view`, `hr.employees.view` | ✓ | ✓ | ✓ |  |  | ✓ | ✓ | ✓ | ✓ |
| POST | `/api/hr/attendance/compile` | `hr.attendance.record` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/hr/attendance/confirm` | `hr.attendance.record` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/hr/attendance/corrections/[id]/cancel` | any of `hr.attendance.record`, `hr.attendance.approve` | ✓ | ✓ |  |  |  |  |  |  |  |
| GET | `/api/hr/attendance/corrections` | any of `hr.attendance.record`, `hr.attendance.approve`, `hr.employees.manage` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/attendance/corrections` | `hr.attendance.record` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/hr/attendance/days/[id]/reopen` | `hr.attendance.approve` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/hr/attendance/days/[id]` | any of `hr.attendance.record`, `hr.attendance.approve`, `hr.employees.manage` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/attendance/days` | `hr.attendance.record` | ✓ | ✓ |  |  |  |  |  |  |  |
| DELETE | `/api/hr/attendance/identities/[id]` | any of `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/attendance/identities` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/attendance/month` | any of `hr.attendance.record`, `hr.attendance.approve`, `hr.employees.manage` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/attendance` | any of `hr.attendance.record`, `hr.attendance.approve`, `hr.employees.manage` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/attendance/sources` | any of `hr.attendance.record`, `hr.attendance.approve`, `hr.employees.manage` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/attendance/sources` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/compensation/[id]/cancel` | any of `hr.compensation.manage`, `hr.payroll.approve` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/compensation` | any of `hr.compensation.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/compensation` | `hr.compensation.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/departments` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/documents/expiring` | `hr.private.view` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/hr/employees/[id]/bank-accounts/[accountId]/deactivate` | `hr.private.manage` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/hr/employees/[id]/bank-accounts/[accountId]/reveal` | `hr.private.view` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/hr/employees/[id]/bank-accounts` | `hr.private.manage` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/hr/employees/[id]/documents` | `hr.private.manage` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/hr/employees/[id]/employment` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/employees/[id]/private` | `hr.private.view` | ✓ |  |  |  |  |  |  |  |  |
| PATCH | `/api/hr/employees/[id]/private` | `hr.private.manage` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/hr/employees/[id]` | any of `hr.employees.view`, `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| PATCH | `/api/hr/employees/[id]` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/employees/[id]/statement` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/employees` | any of `hr.expenses.submit`, `hr.employees.view` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/employees` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/expense-accounts` | `hr.expenses.submit` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/expenses` | `hr.expenses.submit` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/expenses` | `hr.expenses.submit` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| DELETE | `/api/hr/holidays/[id]` | any of `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/holidays` | any of `hr.attendance.record`, `hr.attendance.approve`, `hr.employees.manage` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/holidays` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/leave/adjustments` | `hr.leave.configure` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/hr/leave/allocate` | `hr.leave.configure` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/hr/leave/balances` | any of `hr.leave.request`, `hr.leave.approve`, `hr.leave.configure` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/leave/ledger` | any of `hr.leave.request`, `hr.leave.approve`, `hr.leave.configure` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/leave/policies/[id]/retire` | `hr.leave.configure` | ✓ |  |  |  |  |  |  |  |  |
| PATCH | `/api/hr/leave/policies/[id]` | `hr.leave.configure` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/hr/leave/policies/[id]/verify` | `hr.leave.configure` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/hr/leave/policies` | any of `hr.leave.request`, `hr.leave.approve`, `hr.leave.configure` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/leave/policies` | `hr.leave.configure` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/hr/leave/preview` | `hr.leave.request` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/leave/requests/[id]/cancel` | any of `hr.leave.request`, `hr.leave.approve` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/leave/requests` | any of `hr.leave.request`, `hr.leave.approve`, `hr.leave.configure` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/leave/requests` | `hr.leave.request` | ✓ |  |  |  |  |  | ✓ |  |  |
| PATCH | `/api/hr/leave/types/[id]` | `hr.leave.configure` | ✓ |  |  |  |  |  |  |  |  |
| GET | `/api/hr/leave/types` | any of `hr.leave.request`, `hr.leave.approve`, `hr.leave.configure` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/leave/types` | `hr.leave.configure` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/hr/payroll/adjustments/[id]/cancel` | `hr.payroll.prepare` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/payroll/adjustments` | any of `hr.payroll.prepare`, `hr.payroll.view`, `hr.payroll.approve` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/payroll/adjustments` | `hr.payroll.prepare` | ✓ |  |  |  |  |  | ✓ |  |  |
| PATCH | `/api/hr/payroll/components/[id]` | `hr.compensation.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/payroll/components` | any of `hr.compensation.view`, `hr.compensation.manage`, `hr.payroll.prepare`, `hr.payroll.view`, `hr.payroll.approve` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/payroll/components` | `hr.compensation.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/payroll/payments/[id]/reverse` | `hr.payroll.pay` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/payroll/runs/[id]/bank-file` | `hr.payroll.pay` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/payroll/runs/[id]/calculate` | `hr.payroll.prepare` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/payroll/runs/[id]/cancel` | `hr.payroll.prepare` | ✓ |  |  |  |  |  | ✓ |  |  |
| PATCH | `/api/hr/payroll/runs/[id]/employees/[employeeId]` | `hr.payroll.prepare` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/payroll/runs/[id]/journal` | any of `hr.payroll.prepare`, `hr.payroll.view`, `hr.payroll.approve`, `hr.payroll.post`, `hr.payroll.pay` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/payroll/runs/[id]/payments` | any of `hr.payroll.prepare`, `hr.payroll.view`, `hr.payroll.approve`, `hr.payroll.post`, `hr.payroll.pay` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/payroll/runs/[id]/payments` | `hr.payroll.pay` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/payroll/runs/[id]/post` | `hr.payroll.post` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/payroll/runs/[id]/register` | any of `hr.payroll.prepare`, `hr.payroll.view`, `hr.payroll.approve`, `hr.payroll.post`, `hr.payroll.pay` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/payroll/runs/[id]/reopen` | `hr.payroll.approve` | ✓ |  |  |  |  |  |  |  |  |
| POST | `/api/hr/payroll/runs/[id]/reverse` | `hr.payroll.post` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/payroll/runs/[id]` | any of `hr.payroll.prepare`, `hr.payroll.view`, `hr.payroll.approve`, `hr.payroll.post`, `hr.payroll.pay` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/payroll/runs/[id]/submit` | `hr.payroll.prepare` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/payroll/runs/[id]/withdraw` | `hr.payroll.prepare` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/payroll/runs` | any of `hr.payroll.prepare`, `hr.payroll.view`, `hr.payroll.approve`, `hr.payroll.post`, `hr.payroll.pay` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/payroll/runs` | `hr.payroll.prepare` | ✓ |  |  |  |  |  | ✓ |  |  |
| PATCH | `/api/hr/schedules/[id]` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/schedules` | any of `hr.attendance.record`, `hr.attendance.approve`, `hr.employees.manage` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/schedules` | `hr.employees.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/statutory/[id]/retire` | `hr.statutory.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| PATCH | `/api/hr/statutory/[id]` | `hr.statutory.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/statutory/[id]/verify` | `hr.statutory.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/hr/statutory` | any of `hr.statutory.manage`, `hr.payroll.prepare`, `hr.payroll.approve`, `hr.payroll.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/statutory` | `hr.statutory.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/hr/transactions` | `hr.advances.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/integrations/attendance/events` | integration key with scope `attendance.ingest` only | · | · | · | · | · | · | · | · | · |
| GET | `/api/integrations/orders/[externalId]` | integration key with scope `orders.status` only | · | · | · | · | · | · | · | · | · |
| POST | `/api/inventory/adjustments` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/inventory/documents/[id]/reverse` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/inventory/documents` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/inventory/exceptions/[id]/resolve` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/inventory/exceptions` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| PATCH | `/api/inventory/lots/[id]` | `stock.sort` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/inventory/products/[id]/packagings` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/inventory/products/[id]` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| PATCH | `/api/inventory/products/[id]/settings` | any of `stock.manage_products`, `accounting.manage` | ✓ | ✓ | ✓ |  |  |  | ✓ |  |  |
| POST | `/api/inventory/release` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/inventory/reports/expiring` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| GET | `/api/inventory/reports/valuation/export` | `stock.valuation.view` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| GET | `/api/inventory/reports/valuation` | `stock.valuation.view` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| POST | `/api/inventory/reservations/[id]/release` | `stock.reserve` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/inventory/reservations` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/inventory/reservations` | `stock.reserve` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/inventory/returns` | `stock.receive` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/inventory/scrap` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/inventory/stock` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/inventory/transfers` | `stock.transfer` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/management/cash-flow` | `reports.finance` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/management/finance/export` | `reports.finance` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/management/finance` | `reports.finance` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/management/operations` | `reports.view` | ✓ | ✓ |  |  |  |  |  |  |  |
| GET | `/api/management/overview` | `reports.finance` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/notifications/read` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/api/notifications` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| PATCH | `/api/operations/drivers/[id]` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/operations/drivers` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/operations/exceptions/[id]/assign` | `orders.approve` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/operations/exceptions/[id]/resolve` | `orders.approve` | ✓ | ✓ |  |  |  |  |  |  |  |
| GET | `/api/operations/exceptions` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| POST | `/api/operations/exceptions` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| GET | `/api/operations/fleet` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| POST | `/api/operations/stops/[id]/delivery` | `orders.dispatch` | ✓ | ✓ |  |  | ✓ |  |  |  |  |
| POST | `/api/operations/trips/[id]/cancel` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/operations/trips/[id]/depart` | `orders.dispatch` | ✓ | ✓ |  |  | ✓ |  |  |  |  |
| POST | `/api/operations/trips/[id]/dispatch` | `orders.dispatch` | ✓ | ✓ |  |  | ✓ |  |  |  |  |
| POST | `/api/operations/trips/[id]/loaded` | `orders.load` | ✓ | ✓ |  |  | ✓ |  |  |  |  |
| GET | `/api/operations/trips/[id]` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| PUT | `/api/operations/trips/[id]` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/operations/trips/[id]/start-loading` | `orders.load` | ✓ | ✓ |  |  | ✓ |  |  |  |  |
| GET | `/api/operations/trips/plannable` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| GET | `/api/operations/trips` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| POST | `/api/operations/trips` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| PATCH | `/api/operations/vehicles/[id]` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/operations/vehicles` | `operations.trips.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/orders/[id]/approve` | `orders.approve` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/orders/[id]/assign` | `orders.approve` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/orders/[id]/cancel` | `orders.edit` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/orders/[id]/clone` | `orders.create` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| POST | `/api/orders/[id]/items/[itemId]/load` | `orders.load` | ✓ | ✓ |  |  | ✓ |  |  |  |  |
| POST | `/api/orders/[id]/items/[itemId]/prepare` | `orders.prepare` | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| PATCH | `/api/orders/[id]/items/[itemId]/price` | `sales.price_override` | ✓ |  |  |  |  | ✓ |  |  |  |
| POST | `/api/orders/[id]/items/[itemId]/required` | `orders.edit` | ✓ | ✓ |  |  |  |  |  |  |  |
| GET | `/api/orders/[id]/pricing` | `sales.pricing.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |  |
| POST | `/api/orders/[id]/reopen` | `orders.edit` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/orders/[id]/reprice` | `sales.price_override` | ✓ |  |  |  |  | ✓ |  |  |  |
| GET | `/api/orders/[id]` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| PATCH | `/api/orders/[id]` | `orders.edit` | ✓ | ✓ |  |  |  |  |  |  |  |
| POST | `/api/orders/[id]/status` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| GET | `/api/orders` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| POST | `/api/orders` | integration key, or `orders.create` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| GET | `/api/production/daily` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| GET | `/api/production/daily/sheet` | `orders.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| POST | `/api/purchasing/bills/[id]/cancel` | `purchasing.bills.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/purchasing/bills/[id]/debit-notes` | `purchasing.bills.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/purchasing/bills/[id]/post` | `purchasing.bills.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/purchasing/bills/[id]` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |
| PUT | `/api/purchasing/bills/[id]` | `purchasing.bills.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/purchasing/bills` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |
| POST | `/api/purchasing/bills` | `purchasing.bills.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/purchasing/orders/[id]/cancel` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| POST | `/api/purchasing/orders/[id]/close` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| GET | `/api/purchasing/orders/[id]` | `purchasing.orders.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| PUT | `/api/purchasing/orders/[id]` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| POST | `/api/purchasing/orders/[id]/send` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| POST | `/api/purchasing/orders/[id]/submit` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| GET | `/api/purchasing/orders` | `purchasing.orders.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/purchasing/orders` | `purchasing.orders.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| GET | `/api/purchasing/products/[id]/prices` | `purchasing.prices.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ |  |
| GET | `/api/purchasing/receiving` | `stock.receive` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/purchasing/reports/ap-aging` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |
| POST | `/api/purchasing/rfqs/[id]/award` | `purchasing.rfq.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| POST | `/api/purchasing/rfqs/[id]/cancel` | `purchasing.rfq.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| POST | `/api/purchasing/rfqs/[id]/quotes` | `purchasing.rfq.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| GET | `/api/purchasing/rfqs/[id]` | any of `purchasing.rfq.manage`, `purchasing.prices.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ |  |
| POST | `/api/purchasing/rfqs/[id]/send` | `purchasing.rfq.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| GET | `/api/purchasing/rfqs` | any of `purchasing.rfq.manage`, `purchasing.prices.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ |  |
| POST | `/api/purchasing/rfqs` | `purchasing.rfq.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| GET | `/api/purchasing/suppliers/[id]/billable` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |
| PATCH | `/api/purchasing/suppliers/[id]/contacts/[contactId]` | `purchasing.suppliers.manage` | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| POST | `/api/purchasing/suppliers/[id]/contacts` | `purchasing.suppliers.manage` | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| GET | `/api/purchasing/suppliers/[id]/prices` | `purchasing.prices.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ |  |
| POST | `/api/purchasing/suppliers/[id]/prices` | `purchasing.prices.manage` | ✓ |  |  |  |  |  |  | ✓ |  |
| GET | `/api/purchasing/suppliers/[id]` | `purchasing.suppliers.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ | ✓ |
| PATCH | `/api/purchasing/suppliers/[id]` | `purchasing.suppliers.manage` | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| GET | `/api/purchasing/suppliers/[id]/statement/export` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |
| GET | `/api/purchasing/suppliers/[id]/statement` | `purchasing.bills.view` | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |
| GET | `/api/purchasing/suppliers` | `purchasing.suppliers.view` | ✓ | ✓ |  |  |  |  | ✓ | ✓ | ✓ |
| POST | `/api/purchasing/suppliers` | `purchasing.suppliers.manage` | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| GET | `/api/reports/daily` | `reports.view` | ✓ | ✓ |  |  |  |  |  |  |  |
| GET | `/api/sales/catalog` | any of `sales.quotations.view`, `sales.pricing.view`, `purchasing.orders.view`, `purchasing.rfq.manage`, `purchasing.prices.view` | ✓ | ✓ | ✓ |  |  | ✓ | ✓ | ✓ |  |
| GET | `/api/sales/customer-groups` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  | ✓ |
| POST | `/api/sales/customer-groups` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| POST | `/api/sales/customers/[id]/aliases` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| PATCH | `/api/sales/customers/[id]/contacts/[contactId]` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| POST | `/api/sales/customers/[id]/contacts` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| PATCH | `/api/sales/customers/[id]/credit` | `sales.credit.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/sales/customers/[id]/exposure` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  | ✓ |
| GET | `/api/sales/customers/[id]/history` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  | ✓ |
| PATCH | `/api/sales/customers/[id]/price-list` | `sales.pricing.manage` | ✓ |  |  |  |  | ✓ |  |  |  |
| GET | `/api/sales/customers/[id]` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  | ✓ |
| PATCH | `/api/sales/customers/[id]` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| GET | `/api/sales/customers/[id]/statement/export` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  | ✓ |
| GET | `/api/sales/customers/[id]/statement` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  | ✓ |
| DELETE | `/api/sales/customers/aliases/[aliasId]` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| POST | `/api/sales/customers/map` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| GET | `/api/sales/customers` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  | ✓ |
| POST | `/api/sales/customers` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| GET | `/api/sales/customers/unmapped` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  | ✓ |
| POST | `/api/sales/invoices/[id]/credit-notes` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/sales/invoices/[id]/issue` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/sales/invoices/[id]/recover` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/sales/invoices/[id]/reprice` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/sales/invoices/[id]` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  | ✓ |
| POST | `/api/sales/invoices/[id]/void` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/sales/invoices` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  | ✓ |
| POST | `/api/sales/invoices` | `sales.invoices.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| GET | `/api/sales/invoices/to-invoice` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  | ✓ |
| PATCH | `/api/sales/legal-entities/[id]` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| GET | `/api/sales/legal-entities` | `sales.customers.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  | ✓ |
| POST | `/api/sales/legal-entities` | `sales.customers.manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| POST | `/api/sales/price-lists/[id]/prices` | `sales.pricing.manage` | ✓ |  |  |  |  | ✓ |  |  |  |
| GET | `/api/sales/price-lists/[id]` | `sales.pricing.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |  |
| PATCH | `/api/sales/price-lists/[id]` | `sales.pricing.manage` | ✓ |  |  |  |  | ✓ |  |  |  |
| GET | `/api/sales/price-lists` | `sales.pricing.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |  |
| POST | `/api/sales/price-lists` | `sales.pricing.manage` | ✓ |  |  |  |  | ✓ |  |  |  |
| PATCH | `/api/sales/products/[id]/tax` | `sales.tax.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| POST | `/api/sales/quotations/[id]/convert` | `sales.quotations.manage` | ✓ |  |  |  |  | ✓ |  |  |  |
| GET | `/api/sales/quotations/[id]` | `sales.quotations.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |  |
| PUT | `/api/sales/quotations/[id]` | `sales.quotations.manage` | ✓ |  |  |  |  | ✓ |  |  |  |
| POST | `/api/sales/quotations/[id]/transition` | `sales.quotations.manage` | ✓ |  |  |  |  | ✓ |  |  |  |
| GET | `/api/sales/quotations` | `sales.quotations.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |  |
| POST | `/api/sales/quotations` | `sales.quotations.manage` | ✓ |  |  |  |  | ✓ |  |  |  |
| GET | `/api/sales/reports/aging` | `sales.invoices.view` | ✓ |  |  |  |  | ✓ | ✓ |  | ✓ |
| GET | `/api/sales/tax-rates` | `sales.pricing.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |  |  |
| GET | `/api/settings/operational` | signed in (checked per record in the service) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| POST | `/api/stock/adjustments` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/stock/audit` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| GET | `/api/stock/dashboard` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| GET | `/api/stock/intakes/[id]` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| PATCH | `/api/stock/intakes/[id]` | `stock.sort` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/stock/intakes/[id]/sort` | `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/stock/intakes/[id]/void` | `stock.sort` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/stock/intakes` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/stock/intakes` | `stock.receive` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/stock/ledger` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| DELETE | `/api/stock/products/[id]/aliases/[aliasId]` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/stock/products/[id]/aliases` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| PATCH | `/api/stock/products/[id]` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/stock/products/coverage` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/stock/products/mapping` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| DELETE | `/api/stock/products/mapping` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| POST | `/api/stock/products/resolve` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| GET | `/api/stock/products` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/stock/products` | `stock.manage_products` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| PATCH | `/api/stock/suppliers/[id]` | `stock.manage_suppliers` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/stock/suppliers` | `stock.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| POST | `/api/stock/suppliers` | `stock.manage_suppliers` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| GET | `/api/supervisor/intelligence` | `reports.view` | ✓ | ✓ |  |  |  |  |  |  |  |

`·` = decided per field / public; see the gate column.
