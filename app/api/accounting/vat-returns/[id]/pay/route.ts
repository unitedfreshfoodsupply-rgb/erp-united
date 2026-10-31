import { payVatReturn } from "@/lib/accounting/vat-returns";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("accounting.manage", async (body, actor, params) => ({ vatReturn: await payVatReturn(params.id, body, actor) }), () => 200);
