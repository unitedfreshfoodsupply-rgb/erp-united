import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import type { Permission } from "@/lib/permissions";
import { isValidISODate } from "@/lib/dates";
import { todayLocalISO } from "@/lib/localDate";
import { customerReceivable, openAmounts } from "@/lib/sales/invoicing";
import { debitedByBill, supplierPayable } from "@/lib/purchasing/bills";
import { orderValue } from "@/lib/sales/pricing";
import { MONEY, maySeeSection, type ProfileKind } from "./access";
import { href, linkFor, refundsLink } from "./links";

/**
 * The 360° profiles of a customer, a supplier and a product (Nov 2026): every document
 * that touched them, newest first, each with a link to the document itself. Each section
 * reads the records the matching module already keeps (no copies, no new totals); money
 * appears only for the permissions in MONEY, and a link only when the viewer can open it.
 */

type Can = (p: Permission) => boolean;
type Window = { limit: number; from?: string; to?: string; open?: boolean };
type Ref = { kind: "customer" | "supplier" | "product"; id: string; name: string; nameAr: string | null; href: string | null };

export type ProfileRow = {
  key: string;
  kind: string;
  id: string;
  number: string;
  date: string;
  status: string | null;
  detail: string | null;
  party?: Ref | null;
  product?: Ref | null;
  qty?: string | null;
  uom?: string | null;
  delivered?: string | null;
  price?: string | null;
  amount?: string | null;
  open?: string | null;
  href: string | null;
  /** A second document the row belongs to (the invoice of a credit note, the order of an issue). */
  via?: { kind: string; number: string; href: string | null } | null;
};
export type ProfileGroup = { key: string; entity: Ref | { kind: "name"; id: null; name: string; nameAr: null; href: null }; uom: string | null; qty: string; delivered?: string | null; count: number; lastDate: string; lastPrice: string | null; avgPrice: string | null };
export type SectionResult = { rows: ProfileRow[]; total: number; groups?: ProfileGroup[]; data?: unknown };

type Sourced = ProfileRow & { at: number };
type Source = { rows: Sourced[]; total: number };

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const m2 = (v: Prisma.Decimal.Value | null | undefined) => D(v).toFixed(2);
const day = (d: Date) => d.toISOString().slice(0, 10);
const range = (field: string, w: Window) => (w.from || w.to ? { [field]: { ...(w.from ? { gte: w.from } : {}), ...(w.to ? { lte: w.to } : {}) } } : {});
const sqlRange = (col: Prisma.Sql, w: Window) => Prisma.sql`${w.from ? Prisma.sql`AND ${col} >= ${w.from}` : Prisma.empty} ${w.to ? Prisma.sql`AND ${col} <= ${w.to}` : Prisma.empty}`;

/** Several sources as one list: newest first, the first `limit`, and how many there are in all. */
function merge(sources: Source[], limit: number): SectionResult {
  const rows = sources.flatMap((s) => s.rows).sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at).slice(0, limit);
  return { rows: rows.map(({ at: _at, ...r }) => r), total: sources.reduce((s, x) => s + x.total, 0) };
}

const partyRef = (can: Can, kind: "customer" | "supplier", p: { id: string; name: string; nameAr: string | null } | null): Ref | null =>
  p ? { kind, id: p.id, name: p.name, nameAr: p.nameAr, href: linkFor(can, href[kind](p.id)) } : null;
const productRef = (can: Can, p: { id: string; name: string; nameAr: string | null } | null): Ref | null =>
  p ? { kind: "product", id: p.id, name: p.name, nameAr: p.nameAr, href: linkFor(can, href.product(p.id)) } : null;

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

async function customerOrders(id: string, can: Can, w: Window): Promise<Source> {
  const where: Prisma.OrderWhereInput = { customerAccountId: id, ...range("deliveryDate", w), ...(w.open ? { status: { notIn: ["dispatched", "cancelled"] } } : {}) };
  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({ where, orderBy: [{ deliveryDate: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, orderNumber: true, deliveryDate: true, deliveryTime: true, status: true, createdAt: true, items: { select: { preparationStatus: true, loadingStatus: true } }, tripStops: { where: { active: true }, select: { status: true, trip: { select: { number: true } } }, take: 1 } } }),
  ]);
  const priced = can(MONEY.salesPrice);
  const rows: Sourced[] = [];
  for (const o of orders) {
    const prepared = o.items.filter((i) => i.preparationStatus === "done").length, loaded = o.items.filter((i) => i.loadingStatus === "done").length;
    rows.push({
      key: `order:${o.id}`, kind: "order", id: o.id, number: o.orderNumber, date: o.deliveryDate, status: o.status, at: o.createdAt.getTime(),
      // lines | prepared | loaded | trip | delivery (the screen spells these out)
      detail: [o.items.length, prepared, loaded, o.tripStops[0]?.trip.number ?? "", o.tripStops[0]?.status ?? ""].join("|"),
      amount: priced ? m2((await orderValue(prisma, o.id)).total) : null,
      href: linkFor(can, href.order(o.id)),
    });
  }
  return { rows, total };
}

async function customerInvoices(id: string, can: Can, w: Window): Promise<Source> {
  const invWhere: Prisma.SalesInvoiceWhereInput = { customerId: id, ...(w.from || w.to ? range("issueDate", w) : {}) };
  const cnWhere: Prisma.CreditNoteWhereInput = { customerId: id, ...range("issueDate", w) };
  const chWhere: Prisma.CustomerChargeWhereInput = { customerId: id, ...range("date", w) };
  const obWhere: Prisma.PartyOpeningBalanceWhereInput = { partyType: "customer", partyId: id, ...range("date", w) };
  const [ni, nc, nch, nob, invs, cns, chs, obs] = await Promise.all([
    prisma.salesInvoice.count({ where: invWhere }), prisma.creditNote.count({ where: cnWhere }), prisma.customerCharge.count({ where: chWhere }), prisma.partyOpeningBalance.count({ where: obWhere }),
    prisma.salesInvoice.findMany({ where: invWhere, orderBy: [{ createdAt: "desc" }], take: w.limit, select: { id: true, number: true, status: true, issueDate: true, dueDate: true, total: true, createdAt: true, order: { select: { id: true, orderNumber: true } } } }),
    prisma.creditNote.findMany({ where: cnWhere, orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, number: true, issueDate: true, reason: true, total: true, createdAt: true, returnDocumentId: true, invoice: { select: { id: true, number: true } } } }),
    prisma.customerCharge.findMany({ where: chWhere, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, reference: true, description: true, date: true, dueDate: true, total: true, createdAt: true } }),
    prisma.partyOpeningBalance.findMany({ where: obWhere, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, reference: true, date: true, dueDate: true, amount: true, createdAt: true, receiptAllocations: { where: { receipt: { reversal: { is: null } } }, select: { amount: true } } } }),
  ]);
  const settled = await openAmounts(prisma, invs.filter((i) => i.status === "issued").map((i) => i.id));
  return {
    total: ni + nc + nch + nob,
    rows: [
      ...invs.map((i): Sourced => ({
        key: `invoice:${i.id}`, kind: "invoice", id: i.id, number: i.number ?? "", date: i.issueDate ?? day(i.createdAt), status: i.status, at: i.createdAt.getTime(), detail: i.dueDate,
        amount: m2(i.total), open: i.status === "issued" ? i.total.minus(settled.get(i.id) ?? 0).toFixed(2) : null, href: linkFor(can, href.invoice(i.id)),
        via: i.order ? { kind: "order", number: i.order.orderNumber, href: linkFor(can, href.order(i.order.id)) } : null,
      })),
      ...cns.map((n): Sourced => ({
        key: `credit_note:${n.id}`, kind: "credit_note", id: n.id, number: n.number, date: n.issueDate, status: n.returnDocumentId ? "with_goods" : null, at: n.createdAt.getTime(), detail: n.reason,
        amount: D(n.total).negated().toFixed(2), href: linkFor(can, href.invoice(n.invoice.id)), via: { kind: "invoice", number: n.invoice.number ?? "", href: linkFor(can, href.invoice(n.invoice.id)) },
      })),
      ...chs.map((c): Sourced => ({ key: `charge:${c.id}`, kind: "charge", id: c.id, number: c.reference, date: c.date, status: null, at: c.createdAt.getTime(), detail: c.description, amount: m2(c.total), href: null })),
      ...obs.map((o): Sourced => ({
        key: `opening:${o.id}`, kind: "opening_balance", id: o.id, number: o.reference ?? "", date: o.date, status: null, at: o.createdAt.getTime(), detail: o.dueDate,
        amount: m2(o.amount), open: o.amount.gt(0) ? o.amount.minus(o.receiptAllocations.reduce((s, a) => s.plus(a.amount), D(0))).toFixed(2) : null, href: linkFor(can, href.opening()),
      })),
    ],
  };
}

async function customerPayments(id: string, can: Can, w: Window): Promise<Source> {
  const where = { customerId: id, ...range("date", w) };
  const [nr, nf, receipts, refunds] = await Promise.all([
    prisma.customerReceipt.count({ where }), prisma.customerRefund.count({ where }),
    prisma.customerReceipt.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, number: true, date: true, amount: true, method: true, reference: true, createdAt: true, allocations: { select: { amount: true } }, deductions: { select: { amount: true } }, reversal: { select: { date: true } } } }),
    prisma.customerRefund.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, number: true, date: true, amount: true, method: true, reason: true, createdAt: true } }),
  ]);
  const refundLink = refundsLink(can, "customer");
  return {
    total: nr + nf,
    rows: [
      ...receipts.map((r): Sourced => {
        const applied = r.reversal ? D(0) : r.allocations.reduce((s, a) => s.plus(a.amount), D(0));
        const withheld = r.deductions.reduce((s, d) => s.plus(d.amount), D(0));
        return {
          key: `receipt:${r.id}`, kind: "receipt", id: r.id, number: r.number, date: r.date, status: r.reversal ? "reversed" : null, at: r.createdAt.getTime(),
          detail: [r.method, r.reference, withheld.gt(0) ? `−${withheld.toFixed(2)}` : null, r.reversal ? r.reversal.date : null].map((x) => x ?? "").join("|"),
          amount: m2(r.amount), open: r.reversal ? "0.00" : r.amount.minus(applied).toFixed(2), href: linkFor(can, href.receipt(r.number)),
        };
      }),
      ...refunds.map((f): Sourced => ({ key: `refund:${f.id}`, kind: "refund", id: f.id, number: f.number, date: f.date, status: null, at: f.createdAt.getTime(), detail: f.reason, amount: D(f.amount).negated().toFixed(2), href: refundLink })),
    ],
  };
}

async function customerReturns(id: string, can: Can, w: Window): Promise<Source> {
  // A customer return belongs to the customer through its order, or through the credit note that settled it.
  const [orders, notes] = await Promise.all([
    prisma.order.findMany({ where: { customerAccountId: id }, select: { id: true } }),
    prisma.creditNote.findMany({ where: { customerId: id, returnDocumentId: { not: null } }, select: { returnDocumentId: true } }),
  ]);
  const where: Prisma.InventoryDocumentWhereInput = {
    type: "customer_return", reversalOfId: null, ...range("businessDate", w),
    OR: [{ sourceType: "order", sourceId: { in: orders.map((o) => o.id) } }, { id: { in: notes.map((n) => n.returnDocumentId!) } }],
  };
  return returnDocuments(where, can, "customer", w);
}

async function returnDocuments(where: Prisma.InventoryDocumentWhereInput, can: Can, side: "customer" | "supplier", w: Window): Promise<Source> {
  const [total, docs] = await Promise.all([
    prisma.inventoryDocument.count({ where }),
    prisma.inventoryDocument.findMany({ where, orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, number: true, businessDate: true, status: true, reason: true, sourceType: true, sourceId: true, createdAt: true, reversedBy: { select: { number: true } }, movements: { select: { quantity: true, product: { select: { unit: true } } } } } }),
  ]);
  const ids = docs.map((d) => d.id);
  const money = side === "customer" ? can(MONEY.receivable) : can(MONEY.payable);
  const [cns, dns, orders] = await Promise.all([
    side === "customer" ? prisma.creditNote.findMany({ where: { returnDocumentId: { in: ids } }, select: { returnDocumentId: true, number: true, total: true, invoice: { select: { id: true } } } }) : [],
    side === "supplier" ? prisma.debitNote.findMany({ where: { returnDocumentId: { in: ids } }, select: { returnDocumentId: true, number: true, total: true, billId: true } }) : [],
    prisma.order.findMany({ where: { id: { in: docs.filter((d) => d.sourceType === "order" && d.sourceId).map((d) => d.sourceId!) } }, select: { id: true, orderNumber: true } }),
  ]);
  const note = new Map<string, { number: string; total: Prisma.Decimal; href: string | null }>([
    ...cns.map((c) => [c.returnDocumentId!, { number: c.number, total: c.total, href: linkFor(can, href.invoice(c.invoice.id)) }] as const),
    ...dns.map((d) => [d.returnDocumentId!, { number: d.number, total: d.total, href: linkFor(can, href.bill(d.billId)) }] as const),
  ]);
  const orderNo = new Map(orders.map((o) => [o.id, o.orderNumber]));
  return {
    total,
    rows: docs.map((d): Sourced => {
      const n = note.get(d.id);
      const units = [...new Set(d.movements.map((m) => m.product.unit))];
      const qty = d.movements.reduce((s, m) => s.plus(m.quantity), D(0)).abs();
      return {
        key: `return:${d.id}`, kind: `${side}_return`, id: d.id, number: d.number, date: d.businessDate, status: d.reversedBy ? "reversed" : d.status, at: d.createdAt.getTime(), detail: d.reason,
        qty: units.length === 1 ? qty.toString() : null, uom: units.length === 1 ? units[0] : null,
        amount: n && money ? D(n.total).negated().toFixed(2) : null, href: linkFor(can, href.stockDocument(d.id)),
        via: n ? { kind: side === "customer" ? "credit_note" : "debit_note", number: n.number, href: n.href } : d.sourceType === "order" && d.sourceId && orderNo.has(d.sourceId) ? { kind: "order", number: orderNo.get(d.sourceId)!, href: linkFor(can, href.order(d.sourceId)) } : null,
      };
    }),
  };
}

/** What a customer ordered, line by line, and per product. */
async function customerProducts(id: string, can: Can, w: Window): Promise<SectionResult> {
  const where: Prisma.OrderItemWhereInput = { order: { customerAccountId: id, status: { not: "cancelled" }, ...range("deliveryDate", w) } };
  const priced = can(MONEY.salesPrice);
  const [total, items, groups] = await Promise.all([
    prisma.orderItem.count({ where }),
    prisma.orderItem.findMany({ where, orderBy: [{ order: { deliveryDate: "desc" } }, { createdAt: "desc" }], take: w.limit, select: { id: true, productName: true, unit: true, requiredQuantity: true, loadedQuantity: true, createdAt: true, price: { select: { unitPrice: true } }, stockProduct: { select: { id: true, name: true, nameAr: true } }, order: { select: { id: true, orderNumber: true, deliveryDate: true, status: true } } } }),
    prisma.$queryRaw<{ pid: string | null; name: string; unit: string; qty: number; loaded: number; n: bigint; last: string; lastPrice: Prisma.Decimal | null; avg: Prisma.Decimal | null; nameAr: string | null; pname: string | null }[]>`
      SELECT i."stockProductId" AS pid, max(i."productName") AS name, i."unit", sum(i."requiredQuantity") AS qty, sum(coalesce(i."loadedQuantity", 0)) AS loaded,
        count(DISTINCT o."id") AS n, max(o."deliveryDate") AS last,
        (array_agg(p."unitPrice" ORDER BY o."deliveryDate" DESC, o."createdAt" DESC) FILTER (WHERE p."unitPrice" IS NOT NULL))[1] AS "lastPrice",
        sum(p."unitPrice" * i."requiredQuantity"::numeric) / nullif(sum(CASE WHEN p."unitPrice" IS NOT NULL THEN i."requiredQuantity"::numeric END), 0) AS avg,
        max(sp."nameAr") AS "nameAr", max(sp."name") AS pname
      FROM "OrderItem" i JOIN "Order" o ON o."id" = i."orderId" LEFT JOIN "OrderItemPrice" p ON p."orderItemId" = i."id" LEFT JOIN "StockProduct" sp ON sp."id" = i."stockProductId"
      WHERE o."customerAccountId" = ${id} AND o."status" <> 'cancelled' ${sqlRange(Prisma.sql`o."deliveryDate"`, w)}
      GROUP BY i."stockProductId", CASE WHEN i."stockProductId" IS NULL THEN i."productName" END, i."unit"
      ORDER BY last DESC, name`,
  ]);
  return {
    total,
    rows: items.map((i) => ({
      key: `item:${i.id}`, kind: "order_line", id: i.order.id, number: i.order.orderNumber, date: i.order.deliveryDate, status: i.order.status, detail: i.stockProduct ? null : i.productName,
      product: productRef(can, i.stockProduct), qty: String(i.requiredQuantity), delivered: i.loadedQuantity == null ? null : String(i.loadedQuantity), uom: i.unit,
      price: priced && i.price ? i.price.unitPrice.toFixed(2) : null, href: linkFor(can, href.order(i.order.id)),
    })),
    groups: groups.map((g) => ({
      key: `${g.pid ?? g.name}:${g.unit}`, entity: g.pid ? productRef(can, { id: g.pid, name: g.pname ?? g.name, nameAr: g.nameAr })! : { kind: "name", id: null, name: g.name, nameAr: null, href: null },
      uom: g.unit, qty: String(Number(g.qty)), delivered: String(Number(g.loaded)), count: Number(g.n), lastDate: g.last,
      lastPrice: priced && g.lastPrice != null ? D(g.lastPrice).toFixed(2) : null, avgPrice: priced && g.avg != null ? D(g.avg).toFixed(2) : null,
    })),
  };
}

async function customerSummary(id: string, can: Can) {
  const c = await prisma.customer.findUnique({ where: { id }, select: { id: true, paymentTermsDays: true, creditLimit: true, creditHold: true } });
  if (!c) throw new ApiError(404, "العميل مش موجود");
  const year = `${todayLocalISO().slice(0, 4)}-01-01`;
  const out: Record<string, unknown> = {};
  if (can("orders.view")) {
    const [orders, open, last] = await Promise.all([
      prisma.order.count({ where: { customerAccountId: id } }),
      prisma.order.count({ where: { customerAccountId: id, status: { notIn: ["dispatched", "cancelled"] } } }),
      prisma.order.findFirst({ where: { customerAccountId: id, status: { not: "cancelled" } }, orderBy: [{ deliveryDate: "desc" }], select: { deliveryDate: true } }),
    ]);
    Object.assign(out, { orders, openOrders: open, lastOrderDate: last?.deliveryDate ?? null });
  }
  if (can(MONEY.receivable)) {
    const [inv, invYear, cn, cnYear, rc, lastRc] = await Promise.all([
      prisma.salesInvoice.aggregate({ where: { customerId: id, status: "issued" }, _sum: { net: true } }),
      prisma.salesInvoice.aggregate({ where: { customerId: id, status: "issued", issueDate: { gte: year } }, _sum: { net: true } }),
      prisma.creditNote.aggregate({ where: { customerId: id }, _sum: { net: true } }),
      prisma.creditNote.aggregate({ where: { customerId: id, issueDate: { gte: year } }, _sum: { net: true } }),
      prisma.customerReceipt.aggregate({ where: { customerId: id, reversal: { is: null } }, _sum: { amount: true } }),
      prisma.customerReceipt.findFirst({ where: { customerId: id, reversal: { is: null } }, orderBy: [{ date: "desc" }], select: { date: true } }),
    ]);
    Object.assign(out, {
      receivable: m2(await customerReceivable(prisma, id)),
      // Net sales: issued invoices less credit notes, before VAT.
      netSales: D(inv._sum.net).minus(D(cn._sum.net)).toFixed(2), netSalesThisYear: D(invYear._sum.net).minus(D(cnYear._sum.net)).toFixed(2),
      received: m2(rc._sum.amount), lastReceiptDate: lastRc?.date ?? null,
    });
  }
  if (can(MONEY.receivable) || can("sales.credit.manage")) Object.assign(out, { paymentTermsDays: c.paymentTermsDays, creditLimit: c.creditLimit?.toFixed(2) ?? null, creditHold: c.creditHold });
  return out;
}

// ---------------------------------------------------------------------------
// Supplier
// ---------------------------------------------------------------------------

async function supplierOrders(id: string, can: Can, w: Window): Promise<Source> {
  const where: Prisma.PurchaseOrderWhereInput = { supplierId: id, ...range("orderDate", w), ...(w.open ? { status: { in: ["approved", "sent", "partially_received"] } } : {}) };
  const priced = can(MONEY.purchasePrice);
  const [total, pos] = await Promise.all([
    prisma.purchaseOrder.count({ where }),
    prisma.purchaseOrder.findMany({ where, orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, number: true, orderDate: true, expectedDate: true, status: true, total: true, createdAt: true, _count: { select: { lines: true } } } }),
  ]);
  return { total, rows: pos.map((p) => ({ key: `po:${p.id}`, kind: "purchase_order", id: p.id, number: p.number, date: p.orderDate, status: p.status, at: p.createdAt.getTime(), detail: `${p._count.lines}|${p.expectedDate ?? ""}`, amount: priced ? m2(p.total) : null, href: linkFor(can, href.po(p.id)) })) };
}

/** Goods received: by supplier (the supplier's receipts) or by product (who it came from). */
async function intakes(where: Prisma.StockIntakeWhereInput, can: Can, w: Window, show: "product" | "supplier"): Promise<Source> {
  const full = { ...where, ...range("receivedDate", w) };
  const [total, rows] = await Promise.all([
    prisma.stockIntake.count({ where: full }),
    prisma.stockIntake.findMany({ where: full, orderBy: [{ receivedDate: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, receiptNumber: true, receivedDate: true, status: true, receivedQty: true, goodQty: true, gradeBQty: true, wasteQty: true, rejectedQty: true, unitCost: true, createdAt: true, product: { select: { id: true, name: true, nameAr: true, unit: true } }, supplier: { select: { id: true, name: true, nameAr: true } }, billLines: { where: { bill: { status: "posted" } }, select: { unitPrice: true, bill: { select: { id: true, number: true } } }, take: 1 }, purchaseOrderLine: { select: { po: { select: { id: true, number: true } } } } } }),
  ]);
  const cost = can(MONEY.cost), billPrice = can(MONEY.payable) || can(MONEY.purchasePrice);
  return {
    total,
    rows: rows.map((i): Sourced => {
      const bill = i.billLines[0]?.bill;
      return {
        key: `intake:${i.id}`, kind: "intake", id: i.id, number: i.receiptNumber, date: i.receivedDate, status: i.status === "voided" ? "voided" : bill ? "billed" : "unbilled", at: i.createdAt.getTime(),
        detail: [i.goodQty, i.gradeBQty, i.wasteQty, i.rejectedQty].map((q) => D(q).toString()).join("|"),
        ...(show === "product" ? { product: productRef(can, i.product) } : { party: partyRef(can, "supplier", i.supplier) }),
        qty: D(i.receivedQty).toString(), uom: i.product.unit,
        // unitCost is a cost field: jsonFor strips it too, but it is only filled for those who may see it.
        ...({ unitCost: cost && i.unitCost != null ? D(i.unitCost).toFixed(4) : null } as object),
        price: billPrice && i.billLines[0] ? D(i.billLines[0].unitPrice).toFixed(4) : null,
        href: linkFor(can, href.intake(i.receiptNumber)),
        via: bill && can(MONEY.payable) ? { kind: "bill", number: bill.number, href: linkFor(can, href.bill(bill.id)) } : i.purchaseOrderLine ? { kind: "purchase_order", number: i.purchaseOrderLine.po.number, href: linkFor(can, href.po(i.purchaseOrderLine.po.id)) } : null,
      };
    }),
  };
}

async function supplierBills(id: string, can: Can, w: Window): Promise<Source> {
  const billWhere: Prisma.SupplierBillWhereInput = { supplierId: id, ...range("billDate", w) };
  const dnWhere: Prisma.DebitNoteWhereInput = { supplierId: id, ...range("issueDate", w) };
  const obWhere: Prisma.PartyOpeningBalanceWhereInput = { partyType: "supplier", partyId: id, ...range("date", w) };
  const [nb, nd, nob, bills, dns, obs] = await Promise.all([
    prisma.supplierBill.count({ where: billWhere }), prisma.debitNote.count({ where: dnWhere }), prisma.partyOpeningBalance.count({ where: obWhere }),
    prisma.supplierBill.findMany({ where: billWhere, orderBy: [{ billDate: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, number: true, supplierInvoiceNo: true, billDate: true, dueDate: true, status: true, total: true, createdAt: true } }),
    prisma.debitNote.findMany({ where: dnWhere, orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, number: true, issueDate: true, reason: true, total: true, createdAt: true, returnDocumentId: true, bill: { select: { id: true, number: true } } } }),
    prisma.partyOpeningBalance.findMany({ where: obWhere, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, reference: true, date: true, dueDate: true, amount: true, createdAt: true, paymentAllocations: { where: { payment: { reversal: { is: null } } }, select: { amount: true } } } }),
  ]);
  const settled = await debitedByBill(prisma, bills.filter((b) => b.status === "posted").map((b) => b.id));
  return {
    total: nb + nd + nob,
    rows: [
      ...bills.map((b): Sourced => ({ key: `bill:${b.id}`, kind: "bill", id: b.id, number: b.number, date: b.billDate, status: b.status, at: b.createdAt.getTime(), detail: `${b.supplierInvoiceNo}|${b.dueDate}`, amount: m2(b.total), open: b.status === "posted" ? b.total.minus(settled.get(b.id) ?? 0).toFixed(2) : null, href: linkFor(can, href.bill(b.id)) })),
      ...dns.map((n): Sourced => ({ key: `debit_note:${n.id}`, kind: "debit_note", id: n.id, number: n.number, date: n.issueDate, status: n.returnDocumentId ? "with_goods" : null, at: n.createdAt.getTime(), detail: n.reason, amount: D(n.total).negated().toFixed(2), href: linkFor(can, href.bill(n.bill.id)), via: { kind: "bill", number: n.bill.number, href: linkFor(can, href.bill(n.bill.id)) } })),
      ...obs.map((o): Sourced => ({ key: `opening:${o.id}`, kind: "opening_balance", id: o.id, number: o.reference ?? "", date: o.date, status: null, at: o.createdAt.getTime(), detail: o.dueDate, amount: m2(o.amount), open: o.amount.gt(0) ? o.amount.minus(o.paymentAllocations.reduce((s, a) => s.plus(a.amount), D(0))).toFixed(2) : null, href: linkFor(can, href.opening()) })),
    ],
  };
}

async function supplierPayments(id: string, can: Can, w: Window): Promise<Source> {
  const where = { supplierId: id, ...range("date", w) };
  const [np, nf, pays, refunds] = await Promise.all([
    prisma.supplierPayment.count({ where }), prisma.supplierRefund.count({ where }),
    prisma.supplierPayment.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, number: true, date: true, amount: true, method: true, reference: true, createdAt: true, allocations: { select: { amount: true } }, deductions: { select: { amount: true } }, reversal: { select: { date: true } } } }),
    prisma.supplierRefund.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, number: true, date: true, amount: true, reason: true, createdAt: true } }),
  ]);
  const refundLink = refundsLink(can, "supplier");
  return {
    total: np + nf,
    rows: [
      ...pays.map((p): Sourced => {
        const applied = p.reversal ? D(0) : p.allocations.reduce((s, a) => s.plus(a.amount), D(0));
        const withheld = p.deductions.reduce((s, d) => s.plus(d.amount), D(0));
        return {
          key: `payment:${p.id}`, kind: "payment", id: p.id, number: p.number, date: p.date, status: p.reversal ? "reversed" : null, at: p.createdAt.getTime(),
          detail: [p.method, p.reference, withheld.gt(0) ? `−${withheld.toFixed(2)}` : null, p.reversal ? p.reversal.date : null].map((x) => x ?? "").join("|"),
          amount: m2(p.amount), open: p.reversal ? "0.00" : p.amount.minus(applied).toFixed(2), href: linkFor(can, href.payment(p.number)),
        };
      }),
      ...refunds.map((f): Sourced => ({ key: `refund:${f.id}`, kind: "refund", id: f.id, number: f.number, date: f.date, status: null, at: f.createdAt.getTime(), detail: f.reason, amount: D(f.amount).negated().toFixed(2), href: refundLink })),
    ],
  };
}

/** What a supplier delivered, per product: received and accepted, receipts, last date, prices. */
async function supplierProducts(id: string, can: Can, w: Window): Promise<SectionResult> {
  const rows = await prisma.$queryRaw<{ pid: string; name: string; nameAr: string | null; unit: string; qty: Prisma.Decimal; good: Prisma.Decimal; n: bigint; last: string; avgCost: Prisma.Decimal | null; lastBill: Prisma.Decimal | null }[]>`
    SELECT p."id" AS pid, p."name", p."nameAr", p."unit", sum(i."receivedQty") AS qty, sum(i."goodQty") AS good, count(*) AS n, max(i."receivedDate") AS last,
      sum(i."unitCost" * i."goodQty") / nullif(sum(CASE WHEN i."unitCost" IS NOT NULL THEN i."goodQty" END), 0) AS "avgCost",
      (SELECT bl."unitPrice" FROM "SupplierBillLine" bl JOIN "SupplierBill" b ON b."id" = bl."billId" WHERE b."supplierId" = ${id} AND b."status" = 'posted' AND bl."productId" = p."id" ORDER BY b."billDate" DESC, b."createdAt" DESC LIMIT 1) AS "lastBill"
    FROM "StockIntake" i JOIN "StockProduct" p ON p."id" = i."productId"
    WHERE i."supplierId" = ${id} AND i."status" = 'posted' ${sqlRange(Prisma.sql`i."receivedDate"`, w)}
    GROUP BY p."id" ORDER BY last DESC, p."name"`;
  const agreed = can(MONEY.purchasePrice)
    ? await prisma.supplierPrice.findMany({ where: { supplierId: id, validFrom: { lte: todayLocalISO() }, OR: [{ validTo: null }, { validTo: { gte: todayLocalISO() } }] }, orderBy: { validFrom: "desc" }, select: { productId: true, unitPrice: true, uomCode: true } })
    : [];
  const agreedBy = new Map<string, string>();
  for (const a of agreed) if (!agreedBy.has(a.productId)) agreedBy.set(a.productId, `${a.unitPrice.toFixed(2)}/${a.uomCode}`);
  const cost = can(MONEY.cost), billPrice = can(MONEY.payable) || can(MONEY.purchasePrice);
  return {
    rows: [], total: rows.length,
    groups: rows.map((g) => ({
      key: g.pid, entity: productRef(can, { id: g.pid, name: g.name, nameAr: g.nameAr })!, uom: g.unit, qty: D(g.qty).toString(), delivered: D(g.good).toString(), count: Number(g.n), lastDate: g.last,
      lastPrice: billPrice && g.lastBill != null ? D(g.lastBill).toFixed(4) : null,
      avgPrice: cost && g.avgCost != null ? D(g.avgCost).toFixed(4) : null,
      ...({ agreed: agreedBy.get(g.pid) ?? null } as object),
    })),
  };
}

async function supplierHistory(id: string): Promise<SectionResult> {
  const logs = await prisma.auditLog.findMany({ where: { entityType: "supplier", entityId: id }, orderBy: { timestamp: "desc" }, take: 200, select: { id: true, action: true, userName: true, timestamp: true, fieldChanged: true, oldValue: true, newValue: true, reason: true } });
  return { rows: [], total: logs.length, data: logs };
}

async function supplierSummary(id: string, can: Can) {
  const s = await prisma.supplier.findUnique({ where: { id }, select: { id: true } });
  if (!s) throw new ApiError(404, "المورد مش موجود");
  const year = `${todayLocalISO().slice(0, 4)}-01-01`;
  const out: Record<string, unknown> = {};
  const [receipts, lastReceipt, unbilled] = await Promise.all([
    prisma.stockIntake.count({ where: { supplierId: id, status: "posted" } }),
    prisma.stockIntake.findFirst({ where: { supplierId: id, status: "posted" }, orderBy: [{ receivedDate: "desc" }], select: { receivedDate: true } }),
    prisma.stockIntake.count({ where: { supplierId: id, status: "posted", billLines: { none: { bill: { status: { in: ["draft", "pending_approval", "approved", "posted"] } } } } } }),
  ]);
  Object.assign(out, { receipts, lastReceiptDate: lastReceipt?.receivedDate ?? null, unbilledReceipts: unbilled });
  if (can("purchasing.orders.view")) {
    const [orders, open] = await Promise.all([prisma.purchaseOrder.count({ where: { supplierId: id } }), prisma.purchaseOrder.count({ where: { supplierId: id, status: { in: ["approved", "sent", "partially_received"] } } })]);
    Object.assign(out, { purchaseOrders: orders, openPurchaseOrders: open });
  }
  if (can(MONEY.payable)) {
    const [billed, billedYear, dn, dnYear, paid, lastPay] = await Promise.all([
      prisma.supplierBill.aggregate({ where: { supplierId: id, status: "posted" }, _sum: { net: true } }),
      prisma.supplierBill.aggregate({ where: { supplierId: id, status: "posted", billDate: { gte: year } }, _sum: { net: true } }),
      prisma.debitNote.aggregate({ where: { supplierId: id }, _sum: { net: true } }),
      prisma.debitNote.aggregate({ where: { supplierId: id, issueDate: { gte: year } }, _sum: { net: true } }),
      prisma.supplierPayment.aggregate({ where: { supplierId: id, reversal: { is: null } }, _sum: { amount: true } }),
      prisma.supplierPayment.findFirst({ where: { supplierId: id, reversal: { is: null } }, orderBy: [{ date: "desc" }], select: { date: true } }),
    ]);
    Object.assign(out, {
      payable: m2(await supplierPayable(prisma, id)),
      // Net purchases: posted bills less debit notes, before VAT.
      netPurchases: D(billed._sum.net).minus(D(dn._sum.net)).toFixed(2), netPurchasesThisYear: D(billedYear._sum.net).minus(D(dnYear._sum.net)).toFixed(2),
      paid: m2(paid._sum.amount), lastPaymentDate: lastPay?.date ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

async function productMovements(id: string, can: Can, w: Window): Promise<Source> {
  const where: Prisma.StockMovementWhereInput = { productId: id, ...range("effectiveDate", w) };
  const [total, moves] = await Promise.all([
    prisma.stockMovement.count({ where }),
    prisma.stockMovement.findMany({ where, orderBy: [{ seq: "desc" }], take: w.limit, select: { id: true, kind: true, quantity: true, effectiveDate: true, occurredAt: true, unitCost: true, reason: true, actorName: true, location: { select: { code: true } }, lot: { select: { lotNumber: true } }, product: { select: { unit: true } }, intake: { select: { receiptNumber: true, supplier: { select: { id: true, name: true, nameAr: true } } } }, document: { select: { id: true, number: true, type: true, sourceType: true, sourceId: true } } } }),
  ]);
  const orderIds = moves.filter((m) => m.document?.sourceType === "order" && m.document.sourceId).map((m) => m.document!.sourceId!);
  const orders = new Map((await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true, customerAccount: { select: { id: true, name: true, nameAr: true } } } })).map((o) => [o.id, o]));
  const cost = can(MONEY.cost);
  return {
    total,
    rows: moves.map((m): Sourced => {
      const order = m.document?.sourceType === "order" && m.document.sourceId ? orders.get(m.document.sourceId) : undefined;
      return {
        key: `move:${m.id}`, kind: m.kind, id: m.id, number: m.document?.number ?? m.intake?.receiptNumber ?? "", date: m.effectiveDate, status: null, at: m.occurredAt.getTime(),
        detail: [m.location.code, m.lot?.lotNumber ?? "", m.actorName, m.reason ?? ""].join("|"),
        qty: D(m.quantity).toString(), uom: m.product.unit,
        ...({ unitCost: cost && m.unitCost != null ? D(m.unitCost).toFixed(4) : null } as object),
        party: m.intake ? partyRef(can, "supplier", m.intake.supplier) : order?.customerAccount ? partyRef(can, "customer", order.customerAccount) : null,
        href: m.document ? linkFor(can, href.stockDocument(m.document.id)) : m.intake ? linkFor(can, href.intake(m.intake.receiptNumber)) : null,
        via: order ? { kind: "order", number: order.orderNumber, href: linkFor(can, href.order(order.id)) } : null,
      };
    }),
  };
}

async function productPurchases(id: string, can: Can, w: Window): Promise<SectionResult> {
  const lines = await intakes({ productId: id }, can, w, "supplier");
  const groups = await prisma.$queryRaw<{ sid: string; name: string; nameAr: string | null; qty: Prisma.Decimal; good: Prisma.Decimal; n: bigint; last: string; avgCost: Prisma.Decimal | null }[]>`
    SELECT s."id" AS sid, s."name", s."nameAr", sum(i."receivedQty") AS qty, sum(i."goodQty") AS good, count(*) AS n, max(i."receivedDate") AS last,
      sum(i."unitCost" * i."goodQty") / nullif(sum(CASE WHEN i."unitCost" IS NOT NULL THEN i."goodQty" END), 0) AS "avgCost"
    FROM "StockIntake" i JOIN "Supplier" s ON s."id" = i."supplierId"
    WHERE i."productId" = ${id} AND i."status" = 'posted' ${sqlRange(Prisma.sql`i."receivedDate"`, w)}
    GROUP BY s."id" ORDER BY last DESC, s."name"`;
  const unit = (await prisma.stockProduct.findUnique({ where: { id }, select: { unit: true } }))?.unit ?? null;
  const cost = can(MONEY.cost);
  return {
    ...merge([lines], w.limit),
    groups: groups.map((g) => ({ key: g.sid, entity: partyRef(can, "supplier", { id: g.sid, name: g.name, nameAr: g.nameAr })!, uom: unit, qty: D(g.qty).toString(), delivered: D(g.good).toString(), count: Number(g.n), lastDate: g.last, lastPrice: null, avgPrice: cost && g.avgCost != null ? D(g.avgCost).toFixed(4) : null })),
  };
}

async function productSales(id: string, can: Can, w: Window): Promise<SectionResult> {
  const where: Prisma.OrderItemWhereInput = { stockProductId: id, order: { status: { not: "cancelled" }, ...range("deliveryDate", w) } };
  const priced = can(MONEY.salesPrice);
  const [total, items, groups] = await Promise.all([
    prisma.orderItem.count({ where }),
    prisma.orderItem.findMany({ where, orderBy: [{ order: { deliveryDate: "desc" } }, { createdAt: "desc" }], take: w.limit, select: { id: true, unit: true, requiredQuantity: true, loadedQuantity: true, price: { select: { unitPrice: true } }, order: { select: { id: true, orderNumber: true, deliveryDate: true, status: true, customerName: true, customerAccount: { select: { id: true, name: true, nameAr: true } } } } } }),
    prisma.$queryRaw<{ cid: string | null; name: string; nameAr: string | null; unit: string; qty: number; loaded: number; n: bigint; last: string; lastPrice: Prisma.Decimal | null; avg: Prisma.Decimal | null }[]>`
      SELECT c."id" AS cid, coalesce(max(c."name"), max(o."customerName")) AS name, max(c."nameAr") AS "nameAr", i."unit", sum(i."requiredQuantity") AS qty, sum(coalesce(i."loadedQuantity", 0)) AS loaded,
        count(DISTINCT o."id") AS n, max(o."deliveryDate") AS last,
        (array_agg(p."unitPrice" ORDER BY o."deliveryDate" DESC, o."createdAt" DESC) FILTER (WHERE p."unitPrice" IS NOT NULL))[1] AS "lastPrice",
        sum(p."unitPrice" * i."requiredQuantity"::numeric) / nullif(sum(CASE WHEN p."unitPrice" IS NOT NULL THEN i."requiredQuantity"::numeric END), 0) AS avg
      FROM "OrderItem" i JOIN "Order" o ON o."id" = i."orderId" LEFT JOIN "Customer" c ON c."id" = o."customerAccountId" LEFT JOIN "OrderItemPrice" p ON p."orderItemId" = i."id"
      WHERE i."stockProductId" = ${id} AND o."status" <> 'cancelled' ${sqlRange(Prisma.sql`o."deliveryDate"`, w)}
      GROUP BY c."id", CASE WHEN c."id" IS NULL THEN o."customerName" END, i."unit"
      ORDER BY last DESC, name`,
  ]);
  return {
    total,
    rows: items.map((i) => ({
      key: `item:${i.id}`, kind: "order_line", id: i.order.id, number: i.order.orderNumber, date: i.order.deliveryDate, status: i.order.status, detail: i.order.customerAccount ? null : i.order.customerName,
      party: partyRef(can, "customer", i.order.customerAccount), qty: String(i.requiredQuantity), delivered: i.loadedQuantity == null ? null : String(i.loadedQuantity), uom: i.unit,
      price: priced && i.price ? i.price.unitPrice.toFixed(2) : null, href: linkFor(can, href.order(i.order.id)),
    })),
    groups: groups.map((g) => ({
      key: `${g.cid ?? g.name}:${g.unit}`, entity: g.cid ? partyRef(can, "customer", { id: g.cid, name: g.name, nameAr: g.nameAr })! : { kind: "name", id: null, name: g.name, nameAr: null, href: null },
      uom: g.unit, qty: String(Number(g.qty)), delivered: String(Number(g.loaded)), count: Number(g.n), lastDate: g.last,
      lastPrice: priced && g.lastPrice != null ? D(g.lastPrice).toFixed(2) : null, avgPrice: priced && g.avg != null ? D(g.avg).toFixed(2) : null,
    })),
  };
}

/** Selling prices (price lists) and agreed buying prices of the product, with their history. */
async function productPrices(id: string, can: Can, w: Window): Promise<Source> {
  const sales = can(MONEY.salesPrice), buying = can(MONEY.purchasePrice);
  const [items, agreed] = await Promise.all([
    sales ? prisma.priceListItem.findMany({ where: { productId: id, ...range("validFrom", w) }, orderBy: [{ validFrom: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, uomCode: true, unitPrice: true, validFrom: true, validTo: true, createdBy: true, createdAt: true, priceList: { select: { name: true, active: true } } } }) : [],
    buying ? prisma.supplierPrice.findMany({ where: { productId: id, ...range("validFrom", w) }, orderBy: [{ validFrom: "desc" }, { createdAt: "desc" }], take: w.limit, select: { id: true, uomCode: true, unitPrice: true, validFrom: true, validTo: true, createdBy: true, createdAt: true, supplier: { select: { id: true, name: true, nameAr: true } } } }) : [],
  ]);
  const [ni, na] = await Promise.all([sales ? prisma.priceListItem.count({ where: { productId: id, ...range("validFrom", w) } }) : 0, buying ? prisma.supplierPrice.count({ where: { productId: id, ...range("validFrom", w) } }) : 0]);
  return {
    total: ni + na,
    rows: [
      ...items.map((p): Sourced => ({ key: `price:${p.id}`, kind: "sales_price", id: p.id, number: p.priceList.name, date: p.validFrom, status: p.priceList.active ? null : "inactive", at: p.createdAt.getTime(), detail: `${p.validTo ?? ""}|${p.createdBy}`, uom: p.uomCode, price: p.unitPrice.toFixed(2), href: linkFor(can, href.priceLists()) })),
      ...agreed.map((p): Sourced => ({ key: `agreed:${p.id}`, kind: "supplier_price", id: p.id, number: "", date: p.validFrom, status: null, at: p.createdAt.getTime(), detail: `${p.validTo ?? ""}|${p.createdBy}`, uom: p.uomCode, price: p.unitPrice.toFixed(2), party: partyRef(can, "supplier", p.supplier), href: partyRef(can, "supplier", p.supplier)?.href ?? null })),
    ],
  };
}

async function productSummary(id: string, can: Can) {
  const p = await prisma.stockProduct.findUnique({
    where: { id },
    select: { id: true, sku: true, name: true, nameAr: true, unit: true, category: true, active: true, stockTracked: true, costingMethod: true, removalStrategy: true, shelfLifeDays: true, coldChain: true, salesTaxCode: true, minStockQty: true, reorderPointQty: true, maxStockQty: true, aliases: { select: { alias: true } }, packagings: { where: { active: true }, select: { uomCode: true, qtyInBaseUnit: true, barcode: true } } },
  });
  if (!p) throw new ApiError(404, "الصنف مش موجود");
  const [receipts, lastReceipt, suppliers] = await Promise.all([
    prisma.stockIntake.count({ where: { productId: id, status: "posted" } }),
    prisma.stockIntake.findFirst({ where: { productId: id, status: "posted" }, orderBy: [{ receivedDate: "desc" }], select: { receivedDate: true } }),
    prisma.stockIntake.groupBy({ by: ["supplierId"], where: { productId: id, status: "posted" } }),
  ]);
  const out: Record<string, unknown> = { product: p, receipts, lastReceiptDate: lastReceipt?.receivedDate ?? null, suppliers: suppliers.length };
  if (can("orders.view")) {
    const [lines, last, customers] = await Promise.all([
      prisma.orderItem.count({ where: { stockProductId: id, order: { status: { not: "cancelled" } } } }),
      prisma.orderItem.findFirst({ where: { stockProductId: id, order: { status: { not: "cancelled" } } }, orderBy: { order: { deliveryDate: "desc" } }, select: { order: { select: { deliveryDate: true } } } }),
      prisma.order.groupBy({ by: ["customerAccountId"], where: { status: { not: "cancelled" }, customerAccountId: { not: null }, items: { some: { stockProductId: id } } } }),
    ]);
    Object.assign(out, { orderLines: lines, lastOrderDate: last?.order.deliveryDate ?? null, customers: customers.length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** The window a request asks for: how many rows (50 by default, at most 1000) and an optional date range. */
export function windowOf(sp: URLSearchParams): Window {
  const raw = Math.floor(Number(sp.get("limit")));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1000) : 50;
  const from = sp.get("from") || undefined, to = sp.get("to") || undefined;
  if ((from && !isValidISODate(from)) || (to && !isValidISODate(to)) || (from && to && from > to)) throw new ApiError(400, "الفترة غير صالحة");
  return { limit, from, to, open: sp.get("open") === "1" };
}

async function exists(kind: ProfileKind, id: string) {
  const found = kind === "customer" ? await prisma.customer.findUnique({ where: { id }, select: { id: true } })
    : kind === "supplier" ? await prisma.supplier.findUnique({ where: { id }, select: { id: true } })
    : await prisma.stockProduct.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw new ApiError(404, kind === "customer" ? "العميل مش موجود" : kind === "supplier" ? "المورد مش موجود" : "الصنف مش موجود");
}

/** One section of one profile, for this viewer (403 when the section is not theirs). */
export async function profileSection(kind: string, id: string, section: string, can: Can, w: Window): Promise<SectionResult | Record<string, unknown>> {
  if (kind !== "customer" && kind !== "supplier" && kind !== "product") throw new ApiError(404, "مش موجود");
  if (!maySeeSection(kind, section, can)) throw new ApiError(403, "مش مسموحلك تشوف الجزء ده");
  await exists(kind, id);
  const sees = (s: string) => maySeeSection(kind, s, can);
  if (kind === "customer") {
    switch (section) {
      case "summary": return customerSummary(id, can);
      case "orders": return merge([await customerOrders(id, can, w)], w.limit);
      case "invoices": return merge([await customerInvoices(id, can, w)], w.limit);
      case "payments": return merge([await customerPayments(id, can, w)], w.limit);
      case "returns": return merge([await customerReturns(id, can, w)], w.limit);
      case "products": return customerProducts(id, can, w);
      case "timeline": return merge(await Promise.all([
        sees("orders") ? customerOrders(id, can, w) : null, sees("invoices") ? customerInvoices(id, can, w) : null,
        sees("payments") ? customerPayments(id, can, w) : null, sees("returns") ? customerReturns(id, can, w) : null,
      ].filter((x): x is Promise<Source> => !!x)), w.limit);
    }
  } else if (kind === "supplier") {
    switch (section) {
      case "summary": return supplierSummary(id, can);
      case "orders": return merge([await supplierOrders(id, can, w)], w.limit);
      case "receipts": return merge([await intakes({ supplierId: id }, can, w, "product")], w.limit);
      case "bills": return merge([await supplierBills(id, can, w)], w.limit);
      case "payments": return merge([await supplierPayments(id, can, w)], w.limit);
      case "returns": return merge([await returnDocuments({ type: "supplier_return", supplierId: id, reversalOfId: null, ...range("businessDate", w) }, can, "supplier", w)], w.limit);
      case "products": return supplierProducts(id, can, w);
      case "history": return supplierHistory(id);
      case "timeline": return merge(await Promise.all([
        sees("orders") ? supplierOrders(id, can, w) : null, sees("receipts") ? intakes({ supplierId: id }, can, w, "product") : null,
        sees("bills") ? supplierBills(id, can, w) : null, sees("payments") ? supplierPayments(id, can, w) : null,
        sees("returns") ? returnDocuments({ type: "supplier_return", supplierId: id, reversalOfId: null, ...range("businessDate", w) }, can, "supplier", w) : null,
      ].filter((x): x is Promise<Source> => !!x)), w.limit);
    }
  } else {
    switch (section) {
      case "summary": return productSummary(id, can);
      case "movements": return merge([await productMovements(id, can, w)], w.limit);
      case "purchases": return productPurchases(id, can, w);
      case "sales": return productSales(id, can, w);
      case "prices": return merge([await productPrices(id, can, w)], w.limit);
    }
  }
  throw new ApiError(404, "مش موجود");
}
