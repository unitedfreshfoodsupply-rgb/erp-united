import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { customerExposure } from "@/lib/sales/credit";
import { localizeServerMessage, requestLocale } from "@/lib/locale/server-messages";

/** What the customer owes and has on order, against its limit: finance information (who reads
 * invoices or manages credit), not part of the customer record every desk role opens. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireAnyPermission(req, ["sales.invoices.view", "sales.credit.manage"]);
    const c = await prisma.customer.findUnique({ where: { id: params.id } });
    if (!c) return NextResponse.json({ error: localizeServerMessage("العميل مش موجود", requestLocale(req)) }, { status: 404 });
    const e = await prisma.$transaction((tx) => customerExposure(tx, c.id));
    return NextResponse.json({
      openOrders: e.openOrders.toFixed(2),
      receivable: e.receivable.toFixed(2),
      exposure: e.exposure.toFixed(2),
      unpricedLines: e.unpricedLines,
      creditLimit: c.creditLimit?.toFixed(2) ?? null,
      available: c.creditLimit ? c.creditLimit.minus(e.exposure).toFixed(2) : null,
      paymentTermsDays: c.paymentTermsDays,
      creditHold: c.creditHold,
    });
  } catch (err) {
    return handleApiError(err, req);
  }
}
