import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { createCategory, listCategories } from "@/lib/accounting/fixed-assets";
import { postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.assets.view");
    return NextResponse.json({ categories: await listCategories() });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("accounting.assets.manage", async (body, actor) => ({ category: await createCategory(body, actor) }));
