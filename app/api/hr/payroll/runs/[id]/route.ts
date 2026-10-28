import { getRun } from "@/lib/hr/payroll";
import { anyOf } from "@/lib/hr/attendance-http";

/** The run, its payslips and lines, and what blocks it. */
export const GET = anyOf(["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve"], (_req, actor, params) => getRun(params.id, actor));
