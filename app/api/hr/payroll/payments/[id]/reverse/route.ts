import { reversePayment } from "@/lib/hr/payroll-posting";
import { postHandler } from "@/lib/route-handlers";

/** Reverses a mistaken payroll payment, with a reason. */
export const POST = postHandler("hr.payroll.pay", async (body, actor, params) => ({ payment: await reversePayment(params.id, body, actor) }), () => 200);
