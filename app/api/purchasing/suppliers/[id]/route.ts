import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission, requirePermission } from "@/lib/authz";
import { readJson } from "@/lib/http";
import { serviceActorFromContext } from "@/lib/core/actor";
import { getSupplier, updateSupplierMaster } from "@/lib/purchasing/suppliers";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requirePermission(req, "purchasing.suppliers.view");
    return NextResponse.json({ supplier: await getSupplier(params.id) });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    // The single supplier editor; which fields this user may change is decided in the service.
    const ctx = await requireAnyPermission(req, ["purchasing.suppliers.manage", "stock.manage_suppliers"]);
    return NextResponse.json({ supplier: await updateSupplierMaster(params.id, await readJson(req), serviceActorFromContext(ctx)) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
