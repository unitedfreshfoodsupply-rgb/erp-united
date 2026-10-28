import { createPayment, runPayments } from "@/lib/hr/payroll-posting";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

/** Payments of the run and what is unpaid per payslip. */
export const GET = anyOf(["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"], (_req, actor, params) => runPayments(params.id, actor));

/** Records salary paid out of a cash or bank account (explicit payslips, or every remainder). */
export const POST = postHandler("hr.payroll.pay", async (body, actor, params) => ({ payment: await createPayment(params.id, body, actor) }));
