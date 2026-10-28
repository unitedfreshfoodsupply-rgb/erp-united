import { removeIdentity } from "@/lib/hr/attendance-config";
import { anyOf } from "@/lib/hr/attendance-http";

export const DELETE = anyOf(["hr.employees.manage"], (_req, actor, params) => removeIdentity(params.id, actor));
