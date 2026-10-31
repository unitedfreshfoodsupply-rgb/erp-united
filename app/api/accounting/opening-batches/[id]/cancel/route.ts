import { cancelBatch } from "@/lib/accounting/opening-batches";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("accounting.manage", async (body, actor, params) => ({ batch: await cancelBatch(params.id, body, actor) }), () => 200);
