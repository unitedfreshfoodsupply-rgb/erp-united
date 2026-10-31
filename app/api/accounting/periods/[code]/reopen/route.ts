import { requestPeriodReopen } from "@/lib/accounting/fiscal-years";
import { postHandler } from "@/lib/route-handlers";

/** Asks for the month to be reopened; a different person with accounting.periods.reopen decides. */
export const POST = postHandler("accounting.periods.close", async (body, actor, params) => ({ approval: await requestPeriodReopen(params.code, body, actor) }), () => 202);
