import { listPolicies, savePolicy } from "@/lib/hr/leave";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.leave.request", "hr.leave.approve", "hr.leave.configure"], async (_req, actor) => ({ policies: await listPolicies(actor) }));

/** A draft entitlement policy with its tiers; usable only once someone else verifies it. */
export const POST = postHandler("hr.leave.configure", async (body, actor) => ({ policy: await savePolicy(null, body, actor) }));
