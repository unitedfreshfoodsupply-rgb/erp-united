import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { setPreparedQuantity, markItemPrepared } from "@/lib/orders-service";
import { readJson } from "@/lib/http";
import { localizeServerMessage, requestLocale } from "@/lib/locale/server-messages";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; itemId: string } }
) {
  try {
    const actor = await requireOrderActor(req, "orders.prepare");
    const body = await readJson(req);

    if (body.quantity !== undefined) {
      const result = await setPreparedQuantity(params.id, params.itemId, body.quantity, actor, {
        expectedVersion: body.expected_version,
        note: body.note,
      });
      if (!body.mark_done) return NextResponse.json(result);
    }

    if (body.mark_done) {
      // If quantity was just set above in this same request, the version already
      // moved on — only enforce expected_version here when mark_done is called alone.
      const item = await markItemPrepared(
        params.id,
        params.itemId,
        actor,
        body.quantity !== undefined ? undefined : body.expected_version
      );
      return NextResponse.json({ item });
    }

    return NextResponse.json({ error: localizeServerMessage("لازم تبعت quantity أو mark_done", requestLocale(req)) }, { status: 400 });
  } catch (err) {
    return handleApiError(err, req);
  }
}
