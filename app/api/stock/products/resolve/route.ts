import { NextRequest } from "next/server";
import { jsonFor } from "@/lib/security/redact";
import { handleApiError } from "@/lib/rbac";
import { requireStockActor } from "@/lib/stock-auth";
import { resolveProductName } from "@/lib/product-master-service";
import { readJson, type JsonBody } from "@/lib/http";

/**
 * Product identity lookup — the contract for n8n / Hermes.
 *
 * Submit a product name, get back exactly one of: matched, ambiguous, unmapped.
 * There is no fourth answer and no confidence score. An integration that receives
 * "unmapped" should record the line as-is and leave it for a human; it must never
 * fall back to picking something similar.
 *
 * A future AI step may PROPOSE that an unmapped name become a product, but it
 * proposes into this same shape and the master stays the authority.
 */
export async function POST(req: NextRequest) {
  try {
    const viewer = await requireStockActor(req, "stock.view");
    const body = await readJson(req).catch((): JsonBody => ({}));
    const names: unknown = body.names ?? body.name;
    if (typeof names === "string") {
      return jsonFor(viewer, { result: await resolveProductName(names) });
    }
    if (Array.isArray(names)) {
      const results = await Promise.all(
        names.filter((n): n is string => typeof n === "string").map(async (n) => ({
          input: n,
          ...(await resolveProductName(n)),
        }))
      );
      return jsonFor(viewer, { results });
    }
    return jsonFor(viewer, { error: "ابعت name أو names" }, { status: 400 });
  } catch (err) {
    return handleApiError(err, req);
  }
}
