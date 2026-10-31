import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { readJson } from "@/lib/http";
import { serviceActorFromContext } from "@/lib/core/actor";
import { updateAccount } from "@/lib/accounting/ledger";

/** Rename, classify for the cash-flow statement, or retire an account (zero balance). */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requirePermission(req, "accounting.manage");
    return NextResponse.json({ account: await updateAccount(params.id, await readJson(req), serviceActorFromContext(ctx)) });
  } catch (err) {
    return handleApiError(err, req);
  }
}
