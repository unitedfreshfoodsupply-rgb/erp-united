import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { listJournals } from "@/lib/accounting/ledger";
import { getJournal, submitManualJournal } from "@/lib/accounting/ledger";
import { postHandler } from "@/lib/route-handlers";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "accounting.view");
    const sp = new URL(req.url).searchParams;
    return NextResponse.json(await listJournals({ from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined, sourceType: sp.get("source_type") ?? undefined, limit: Number(sp.get("limit")) || undefined, offset: Number(sp.get("offset")) || undefined }));
  } catch (err) {
    return handleApiError(err, req);
  }
}
/** 201 { journal } when it posts at once; 202 { journalRequest } when it waits for approval. */
export const POST = postHandler("accounting.manage", async (body, actor) => {
  const r = await submitManualJournal(body, actor);
  return r.request ? { journalRequest: { ...r.request, total: r.request.total.toFixed(2) }, document: { status: r.request.status } } : { journal: await getJournal(r.journal!.id) };
}, (r) => ((r as { document?: { status?: string } }).document?.status === "pending_approval" ? 202 : 201));
