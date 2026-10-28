import { HOME_BY_ROLE, type Role } from "@/lib/types";
import type { Permission } from "@/lib/permissions";
import type { TranslationKey } from "@/lib/locale";

/**
 * The single navigation definition. The header renders from it, and the post-login
 * landing page is chosen from it, so a module can never appear in one place and be
 * missing from the other. Each entry names the permission that both hides the link
 * and — enforced separately, server-side — protects the page behind it.
 *
 * `labelKey` is a TranslationKey into the locale dictionary, so the same definition
 * works for both Arabic and English without a server-side locale context.
 */
export type NavLink = {
  href: string;
  labelKey: TranslationKey;
  /** The Arabic label for fallback / server-side use (e.g. print titles). */
  label: string;
  /** One permission, or several meaning "any of these". */
  permission: Permission | Permission[];
  /** Shown in the header. Sub-pages of a module are reachable from the module itself. */
  primary: boolean;
  /** The department the link belongs to — the header groups by it when a role sees many links. */
  group: NavGroup;
  /** When the PAGE is open to every signed-in user (it then filters its own content)
   * and `permission` only decides whether the link is worth showing in the header. */
  pageOpenToAll?: true;
};

export type NavGroup = "ops" | "control" | "sales" | "purchasing" | "stock" | "finance" | "admin";
export const NAV_GROUPS: { key: NavGroup; labelKey: TranslationKey; label: string }[] = [
  { key: "ops", labelKey: "nav.group.ops", label: "التشغيل" },
  { key: "control", labelKey: "nav.group.control", label: "المتابعة" },
  { key: "sales", labelKey: "nav.group.sales", label: "المبيعات" },
  { key: "purchasing", labelKey: "nav.group.purchasing", label: "المشتريات" },
  { key: "stock", labelKey: "nav.group.stock", label: "المخزون" },
  { key: "finance", labelKey: "nav.group.finance", label: "الحسابات" },
  { key: "admin", labelKey: "nav.group.admin", label: "الإدارة" },
];

export const NAV_LINKS: NavLink[] = [
  { href: "/prep", labelKey: "nav.link.prep", label: "التجهيز", permission: "orders.prepare", group: "ops", primary: true },
  { href: "/load", labelKey: "nav.link.load", label: "التحميل", permission: "orders.load", group: "ops", primary: true },
  { href: "/production", labelKey: "nav.link.production", label: "إنتاج النهارده", permission: "orders.view", group: "ops", primary: true },
  { href: "/production/sheet", labelKey: "nav.link.sheet", label: "شيت التجهيز الموحد", permission: "orders.view", group: "ops", primary: true },
  { href: "/operations", labelKey: "nav.link.operations", label: "التوزيع", permission: "orders.view", group: "ops", primary: true },
  { href: "/supervisor", labelKey: "nav.link.supervisor", label: "مركز التحكم", permission: "reports.view", group: "control", primary: true },
  { href: "/supervisor/exceptions", labelKey: "nav.link.exceptions", label: "نواقص التجهيز", permission: "reports.view", group: "control", primary: true },
  { href: "/supervisor/report", labelKey: "nav.link.daily-report", label: "تقرير اليوم", permission: "reports.view", group: "control", primary: true },
  { href: "/supervisor/audit", labelKey: "nav.link.audit-log", label: "سجل المراجعة", permission: "audit.view", group: "control", primary: false },
  // Every permission that can decide some approval type — see lib/core/approvals.ts.
  // The page lists what you may decide AND what you raised, so anyone may open it.
  { href: "/approvals", labelKey: "nav.link.approvals", label: "الموافقات", permission: ["orders.approve", "stock.approve_adjustments", "sales.credit.manage", "purchasing.orders.approve", "purchasing.bills.approve", "hr.expenses.approve", "hr.attendance.approve", "hr.leave.approve", "hr.payroll.approve"], group: "control", primary: true, pageOpenToAll: true },
  { href: "/sales", labelKey: "nav.link.sales", label: "العملاء", permission: "sales.customers.view", group: "sales", primary: true },
  { href: "/purchasing", labelKey: "nav.link.purchasing", label: "المشتريات", permission: "purchasing.orders.view", group: "purchasing", primary: true },
  { href: "/accounting", labelKey: "nav.link.accounting", label: "الحسابات", permission: "accounting.view", group: "finance", primary: true },
  { href: "/eta", labelKey: "nav.link.eta", label: "الفاتورة الإلكترونية", permission: "accounting.eta.view", group: "finance", primary: true },
  { href: "/hr", labelKey: "nav.link.hr", label: "الموظفين والمصروفات", permission: "hr.expenses.submit", group: "admin", primary: true },
  { href: "/hr/attendance", labelKey: "nav.link.attendance", label: "الحضور والانصراف", permission: ["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"], group: "admin", primary: true },
  { href: "/hr/leave", labelKey: "nav.link.leave", label: "الإجازات", permission: ["hr.leave.request", "hr.leave.approve", "hr.leave.configure"], group: "admin", primary: true },
  { href: "/hr/payroll", labelKey: "nav.link.payroll", label: "المرتبات", permission: ["hr.compensation.view", "hr.compensation.manage", "hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay", "hr.statutory.manage"], group: "admin", primary: true },
  { href: "/management", labelKey: "nav.link.management", label: "تقارير الإدارة", permission: "reports.finance", group: "finance", primary: true },
  { href: "/management/operations", labelKey: "nav.link.ops-report", label: "أداء التشغيل", permission: "reports.view", group: "control", primary: true },
  { href: "/stock", labelKey: "nav.link.stock", label: "المخزون", permission: "stock.view", group: "stock", primary: true },
  { href: "/stock/inventory", labelKey: "nav.link.inventory", label: "إدارة المخزون", permission: "stock.view", group: "stock", primary: true },
  { href: "/stock/entries", labelKey: "nav.link.entries", label: "الاستلامات", permission: "stock.receive", group: "stock", primary: true },
  { href: "/stock/ledger", labelKey: "nav.link.ledger", label: "سجل الحركات", permission: "stock.view", group: "stock", primary: true },
  { href: "/stock/setup", labelKey: "nav.link.setup", label: "دليل الأصناف", permission: "stock.view", group: "stock", primary: true },
  { href: "/admin", labelKey: "nav.link.admin", label: "الإدارة", permission: "users.view", group: "admin", primary: true },
];

/**
 * Where to send someone who lands on "/".
 *
 * Derived from what they can actually reach, not from their role: a supervisor whose
 * reports permission has been revoked by an override would otherwise be bounced into
 * a page they are about to be refused from, which reads as a broken login.
 */
const LANDING_ORDER = ["/admin", "/supervisor", "/sales", "/purchasing", "/stock", "/prep", "/load", "/production"];

function holds(held: Set<string>, permission: NavLink["permission"]) {
  return Array.isArray(permission) ? permission.some((p) => held.has(p)) : held.has(permission);
}

export function homePathFor(permissions: Iterable<string>, role?: Role): string {
  const held = new Set(permissions);
  // The role's own home first (an accountant lands on sales/finance, not on the
  // operations board it can also read), when it can actually reach it.
  const own = role ? NAV_LINKS.find((l) => l.href === HOME_BY_ROLE[role]) : undefined;
  if (own && holds(held, own.permission)) return own.href;
  for (const href of LANDING_ORDER) {
    const link = NAV_LINKS.find((l) => l.href === href);
    if (link && holds(held, link.permission)) return href;
  }
  return "/no-access";
}

export function visibleNavLinks(permissions: Iterable<string>): NavLink[] {
  const held = new Set(permissions);
  return NAV_LINKS.filter((l) => l.primary && holds(held, l.permission));
}