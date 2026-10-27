import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { changeUserRole, getUserPermissionDetail, setUserActive, updateUser } from "@/lib/admin-service";
import { readJson } from "@/lib/http";
import { localizeServerMessage, requestLocale } from "@/lib/locale/server-messages";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requirePermission(req, "users.view");
    return NextResponse.json(await getUserPermissionDetail(params.id));
  } catch (err) {
    return handleApiError(err, req);
  }
}

/**
 * One endpoint, three distinct permissions — each field is gated on its own, so
 * holding users.edit never becomes a back door to changing roles or reactivating a
 * disabled account. Fields the caller may not touch are refused, not ignored.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await readJson(req);
    let user;

    if (body.role !== undefined) {
      const actor = await requirePermission(req, "users.change_role");
      user = await changeUserRole(params.id, body.role, actor, body.expected_version);
    }
    if (body.active !== undefined) {
      const actor = await requirePermission(req, "users.disable");
      user = await setUserActive(params.id, body.active, actor, user ? user.version : body.expected_version);
    }
    if (body.name !== undefined || body.username !== undefined || body.password !== undefined) {
      const actor = await requirePermission(req, "users.edit");
      user = await updateUser(
        params.id,
        { name: body.name, username: body.username, password: body.password, mustChangePassword: body.must_change_password },
        actor,
        user ? user.version : body.expected_version
      );
    }

    if (!user) {
      await requirePermission(req, "users.view");
      return NextResponse.json({ error: localizeServerMessage("مفيش حاجة تتعدّل في الطلب ده", requestLocale(req)) }, { status: 400 });
    }
    return NextResponse.json({
      user: { id: user.id, name: user.name, username: user.username, role: user.role, active: user.active, version: user.version },
    });
  } catch (err) {
    return handleApiError(err, req);
  }
}
