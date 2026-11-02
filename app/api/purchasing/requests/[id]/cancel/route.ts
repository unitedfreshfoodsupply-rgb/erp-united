import { cancelPurchaseRequest } from "@/lib/purchasing/requests";
import { postHandler } from "@/lib/route-handlers";

export const POST = postHandler("purchasing.requests.create", async (body, actor, params) => ({ request: await cancelPurchaseRequest(params.id, body, actor) }), () => 200);
