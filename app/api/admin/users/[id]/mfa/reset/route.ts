import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { readJson } from "@/lib/http";
import { adminResetMfa } from "@/lib/security/mfa-service";

/**
 * Administrator reset of a user's two-step sign-in (lost phone and recovery codes).
 * Same permission as resetting their password — both hand the account back to whoever
 * knows the password. A reason is required; the user's sessions all end; your own
 * reset needs another super admin when one exists. Audited.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const actor = await requirePermission(req, "users.edit");
    const body = await readJson(req);
    await adminResetMfa(actor, params.id, body.reason);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err, req);
  }
}
