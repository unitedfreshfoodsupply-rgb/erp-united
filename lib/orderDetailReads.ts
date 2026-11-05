/**
 * Reads behind the order detail screen's side panels (Nov 2026), each answering only what
 * the screen can show for the order's current state.
 */
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { actorCan } from "@/lib/authz-core";
import { liveTripStop } from "@/lib/orders-service";
import { invoiceCreditFacts } from "@/lib/sales/invoicing";
import { orderStockView, type HoldActor } from "@/lib/sales/stock-hold";
import { orderSuggestions } from "@/lib/purchasing/requests";
import { orderActionState, type OrderInvoiceFact } from "@/lib/orderActions";

/**
 * Cancel and reopen for the order screen: the order, its live trip stop and — for a
 * dispatched order, the only one an invoice can block — its invoice that is not void.
 */
export async function orderActionView(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, version: true } });
  if (!order) throw new ApiError(404, "الأوردر مش موجود");
  const [stop, live] = await Promise.all([
    liveTripStop(orderId),
    order.status === "dispatched" ? prisma.salesInvoice.findMany({ where: { orderId, status: { not: "void" } }, select: { id: true, number: true, status: true, total: true } }) : [],
  ]);
  // releaseOrderInvoiceForReopen refuses at the first issued invoice: only that one is described.
  const issued = live.find((i) => i.status === "issued");
  const invoices: OrderInvoiceFact[] = live.map((i) => ({ id: i.id, number: i.number, status: i.status, fullyCredited: false, creditNotes: [] }));
  if (issued) Object.assign(invoices.find((i) => i.id === issued.id)!, await invoiceCreditFacts(prisma, issued));
  const state = orderActionState({
    status: order.status,
    liveStop: stop ? { tripNumber: stop.trip.number, tripStatus: stop.trip.status } : null,
    invoices,
  });
  return { orderId: order.id, version: order.version, ...state };
}

/**
 * The stock panel (StockHoldPanel). Coverage per line is shown only for an order waiting for
 * stock, so only that order is assessed; any other order gets its purchase suggestions (for
 * whoever may see them) and nothing else — the same answer the panel rendered before, without
 * reading the stock of every line.
 */
export async function orderStockPanel(orderId: string, actor: HoldActor & { permissions: readonly string[] }) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, stockStatus: true, version: true } });
  if (!order) throw new ApiError(404, "الأوردر مش موجود");
  if (order.stockStatus === "awaiting_stock" && order.status === "new") return orderStockView(orderId, actor);
  return {
    stockStatus: order.stockStatus,
    status: order.status,
    version: order.version,
    lines: [],
    shortfalls: [],
    releasable: false,
    suggestions: actorCan(actor, "purchasing.requests.view") ? await orderSuggestions(orderId) : null,
  };
}
