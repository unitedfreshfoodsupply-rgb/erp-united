/**
 * Which accounts a service-bill line may be charged to — one rule for the server
 * (lib/purchasing/bills.ts) and the form (components/purchasing/BillsView.tsx), so
 * the form never offers an account the server refuses, nor hides one it accepts.
 *
 * Allowed: an active, postable expense or asset account that is not a cash/bank
 * account and whose system key is not one of these:
 *  - control accounts, moved only by their own documents (customers, suppliers,
 *    inventory, goods received not invoiced, employee balances);
 *  - VAT accounts: input VAT, which the bill posts by itself from each line's tax, and the
 *    output / payable accounts the VAT return moves;
 *  - fixed-asset accounts (category cost and accumulated depreciation, depreciation and
 *    disposal results), which only the asset register posts — an asset is bought on a
 *    capital line naming its category;
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
  "vat_input", "vat_output", "vat_payable",
  "cogs", "inventory_adjustment", "ppv",
  "cash", "bank",
  // Depreciation and disposal results are posted by the fixed-asset register only.
  "fa_depreciation", "fa_disposal_gain", "fa_disposal_loss",
]);

export type ChargeableAccount = { type: string; postable: boolean; active: boolean; systemKey: string | null; controlledBy?: string | null };

/** `isCashAccount`: the account backs a cash box or bank account (CashAccount). */
export function isServiceBillAccount(a: ChargeableAccount, isCashAccount = false): boolean {
  // A fixed-asset category's cost account is charged through a capital line (asset category), never directly.
  return a.active && a.postable && (a.type === "expense" || a.type === "asset") && !isCashAccount && !a.controlledBy && !(a.systemKey && SERVICE_BILL_REFUSED_KEYS.has(a.systemKey));
}
