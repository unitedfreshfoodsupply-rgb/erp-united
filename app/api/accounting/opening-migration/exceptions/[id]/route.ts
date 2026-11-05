import { resolveException } from "@/lib/accounting/opening-migration";
import { postHandler } from "@/lib/route-handlers";

/** Decides an exception: resolved or excluded, always with the reason. */
export const POST = postHandler("accounting.manage", async (body, actor, params) => ({ exception: await resolveException(params.id, body, actor) }), () => 200);
