import type { Tx } from "@/lib/tx";
import { companySnapshot, documentCompany, partySnapshot, productCodes, type CompanySnapshot, type PartySnapshot } from "@/lib/core/document-snapshot";

/**
 * What a supplier bill freezes when it posts: the supplier's card, UNITED as the buyer, and per
 * goods line its product code, PO and receipt. The bill itself records the supplier's own
 * invoice (number, date, amounts); this snapshot keeps who it was from as they were then.
 */
export type BillPostSnapshot = {
  v: 1;
  supplier: PartySnapshot & { category: string | null };
  buyer: CompanySnapshot | null;
  /** By line number (goods lines). */
  lines: Record<string, { productCode: string | null; poNumber: string | null; receiptNumber: string; receivedDate: string }>;
};

export async function buildPostSnapshot(tx: Tx, billId: string): Promise<BillPostSnapshot> {
  const [company, bill] = await Promise.all([
    documentCompany(tx),
    tx.supplierBill.findUniqueOrThrow({
      where: { id: billId },
      select: {
        supplier: true,
        lines: { select: { lineNo: true, productId: true, intake: { select: { receiptNumber: true, receivedDate: true } }, poLine: { select: { po: { select: { number: true } } } } } },
      },
    }),
  ]);
  const codes = await productCodes(tx, bill.lines.map((l) => l.productId));
  return {
    v: 1,
    supplier: { ...partySnapshot(bill.supplier), category: bill.supplier.category ?? null },
    buyer: company ? companySnapshot(company) : null,
    lines: Object.fromEntries(
      bill.lines.map((l) => [String(l.lineNo), { productCode: codes.get(l.productId) ?? null, poNumber: l.poLine?.po.number ?? null, receiptNumber: l.intake.receiptNumber, receivedDate: l.intake.receivedDate }])
    ),
  };
}

export function readPostSnapshot(v: unknown): BillPostSnapshot | null {
  return v && typeof v === "object" && (v as { v?: unknown }).v === 1 ? (v as BillPostSnapshot) : null;
}
