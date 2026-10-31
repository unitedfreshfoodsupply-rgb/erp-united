import { closeFiscalYear } from "@/lib/accounting/fiscal-years";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("accounting.periods.close", async (body, actor, params) => ({ year: await closeFiscalYear(params.code, actor) }), () => 200);
