import type { Role } from "@/lib/types";

/**
 * The permission catalogue and the role bundles — the single source of truth for
 * who can do what. Nothing else in the codebase may define authorization: routes,
 * services, pages and navigation all resolve against this file.
 *
 * These are deliberately code constants rather than editable rows. The database
 * mirrors them (see syncPermissionCatalogue) so permissions can be inspected and
 * audited with plain SQL, but an UPDATE on a row can never widen access on its own —
 * the next sync puts it back. Per-user exceptions are the supported way to deviate,
 * and those are recorded, attributed and audited.
 */

export const PERMISSION_GROUPS = ["orders", "stock", "reports", "audit", "users", "settings", "core", "sales", "purchasing", "operations", "accounting", "hr", "integrations"] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export type PermissionDef = {
  key: string;
  group: PermissionGroup;
  label: string;
  description: string;
};

export const PERMISSION_DEFS = [
  // --- orders ------------------------------------------------------------
  { key: "orders.view", group: "orders", label: "عرض الأوردرات", description: "يشوف الأوردرات وتفاصيلها وسجل الأوردر الواحد" },
  { key: "orders.create", group: "orders", label: "إنشاء أوردر", description: "يعمل أوردر يدوي أو ينسخ أوردر موجود" },
  { key: "orders.edit", group: "orders", label: "تعديل أوردر", description: "يعدّل بيانات الأوردر والكمية المطلوبة، يلغي، يعيد الفتح، ويغيّر الحالة يدويًا" },
  { key: "orders.approve", group: "orders", label: "اعتماد الفروقات", description: "يعتمد النقص ويفك وقف الأوردر المحتاج مراجعة" },
  { key: "orders.prepare", group: "orders", label: "تجهيز", description: "يسجّل كميات التجهيز وينقل الأوردر لمرحلة التجهيز/الجاهز للتحميل" },
  { key: "orders.load", group: "orders", label: "تحميل", description: "يسجّل كميات التحميل وينقل الأوردر لمرحلة التحميل/تم التحميل" },
  { key: "orders.dispatch", group: "orders", label: "تأكيد خروج العربية", description: "يأكد خروج الأوردر ببيانات السواق والعربية والبرنيكة" },
  // --- stock -------------------------------------------------------------
  { key: "stock.view", group: "stock", label: "عرض المخزون", description: "يشوف لوحة المخزون والرصيد والسجل والاستلامات" },
  { key: "stock.receive", group: "stock", label: "تسجيل استلام", description: "يسجّل استلام خامات جديدة من مورد" },
  { key: "stock.sort", group: "stock", label: "تعديل الفرز", description: "يعدّل كميات الاستلام والفرز أو يلغي استلام" },
  { key: "stock.adjust", group: "stock", label: "تسوية المخزون", description: "يعمل تسوية يدوية على رصيد صنف بسبب مكتوب" },
  { key: "stock.manage_products", group: "stock", label: "إدارة أصناف المخزون", description: "يضيف ويعدّل ويوقف أصناف المخزون" },
  { key: "stock.manage_suppliers", group: "stock", label: "إدارة الموردين", description: "يضيف ويعدّل ويوقف الموردين" },
  { key: "stock.transfer", group: "stock", label: "تحويل بين الأماكن", description: "ينقل مخزون بين أماكن التخزين (مثلًا من الاستلام لغرفة التبريد)" },
  { key: "stock.reserve", group: "stock", label: "حجز مخزون", description: "يحجز أو يفك حجز كمية لأوردر" },
  { key: "stock.approve_adjustments", group: "stock", label: "اعتماد تسويات المخزون", description: "يوافق أو يرفض التسويات الكبيرة اللي محتاجة موافقة" },
  { key: "stock.valuation.view", group: "stock", label: "عرض تكلفة وقيمة المخزون", description: "يشوف متوسط التكلفة وقيمة المخزون" },
  // --- reports / audit ---------------------------------------------------
  { key: "reports.view", group: "reports", label: "عرض التقارير", description: "يشوف تقرير التشغيل اليومي ومركز التحكم والاستثناءات" },
  { key: "reports.finance", group: "reports", label: "تقارير الإدارة المالية", description: "يشوف المبيعات والهامش والأرصدة وقيمة المخزون والنقدية وقائمة الدخل" },
  { key: "audit.view", group: "audit", label: "عرض سجل المراجعة", description: "يشوف سجل المراجعة الكامل لكل الأوردرات" },
  // --- users -------------------------------------------------------------
  { key: "users.view", group: "users", label: "عرض المستخدمين", description: "يدخل لوحة الإدارة ويشوف المستخدمين وصلاحياتهم" },
  { key: "users.create", group: "users", label: "إنشاء مستخدم", description: "يضيف مستخدم جديد" },
  { key: "users.edit", group: "users", label: "تعديل مستخدم", description: "يعدّل اسم المستخدم أو الاسم المعروض" },
  { key: "users.disable", group: "users", label: "إيقاف/تفعيل مستخدم", description: "يوقف أو يفعّل حساب مستخدم" },
  { key: "users.change_role", group: "users", label: "تغيير الدور", description: "يغيّر دور المستخدم" },
  // --- settings ----------------------------------------------------------
  { key: "settings.manage", group: "settings", label: "إدارة الصلاحيات", description: "يدير الاستثناءات الفردية للصلاحيات وإعدادات النظام" },
  // --- core (ERP master data) -------------------------------------------
  // New ERP modules use namespaced keys (module.area.action). The keys above keep
  // their original names: renaming one would orphan per-user overrides in production.
  { key: "core.masterdata.view", group: "core", label: "عرض البيانات الأساسية", description: "يشوف الشركة والفروع والمخازن وأماكن التخزين ووحدات القياس والعملات" },
  { key: "core.masterdata.manage", group: "core", label: "إدارة البيانات الأساسية", description: "يضيف ويعدّل ويوقف الشركة والفروع والمخازن وأماكن التخزين ووحدات القياس والعملات" },
  // --- sales -------------------------------------------------------------
  { key: "sales.customers.view", group: "sales", label: "عرض العملاء", description: "يشوف بيانات العملاء وجهات الاتصال وشروط الدفع" },
  { key: "sales.customers.manage", group: "sales", label: "إدارة العملاء", description: "يضيف ويعدّل العملاء وأسماءهم البديلة ويربط أسماء العملاء في الأوردرات بحساباتهم" },
  { key: "sales.pricing.view", group: "sales", label: "عرض الأسعار", description: "يشوف قوائم الأسعار وأسعار وقيمة الأوردرات" },
  { key: "sales.pricing.manage", group: "sales", label: "إدارة الأسعار", description: "يعمل قوائم الأسعار ويسجل الأسعار اليومية ويحدد ضريبة الصنف وقائمة العميل" },
  { key: "sales.price_override", group: "sales", label: "تعديل سعر أوردر", description: "يغيّر سعر أو خصم سطر في أوردر بسبب مكتوب، ويعيد تسعير الأوردر" },
  { key: "sales.quotations.view", group: "sales", label: "عرض عروض الأسعار", description: "يشوف عروض الأسعار وحالتها" },
  { key: "sales.quotations.manage", group: "sales", label: "إدارة عروض الأسعار", description: "يعمل ويبعت عروض الأسعار ويسجل رد العميل ويحوّلها لأوردر" },
  { key: "sales.invoices.view", group: "sales", label: "عرض الفواتير", description: "يشوف الفواتير والإشعارات الدائنة وكشف حساب العميل وأعمار الديون" },
  { key: "sales.invoices.manage", group: "sales", label: "إصدار الفواتير", description: "يعمل ويصدر فواتير المبيعات والإشعارات الدائنة" },
  { key: "sales.tax.manage", group: "sales", label: "إدارة التصنيف الضريبي", description: "يحدد ضريبة القيمة المضافة لكل صنف (معفى / 14% / صفر)" },
  { key: "sales.credit.manage", group: "sales", label: "إدارة الائتمان", description: "يحدد حد الائتمان ومدة السداد ويوقف أو يفك إيقاف التعامل الآجل مع العميل" },
  // --- purchasing --------------------------------------------------------
  { key: "purchasing.suppliers.view", group: "purchasing", label: "عرض الموردين", description: "يشوف بيانات الموردين وجهات الاتصال وشروط الدفع" },
  { key: "purchasing.suppliers.manage", group: "purchasing", label: "إدارة الموردين (التجاري)", description: "يعدّل الشروط التجارية للمورد: الرقم الضريبي، مدة السداد، مدة التوريد، جهات الاتصال" },
  { key: "purchasing.prices.view", group: "purchasing", label: "عرض أسعار الشراء", description: "يشوف أسعار الموردين وقيم أوامر الشراء وعروض الموردين" },
  { key: "purchasing.prices.manage", group: "purchasing", label: "إدارة أسعار الموردين", description: "يسجل أسعار الموردين المتفق عليها بالتاريخ" },
  { key: "purchasing.rfq.manage", group: "purchasing", label: "طلبات عروض الأسعار", description: "يعمل طلب عرض سعر للموردين ويسجل عروضهم ويرسّي" },
  { key: "purchasing.orders.view", group: "purchasing", label: "عرض أوامر الشراء", description: "يشوف أوامر الشراء والكميات المطلوبة والمستلمة (الأسعار محتاجة صلاحية عرض أسعار الشراء)" },
  { key: "purchasing.orders.manage", group: "purchasing", label: "إدارة أوامر الشراء", description: "يعمل ويعدّل ويبعت ويلغي أوامر الشراء" },
  { key: "purchasing.orders.approve", group: "purchasing", label: "اعتماد أوامر الشراء", description: "يوافق على أوامر الشراء اللي فوق حد الاعتماد" },
  { key: "purchasing.bills.view", group: "purchasing", label: "عرض فواتير الموردين", description: "يشوف فواتير الموردين وأرصدتهم وأعمار الدائنين" },
  { key: "purchasing.bills.manage", group: "purchasing", label: "تسجيل فواتير الموردين", description: "يسجل فواتير الموردين ويطابقها مع أمر الشراء والاستلام، ويعمل إشعارات مدينة" },
  { key: "accounting.view", group: "accounting", label: "عرض الحسابات", description: "يشوف دليل الحسابات والقيود وميزان المراجعة والنقدية" },
  { key: "accounting.manage", group: "accounting", label: "إدارة الحسابات", description: "قيود يدوية وعكسها، ترحيل تقييم المخزون، تسوية البنك" },
  { key: "accounting.receipts.manage", group: "accounting", label: "تحصيل من العملاء", description: "يسجل إيصالات التحصيل ويخصصها على الفواتير" },
  { key: "accounting.payments.manage", group: "accounting", label: "سداد للموردين", description: "يسجل سندات الصرف للموردين ويخصصها على فواتيرهم" },
  { key: "accounting.periods.close", group: "accounting", label: "قفل الفترات المحاسبية", description: "يقفل الشهر المحاسبي فمينفعش يترحّل فيه تاني" },
  { key: "accounting.periods.reopen", group: "accounting", label: "إعادة فتح الفترات والسنوات", description: "يوافق على إعادة فتح شهر أو سنة مالية مقفولة بطلب من شخص تاني وبسبب مكتوب" },
  { key: "accounting.journals.approve", group: "accounting", label: "اعتماد القيود اليدوية", description: "يوافق على القيود اليدوية اللي فوق حد الاعتماد (مش قيوده هو)" },
  { key: "accounting.opening.approve", group: "accounting", label: "اعتماد الأرصدة الافتتاحية", description: "يوافق على دفعة الأرصدة الافتتاحية بعد مراجعتها فتترحّل مرة واحدة" },
  { key: "accounting.assets.view", group: "accounting", label: "عرض الأصول الثابتة", description: "يشوف سجل الأصول وقيمتها الدفترية والإهلاك والتقارير" },
  { key: "accounting.assets.manage", group: "accounting", label: "إدارة الأصول الثابتة", description: "يسجل الأصول وفئاتها ويشغّل الإهلاك الشهري وينقل ويستبعد الأصول" },
  { key: "accounting.eta.view", group: "accounting", label: "متابعة الفاتورة الإلكترونية", description: "يشوف حالة إرسال الفواتير لمصلحة الضرائب وجاهزيتها وأخطاء الرفض" },
  { key: "accounting.eta.manage", group: "accounting", label: "إرسال الفاتورة الإلكترونية", description: "يرسل الفواتير لمصلحة الضرائب ويحدّث حالتها ويظبط أكواد الأصناف والوحدات وبيانات المُصدِر" },
  { key: "hr.employees.manage", group: "hr", label: "إدارة الموظفين", description: "يسجل الأقسام والموظفين ويشوف أرصدتهم (سلف ومستحقات)" },
  { key: "hr.expenses.submit", group: "hr", label: "تسجيل المصروفات", description: "يسجل مصروف (نقدي أو على موظف)؛ اللي فوق الحد بيستنى اعتماد" },
  { key: "hr.expenses.approve", group: "hr", label: "اعتماد المصروفات", description: "يوافق على المصروفات اللي فوق حد الاعتماد" },
  { key: "hr.advances.manage", group: "hr", label: "سلف ومستحقات الموظفين", description: "يصرف سلفة أو مستحقات لموظف أو يستلم رد سلفة" },
  // HR & payroll (docs/erp/HR_PAYROLL_GAP_AUDIT.md §6). Ledger posting and payment of payroll
  // come with phase 6, after the accountant approves the account mapping.
  { key: "hr.employees.view", group: "hr", label: "عرض ملفات الموظفين", description: "يشوف ملف الموظف وتاريخ تعيينه ونقله (من غير البيانات الشخصية أو المرتب)" },
  { key: "hr.private.view", group: "hr", label: "عرض البيانات الشخصية للموظفين", description: "يشوف الرقم القومي والتأمينات والحساب البنكي ومستندات الموظف — كل فتح بيتسجل" },
  { key: "hr.private.manage", group: "hr", label: "تعديل البيانات الشخصية للموظفين", description: "يسجل ويعدّل البيانات الشخصية والحساب البنكي ويرفع مستندات الموظف" },
  { key: "hr.attendance.record", group: "hr", label: "تسجيل الحضور", description: "يسجل حضور وغياب وإضافي الموظفين ويأكده" },
  { key: "hr.attendance.approve", group: "hr", label: "اعتماد تصحيح الحضور", description: "يوافق على تصحيح يوم حضور اتأكد أو اتقفل" },
  { key: "hr.leave.request", group: "hr", label: "تسجيل طلبات الإجازة", description: "يسجل طلب إجازة لموظف" },
  { key: "hr.leave.approve", group: "hr", label: "اعتماد الإجازات", description: "يوافق على طلبات الإجازة أو يرفضها" },
  { key: "hr.leave.configure", group: "hr", label: "إعداد أنواع وسياسات الإجازات", description: "يعرّف أنواع الإجازات وأرصدتها حسب السياسة المعتمدة" },
  { key: "hr.compensation.view", group: "hr", label: "عرض المرتبات", description: "يشوف مرتب كل موظف ومكوناته وتاريخ تغييره" },
  { key: "hr.compensation.manage", group: "hr", label: "اقتراح تعديل المرتبات", description: "يقترح مرتب أو تعديل مرتب — بيتنفذ بعد الاعتماد" },
  { key: "hr.payroll.prepare", group: "hr", label: "تجهيز المرتبات", description: "يعمل مسير الشهر ويحسبه ويقدمه للاعتماد" },
  { key: "hr.payroll.approve", group: "hr", label: "اعتماد المرتبات", description: "يعتمد مسير المرتبات أو يرجعه — مينفعش يعتمد مسير جهزه أو قدمه بنفسه" },
  { key: "hr.payroll.view", group: "hr", label: "عرض المرتبات المحسوبة", description: "يشوف مسيرات المرتبات وقسائم الموظفين" },
  { key: "hr.payroll.post", group: "hr", label: "ترحيل المرتبات", description: "يرحّل مسير معتمد للحسابات أو يعكسه قبل أي صرف — بحسابات البنود وحساب صافي المرتبات اللي المحاسب حددها" },
  { key: "hr.payroll.pay", group: "hr", label: "صرف المرتبات", description: "يسجّل صرف مرتبات مسير مترحّل (لحد صافي كل قسيمة) ويعكس صرف غلط" },
  { key: "hr.statutory.manage", group: "hr", label: "القواعد القانونية للمرتبات", description: "يسجل نسب التأمينات والضرايب بمرجعها القانوني؛ اعتمادها بيحتاج شخص تاني" },
  { key: "integrations.manage", group: "integrations", label: "إدارة التكاملات", description: "يعمل ويلغي مفاتيح التكامل (n8n، Hermes) ويشوف سجل الاتصالات" },
  { key: "operations.trips.manage", group: "operations", label: "تخطيط الرحلات والأسطول", description: "يسجل العربيات والسواقين، ويعمل الرحلات ويوزّع عليها الأوردرات ويلغيها" },
  { key: "purchasing.bills.approve", group: "purchasing", label: "اعتماد فروق فواتير الموردين", description: "يوافق على فاتورة مورد مختلفة عن السعر المتفق عليه أو الكمية المستلمة أكتر من السماحية" },
] as const satisfies readonly PermissionDef[];

export type Permission = (typeof PERMISSION_DEFS)[number]["key"];

export const ALL_PERMISSIONS: Permission[] = PERMISSION_DEFS.map((p) => p.key);
const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

export function permissionDef(key: Permission): PermissionDef {
  return PERMISSION_DEFS.find((p) => p.key === key)!;
}

/**
 * Role bundles.
 *
 * These reproduce exactly what each role could already do before permissions
 * existed, so no working account gains or loses anything on the day this ships:
 *  - PREPARER could read orders and record preparation.
 *  - LOADER could read orders, record loading, and confirm dispatch.
 *  - SUPERVISOR could do every order action, read reports and the full audit log,
 *    and had full access to the stock module.
 *  - STOCK_CONTROLLER was walled off from orders entirely and owned stock.
 * SUPER_ADMIN is new and holds everything.
 */
const ORDER_OPERATIONS: Permission[] = [
  "orders.view",
  "orders.create",
  "orders.edit",
  "orders.approve",
  "orders.prepare",
  "orders.load",
  "orders.dispatch",
];

const STOCK_OPERATIONS: Permission[] = [
  "stock.view",
  "stock.receive",
  "stock.sort",
  "stock.adjust",
  "stock.manage_products",
  "stock.manage_suppliers",
  "stock.transfer",
  "stock.reserve",
];

/** Stock decisions a supervisor makes but the person doing the counting does not:
 * approving their own large adjustments, and seeing what the stock is worth. */
const STOCK_OVERSIGHT: Permission[] = ["stock.approve_adjustments", "stock.valuation.view"];

/** Customer accounts: who the business sells to. Credit terms are a finance
 * decision and sit apart (sales.credit.manage). */
const CUSTOMER_MASTER: Permission[] = ["sales.customers.view", "sales.customers.manage"];
/** Prices: sales sets the daily prices and may change a line's price (with a reason). */
const PRICING: Permission[] = ["sales.pricing.view", "sales.pricing.manage", "sales.price_override"];
const QUOTATIONS: Permission[] = ["sales.quotations.view", "sales.quotations.manage"];
/** Buying: suppliers' commercial side, their prices, RFQs and purchase orders. */
const PURCHASING: Permission[] = [
  "purchasing.suppliers.view",
  "purchasing.suppliers.manage",
  "purchasing.prices.view",
  "purchasing.prices.manage",
  "purchasing.rfq.manage",
  "purchasing.orders.view",
  "purchasing.orders.manage",
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  SUPERVISOR: [...ORDER_OPERATIONS, ...STOCK_OPERATIONS, ...STOCK_OVERSIGHT, ...CUSTOMER_MASTER, "operations.trips.manage", "hr.expenses.submit", "hr.attendance.record", "accounting.eta.view", "sales.pricing.view", "sales.quotations.view", "purchasing.suppliers.view", "purchasing.orders.view", "purchasing.prices.view", "reports.view", "audit.view"],
  // Receives against purchase orders, so sees them — quantities only (no prices).
  STOCK_CONTROLLER: [...STOCK_OPERATIONS, "purchasing.orders.view"],
  PREPARER: ["orders.view", "orders.prepare"],
  LOADER: ["orders.view", "orders.load", "orders.dispatch"],
  // New in Phase 3. Sales staff take and follow orders and own the customer master;
  // they do not touch the floor workflow or stock.
  SALES: ["orders.view", "orders.create", ...CUSTOMER_MASTER, ...PRICING, ...QUOTATIONS, "sales.invoices.view"],
  // Accounting reads what was sold and what stock is worth, owns credit, invoicing and
  // tax classification, and reads the audit trail. Not the floor: no operational
  // reports (reports.view is the operations board), no order or stock actions.
  ACCOUNTANT: ["orders.view", "stock.view", "stock.valuation.view", "sales.customers.view", "sales.pricing.view", "sales.quotations.view", "sales.invoices.view", "sales.invoices.manage", "sales.credit.manage", "sales.tax.manage",
    // Finance controls spend and owns payables: approves POs above the threshold, books supplier bills.
    "purchasing.suppliers.view", "purchasing.suppliers.manage", "purchasing.prices.view", "purchasing.orders.view", "purchasing.orders.approve", "purchasing.bills.view", "purchasing.bills.manage",
    // The ledger, cash and bank: Phase 6.
    "accounting.view", "accounting.manage", "accounting.receipts.manage", "accounting.payments.manage", "accounting.periods.close", "reports.finance",
    // Approves manual journals of others above the threshold (never their own: enforced in the service).
    "accounting.journals.approve", "accounting.assets.view", "accounting.assets.manage",
    // E-invoicing (ETA): submission and its codes sit with finance; supervisors follow status.
    "accounting.eta.view", "accounting.eta.manage",
    "hr.employees.manage", "hr.expenses.submit", "hr.advances.manage",
    // Payroll preparation and salary proposals sit with finance; private data and every
    // approval stay with the owner (SUPER_ADMIN) until an HR role is decided (audit doc §12 P2/P3).
    "hr.employees.view", "hr.leave.request", "hr.compensation.view", "hr.compensation.manage", "hr.payroll.prepare", "hr.payroll.view", "hr.statutory.manage",
    // Posting an approved run and paying it are finance's, like any other payable.
    "hr.payroll.post", "hr.payroll.pay",
    "audit.view"],
  // New in Phase 4. Buys: suppliers, their prices, RFQs, purchase orders; reads stock
  // levels to know what to buy. Does not approve its own spend, book bills, or move stock.
  PURCHASER: [...PURCHASING, "stock.view", "purchasing.bills.view"],
  // Accounting clerk: the receipts and payments workflows and the minimum they need —
  // the customer or supplier, their open invoices or bills. Not accounting.view (chart of
  // accounts, balances, journals, ledgers, trial balance, VAT/withholding), not
  // reports.finance, not stock valuation, not reversals or period closing (manager only).
  ACCOUNTING_CLERK: ["sales.customers.view", "sales.invoices.view", "purchasing.suppliers.view", "purchasing.bills.view", "accounting.receipts.manage", "accounting.payments.manage"],
};

/**
 * SUPER_ADMIN always resolves to every permission and ignores per-user overrides.
 * That is not a convenience — it is the reason it is impossible to lock every
 * administrator out of the system by editing permissions, which is the classic way
 * an RBAC rollout bricks a production app.
 */
export const ABSOLUTE_ROLE: Role = "SUPER_ADMIN";

/** Permission required to move an order INTO each status. */
export const STATUS_PERMISSION: Record<string, Permission> = {
  new: "orders.edit",
  preparing: "orders.prepare",
  ready_for_loading: "orders.prepare",
  loading: "orders.load",
  loaded: "orders.load",
  dispatched: "orders.dispatch",
  cancelled: "orders.edit",
};

export const PERMISSION_LABEL_EN: Record<Permission, string> = {
  "stock.transfer": "Transfer Stock",
  "stock.reserve": "Reserve Stock",
  "stock.valuation.view": "View Stock Cost and Value",
  "users.create": "Create Users",
  "users.edit": "Edit Users",
  "users.disable": "Disable/Enable Users",
  "users.change_role": "Change Role",
  "settings.manage": "Manage Permissions and Settings",
  "core.masterdata.view": "View Master Data",
  "core.masterdata.manage": "Manage Master Data",
  "sales.pricing.view": "View Prices",
  "sales.pricing.manage": "Manage Prices",
  "sales.invoices.manage": "Issue Invoices",
  "sales.tax.manage": "Manage Tax Classification",
  "purchasing.prices.view": "View Purchase Prices",
  "purchasing.prices.manage": "Manage Supplier Prices",
  "purchasing.rfq.manage": "Requests for Quotation",
  "purchasing.orders.manage": "Manage Purchase Orders",
  "purchasing.bills.manage": "Record Supplier Bills",
  "accounting.manage": "Manage Accounting",
  "accounting.receipts.manage": "Customer Receipts",
  "accounting.payments.manage": "Supplier Payments",
  "hr.advances.manage": "Employee Advances and Payouts",
  "accounting.eta.manage": "Manage E-Invoice Setup",
  "accounting.eta.view": "View E-Invoice",
  "accounting.periods.close": "Close Periods",
  "accounting.periods.reopen": "Reopen Periods and Years",
  "accounting.journals.approve": "Approve Manual Journals",
  "accounting.opening.approve": "Approve Opening Balances",
  "accounting.assets.view": "View Fixed Assets",
  "accounting.assets.manage": "Manage Fixed Assets",
  "accounting.view": "View Accounting",
  "audit.view": "View Audit Log",
  "hr.employees.manage": "Manage Employees",
  "hr.employees.view": "View Employee Files",
  "hr.private.view": "View Employee Private Data",
  "hr.private.manage": "Manage Employee Private Data",
  "hr.attendance.record": "Record Attendance",
  "hr.attendance.approve": "Approve Attendance Corrections",
  "hr.leave.request": "Record Leave Requests",
  "hr.leave.approve": "Approve Leave",
  "hr.leave.configure": "Configure Leave Types and Policies",
  "hr.compensation.view": "View Salaries",
  "hr.compensation.manage": "Propose Salary Changes",
  "hr.payroll.prepare": "Prepare Payroll",
  "hr.payroll.approve": "Approve Payroll",
  "hr.payroll.view": "View Payroll",
  "hr.payroll.post": "Post Payroll",
  "hr.payroll.pay": "Pay Payroll",
  "hr.statutory.manage": "Manage Statutory Payroll Rules",
  "hr.expenses.approve": "Approve Expenses",
  "hr.expenses.submit": "Submit Expenses",
  "integrations.manage": "Manage Integrations",
  "operations.trips.manage": "Manage Trips",
  "orders.approve": "Approve Variances",
  "orders.create": "Create Order",
  "orders.dispatch": "Confirm Dispatch",
  "orders.edit": "Edit Order",
  "orders.load": "Load",
  "orders.prepare": "Prepare",
  "orders.view": "View Orders",
  "purchasing.bills.approve": "Approve Bills",
  "purchasing.bills.view": "View Supplier Bills",
  "purchasing.orders.approve": "Approve Purchase Orders",
  "purchasing.orders.view": "View Purchase Orders",
  "purchasing.suppliers.manage": "Manage Suppliers",
  "purchasing.suppliers.view": "View Suppliers",
  "reports.finance": "View Financial Reports",
  "reports.view": "View Reports",
  "sales.credit.manage": "Manage Credit",
  "sales.customers.manage": "Manage Customers",
  "sales.customers.view": "View Customers",
  "sales.invoices.view": "View Invoices",
  "sales.price_override": "Override Prices",
  "sales.quotations.manage": "Manage Quotations",
  "sales.quotations.view": "View Quotations",
  "stock.adjust": "Adjust Stock",
  "stock.approve_adjustments": "Approve Adjustments",
  "stock.manage_products": "Manage Products",
  "stock.manage_suppliers": "Manage Suppliers",
  "stock.receive": "Record Receipt",
  "stock.sort": "Modify Sorting",
  "stock.view": "View Stock",
  "users.view": "View Users",
};

export const PERMISSION_DESC_EN: Record<Permission, string> = {
  "stock.transfer": "Move stock between storage locations (e.g. from receiving to the cold room)",
  "stock.reserve": "Reserve or release a quantity for an order",
  "stock.valuation.view": "See average cost and stock value",
  "users.create": "Add a new user",
  "users.edit": "Change a user's username or display name",
  "users.disable": "Disable or enable a user account",
  "users.change_role": "Change a user's role",
  "settings.manage": "Manage individual permission exceptions and system settings",
  "core.masterdata.view": "See the company, branches, warehouses, storage locations, units of measure and currencies",
  "core.masterdata.manage": "Add, edit and deactivate the company, branches, warehouses, storage locations, units of measure and currencies",
  "sales.pricing.view": "See price lists and order prices and values",
  "sales.pricing.manage": "Create price lists, record daily prices, set product tax and customer price lists",
  "sales.invoices.manage": "Create and issue sales invoices and credit notes",
  "sales.tax.manage": "Set the VAT treatment of each product (exempt / 14% / zero)",
  "purchasing.prices.view": "See supplier prices, purchase order values and supplier quotes",
  "purchasing.prices.manage": "Record agreed supplier prices by date",
  "purchasing.rfq.manage": "Send requests for quotation to suppliers, record their quotes and award",
  "purchasing.orders.manage": "Create, edit, send and cancel purchase orders",
  "purchasing.bills.manage": "Record supplier bills, match them to the order and receipt, and issue debit notes",
  "accounting.manage": "Manual journals and their reversal, stock valuation posting, bank reconciliation",
  "accounting.receipts.manage": "Record customer receipts and allocate them to invoices",
  "accounting.payments.manage": "Record supplier payments and allocate them to their bills",
  "hr.advances.manage": "Pay an employee an advance or what they are owed, or receive an advance repayment",
  "accounting.eta.manage": "Configure e-invoice issuer and receiver profiles",
  "accounting.eta.view": "View e-invoice status and submissions",
  "accounting.periods.close": "Close accounting periods and fiscal years; request a reopen",
  "accounting.periods.reopen": "Approve reopening a closed month or fiscal year requested by someone else, with a written reason",
  "accounting.journals.approve": "Approve manual journals above the approval threshold (never one's own)",
  "accounting.opening.approve": "Approve the reviewed opening-balance batch so it posts once",
  "accounting.assets.view": "See the fixed-asset register, book values, depreciation and reports",
  "accounting.assets.manage": "Record assets and categories, run monthly depreciation, transfer and dispose of assets",
  "accounting.view": "View accounting dashboards and reports",
  "audit.view": "View the system audit log",
  "hr.employees.manage": "Add, edit, and manage employee records",
  "hr.employees.view": "View employee files and employment history (no private data or salary)",
  "hr.private.view": "View national ID, insurance, bank account and employee documents — every view is logged",
  "hr.private.manage": "Record and change private data, bank accounts and employee documents",
  "hr.attendance.record": "Record and confirm attendance, absences and overtime",
  "hr.attendance.approve": "Approve corrections to confirmed or locked attendance days",
  "hr.leave.request": "Record leave requests for employees",
  "hr.leave.approve": "Approve or reject leave requests",
  "hr.leave.configure": "Define leave types and entitlement policies",
  "hr.compensation.view": "View each employee's salary, components and history",
  "hr.compensation.manage": "Propose a salary or a salary change — applied after approval",
  "hr.payroll.prepare": "Create, calculate and submit the monthly payroll run",
  "hr.payroll.approve": "Approve or return a payroll run — never one you prepared or submitted",
  "hr.payroll.view": "View payroll runs and payslips",
  "hr.payroll.post": "Post an approved run to the ledger, or reverse it before anything is paid — using the accounts the accountant configured",
  "hr.payroll.pay": "Record salary payments of a posted run (up to each payslip's net) and reverse a mistaken payment",
  "hr.statutory.manage": "Record statutory payroll rules with their legal reference; verification needs a second person",
  "hr.expenses.approve": "Approve expense claims and advances",
  "hr.expenses.submit": "Submit expense claims and advances",
  "integrations.manage": "Create and revoke integration API keys, view call logs",
  "operations.trips.manage": "Create and manage trips",
  "orders.approve": "Approve shortages and release orders needing review",
  "orders.create": "Create a manual order or clone an existing one",
  "orders.dispatch": "Confirm order dispatch with driver and vehicle data",
  "orders.edit": "Edit order data, quantities, cancel, reopen, and manually change status",
  "orders.load": "Record loading quantities and advance order status",
  "orders.prepare": "Record preparation quantities and advance order status",
  "orders.view": "View orders and their details and history",
  "purchasing.bills.approve": "Approve supplier bills",
  "purchasing.bills.view": "View supplier bills and invoices",
  "purchasing.orders.approve": "Approve purchase orders",
  "purchasing.orders.view": "View purchase orders",
  "purchasing.suppliers.manage": "Create, edit, and manage suppliers",
  "purchasing.suppliers.view": "View supplier accounts",
  "reports.finance": "View financial reports and summaries",
  "reports.view": "View operational and management reports",
  "sales.credit.manage": "Manage customer credit and payment holds",
  "sales.customers.manage": "Create, edit, and manage customer accounts",
  "sales.customers.view": "View customer accounts and details",
  "sales.invoices.view": "View issued and draft invoices",
  "sales.price_override": "Override order line prices and discounts",
  "sales.quotations.manage": "Create, edit, send, and convert quotations",
  "sales.quotations.view": "View quotations and their status",
  "stock.adjust": "Perform manual stock adjustments with a reason",
  "stock.approve_adjustments": "Approve pending stock adjustments",
  "stock.manage_products": "Add, edit, and deactivate stock products",
  "stock.manage_suppliers": "Add, edit, and deactivate suppliers",
  "stock.receive": "Record new material receipts from suppliers",
  "stock.sort": "Edit receipt and sorting quantities or void a receipt",
  "stock.view": "View stock dashboard, balances, ledger, and receipts",
  "users.view": "View user accounts and their details",
};

/** A permission's label and description in the screen's language (English maps are complete by type). */
export function permissionText(key: string, locale: string) {
  const d = PERMISSION_DEFS.find((x) => x.key === key);
  if (locale === "en" && d) return { label: PERMISSION_LABEL_EN[d.key], description: PERMISSION_DESC_EN[d.key] };
  return { label: d?.label ?? key, description: d?.description ?? "" };
}
