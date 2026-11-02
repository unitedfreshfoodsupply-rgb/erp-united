import { NextRequest } from "next/server";
import { jsonFor } from "@/lib/security/redact";
import { handleApiError } from "@/lib/rbac";
import { requireStockActor } from "@/lib/stock-auth";
import { createSupplier, listSuppliers } from "@/lib/stock-service";
import { readJson } from "@/lib/http";

export async function GET(req: NextRequest) {
  try {
    const viewer = await requireStockActor(req, "stock.view");
    const includeInactive = new URL(req.url).searchParams.get("all") === "1";
    return jsonFor(viewer, { suppliers: await listSuppliers({ includeInactive }) });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireStockActor(req, "stock.manage_suppliers");
    const body = await readJson(req);
    const supplier = await createSupplier(
      { name: body.name, name_ar: body.name_ar, phone: body.phone, notes: body.notes },
      actor
    );
    return jsonFor(actor, { supplier }, { status: 201 });
  } catch (err) {
    return handleApiError(err, req);
  }
}
