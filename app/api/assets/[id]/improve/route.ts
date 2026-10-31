import { improveAsset } from "@/lib/accounting/fixed-assets";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("assets.manage", async (body, actor, params) => ({ result: await improveAsset(params.id, body, actor) }), () => 200);
