import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireMfaSession } from "@/lib/authz";
import { startEnrollment } from "@/lib/security/mfa-service";

/**
 * Starts enrolment: a new secret, returned exactly once (as the otpauth:// URI the
 * client turns into a QR code, plus the base32 text for manual entry). Calling it
 * again replaces an unconfirmed secret. Responses are never cached.
 */
export async function POST(req: NextRequest) {
  try {
    const me = await requireMfaSession(req);
    const { secret, otpauthUri } = await startEnrollment(me);
    return NextResponse.json({ secret, otpauth_uri: otpauthUri }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err, req);
  }
}
