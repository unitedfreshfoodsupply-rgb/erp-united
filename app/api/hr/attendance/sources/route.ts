import { createSource, listSources } from "@/lib/hr/attendance-config";
import { anyOf } from "@/lib/hr/attendance-http";
import { postHandler } from "@/lib/route-handlers";

export const GET = anyOf(["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"], (_req, actor) => listSources(actor));

/** A device or file-import source, bound to an integration key that holds attendance.ingest. */
export const POST = postHandler("hr.employees.manage", async (body, actor) => ({ source: await createSource(body, actor) }));
