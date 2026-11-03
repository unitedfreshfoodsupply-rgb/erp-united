import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/core/settings-service";
import { resolveBuyerIdentity } from "@/lib/sales/invoicing";

/**
 * Cutover readiness (remediation 2026-11, MIG-02). A read-only report of what still
 * separates the books from a complete, reconciled go-live from Odoo. It invents no
 * figure: each item states what the data shows and what must be done, and the
 * exception lists name the records. Reconciliation against Odoo's own closing figures
 * is entered by people (CUTOVER.md §4.3); this report shows UNITED's side of it.
 */

type Item = {
  key: string;
  ok: boolean;
  severity: "blocker" | "warning" | "info";
  label: string;
  labelEn: string;
  value?: string;
  count?: number;
  detail?: unknown[];
};

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);

async function glBalance(systemKey: string, asOf: string | null = null) {
  const r = await prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT sum(l."debit" - l."credit") AS v FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE a."systemKey" = ${systemKey} AND (${asOf}::text IS NULL OR e."date" <= ${asOf})`;
  return D(r[0]?.v);
}

/**
 * The opening-balance items (OPN-D13), from facts read by cutoverReadiness. Opening equity
 * (3300) is a clearing account: an approved batch nets it to zero (opening-batches.ts), so a
 * balance left in it — overall, or as at the cut-over date — means opening figures are missing
 * or counted twice. An opening entry is "direct" when it did not come from a batch.
 */
export function openingItems(f: {
  initial: { number: string; cutoverDate: string } | null;
  batches: unknown[];
  equity: Prisma.Decimal;
  equityAtCutover: Prisma.Decimal | null;
  directStock: { number: string; businessDate: string }[];
  /** Direct opening stock entries that were reversed, with the GL date of the reversal. */
  reversedDirect?: { number: string; reversedOn: string }[];
  partyRows: number;
  batchPartyLines: number;
}): Item[] {
  const directParty = Math.max(0, f.partyRows - f.batchPartyLines);
  const items: Item[] = [
    { key: "opening_batch", ok: !!f.initial, severity: "blocker", label: "دفعة الأرصدة الافتتاحية اتعتمدت واترحّلت", labelEn: "The initial opening batch is approved and posted", detail: f.batches },
    { key: "opening_equity_zero", ok: f.equity.isZero(), severity: "blocker", label: "حساب الأرصدة الافتتاحية (3300) رصيده صفر", labelEn: "Opening equity (3300) nets to zero", value: f.equity.toFixed(2) },
    { key: "direct_opening_stock", ok: f.directStock.length === 0, severity: "warning", label: "مخزون افتتاحي اتسجل مباشرة من غير دفعة (من غير موافقة شخص تاني) — راجعه", labelEn: "Opening stock posted directly, outside a batch (no second person) — review it", count: f.directStock.length, detail: f.directStock },
    { key: "direct_party_opening", ok: directParty === 0, severity: "warning", label: "أرصدة افتتاحية للعملاء/الموردين اتسجلت مباشرة من غير دفعة", labelEn: "Customer/supplier opening balances posted directly, outside a batch", count: directParty, value: `${f.partyRows} / ${f.batchPartyLines}` },
  ];
  if (f.initial) items.splice(2, 0, { key: "opening_equity_at_cutover", ok: !!f.equityAtCutover?.isZero(), severity: "blocker", label: `حساب الأرصدة الافتتاحية (3300) صفر في تاريخ الافتتاح ${f.initial.cutoverDate}`, labelEn: `Opening equity (3300) is zero as at the cut-over date ${f.initial.cutoverDate}`, value: f.equityAtCutover?.toFixed(2) });
  // A batch dated before the reversal of a direct opening entry: on every day from the cut-over
  // date until that reversal, the balance sheet carries the opening stock twice (D13).
  const late = f.initial ? (f.reversedDirect ?? []).filter((r) => r.reversedOn > f.initial!.cutoverDate) : [];
  if (f.initial && f.reversedDirect?.length) items.splice(3, 0, { key: "cutover_after_direct_reversal", ok: late.length === 0, severity: "blocker", label: `تاريخ الافتتاح ${f.initial.cutoverDate} مش قبل عكس المخزون الافتتاحي المباشر`, labelEn: `The cut-over date ${f.initial.cutoverDate} is not before the reversal of the direct opening stock`, count: late.length, detail: late });
  return items;
}

export async function cutoverReadiness() {
  const items: Item[] = [];
  const company = await prisma.company.findFirst({ select: { taxRegistrationNumber: true } });
  items.push({
    key: "company_tax", ok: !!company?.taxRegistrationNumber && /^\d{9}$/.test(company.taxRegistrationNumber), severity: "blocker",
    label: "رقم التسجيل الضريبي للشركة متسجل", labelEn: "Company tax registration number is recorded",
  });

  // Opening balances: one approved batch is the target state, and opening equity nets to zero.
  const [batches, partyRows, batchPartyLines, directStock] = await Promise.all([
    prisma.openingBatch.findMany({ select: { number: true, kind: true, status: true, cutoverDate: true } }),
    prisma.partyOpeningBalance.count(),
    prisma.openingBatchLine.count({ where: { kind: { in: ["customer", "supplier"] }, batch: { status: "posted" } } }),
    // Posted, not reversed, and not from a batch (a batch tags its document "<batch id>:stock").
    prisma.inventoryDocument.findMany({ where: { type: "adjustment", sourceType: "opening_balance", status: "posted", reversalOfId: null, sourceId: null }, select: { number: true, businessDate: true }, orderBy: { number: "asc" } }),
  ]);
  const initial = batches.find((b) => b.kind === "initial" && b.status === "posted") ?? null;
  // The GL date the reversal of each direct opening stock entry took the stock off the books.
  const reversedDirect = await prisma.$queryRaw<{ number: string; reversedOn: string }[]>`
    SELECT d."number", max(e."date") AS "reversedOn"
    FROM "InventoryDocument" d JOIN "InventoryDocument" r ON r."reversalOfId" = d."id"
    JOIN "StockMovement" m ON m."documentId" = r."id" JOIN "StockValuationPosting" p ON p."movementId" = m."id" JOIN "JournalEntry" e ON e."id" = p."entryId"
    WHERE d."type" = 'adjustment' AND d."sourceType" = 'opening_balance' AND d."sourceId" IS NULL
    GROUP BY d."number" ORDER BY d."number"`;
  const [equity, equityAtCutover] = await Promise.all([glBalance("opening_equity"), initial ? glBalance("opening_equity", initial.cutoverDate) : Promise.resolve(null)]);
  items.push(...openingItems({ initial, batches, equity, equityAtCutover, directStock, reversedDirect, partyRows, batchPartyLines }));

  // Sub-ledgers against the GL (UNITED's side of the Odoo reconciliation).
  const [ar, ap, inv, grni, cash] = await Promise.all([glBalance("ar"), glBalance("ap"), glBalance("inventory"), glBalance("grni"), prisma.$queryRaw<{ code: string; v: Prisma.Decimal | null }[]>`
    SELECT c."code", sum(l."debit" - l."credit") AS v FROM "CashAccount" c LEFT JOIN "JournalLine" l ON l."accountId" = c."accountId" GROUP BY c."code" ORDER BY c."code"`]);
  const valuation = await prisma.stockValuationLayer.aggregate({ _sum: { value: true } });
  items.push({ key: "gl_ar", ok: true, severity: "info", label: "رصيد العملاء في الأستاذ (قارنه برصيد Odoo)", labelEn: "Receivables in the GL (compare with Odoo)", value: ar.toFixed(2) });
  items.push({ key: "gl_ap", ok: true, severity: "info", label: "رصيد الموردين في الأستاذ (قارنه برصيد Odoo)", labelEn: "Payables in the GL (compare with Odoo)", value: ap.negated().toFixed(2) });
  const invDiff = inv.minus(D(valuation._sum.value));
  items.push({ key: "inventory_vs_gl", ok: invDiff.abs().lte(0.01), severity: "blocker", label: "قيمة المخزون = حساب المخزون في الأستاذ", labelEn: "Inventory valuation equals the GL inventory account", value: `${D(valuation._sum.value).toFixed(2)} / ${inv.toFixed(2)}` });
  items.push({ key: "grni", ok: true, severity: "info", label: "بضاعة مستلمة لسه فاتورتها مجتش (GRNI)", labelEn: "Goods received not invoiced (GRNI)", value: grni.negated().toFixed(2) });
  items.push({ key: "cash_bank", ok: true, severity: "info", label: "أرصدة الخزائن والبنوك (قارنها بالجرد وكشف البنك)", labelEn: "Cash and bank balances (compare with the count and bank statement)", detail: cash.map((c) => ({ code: c.code, balance: D(c.v).toFixed(2) })) });

  // Master data the business cycle needs.
  const [priceLists, defaultList, products, packless, lots, lotsNoExpiry] = await Promise.all([
    prisma.priceList.count({ where: { active: true } }),
    prisma.priceList.count({ where: { active: true, isDefault: true } }),
    prisma.stockProduct.count({ where: { active: true } }),
    prisma.stockProduct.count({ where: { active: true, packagings: { none: {} }, unit: { notIn: ["KG", "PIECE"] } } }),
    prisma.stockLot.count(),
    prisma.stockLot.count({ where: { expiryDate: null, movements: { some: {} } } }),
  ]);
  items.push({ key: "price_list", ok: defaultList === 1, severity: "warning", label: "قائمة أسعار افتراضية واحدة نشطة (وإلا كل سطر بيتسعر يدوي)", labelEn: "Exactly one active default price list (otherwise every line is priced by hand)", count: priceLists });
  items.push({ key: "packaging", ok: packless === 0, severity: "warning", label: "أصناف بوحدة تعبئة من غير تحويل للوزن/العدد", labelEn: "Products in a package unit without a weight/count conversion", count: packless, value: String(products) });
  items.push({ key: "lot_expiry", ok: lotsNoExpiry === 0, severity: "warning", label: "دفعات من غير تاريخ صلاحية (التنبيهات وFEFO مش هتشتغل عليها)", labelEn: "Lots without an expiry date (alerts and FEFO cannot use them)", count: lotsNoExpiry, value: String(lots) });

  // Buyer tax identity: who cannot be invoiced today (MIG-01).
  const customers = await prisma.customer.findMany({ where: { active: true }, select: { code: true, name: true, nameAr: true, legalName: true, legalNameAr: true, taxRegistrationNo: true, address: true, area: true, city: true, legalEntity: { select: { name: true, nameAr: true, taxRegistrationNo: true, address: true, area: true, city: true, receiverType: true, receiverId: true, active: true } } } });
  const blocked = customers.filter((c) => !resolveBuyerIdentity(c).ok).map((c) => ({ code: c.code, name: c.nameAr ?? c.name }));
  items.push({ key: "buyer_tax_identity", ok: blocked.length === 0, severity: "blocker", label: "عملاء مايتفوترش لهم: مفيش رقم ضريبي لا على الكارت ولا على الكيان القانوني", labelEn: "Customers who cannot be invoiced: no tax number on the card or its legal entity", count: blocked.length, detail: blocked.slice(0, 200) });

  // Open documents carried over: UNITED does not import them (CUTOVER.md §2).
  const [openOrders, openPos, openExceptions] = await Promise.all([
    prisma.order.count({ where: { status: { notIn: ["dispatched", "cancelled"] } } }),
    prisma.purchaseOrder.count({ where: { status: { notIn: ["closed", "cancelled", "received"] } } }),
    prisma.stockIssueException.findMany({ where: { status: "open" }, select: { id: true, orderId: true, productName: true, requestedQty: true, issuedQty: true, unit: true } }),
  ]);
  items.push({ key: "open_orders", ok: true, severity: "info", label: "أوردرات بيع مفتوحة (بتتعمل من جديد، مش بتتستورد)", labelEn: "Open sales orders (recreated, not imported)", count: openOrders });
  items.push({ key: "open_pos", ok: true, severity: "info", label: "أوامر شراء مفتوحة", labelEn: "Open purchase orders", count: openPos });
  items.push({ key: "stock_issue_exceptions", ok: openExceptions.length === 0, severity: "blocker", label: "استثناءات صرف مفتوحة (بيع من غير تكلفة) — لازم تتسوّى", labelEn: "Open stock-issue exceptions (revenue without cost) — must be reconciled", count: openExceptions.length, detail: openExceptions.map((e) => ({ ...e, requestedQty: e.requestedQty.toFixed(), issuedQty: e.issuedQty.toFixed() })) });

  // Controls the go-live depends on.
  const [users, diffApprover] = await Promise.all([prisma.user.count({ where: { active: true } }), getSetting("approvals.require_different_approver")]);
  items.push({ key: "second_person", ok: users >= 2 && diffApprover, severity: "blocker", label: "فيه شخص تاني على النظام للموافقات (فصل المهام)", labelEn: "A second person exists for approvals (segregation of duties)", count: users });

  return {
    ready: items.every((i) => i.ok || i.severity !== "blocker"),
    checkedAt: new Date().toISOString(),
    items,
  };
}
