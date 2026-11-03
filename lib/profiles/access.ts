import type { Permission } from "@/lib/permissions";

/**
 * Who reads what on the customer, supplier and product profiles (Nov 2026). One table for
 * the screen (which tabs to show) and the API (which sections to answer): any one listed
 * permission opens a section. Money inside a section follows MONEY below and is removed on
 * the server, never just hidden.
 */
export type ProfileKind = "customer" | "supplier" | "product";

export const PROFILE_PAGE: Record<ProfileKind, Permission> = {
  customer: "sales.customers.view",
  supplier: "purchasing.suppliers.view",
  product: "stock.view",
};

export const PROFILE_SECTIONS = {
  customer: {
    summary: ["sales.customers.view"],
    orders: ["orders.view"],
    invoices: ["sales.invoices.view"],
    payments: ["sales.invoices.view", "accounting.view", "accounting.receipts.manage"],
    returns: ["stock.view", "sales.invoices.view"],
    products: ["orders.view"],
    timeline: ["sales.customers.view"],
  },
  supplier: {
    summary: ["purchasing.suppliers.view"],
    orders: ["purchasing.orders.view"],
    receipts: ["stock.view", "purchasing.bills.view"],
    bills: ["purchasing.bills.view"],
    payments: ["purchasing.bills.view", "accounting.view", "accounting.payments.manage"],
    returns: ["stock.view", "purchasing.bills.view"],
    products: ["purchasing.suppliers.view"],
    timeline: ["purchasing.suppliers.view"],
    history: ["purchasing.suppliers.view"],
  },
  product: {
    summary: ["stock.view"],
    movements: ["stock.view"],
    purchases: ["stock.view"],
    sales: ["orders.view"],
    prices: ["sales.pricing.view", "purchasing.prices.view"],
  },
} as const satisfies Record<ProfileKind, Record<string, readonly Permission[]>>;

export type ProfileSection<K extends ProfileKind> = keyof (typeof PROFILE_SECTIONS)[K] & string;

/** The money a profile can show, and the permission each needs. */
export const MONEY = {
  /** Invoices, credit notes, receipts, refunds, balances and sales totals of a customer. */
  receivable: "sales.invoices.view",
  /** Selling prices on orders and price lists. */
  salesPrice: "sales.pricing.view",
  /** Bills, debit notes, payments, refunds and balances of a supplier. */
  payable: "purchasing.bills.view",
  /** Purchase order prices and agreed supplier prices. */
  purchasePrice: "purchasing.prices.view",
  /** What stock cost: receipt and movement costs. */
  cost: "stock.valuation.view",
} as const satisfies Record<string, Permission>;

export function maySeeSection(kind: ProfileKind, section: string, can: (p: Permission) => boolean): boolean {
  const table = PROFILE_SECTIONS[kind] as Record<string, readonly Permission[]>;
  return !!table[section] && can(PROFILE_PAGE[kind]) && table[section].some(can);
}
