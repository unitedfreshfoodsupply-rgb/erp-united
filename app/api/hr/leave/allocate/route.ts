import { allocateLeave } from "@/lib/hr/leave";
import { postHandler } from "@/lib/route-handlers";

/** Entitlements for a year (annual) or a month (monthly) from a verified policy — idempotent. */
export const POST = postHandler("hr.leave.configure", (body, actor) => allocateLeave(body, actor), () => 200);
