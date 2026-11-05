import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAuth } from "@/lib/authz";
import { myNotifications } from "@/lib/core/notifications";
import { jsonResponse } from "@/lib/http-response";

/** The caller's own notifications, newest first, plus the unread count. The bell polls this on
 * every screen: an unchanged inbox revalidates to a body-less 304 (lib/http-response.ts). */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);
    const sp = new URL(req.url).searchParams;
    return jsonResponse(req, await myNotifications(ctx.id, { unreadOnly: sp.get("unread") === "1", limit: Number(sp.get("limit")) || undefined }));
  } catch (err) {
    return handleApiError(err, req);
  }
}
