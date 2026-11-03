import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { createSupplierFull, listSuppliersFull } from "@/lib/purchasing/suppliers";
import { postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "purchasing.suppliers.view");
    const sp = new URL(req.url).searchParams;
    return NextResponse.json({ suppliers: await listSuppliersFull({ q: sp.get("q") ?? undefined, includeInactive: sp.get("include_inactive") === "1", type: sp.get("type") || undefined }) });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("purchasing.suppliers.manage", (body, actor) => createSupplierFull(body, actor).then((supplier) => ({ supplier })));
