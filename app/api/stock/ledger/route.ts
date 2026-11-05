import { NextRequest } from "next/server";
import { jsonFor } from "@/lib/security/redact";
import { handleApiError } from "@/lib/rbac";
import { requireStockActor } from "@/lib/stock-auth";
import { currentStock, listMovements } from "@/lib/stock-service";

export async function GET(req: NextRequest) {
  try {
    const viewer = await requireStockActor(req, "stock.view");
    const q = new URL(req.url).searchParams;
    // ?with_stock=0: the movements only, without every product's balance (the grading form
    // reads one receipt's movements; ARC-5). Without it the response is as it always was.
    const withStock = q.get("with_stock") !== "0";
    const [movements, stock] = await Promise.all([
      listMovements({
        productId: q.get("product_id") ?? undefined,
        from: q.get("from") ?? undefined,
        to: q.get("to") ?? undefined,
        limit: q.get("limit") ? Number(q.get("limit")) : 100,
      }),
      withStock ? currentStock() : null,
    ]);
    return jsonFor(viewer, stock ? { movements, currentStock: stock } : { movements });
  } catch (err) {
    return handleApiError(err, req);
  }
}
