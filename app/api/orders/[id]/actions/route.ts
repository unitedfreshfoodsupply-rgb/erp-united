import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { jsonResponse } from "@/lib/http-response";
import { localizeServerMessage, requestLocale } from "@/lib/locale/server-messages";
import { orderActionView } from "@/lib/orderDetailReads";
import type { OrderActionState } from "@/lib/orderActions";

/**
 * Whether the order can be cancelled or reopened now, and if not, why and what to do instead
 * — in the words the server would refuse with (lib/orderActions.ts). For whoever may edit
 * orders; read-only.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireOrderActor(req, "orders.edit");
    const locale = requestLocale(req);
    const say = (s: OrderActionState): OrderActionState => ({
      ...s,
      ...(s.message ? { message: localizeServerMessage(s.message, locale) } : {}),
      ...(s.detail ? { detail: localizeServerMessage(s.detail, locale) } : {}),
    });
    const view = await orderActionView(params.id);
    return jsonResponse(req, { ...view, cancel: say(view.cancel), reopen: say(view.reopen) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
