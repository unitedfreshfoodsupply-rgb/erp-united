import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireMfaSession } from "@/lib/authz";
import { readJson } from "@/lib/http";
import { disableOwnMfa } from "@/lib/security/mfa-service";

/** Turns the caller's own second factor off: current password AND a current code (or
 * a recovery code). Refused for a role that requires two-step sign-in. Audited. */
export async function POST(req: NextRequest) {
  try {
    const me = await requireMfaSession(req);
    const body = await readJson(req);
    await disableOwnMfa(me, body.password, { code: body.code, recoveryCode: body.recovery_code });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err, req);
  }
}
