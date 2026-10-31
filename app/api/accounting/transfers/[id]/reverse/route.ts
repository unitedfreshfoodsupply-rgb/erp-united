import { reverseTransfer } from "@/lib/accounting/treasury";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("accounting.manage", async (body, actor, params) => ({ transfer: await reverseTransfer(params.id, body, actor) }), () => 200);
