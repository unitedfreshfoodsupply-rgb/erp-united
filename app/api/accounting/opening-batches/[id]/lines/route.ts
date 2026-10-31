import { addLines } from "@/lib/accounting/opening-batches";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("accounting.manage", async (body, actor, params) => addLines(params.id, body, actor));
