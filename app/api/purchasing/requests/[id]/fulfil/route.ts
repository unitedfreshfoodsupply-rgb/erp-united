import { fulfilPurchaseRequest } from "@/lib/purchasing/requests";
import { postHandler } from "@/lib/route-handlers";

/** Goods sellable now: a normal, stock-checked sales order for the request's customer. */
export const POST = postHandler("orders.create", async (body, actor, params) => fulfilPurchaseRequest(params.id, body, actor));
