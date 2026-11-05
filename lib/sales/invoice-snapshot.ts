import type { Tx } from "@/lib/tx";
import { companySnapshot, documentCompany, partySnapshot, productCodes, type CompanySnapshot, type PartySnapshot } from "@/lib/core/document-snapshot";

/**
 * What a sales invoice freezes at issue, besides the buyer columns it always had (name, tax
 * number, address — which the ETA mapper reads): the seller, the buyer's full card, the order's
 * references and each line's product code. Printed from this snapshot ever after.
 */
export type SalesIssueSnapshot = {
  v: 1;
  seller: CompanySnapshot | null;
  buyer: PartySnapshot & { identitySource: string };
  order: { id: string; number: string; customerPoRef: string | null; deliveryDate: string; trip: string | null } | null;
  /** By line number. */
  lines: Record<string, { productCode: string | null }>;
};

type IssuingCustomer = Parameters<typeof partySnapshot>[0];

export async function buildIssueSnapshot(tx: Tx, invoice: { id: string; orderId: string | null; customer: IssuingCustomer }, identitySource: string): Promise<SalesIssueSnapshot> {
  const [company, order, stop, lines] = await Promise.all([
    documentCompany(tx),
    invoice.orderId ? tx.order.findUnique({ where: { id: invoice.orderId }, select: { id: true, orderNumber: true, customerPoRef: true, deliveryDate: true } }) : null,
    invoice.orderId ? tx.tripStop.findFirst({ where: { orderId: invoice.orderId, active: true }, select: { trip: { select: { number: true } } } }) : null,
    tx.salesInvoiceLine.findMany({ where: { invoiceId: invoice.id }, select: { lineNo: true, productId: true } }),
  ]);
  const codes = await productCodes(tx, lines.map((l) => l.productId));
  return {
    v: 1,
    seller: company ? companySnapshot(company) : null,
    buyer: { ...partySnapshot(invoice.customer), identitySource },
    order: order ? { id: order.id, number: order.orderNumber, customerPoRef: order.customerPoRef, deliveryDate: order.deliveryDate, trip: stop?.trip.number ?? null } : null,
    lines: Object.fromEntries(lines.map((l) => [String(l.lineNo), { productCode: l.productId ? codes.get(l.productId) ?? null : null }])),
  };
}

/** Reads a stored snapshot (JSON from the database); null for drafts and pre-Nov-2026 invoices. */
export function readIssueSnapshot(v: unknown): SalesIssueSnapshot | null {
  return v && typeof v === "object" && (v as { v?: unknown }).v === 1 ? (v as SalesIssueSnapshot) : null;
}
