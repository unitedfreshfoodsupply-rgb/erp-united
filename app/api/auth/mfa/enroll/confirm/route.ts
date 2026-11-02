import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireMfaSession } from "@/lib/authz";
import { setSessionCookie } from "@/lib/auth";
import { getSetting } from "@/lib/core/settings-service";
import { readJson } from "@/lib/http";
import { confirmEnrollment } from "@/lib/security/mfa-service";

/**
 * Confirms enrolment with the first code from the authenticator app. Every other
 * session of the account ends (the epoch moves); this one is re-issued under the new
 * epoch — cookie and tab token alike — so the user carries straight on. The recovery
 * codes are in this response and nowhere else, ever.
 */
export async function POST(req: NextRequest) {
  try {
    const me = await requireMfaSession(req);
    const body = await readJson(req);
    const { recoveryCodes, sessionEpoch } = await confirmEnrollment(me, body.code);
    const token = await setSessionCookie(
      { id: me.id, name: me.name, username: me.username, role: me.role, sessionEpoch },
      await getSetting("auth.session_ttl_hours")
    );
    return NextResponse.json({ ok: true, recovery_codes: recoveryCodes, token }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err, req);
  }
}
