import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { setLoadedQuantity, markItemLoaded, recordLoaded } from "@/lib/orders-service";
import { readJson } from "@/lib/http";
import { localizeServerMessage, requestLocale } from "@/lib/locale/server-messages";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; itemId: string } }
) {
  try {
    const actor = await requireOrderActor(req, "orders.load");
    const body = await readJson(req);

    // The floor's one tap — quantity and done together — is one transaction (PM-8).
    if (body.quantity !== undefined && body.mark_done) {
      const item = await recordLoaded(params.id, params.itemId, body.quantity, actor, {
        expectedVersion: body.expected_version,
        note: body.note,
      });
      return NextResponse.json({ item });
    }

    if (body.quantity !== undefined) {
      return NextResponse.json(await setLoadedQuantity(params.id, params.itemId, body.quantity, actor, {
        expectedVersion: body.expected_version,
        note: body.note,
      }));
    }

    if (body.mark_done) {
      const item = await markItemLoaded(params.id, params.itemId, actor, body.expected_version);
      return NextResponse.json({ item });
    }

    return NextResponse.json({ error: localizeServerMessage("لازم تبعت quantity أو mark_done", requestLocale(req)) }, { status: 400 });
  } catch (err) {
    return handleApiError(err, req);
  }
}
