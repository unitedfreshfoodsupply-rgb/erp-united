import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireServiceActor } from "@/lib/core/actor";
import { getPurchaseRequest } from "@/lib/purchasing/requests";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = await requireServiceActor(req, "purchasing.requests.view");
    return NextResponse.json({ request: await getPurchaseRequest(params.id, actor) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
