import { createAdjustment, listAdjustments } from "@/lib/hr/payroll";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve"], async (req, actor) => ({ adjustments: await listAdjustments(actor, { period: new URL(req.url).searchParams.get("period") }) }));

/** A one-off input (bonus, deduction, correction) for a month. */
export const POST = postHandler("hr.payroll.prepare", async (body, actor) => ({ adjustment: await createAdjustment(body, actor) }));
