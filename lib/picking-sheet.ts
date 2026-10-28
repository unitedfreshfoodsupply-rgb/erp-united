import { prisma } from "@/lib/prisma";


/**
 * Order item statuses that are "in play" for the daily sheet.
 */
const ELIGIBLE_STATUSES = ["new", "preparing", "ready_for_loading", "loading"];

/**
 * Consolidated daily picking sheet.
 *
 * Groups eligible orders by the operational date, product, grade, and unit.
 * Shows aggregate quantities (required, prepared, approved, loaded, remaining)
 * with per-customer allocation underneath each product.
 *
 * The sheet is an operational view — it never writes stock, never changes order
 * state, and never duplicates quantities when an order is reopened.
 */
export interface ConsolidatedLine {
  productName: string;
  unit: string;
  totalRequired: number;
  totalPrepared: number;
  totalApproved: number;
  totalLoaded: number;
  totalRemaining: number;
  /** Total quantity across allocations that have been rejected. */
  totalRejected: number;
  allocations: {
    orderId: string;
    orderNumber: string;
    customerName: string;
    deliveryTime: string | null;
    requiredQuantity: number;
    preparedQuantity: number | null;
    loadedQuantity: number | null;
    preparationStatus: string;
    loadingStatus: string;
    status: string;
    needsReview: boolean;
    /** Whether the supervisor rejected this item's preparation. */
    rejected: boolean;
  }[];
}

export interface DailySheetDTO {
  date: string;
  lines: ConsolidatedLine[];
  summary: {
    orderCount: number;
    totalRequired: number;
    totalPrepared: number;
    totalApproved: number;
    totalLoaded: number;
    totalRemaining: number;
  };
}

/**
 * Fetch the consolidated daily picking sheet for a given date.
 * Only includes orders in eligible statuses (not cancelled/dispatched).
 */
export async function dailyConsolidatedSheet(date: string): Promise<DailySheetDTO> {
  const orders = await prisma.order.findMany({
    where: {
      deliveryDate: date,
      status: { in: ELIGIBLE_STATUSES },
    },
    include: {
      items: {
        orderBy: { id: "asc" },
      },
    },
    orderBy: [{ deliveryTime: "asc" }, { customerName: "asc" }],
  });

  // Group items by (productName, unit)
  const groups = new Map<string, ConsolidatedLine>();

  for (const order of orders) {
    for (const item of order.items) {
      const key = `${item.productName}__${item.unit}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          productName: item.productName,
          unit: item.unit,
          totalRequired: 0,
          totalPrepared: 0,
          totalApproved: 0,
          totalLoaded: 0,
          totalRemaining: 0,
          totalRejected: 0,
          allocations: [],
        };
        groups.set(key, group);
      }

      // Detect rejection: preparation was done but reset to pending with [رفض:] note
      const rejected = item.preparationStatus === "pending" && item.preparedQuantity != null && /^\[رفض:/i.test(item.notes ?? "");

      // "Approved" quantity = what the preparer recorded and hasn't been rejected
      // If the item was prepared and not rejected, count it toward approved
      const prepared = item.preparedQuantity ?? 0;
      const approved = item.preparationStatus === "done" ? prepared : 0;
      const loaded = item.loadedQuantity ?? 0;
      const remaining = Math.max(0, item.requiredQuantity - loaded);
      // Rejected quantity: what was prepared but then rejected by supervisor
      const rejectedQty = rejected ? (item.preparedQuantity ?? 0) : 0;

      group.totalRequired += item.requiredQuantity;
      group.totalPrepared += prepared;
      group.totalApproved += approved;
      group.totalLoaded += loaded;
      group.totalRemaining += remaining;
      group.totalRejected += rejectedQty;

      group.allocations.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        deliveryTime: order.deliveryTime,
        requiredQuantity: item.requiredQuantity,
        preparedQuantity: item.preparedQuantity,
        loadedQuantity: item.loadedQuantity,
        preparationStatus: item.preparationStatus,
        loadingStatus: item.loadingStatus,
        status: order.status,
        needsReview: order.needsReview,
        rejected,
      });
    }
  }

  // Sort: products by name, allocations by customer
  const lines = Array.from(groups.values())
    .sort((a, b) => a.productName.localeCompare(b.productName))
    .map((g) => ({
      ...g,
      allocations: g.allocations.sort((a, b) =>
        a.customerName.localeCompare(b.customerName)
      ),
    }));

  const summary = {
    orderCount: orders.length,
    totalRequired: lines.reduce((s, l) => s + l.totalRequired, 0),
    totalPrepared: lines.reduce((s, l) => s + l.totalPrepared, 0),
    totalApproved: lines.reduce((s, l) => s + l.totalApproved, 0),
    totalLoaded: lines.reduce((s, l) => s + l.totalLoaded, 0),
    totalRemaining: lines.reduce((s, l) => s + l.totalRemaining, 0),
  };

  return { date, lines, summary };
}