/**
 * Which accounts a service-bill line may be charged to — one rule for the server
 * (lib/purchasing/bills.ts) and the form (components/purchasing/BillsView.tsx), so
 * the form never offers an account the server refuses, nor hides one it accepts.
 *
 * Allowed: an active, postable expense or asset account that is not a cash/bank
 * account and whose system key is not one of these:
 *  - control accounts, moved only by their own documents (customers, suppliers,
 *    inventory, goods received not invoiced, employee balances);
 *  - input VAT, which the bill posts by itself from each line's tax;
 *  - the stock-cost accounts — cost of goods sold, inventory adjustments, purchase
 *    price variance — which the stock ledger and goods bills post, so a service
 *    charged there would distort margins and the cost reconciliation.
 * The standard operating-expense accounts (general, transport, salaries) carry system
 * keys too and are allowed.
 *
 * Pure: imported by the client as well as the server.
 */

export const SERVICE_BILL_REFUSED_KEYS: ReadonlySet<string> = new Set([
  "ar", "ap", "inventory", "grni", "employee_advances", "employee_payable",
  "vat_input",
  "cogs", "inventory_adjustment", "ppv",
  "cash", "bank",
]);

export type ChargeableAccount = { type: string; postable: boolean; active: boolean; systemKey: string | null };

/** `isCashAccount`: the account backs a cash box or bank account (CashAccount). */
export function isServiceBillAccount(a: ChargeableAccount, isCashAccount = false): boolean {
  return a.active && a.postable && (a.type === "expense" || a.type === "asset") && !isCashAccount && !(a.systemKey && SERVICE_BILL_REFUSED_KEYS.has(a.systemKey));
}
