import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { permissionMatrix, securityAuditLog, systemAccessOverview } from "@/lib/admin-service";
import { jsonResponse } from "@/lib/http-response";

/** Role/permission matrix, system access overview and the security audit trail,
 * in one round trip for the admin dashboard. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "users.view");
    const [matrix, overview, audit] = await Promise.all([
      permissionMatrix(),
      systemAccessOverview(),
      securityAuditLog(),
    ]);
    return jsonResponse(req, { matrix, overview, audit });
  } catch (err) {
    return handleApiError(err, req);
  }
}
