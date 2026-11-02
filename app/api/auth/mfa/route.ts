import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireMfaSession } from "@/lib/authz";
import { mfaStatus } from "@/lib/security/mfa-service";

/** The caller's own two-step status. Reachable while the session is held at enrolment
 * (that is how /mfa/setup knows what to show). Never carries a secret or a code. */
export async function GET(req: NextRequest) {
  try {
    const me = await requireMfaSession(req);
    const status = await mfaStatus(me.id);
    return NextResponse.json({ mfa: { ...status, mustEnroll: me.mustEnroll } });
  } catch (err) {
    return handleApiError(err, req);
  }
}
