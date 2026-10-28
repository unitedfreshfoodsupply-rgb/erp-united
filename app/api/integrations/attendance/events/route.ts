import { NextRequest } from "next/server";
import { readJson } from "@/lib/http";
import { loggedIntegrationCall, requireScope } from "@/lib/integrations/service";
import { ingestAttendanceEvents } from "@/lib/hr/attendance-config";

/** For an attendance device or its adapter (x-api-key, scope attendance.ingest): raw punches, idempotent per event id. */
export async function POST(req: NextRequest) {
  return loggedIntegrationCall(req, async (caller) => {
    requireScope(caller, "attendance.ingest");
    const out = await ingestAttendanceEvents(caller, await readJson(req));
    return { body: out, status: 201, externalId: out.batch_id, result: `${out.accepted} accepted · ${out.duplicates} duplicates · ${out.unmatched} unmatched` };
  });
}
