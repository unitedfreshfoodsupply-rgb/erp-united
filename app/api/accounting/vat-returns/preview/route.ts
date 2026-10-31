import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { previewVatReturn } from "@/lib/accounting/vat-returns";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    const q = new URL(req.url).searchParams;
    return NextResponse.json({ preview: await previewVatReturn(q.get("from") ?? "", q.get("to") ?? "") });
  } catch (err) {
    return handleApiError(err, req);
  }
}
