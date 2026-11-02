import { NextRequest } from "next/server";
import { jsonFor } from "@/lib/security/redact";
import { handleApiError } from "@/lib/rbac";
import { requireStockActor } from "@/lib/stock-auth";
import { recordIntake, listIntakes } from "@/lib/stock-service";
import { readJson } from "@/lib/http";
import { searchText } from "@/lib/core/search";

export async function GET(req: NextRequest) {
  try {
    const viewer = await requireStockActor(req, "stock.view");
    const q = new URL(req.url).searchParams;
    const intakes = await listIntakes({
      date: q.get("date") ?? undefined,
      from: q.get("from") ?? undefined,
      to: q.get("to") ?? undefined,
      supplierId: q.get("supplier_id") ?? undefined,
      productId: q.get("product_id") ?? undefined,
      includeVoided: q.get("include_voided") === "1",
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
      q: searchText(q.get("q")) || undefined,
    });
    return jsonFor(viewer, { intakes });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireStockActor(req, "stock.receive");
    const body = await readJson(req);
    const { intake, replayed } = await recordIntake(
          {
            supplier_id: body.supplier_id,
            product_id: body.product_id,
            received_date: body.received_date,
            received_kg: body.received_kg,
            crate_count: body.crate_count,
            rejected_kg: body.rejected_kg,
            notes: body.notes,
            received_qty: body.received_qty,
            rejected_qty: body.rejected_qty,
            grade_b_qty: body.grade_b_qty,
            waste_qty: body.waste_qty,
            grade_b_product_id: body.grade_b_product_id,
            warehouse_id: body.warehouse_id,
            location_id: body.location_id,
            expiry_date: body.expiry_date,
            unit_cost: body.unit_cost,
            provisional_unit_cost: body.provisional_unit_cost,
            entered_qty: body.entered_qty,
            entered_uom: body.entered_uom,
            purchase_order_line_id: body.purchase_order_line_id,
            rejection_reason: body.rejection_reason,
            idempotency_key: body.idempotency_key,
          },
          actor
        );
    // A replay of an already recorded receipt answers 200 with the original.
    return jsonFor(actor, { intake }, { status: replayed ? 200 : 201 });
  } catch (err) {
    return handleApiError(err, req);
  }
}
