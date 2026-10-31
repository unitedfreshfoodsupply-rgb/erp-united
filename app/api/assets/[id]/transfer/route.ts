import { transferAsset } from "@/lib/accounting/fixed-assets";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("accounting.assets.manage", async (body, actor, params) => ({ result: await transferAsset(params.id, body, actor) }), () => 200);
