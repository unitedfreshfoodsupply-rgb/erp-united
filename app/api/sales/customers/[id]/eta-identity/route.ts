import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission, requirePermission } from "@/lib/authz";
import { readJson } from "@/lib/http";
import { serviceActorFromContext } from "@/lib/core/actor";
import { createLegalEntityForCustomer, customerEtaIdentity } from "@/lib/sales/customers";

/** The customer's e-invoice identity from its master record (sales.customers.view or accounting.eta.view). */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireAnyPermission(req, ["sales.customers.view", "accounting.eta.view"]);
    return NextResponse.json(await customerEtaIdentity(params.id, serviceActorFromContext(ctx)));
  } catch (err) {
    return handleApiError(err, req);
  }
}

/** Creates the customer's legal entity from its card and links it (sales.customers.manage). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requirePermission(req, "sales.customers.manage");
    return NextResponse.json({ legalEntity: await createLegalEntityForCustomer(params.id, await readJson(req), serviceActorFromContext(ctx)) }, { status: 201 });
  } catch (err) {
    return handleApiError(err, req);
  }
}
