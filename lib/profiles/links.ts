import type { Permission } from "@/lib/permissions";
import { mayOpenLink } from "@/lib/reports/page-access";

/**
 * Where each document a profile lists is opened. A link the viewer cannot open (the page's
 * own guard, or the tab or record it names) is dropped by `linkFor`, so a row never leads
 * to "access denied" — the same rule as report drill-downs.
 */
const q = encodeURIComponent;
export const href = {
  customer: (id: string) => `/sales/customers/${id}`,
  supplier: (id: string) => `/purchasing/suppliers/${id}`,
  product: (id: string) => `/stock/products/${id}`,
  order: (id: string) => `/orders/${id}`,
  invoice: (id: string) => `/sales?tab=invoices&invoice=${id}`,
  receipt: (number: string) => `/accounting?tab=receipts&receipts_q=${q(number)}`,
  payment: (number: string) => `/accounting?tab=payments&payments_q=${q(number)}`,
  refunds: (side: "customer" | "supplier") => `/accounting?tab=${side === "customer" ? "receipts" : "payments"}`,
  opening: () => "/accounting?tab=opening",
  po: (id: string) => `/purchasing?po=${id}`,
  bill: (id: string) => `/purchasing?bill=${id}`,
  intake: (receiptNumber: string) => `/stock/entries?in_q=${q(receiptNumber)}`,
  stockDocument: (id: string) => `/stock/inventory?tab=documents&doc=${id}`,
  priceLists: () => "/sales?tab=prices",
};

/** The link, or null when this viewer would not be let in. */
export function linkFor(can: (p: Permission) => boolean, url: string | null): string | null {
  return url && mayOpenLink(url, can) ? url : null;
}

/** Refunds are listed under receipts (customer) or payments (supplier), and only to those who
 * see both sides of the money (AccountingView): full accounting, or both clerk workflows. */
export function refundsLink(can: (p: Permission) => boolean, side: "customer" | "supplier"): string | null {
  const both = can("accounting.view") || (can("accounting.receipts.manage") && can("accounting.payments.manage"));
  return both ? linkFor(can, href.refunds(side)) : null;
}
