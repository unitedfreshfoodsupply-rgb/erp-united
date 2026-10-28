import { listPackages, proposePackage } from "@/lib/hr/compensation";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

/** Salaries: hr.compensation.view only. */
export const GET = anyOf(["hr.compensation.view"], async (req, actor) => {
  const p = new URL(req.url).searchParams;
  return { packages: await listPackages(actor, { employeeId: p.get("employee_id"), status: p.get("status") }) };
});

/** Proposes a package; it applies once someone else approves it. */
export const POST = postHandler("hr.compensation.manage", async (body, actor) => ({ package: await proposePackage(body, actor) }));
