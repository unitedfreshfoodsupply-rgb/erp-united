import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireServiceActor } from "@/lib/core/actor";
import { getPrivateFile, savePrivateInfo } from "@/lib/hr/private-data";
import { postHandler } from "@/lib/route-handlers";

/** Personal and statutory identifiers, bank accounts (masked) and the document register. Every read is audited. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = await requireServiceActor(req, "hr.private.view");
    return NextResponse.json(await getPrivateFile(params.id, actor));
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const PATCH = postHandler("hr.private.manage", async (body, actor, params) => ({ info: await savePrivateInfo(params.id, body, actor) }), () => 200);
