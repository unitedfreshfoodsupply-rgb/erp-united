import { D, type Dec } from "@/lib/inventory/decimal";

export type AdjustmentQuantity = { productId: string; quantity: string };

/** Approval limits apply to the total absolute change for each product in a document.
 * This prevents splitting one large change across lines to bypass approval. */
/**
 * `required` (setting inventory.adjustment_approval_required, on by default) makes the
 * threshold mean "above this quantity; 0 = every adjustment". Without it, the legacy
 * reading applies: a threshold of 0 means no approval.
 */
export function requiresAdjustmentApproval(lines: AdjustmentQuantity[], threshold: Dec, required = threshold.gt(0)): boolean {
  if (!required) return false;
  const byProduct = new Map<string, Dec>();
  for (const line of lines) {
    byProduct.set(line.productId, (byProduct.get(line.productId) ?? D(0)).plus(D(line.quantity).abs()));
  }
  return [...byProduct.values()].some((quantity) => quantity.gt(threshold));
}
