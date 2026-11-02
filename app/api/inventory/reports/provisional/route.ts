import { NextRequest } from "next/server";
import { jsonFor } from "@/lib/security/redact";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { provisionalReceipts } from "@/lib/inventory/reports";

/** WS3 (ACC-E1): receipts still carried at a provisional cost (no posted supplier bill yet). */
export async function GET(req: NextRequest) {
  try {
    const viewer = await requirePermission(req, "stock.valuation.view");
    const rows = await provisionalReceipts();
    return jsonFor(viewer, {
      receipts: rows.map((r) => ({
        intakeId: r.intakeId, receiptNumber: r.receiptNumber, receivedDate: r.receivedDate, supplierId: r.supplierId, productId: r.productId,
        provisionalUnitCost: r.unitCost.toFixed(4), acceptedQty: r.accepted.toString(), onHandQty: r.onHand.toString(),
        provisionalValueOnHand: r.onHand.times(r.unitCost).toFixed(2), billNumber: r.billNumber, billStatus: r.billStatus,
      })),
    });
  } catch (err) {
    return handleApiError(err, req);
  }
}
