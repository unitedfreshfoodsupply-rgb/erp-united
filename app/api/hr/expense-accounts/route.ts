import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

/** The expense accounts an expense may be booked to — names only, no balances. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "hr.expenses.submit");
    const accounts = await prisma.account.findMany({ where: { type: "expense", postable: true, active: true, NOT: { systemKey: { in: ["cogs", "inventory_adjustment", "ppv"] } } }, select: { id: true, code: true, name: true, nameAr: true }, orderBy: { code: "asc" } });
    return NextResponse.json({ accounts });
  } catch (err) {
    return handleApiError(err, req);
  }
}
