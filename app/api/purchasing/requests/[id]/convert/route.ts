import { convertPurchaseRequest } from "@/lib/purchasing/requests";
import { postHandler } from "@/lib/route-handlers";

/** Approved request → one line on a new purchase order to the chosen supplier. */
export const POST = postHandler("purchasing.orders.manage", async (body, actor, params) => ({ request: await convertPurchaseRequest(params.id, body, actor) }), () => 200);
