/**
 * The manual order form's per-line rules (components/supervisor/CreateOrderForm.tsx), kept
 * pure so they can be tested without a browser. The server enforces the same rules again
 * (lib/orders-service.ts, setAgreedLinePriceInTx in lib/sales/pricing.ts).
 */

/** The parts of a form line these rules read. Every value is the input's raw text. */
export type EntryLine = { stock_product_id: string; quantity: string; unit_price: string; discount_pct: string };

/** What a line sends as its agreed price; null sends nothing and the list price applies. */
export type EntryLinePricing = { unit_price: string; discount_pct: string; price_reason?: string };

/** A discount was typed and it is not zero. */
export function hasTypedDiscount(line: Pick<EntryLine, "discount_pct">): boolean {
  return line.discount_pct.trim() !== "" && Number(line.discount_pct) !== 0;
}

/**
 * The line's price differs from the list price, so the server wants a reason. List prices
 * carry no discount, so any discount counts as a difference, as does a typed unit price
 * other than the list's. With no list price the typed price is the price: no reason needed.
 */
export function linePriceDiffers(line: Pick<EntryLine, "unit_price" | "discount_pct">, listPrice: string | null): boolean {
  if (listPrice === null) return false;
  const priceDiffers = line.unit_price.trim() !== "" && Number(line.unit_price) !== Number(listPrice);
  return priceDiffers || hasTypedDiscount(line);
}

/**
 * The price a line sends. A discount typed on its own applies to the list price shown as
 * the placeholder, so that price is sent as the unit price; without it the server would
 * price the line at the full list price and the discount on screen would be lost. A line
 * with neither a typed nor a list price stays unpriced, as the form shows it.
 */
export function linePricingPayload(
  line: Pick<EntryLine, "unit_price" | "discount_pct">,
  listPrice: string | null,
  priceReason: string
): EntryLinePricing | null {
  const typedPrice = line.unit_price.trim();
  if (typedPrice === "" && !hasTypedDiscount(line)) return null;
  const unitPrice = typedPrice !== "" ? typedPrice : listPrice;
  if (unitPrice === null) return null;
  return {
    unit_price: unitPrice,
    discount_pct: line.discount_pct.trim() || "0",
    price_reason: priceReason.trim() || undefined,
  };
}

/**
 * The line's pricing is built on the list price: a discount typed without a price. Such a line
 * is never sent while that list price is still loading or failed to load — it would go without
 * any pricing and the server would charge the full list price, dropping the discount.
 */
export function lineNeedsListPrice(line: Pick<EntryLine, "unit_price" | "discount_pct">): boolean {
  return line.unit_price.trim() === "" && hasTypedDiscount(line);
}

/** A product was chosen but no positive quantity typed: refused, never silently dropped. */
export function lineMissingQuantity(line: Pick<EntryLine, "stock_product_id" | "quantity">): boolean {
  return line.stock_product_id !== "" && !(Number(line.quantity) > 0);
}
