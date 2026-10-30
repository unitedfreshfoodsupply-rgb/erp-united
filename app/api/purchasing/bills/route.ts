import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { createBill, getBill, listBills } from "@/lib/purchasing/bills";
import { postHandler } from "@/lib/route-handlers";
import { jsonResponse } from "@/lib/http-response";
import { listLimit } from "@/lib/core/list-window";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "purchasing.bills.view");
    const sp = new URL(req.url).searchParams;
    const limit = listLimit(sp.get("limit"));
    const { items, total } = await listBills({ status: sp.get("status") ?? undefined, supplierId: sp.get("supplier_id") ?? undefined, limit });
    return jsonResponse(req, { bills: items, total, limit });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("purchasing.bills.manage", async (body, actor) => ({ bill: await getBill((await createBill(body, actor)).id) }));
