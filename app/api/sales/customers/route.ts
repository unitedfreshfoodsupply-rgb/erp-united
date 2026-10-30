import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { createCustomer, listCustomers } from "@/lib/sales/customers";
import { postHandler } from "@/lib/route-handlers";
import { jsonResponse } from "@/lib/http-response";
import { listLimit } from "@/lib/core/list-window";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "sales.customers.view");
    const sp = new URL(req.url).searchParams;
    const limit = listLimit(sp.get("limit"));
    const { items, total } = await listCustomers({ q: sp.get("q") ?? undefined, includeInactive: sp.get("include_inactive") === "1", limit });
    return jsonResponse(req, { customers: items, total, limit });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("sales.customers.manage", (body, actor) => createCustomer(body, actor).then((customer) => ({ customer })));
