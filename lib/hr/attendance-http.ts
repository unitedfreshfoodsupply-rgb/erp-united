import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAnyPermission } from "@/lib/authz";
import { serviceActorFromContext, type ServiceActor } from "@/lib/core/actor";
import type { Permission } from "@/lib/permissions";


/** A body-less endpoint open to any of several permissions — the HTTP door; the service is the lock. */
export function anyOf(permissions: Permission[], run: (req: NextRequest, actor: ServiceActor, params: Record<string, string>) => Promise<unknown>) {
  return async (req: NextRequest, ctx: { params: Record<string, string> }) => {
    try {
      const actor = serviceActorFromContext(await requireAnyPermission(req, permissions));
      return NextResponse.json(await run(req, actor, ctx.params ?? {}));
    } catch (err) {
      return handleApiError(err, req);
    }
  };
}
