import { requestYearReopen } from "@/lib/accounting/fiscal-years";
import { postHandler } from "@/lib/route-handlers";

/** Asks for the year to be reopened; a different person with accounting.periods.reopen decides. */
export const POST = postHandler("accounting.periods.close", async (body, actor, params) => ({ approval: await requestYearReopen(params.code, body, actor) }), () => 202);
