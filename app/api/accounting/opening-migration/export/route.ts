import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { openingPositionExport } from "@/lib/accounting/opening-migration";
import { csvResponse, toCsv } from "@/lib/core/csv-export";

/**
 * The opening position as UNITED holds it, for reconciling against the legacy books:
 * ?part=accounts — each account's balance at the cut-off (signed, debit positive);
 * ?part=parties  — each customer's and supplier's opening balance, with the batch that posted it.
 */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    const part = new URL(req.url).searchParams.get("part") === "parties" ? "parties" : "accounts";
    const x = await openingPositionExport();
    const rows = part === "accounts"
      ? x.accounts.map((a) => ({ cutoff: x.cutoverDate, migration_status: x.status, code: a.code, name_ar: a.nameAr, name: a.name, balance_debit_positive: a.v }))
      : x.parties.map((p) => ({ cutoff: x.cutoverDate, migration_status: x.status, party_type: p.partyType, code: p.code, name: p.name, batch: p.batch ?? "", opening_balance: p.v }));
    return csvResponse(toCsv(rows), `opening-${part}-${x.cutoverDate}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}
