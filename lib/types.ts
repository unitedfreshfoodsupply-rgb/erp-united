export const ROLES = ["SUPER_ADMIN", "SUPERVISOR", "STOCK_CONTROLLER", "PREPARER", "LOADER", "SALES", "ACCOUNTANT", "PURCHASER", "ACCOUNTING_CLERK"] as const;
export type Role = (typeof ROLES)[number];

export const ORDER_STATUSES = [
  "new",
  "preparing",
  "ready_for_loading",
  "loading",
  "loaded",
  "dispatched",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ITEM_STATUSES = ["pending", "done"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const HOME_BY_ROLE: Record<Role, string> = {
  SUPER_ADMIN: "/home",
  SUPERVISOR: "/supervisor",
  STOCK_CONTROLLER: "/stock",
  PREPARER: "/prep",
  LOADER: "/load",
  SALES: "/sales",
  ACCOUNTANT: "/home",
  PURCHASER: "/purchasing",
  ACCOUNTING_CLERK: "/accounting",
};

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: "مدير النظام",
  SUPERVISOR: "مشرف",
  STOCK_CONTROLLER: "مراقب المخزون",
  PREPARER: "تجهيز",
  LOADER: "تحميل",
  SALES: "مبيعات",
  ACCOUNTANT: "مدير الحسابات",
  PURCHASER: "مشتريات",
  ACCOUNTING_CLERK: "موظف حسابات",
};

/** English role labels for localized interface. */
export const ROLE_LABEL_EN: Record<Role, string> = {
  SUPER_ADMIN: "System Admin",
  SUPERVISOR: "Supervisor",
  STOCK_CONTROLLER: "Stock Controller",
  PREPARER: "Preparer",
  LOADER: "Loader",
  SALES: "Sales",
  ACCOUNTANT: "Accounting manager",
  PURCHASER: "Purchaser",
  ACCOUNTING_CLERK: "Accounting clerk",
};

/** Human-readable one-line description of each role, shown on the read-only profile. */
export const ROLE_DESC: Record<Role, string> = {
  SUPER_ADMIN: "إدارة كاملة للنظام والمستخدمين والإعدادات",
  SUPERVISOR: "إشراف على تجهيز وتحميل الأوردرات واعتماد النقص",
  STOCK_CONTROLLER: "إدارة المخزون والاستلام والجرد والتحويلات",
  PREPARER: "تجهيز الأوردرات من المخزون",
  LOADER: "التحميل على العربيات والتوزيع",
  SALES: "المبيعات: الأوردرات والتسعير والعملاء والفوترة",
  ACCOUNTANT: "الحسابات: القيود والميزان والتحصيل والسداد",
  PURCHASER: "المشتريات: أوامر الشراء والاستلام وفواتير الموردين",
  ACCOUNTING_CLERK: "تسجيل التحصيل من العملاء والسداد للموردين بس — من غير الأرصدة والقيود والتقارير المالية",
};

/** English role descriptions for localized interface. */
export const ROLE_DESC_EN: Record<Role, string> = {
  SUPER_ADMIN: "Full system, user, and settings management",
  SUPERVISOR: "Oversee order prep, loading, and shortage approval",
  STOCK_CONTROLLER: "Manage stock, receiving, inventory, and transfers",
  PREPARER: "Prepare orders from stock",
  LOADER: "Loading and dispatch",
  SALES: "Sales: orders, pricing, customers, invoicing",
  ACCOUNTANT: "Accounting: entries, balance, collection, payments",
  PURCHASER: "Purchasing: POs, receiving, supplier bills",
  ACCOUNTING_CLERK: "Records customer receipts and supplier payments only — no balances, journals or financial reports",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
