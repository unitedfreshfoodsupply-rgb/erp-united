import { journalPreview } from "@/lib/hr/payroll-posting";
import { anyOf } from "@/lib/hr/attendance-http";

/** The entry posting would write (or the one it wrote), and every missing account. */
export const GET = anyOf(["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"], (_req, actor, params) => journalPreview(params.id, actor));
