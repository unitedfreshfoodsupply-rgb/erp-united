import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireMfaSession } from "@/lib/authz";
import { readJson } from "@/lib/http";
import { regenerateRecoveryCodes } from "@/lib/security/mfa-service";

/** A fresh set of recovery codes (every older one stops working): current password AND
 * a current code. The new codes are in this response only. Audited. */
export async function POST(req: NextRequest) {
  try {
    const me = await requireMfaSession(req);
    const body = await readJson(req);
    const { recoveryCodes } = await regenerateRecoveryCodes(me, body.password, { code: body.code, recoveryCode: body.recovery_code });
    return NextResponse.json({ recovery_codes: recoveryCodes }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err, req);
  }
}
