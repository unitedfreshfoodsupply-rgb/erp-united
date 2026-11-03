import type { Permission } from "@/lib/permissions";
import { REPORT_PAGE_PERMISSIONS } from "@/lib/nav";

/**
 * Whether a viewer can open a link a report gives — a catalogue entry's own screen or a
 * row's drill-down. A link the viewer would only meet as "access denied" (or as another tab
 * than the one it names) is not offered: the catalogue leaves the entry out, and the row is
 * listed without its link.
 *
 * PAGE_GATES is each linked page's guard exactly as its app/<route>/page.tsx checks it (any
 * one permission opens it; tests/unit/report-page-access.test.ts reads them from there).
 * DEEP_LINK_GATES is what the view needs to show the tab or record a link names — without
 * it the view falls back to another tab. A page missing from the table is not linked.
 */
export const PAGE_GATES: Record<string, readonly Permission[]> = {
  "/accounting": ["accounting.view", "accounting.receipts.manage", "accounting.payments.manage"],
  "/management": ["reports.finance"],
  "/management/cash-flow": ["reports.finance"],
  "/orders/[orderId]": ["orders.view"],
  "/purchasing": ["purchasing.orders.view", "purchasing.suppliers.view", "purchasing.bills.view"],
  "/purchasing/suppliers/[id]": ["purchasing.suppliers.view"],
  "/reports": REPORT_PAGE_PERMISSIONS,
  "/reports/[key]": REPORT_PAGE_PERMISSIONS,
  "/sales": ["sales.customers.view"],
  "/sales/customers/[id]": ["sales.customers.view"],
  "/stock/entries": ["stock.receive"],
  "/stock/inventory": ["stock.view"],
  "/stock/ledger": ["stock.view"],
  "/stock/products/[id]": ["stock.view"],
};

type DeepLinkGate = { page: string; param: string; values?: readonly string[]; anyOf: readonly Permission[] };
export const DEEP_LINK_GATES: DeepLinkGate[] = [
  // AccountingView: the ledger tabs need full visibility; a clerk sees only receipts or payments.
  { page: "/accounting", param: "tab", values: ["health", "treasury", "chart", "costcenters", "analysis", "journals", "trial", "vat", "periods"], anyOf: ["accounting.view"] },
  { page: "/accounting", param: "tab", values: ["reconcile", "opening"], anyOf: ["accounting.manage"] },
  { page: "/accounting", param: "tab", values: ["receipts"], anyOf: ["accounting.view", "accounting.receipts.manage"] },
  { page: "/accounting", param: "tab", values: ["payments"], anyOf: ["accounting.view", "accounting.payments.manage"] },
  // PurchasingView: bills (and the payables aging and statements in them) and suppliers are tabs of their own.
  { page: "/purchasing", param: "tab", values: ["bills"], anyOf: ["purchasing.bills.view"] },
  { page: "/purchasing", param: "tab", values: ["orders", "replenishment"], anyOf: ["purchasing.orders.view"] },
  { page: "/purchasing", param: "tab", values: ["rfqs"], anyOf: ["purchasing.rfq.manage"] },
  { page: "/purchasing", param: "tab", values: ["suppliers"], anyOf: ["purchasing.suppliers.view"] },
  { page: "/purchasing", param: "po", anyOf: ["purchasing.orders.view"] },
  { page: "/purchasing", param: "bill", anyOf: ["purchasing.bills.view"] },
  { page: "/purchasing", param: "supplier", anyOf: ["purchasing.suppliers.view"] },
  // CustomersView: invoices (and the receivables aging in them).
  { page: "/sales", param: "tab", values: ["invoices"], anyOf: ["sales.invoices.view"] },
  { page: "/sales", param: "invoice", anyOf: ["sales.invoices.view"] },
  { page: "/sales", param: "tab", values: ["prices"], anyOf: ["sales.pricing.view"] },
  { page: "/sales", param: "tab", values: ["quotations"], anyOf: ["sales.quotations.view"] },
  // InventoryView: what stock is worth.
  { page: "/stock/inventory", param: "tab", values: ["valuation"], anyOf: ["stock.valuation.view"] },
];

const segments = (path: string) => path.split("/").filter(Boolean);

/** The app route ("/orders/[orderId]") a pathname opens, or null when the table does not know it. */
export function pageOf(pathname: string): string | null {
  const s = segments(pathname);
  return Object.keys(PAGE_GATES).find((route) => { const r = segments(route); return r.length === s.length && r.every((x, i) => x.startsWith("[") || x === s[i]); }) ?? null;
}

/** True when the viewer passes the page's guard and whatever the link's tab or record needs inside it. */
export function mayOpenLink(href: string, can: (p: Permission) => boolean): boolean {
  const url = new URL(href, "http://report.link");
  const page = pageOf(url.pathname);
  if (!page || !PAGE_GATES[page].some(can)) return false;
  return DEEP_LINK_GATES.every((g) => {
    const v = url.searchParams.get(g.param);
    return g.page !== page || v === null || (g.values !== undefined && !g.values.includes(v)) || g.anyOf.some(can);
  });
}
