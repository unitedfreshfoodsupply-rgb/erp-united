import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { createCashAccount, listCashAccounts } from "@/lib/accounting/treasury";
import { postHandler } from "@/lib/route-handlers";

/** Cash boxes and bank accounts with their balances. Receipt/payment forms read the active
 * ones (names only) through /api/accounting/cash-accounts?active=1 as well. */
export async function GET(req: NextRequest) {
  try {
    const ctxFull = await requireAnyPermission(req, ["accounting.view", "accounting.receipts.manage", "accounting.payments.manage", "hr.expenses.submit", "hr.advances.manage", "hr.payroll.pay"]);
    const all = new URL(req.url).searchParams.get("all") === "1";
    const rows = await listCashAccounts({ includeInactive: all && ctxFull.can("accounting.view") });
    // Balances are financial visibility (accounting.view); the forms need only the names.
    const full = ctxFull.can("accounting.view");
    return NextResponse.json({ cashAccounts: full ? rows : rows.map((r) => ({ id: r.id, code: r.code, name: r.name, nameAr: r.nameAr, type: r.type, active: r.active })) });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export const POST = postHandler("accounting.manage", async (body, actor) => ({ cashAccount: await createCashAccount(body, actor) }));
