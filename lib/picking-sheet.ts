import { prisma } from "@/lib/prisma";
import { storedOrderCustomerName } from "@/lib/locale/names";


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
  /** Stable group key: the product card (p:<id>) or, for an unlinked line, its text (n:<text>). */
  productKey: string;
  /** Arabic-first display name (kept for existing consumers and the printed sheet). */
  productName: string;
  /** The product card's names, for the reader's language (null for an unlinked line). */
  productNameEn: string | null;
  productNameAr: string | null;
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
    /** The customer as of now, Arabic-first: the linked card, else the name as received. */
    customerName: string;
    /** The linked card's names, for the reader's language (null for an unmapped order). */
    customerAccount: { name: string; nameAr: string | null } | null;
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

/** One unit's totals over the sheet's lines. */
export interface SheetUnitTotals {
  unit: string;
  totalRequired: number;
  totalPrepared: number;
  totalApproved: number;
  totalLoaded: number;
  totalRemaining: number;
}

export interface DailySheetDTO {
  date: string;
  lines: ConsolidatedLine[];
  summary: {
    orderCount: number;
    /** Sums over every line whatever its unit (kept for existing readers; a screen shows
     * `byUnit`, since kg and pieces do not add up). */
    totalRequired: number;
    totalPrepared: number;
    totalApproved: number;
    totalLoaded: number;
    totalRemaining: number;
    /** The same totals per unit, in the order the units first appear on the sheet (UXO-10). */
    byUnit: SheetUnitTotals[];
  };
}

/** Per-unit totals of consolidated lines: kg are added to kg, pieces to pieces. */
export function sheetTotalsByUnit(lines: readonly Pick<ConsolidatedLine, "unit" | "totalRequired" | "totalPrepared" | "totalApproved" | "totalLoaded" | "totalRemaining">[]): SheetUnitTotals[] {
  const byUnit = new Map<string, SheetUnitTotals>();
  for (const l of lines) {
    const u = byUnit.get(l.unit) ?? { unit: l.unit, totalRequired: 0, totalPrepared: 0, totalApproved: 0, totalLoaded: 0, totalRemaining: 0 };
    u.totalRequired += l.totalRequired;
    u.totalPrepared += l.totalPrepared;
    u.totalApproved += l.totalApproved;
    u.totalLoaded += l.totalLoaded;
    u.totalRemaining += l.totalRemaining;
    byUnit.set(l.unit, u);
  }
  return [...byUnit.values()];
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
      // An order waiting for stock is not picked until it is released (Nov 2026).
      stockStatus: "ok",
    },
    include: {
      items: {
        orderBy: { id: "asc" },
        include: { stockProduct: { select: { id: true, name: true, nameAr: true } } },
      },
      customerAccount: { select: { name: true, nameAr: true } },
    },
    orderBy: [{ deliveryTime: "asc" }, { customerName: "asc" }],
  });

  // Group items by (product, unit). I18N-03: the product card, not the text typed on each
  // order — "Tomatoes" and "طماطم" on two orders are one pick line. A line not yet linked to
  // a product groups by its text, as before.
  const groups = new Map<string, ConsolidatedLine>();

  for (const order of orders) {
    for (const item of order.items) {
      const productKey = item.stockProduct ? `p:${item.stockProduct.id}` : `n:${item.productName}`;
      const key = `${productKey}__${item.unit}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          productKey,
          productName: item.stockProduct ? item.stockProduct.nameAr ?? item.stockProduct.name : item.productName,
          productNameEn: item.stockProduct?.name ?? null,
          productNameAr: item.stockProduct?.nameAr ?? null,
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
        // An open order shows the customer card as it is now (a rename reaches the floor at once).
        customerName: order.customerAccount ? storedOrderCustomerName(order.customerAccount) : order.customerName,
        customerAccount: order.customerAccount,
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
    byUnit: sheetTotalsByUnit(lines),
  };

  return { date, lines, summary };
}