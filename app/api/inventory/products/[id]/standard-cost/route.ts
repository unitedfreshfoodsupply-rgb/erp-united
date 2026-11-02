import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { standardCostHistory } from "@/lib/inventory/standard-cost";

/** A product's standard-cost history (DEFECT-SC-01): who changed it, when, why, what it revalued. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireAnyPermission(req, ["accounting.manage", "stock.valuation.view"]);
    return NextResponse.json({ changes: await standardCostHistory(prisma, params.id) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
