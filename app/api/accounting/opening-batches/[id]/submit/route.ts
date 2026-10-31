import { submitBatch } from "@/lib/accounting/opening-batches";
import { postHandler } from "@/lib/route-handlers";

/** Freezes the batch and asks someone with accounting.opening.approve to post it. */
export const POST = postHandler("accounting.manage", async (_body, actor, params) => ({ batch: await submitBatch(params.id, actor) }), () => 202);
