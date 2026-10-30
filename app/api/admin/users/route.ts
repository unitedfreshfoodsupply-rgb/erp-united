import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { createUser, listUsers } from "@/lib/admin-service";
import { readJson } from "@/lib/http";
import { jsonResponse } from "@/lib/http-response";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "users.view");
    return jsonResponse(req, { users: await listUsers() });
  } catch (err) {
    return handleApiError(err, req);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requirePermission(req, "users.create");
    const body = await readJson(req);
    const user = await createUser(
      { name: body.name, username: body.username, password: body.password, role: body.role, mustChangePassword: body.must_change_password },
      actor
    );
    // Never echo the hash back.
    return NextResponse.json(
      { user: { id: user.id, name: user.name, username: user.username, role: user.role, active: user.active, version: user.version } },
      { status: 201 }
    );
  } catch (err) {
    return handleApiError(err, req);
  }
}
