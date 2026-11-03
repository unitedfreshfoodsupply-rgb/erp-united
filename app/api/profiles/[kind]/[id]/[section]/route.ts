import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAuth } from "@/lib/authz";
import { jsonFor } from "@/lib/security/redact";
import { profileSection, windowOf } from "@/lib/profiles/service";

/** One tab of a customer, supplier or product profile; who may read it is lib/profiles/access.ts. */
export async function GET(req: NextRequest, { params }: { params: { kind: string; id: string; section: string } }) {
  try {
    const ctx = await requireAuth(req);
    return jsonFor(ctx, await profileSection(params.kind, params.id, params.section, ctx.can, windowOf(new URL(req.url).searchParams)));
  } catch (err) {
    return handleApiError(err, req);
  }
}
