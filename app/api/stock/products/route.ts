import { NextRequest } from "next/server";
import { jsonFor, jsonForGet } from "@/lib/security/redact";
import { handleApiError } from "@/lib/rbac";
import { requireStockActor } from "@/lib/stock-auth";
import { createProduct, listProducts } from "@/lib/product-master-service";
import { readJson } from "@/lib/http";

export async function GET(req: NextRequest) {
  try {
    const viewer = await requireStockActor(req, "stock.view");
    const includeInactive = new URL(req.url).searchParams.get("all") === "1";
    return jsonForGet(req, viewer, { products: await listProducts({ includeInactive }) });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireStockActor(req, "stock.manage_products");
    const body = await readJson(req);
    const product = await createProduct(
      {
        name: body.name,
        name_ar: body.name_ar,
        sku: body.sku,
        category: body.category,
        unit: body.unit,
        stock_tracked: body.stock_tracked,
      },
      actor
    );
    return jsonFor(actor, { product }, { status: 201 });
  } catch (err) {
    return handleApiError(err, req);
  }
}
