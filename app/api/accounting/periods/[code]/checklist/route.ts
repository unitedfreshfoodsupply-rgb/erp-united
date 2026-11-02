import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { periodCloseChecklist } from "@/lib/accounting/close-checklist";

/** ACC-13: what is unfinished in a month before closing it (warnings, not blocks). */
export async function GET(req: NextRequest, { params }: { params: { code: string } }) {
  try {
    await requireAnyPermission(req, ["accounting.periods.close", "accounting.view"]);
    return NextResponse.json(await periodCloseChecklist(params.code));
  } catch (err) {
    return handleApiError(err, req);
  }
}
