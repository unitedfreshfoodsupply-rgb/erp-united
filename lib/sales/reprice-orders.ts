import { Prisma, type PriceList, type PriceListItem } from "@prisma/client";
import { writeAuditMany, type AuditInput } from "@/lib/audit";
import type { Tx } from "@/lib/tx";
import { toBaseQuantity } from "@/lib/inventory/packaging";

/**
 * applyListPrices (lib/sales/pricing.ts) for many orders at once (Nov 2026). Mapping a customer
 * name or a product name re-prices every open order carrying it; one order at a time that was
 * ~9 statements per order plus 1–2 per line, so a backlog of ~20 orders ran past the 20 s
 * transaction limit and the mapping failed. This reads the orders, invoices, lists, list
 * prices, units and packagings once and writes the prices in three statements, with the same
 * rules line by line: manual and quotation prices are never touched; existing list prices
 * only with `refresh`; a cancelled or invoiced order is left alone; the customer's own list
 * first, then the default; a price that no longer applies is removed on refresh; an
 * unchanged price is not rewritten; one "order_priced" audit row per order that changed.
 */
type Actorish = { id: string | null; name: string; role: string; deviceId?: string };
type Found = { item: PriceListItem; unitPrice: Prisma.Decimal };

export async function applyListPricesToOrders(tx: Tx, orderIds: string[], actor: Actorish, opts: { refresh?: boolean } = {}): Promise<Map<string, { priced: number }>> {
  const ids = [...new Set(orderIds)];
  const result = new Map<string, { priced: number }>(ids.map((id) => [id, { priced: 0 }]));
  if (!ids.length) return result;
  const [orders, invoices] = await Promise.all([
    tx.order.findMany({ where: { id: { in: ids } }, include: { items: { include: { price: true, stockProduct: { include: { salesTax: true } } } } } }),
    tx.salesInvoice.findMany({ where: { orderId: { in: ids }, status: { in: ["draft", "issued"] } }, select: { orderId: true } }),
  ]);
  // Background re-pricing (customer or mapping changed) never rewrites an invoiced order.
  const invoiced = new Set(invoices.map((i) => i.orderId));
  const live = orders.filter((o) => o.status !== "cancelled" && !invoiced.has(o.id));
  if (!live.length) return result;

  // The lists a customer is priced from, in order: its own list, then the default list.
  const customerIds = [...new Set(live.map((o) => o.customerAccountId).filter((x): x is string => !!x))];
  const [customers, def] = await Promise.all([
    customerIds.length ? tx.customer.findMany({ where: { id: { in: customerIds } }, include: { priceList: true } }) : [],
    tx.priceList.findFirst({ where: { isDefault: true, active: true } }),
  ]);
  const ownList = new Map(customers.map((c) => [c.id, c.priceList?.active ? c.priceList : null]));
  const listsFor = (customerId: string | null): PriceList[] => {
    const out: PriceList[] = [];
    const own = customerId ? ownList.get(customerId) : null;
    if (own) out.push(own);
    if (def && !out.some((l) => l.id === def.id)) out.push(def);
    return out;
  };

  // Every line that may be (re)priced, and the list prices that could apply to it.
  const wanted = live.flatMap((o) => o.items.filter((i) => i.stockProduct && (!i.price || (i.price.source === "list" && opts.refresh))).map((i) => ({ o, i, product: i.stockProduct! })));
  const listIds = [...new Set(live.flatMap((o) => listsFor(o.customerAccountId).map((l) => l.id)))];
  const dates = live.map((o) => o.deliveryDate).sort();
  const [rows, conversions] = await Promise.all([
    wanted.length && listIds.length
      ? tx.priceListItem.findMany({
          where: {
            priceListId: { in: listIds },
            productId: { in: [...new Set(wanted.map((w) => w.product.id))] },
            uomCode: { in: [...new Set(wanted.flatMap((w) => [w.i.unit, w.product.unit]))] },
            validFrom: { lte: dates[dates.length - 1] },
            OR: [{ validTo: null }, { validTo: { gte: dates[0] } }],
          },
          orderBy: { validFrom: "desc" },
        })
      : [],
    conversionDb(tx, wanted.filter((w) => w.i.unit !== w.product.unit).map((w) => w.product.id)),
  ]);

  /** effectivePrice, from the rows read above. */
  async function priceOf(listId: string, product: { id: string; name: string; unit: string }, lineUom: string, date: string): Promise<Found | null> {
    const valid = rows.filter((r) => r.priceListId === listId && r.productId === product.id && (r.uomCode === lineUom || r.uomCode === product.unit) && r.validFrom <= date && (r.validTo === null || r.validTo >= date));
    const exact = valid.find((r) => r.uomCode === lineUom);
    if (exact) return { item: exact, unitPrice: exact.unitPrice };
    const base = valid.find((r) => r.uomCode === product.unit);
    if (!base) return null;
    let factor: Prisma.Decimal;
    try {
      factor = await toBaseQuantity(conversions, product, new Prisma.Decimal(1), lineUom);
    } catch {
      return null; // the line's unit does not convert: it stays unpriced for a person
    }
    return { item: base, unitPrice: base.unitPrice.times(factor).toDecimalPlaces(4) };
  }

  const removed: string[] = [];
  const created: Prisma.OrderItemPriceCreateManyInput[] = [];
  const updated: Prisma.Sql[] = [];
  const audits: AuditInput[] = [];
  for (const o of live) {
    const lists = listsFor(o.customerAccountId);
    if (!lists.length) continue;
    let priced = 0;
    for (const { i: item, product } of wanted.filter((w) => w.o === o)) {
      const current = item.price;
      let found: Found | null = null;
      let list = lists[0];
      for (const l of lists) {
        found = await priceOf(l.id, product, item.unit, o.deliveryDate);
        if (found) {
          list = l;
          break;
        }
      }
      if (!found) {
        // No price any more (e.g. the customer moved to a list without it): a stale
        // list price must not linger as if it applied.
        if (current && opts.refresh) removed.push(item.id);
        continue;
      }
      if (current) {
        if (current.unitPrice.equals(found.unitPrice) && current.priceListItemId === found.item.id && current.taxCode === product.salesTaxCode) continue;
        updated.push(Prisma.sql`(${item.id}::text, ${found.unitPrice.toString()}::numeric, ${product.salesTaxCode}::text, ${product.salesTax.rate.toString()}::numeric, ${list.currencyCode}::text, ${list.id}::text, ${found.item.id}::text)`);
      } else {
        created.push({
          orderItemId: item.id, unitPrice: found.unitPrice, discountPct: new Prisma.Decimal(0), taxCode: product.salesTaxCode, taxRate: product.salesTax.rate,
          currencyCode: list.currencyCode, source: "list", priceListId: list.id, priceListItemId: found.item.id, reason: null, setById: actor.id, setBy: actor.name,
        });
      }
      priced++;
    }
    result.set(o.id, { priced });
    if (priced) {
      audits.push({ userId: actor.id, userName: actor.name, role: actor.role, source: "user", deviceId: actor.deviceId, action: "order_priced", entityType: "order", entityId: o.id, orderId: o.id, fieldChanged: lists.map((l) => l.code).join(" → "), newValue: `${priced} سطر` });
    }
  }
  if (removed.length) await tx.orderItemPrice.deleteMany({ where: { orderItemId: { in: removed } } });
  if (created.length) await tx.orderItemPrice.createMany({ data: created });
  if (updated.length) {
    await tx.$executeRaw`
      UPDATE "OrderItemPrice" AS p SET "unitPrice" = v.unit_price, "discountPct" = 0, "taxCode" = v.tax_code, "taxRate" = v.tax_rate, "currencyCode" = v.currency,
        "source" = 'list', "priceListId" = v.list_id, "priceListItemId" = v.item_id, "reason" = NULL, "setById" = ${actor.id}::text, "setBy" = ${actor.name}::text,
        "version" = p."version" + 1, "updatedAt" = ${new Date().toISOString()}::timestamp(3)
      FROM (VALUES ${Prisma.join(updated)}) AS v(order_item_id, unit_price, tax_code, tax_rate, currency, list_id, item_id)
      WHERE p."orderItemId" = v.order_item_id`;
  }
  await writeAuditMany(audits, tx);
  return result;
}

/** What toBaseQuantity reads (units, the products' packagings), read once and served from memory. */
async function conversionDb(tx: Tx, productIds: string[]): Promise<Pick<Tx, "unitOfMeasure" | "productPackaging">> {
  const [units, packs] = productIds.length
    ? await Promise.all([tx.unitOfMeasure.findMany(), tx.productPackaging.findMany({ where: { productId: { in: [...new Set(productIds)] } } })])
    : [[], []];
  const unitBy = new Map(units.map((u) => [u.code, u]));
  const packBy = new Map(packs.map((p) => [`${p.productId}|${p.uomCode}`, p]));
  return {
    unitOfMeasure: { findUnique: async ({ where }: { where: { code: string } }) => unitBy.get(where.code) ?? null },
    productPackaging: { findUnique: async ({ where }: { where: { productId_uomCode: { productId: string; uomCode: string } } }) => packBy.get(`${where.productId_uomCode.productId}|${where.productId_uomCode.uomCode}`) ?? null },
  } as unknown as Pick<Tx, "unitOfMeasure" | "productPackaging">;
}
