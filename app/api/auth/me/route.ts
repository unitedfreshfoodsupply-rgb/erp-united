import { NextResponse, type NextRequest } from "next/server";
import { resolveAuth } from "@/lib/authz";
import { handleApiError } from "@/lib/rbac";
import { PERMISSION_DEFS } from "@/lib/permissions";
import { ROLE_LABEL, ROLE_DESC, type Role } from "@/lib/types";

/** The client's view of the session: who you are and what you may do. The permission
 * list drives navigation only — every action it leads to is checked again server-side.
 *
 * `profile` is the read-only self-profile payload (name, username, role with Arabic
 * label/description, account status, effective permissions with Arabic labels). There
 * is NO user-supplied id here — the response is always about the authenticated user,
 * so no caller can ask for someone else's profile. Nothing sensitive (no hashes,
 * tokens, or epochs) leaves the server. */
export async function GET(req: NextRequest) {
  // One read of the session, so the answer cannot change between two checks.
  const outcome = await resolveAuth();
  // A database that could not check the session is not "signed out": 503 busy, not user: null.
  if (outcome.kind === "unavailable") return handleApiError(outcome.error, req);
  // WS6: a session held at MFA enrolment is not a usable session — but the client is
  // told why, so it can open /mfa/setup instead of the sign-in form.
  if (outcome.kind !== "ok") return NextResponse.json({ user: null, profile: null, ...(outcome.kind === "mfa_enroll" ? { mfa_enrollment_required: true } : {}) });
  const ctx = outcome.ctx;
  const permissions = [...ctx.permissions]
    .map((key) => PERMISSION_DEFS.find((d) => d.key === key))
    .filter((d): d is (typeof PERMISSION_DEFS)[number] => !!d)
    .sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label, "ar") : a.group.localeCompare(b.group)));
  return NextResponse.json({
    user: {
      id: ctx.id,
      name: ctx.name,
      username: ctx.username,
      role: ctx.role,
      active: ctx.active,
      mustChangePassword: ctx.mustChangePassword,
      permissions: [...ctx.permissions].sort(),
    },
    profile: {
      roleLabel: ROLE_LABEL[ctx.role as Role],
      roleDescription: ROLE_DESC[ctx.role as Role],
      active: ctx.active,
      mustChangePassword: ctx.mustChangePassword,
      permissions: permissions.map((d) => ({ key: d.key, group: d.group, label: d.label, description: d.description })),
    },
  });
}