import { cancelPackage } from "@/lib/hr/compensation";
import { anyOf } from "@/lib/hr/attendance-http";

/** The proposer (or an approver) withdraws a pending package. */
export const POST = anyOf(["hr.compensation.manage", "hr.payroll.approve"], async (_req, actor, params) => ({ package: await cancelPackage(params.id, actor) }));
