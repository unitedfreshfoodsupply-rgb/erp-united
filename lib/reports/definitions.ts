import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { todayLocalISO } from "@/lib/localDate";
import { businessDate, businessDayRange } from "@/lib/reports/business-day";
import type { ReportDef, ReportParams, ReportResult, ReportRow } from "@/lib/reports/types";

/*
 * The report catalogue (maturity 2026-11). Money comes from the general ledger or from the
 * posted documents that feed it; stock from the stock ledger and its valuation layers;
 * operations from the documents and the audit trail. Statements that already have their
 * own screen (trial balance, P&L, balance sheet, cash flow, aging, VAT, reconciliation,
 * integrity) are linked, not rebuilt: one figure, one place.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const m2 = (v: Prisma.Decimal.Value | null | undefined) => D(v).toFixed(2);
const q3 = (v: Prisma.Decimal.Value | null | undefined) => Number(D(v).toFixed(3));
const pct = (part: Prisma.Decimal.Value | null | undefined, whole: Prisma.Decimal.Value | null | undefined) => (D(whole).isZero() ? null : Number(D(part).div(D(whole)).times(100).toFixed(1)));
const enc = encodeURIComponent;
const name = (ar: string | null | undefined, en: string | null | undefined) => ({ name_ar: ar || en || "", name_en: en || ar || "" });
const PARTY_COLS = [{ key: "name_ar", label: { ar: "الاسم", en: "Name (Arabic)" }, type: "text" as const }, { key: "name_en", label: { ar: "الاسم بالإنجليزي", en: "Name" }, type: "text" as const }];
/** A supplier named in both languages (the screen shows the reader's; exports carry both, like PARTY_COLS). */
const SUPPLIER_COLS = [{ key: "supplier_ar", label: { ar: "المورد", en: "Supplier (Arabic)" }, type: "text" as const }, { key: "supplier_en", label: { ar: "المورد بالإنجليزي", en: "Supplier" }, type: "text" as const }];
const supplierName = (ar: string | null | undefined, en: string | null | undefined) => ({ supplier_ar: ar || en || "", supplier_en: en || ar || "" });
/** The dates a grouped period row covers (day / week / month / year), inside the report's own range. */
const periodSpan = (start: string, groupBy: string, p: { from: string; to: string }) => {
  const d = new Date(`${start}T00:00:00Z`);
  const end = groupBy === "day" ? d : groupBy === "week" ? new Date(d.getTime() + 6 * 86_400_000) : groupBy === "month" ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)) : new Date(Date.UTC(d.getUTCFullYear(), 11, 31));
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return `from=${start < p.from ? p.from : start}&to=${iso(end) > p.to ? p.to : iso(end)}`;
};

const FIN: ReportDef["permissions"] = ["accounting.view", "reports.finance"];
const SALES: ReportDef["permissions"] = ["reports.finance", "sales.invoices.view"];
const PURCH: ReportDef["permissions"] = ["reports.finance", "purchasing.bills.view"];
const STOCK: ReportDef["permissions"] = ["stock.view"];
const STOCK_VALUE: ReportDef["permissions"] = ["stock.valuation.view"];
const OPS: ReportDef["permissions"] = ["reports.view"];

const linked = (key: string, category: ReportDef["category"], title: ReportDef["title"], description: ReportDef["description"], href: string, permissions: ReportDef["permissions"]): ReportDef => ({ key, category, title, description, href, permissions, filters: [], columns: [] });

export const REPORTS: ReportDef[] = [
  // ---------------------------------------------------------------- financial
  linked("trial-balance", "financial", { ar: "ميزان المراجعة", en: "Trial balance" }, { ar: "أرصدة كل الحسابات من دفتر الأستاذ", en: "Every account's balance from the general ledger" }, "/accounting?tab=trial", FIN),
  linked("profit-loss", "financial", { ar: "قائمة الدخل", en: "Profit & loss" }, { ar: "الإيرادات وتكلفة المبيعات والمصروفات وصافي الربح من دفتر الأستاذ", en: "Revenue, cost of sales, expenses and net profit from the ledger" }, "/management", ["reports.finance"]),
  linked("balance-sheet", "financial", { ar: "الميزانية", en: "Balance sheet" }, { ar: "الأصول والخصوم وحقوق الملكية في تاريخ", en: "Assets, liabilities and equity at a date" }, "/accounting?tab=analysis", ["accounting.view"]),
  linked("cash-flow", "financial", { ar: "قائمة التدفقات النقدية", en: "Cash flow statement" }, { ar: "النقدية الداخلة والخارجة حسب النشاط", en: "Cash in and out by activity" }, "/management/cash-flow", ["reports.finance"]),
  {
    key: "general-ledger", category: "financial",
    title: { ar: "دفتر الأستاذ / حركة حساب", en: "General ledger / account activity" },
    description: { ar: "كل قيد على حساب في الفترة، برصيد افتتاحي ورصيد جاري", en: "Every entry on an account in the period, with opening and running balance" },
    notes: { ar: "من دفتر الأستاذ مباشرة. الرصيد = مدين − دائن.", en: "Straight from the general ledger. Balance = debit − credit." },
    permissions: FIN, filters: ["period", "account"],
    columns: [
      { key: "date", label: { ar: "التاريخ", en: "Date" }, type: "date" }, { key: "number", label: { ar: "القيد", en: "Entry" }, type: "code" },
      { key: "description", label: { ar: "البيان", en: "Description" }, type: "text" }, { key: "debit", label: { ar: "مدين", en: "Debit" }, type: "money", total: true },
      { key: "credit", label: { ar: "دائن", en: "Credit" }, type: "money", total: true }, { key: "balance", label: { ar: "الرصيد", en: "Balance" }, type: "money" },
    ],
    run: async (p) => {
      if (!p.accountId) return { rows: [], warnings: [{ ar: "اختار الحساب الأول.", en: "Choose an account first." }] };
      const [open] = await prisma.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."debit" - l."credit") b FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" WHERE l."accountId" = ${p.accountId} AND e."date" < ${p.from}`;
      const lines = await prisma.$queryRaw<{ date: string; number: string; description: string; debit: Prisma.Decimal; credit: Prisma.Decimal }[]>`
        SELECT e."date", e."number", coalesce(l."description", e."description") description, l."debit", l."credit"
        FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId"
        WHERE l."accountId" = ${p.accountId} AND e."date" BETWEEN ${p.from} AND ${p.to} ORDER BY e."date", e."number"`;
      let bal = D(open?.b);
      const rows: ReportRow[] = [{ date: p.from, number: "", description: "رصيد أول المدة", debit: null, credit: null, balance: m2(bal) }];
      for (const l of lines) {
        bal = bal.plus(l.debit).minus(l.credit);
        rows.push({ date: l.date, number: l.number, description: l.description, debit: m2(l.debit), credit: m2(l.credit), balance: m2(bal), _href: `/accounting?tab=journals&j_q=${enc(l.number)}` });
      }
      return { rows, totals: { balance: m2(bal) } };
    },
  },
  linked("journal-entries", "financial", { ar: "القيود اليومية", en: "Journal entries" }, { ar: "كل القيود، بحث بالرقم أو البيان", en: "All entries, searchable by number or description" }, "/accounting?tab=journals", FIN),
  {
    key: "cash-movements", category: "financial",
    title: { ar: "حركة الخزينة والبنوك", en: "Cash and bank movements" },
    description: { ar: "كل دخول وخروج فلوس من حساب نقدي أو بنكي، برصيد جاري", en: "Every inflow and outflow of a cash or bank account, with running balance" },
    notes: { ar: "من دفتر الأستاذ: حساب الخزينة/البنك المختار، ولو مااخترتش: كل الخزن والحسابات البنكية النشطة مع بعض (نفس رقم «النقدية والبنوك» في مركز القيادة) — والتحويل بينهم مابيظهرش، لأنه مش دخول ولا خروج فلوس.", en: "From the general ledger: the chosen cash or bank account or, with none chosen, every active cash and bank account together (the Command Center's cash and bank figure) — where a transfer between them is left out: no money came in or went out." },
    permissions: FIN, filters: ["period", "cashAccount"],
    columns: [
      { key: "date", label: { ar: "التاريخ", en: "Date" }, type: "date" }, { key: "number", label: { ar: "القيد", en: "Entry" }, type: "code" },
      { key: "description", label: { ar: "البيان", en: "Description" }, type: "text" }, { key: "inflow", label: { ar: "داخل", en: "In" }, type: "money", total: true },
      { key: "outflow", label: { ar: "خارج", en: "Out" }, type: "money", total: true }, { key: "balance", label: { ar: "الرصيد", en: "Balance" }, type: "money" },
    ],
    run: async (p) => {
      const chosen = p.cashAccountId ? await prisma.cashAccount.findUnique({ where: { id: p.cashAccountId }, select: { accountId: true, code: true, name: true, nameAr: true } }) : null;
      if (p.cashAccountId && !chosen) return { rows: [] };
      // None chosen ("All"): every active cash box and bank account together, as the Command Center counts them.
      const accounts = chosen ? [chosen.accountId] : (await prisma.cashAccount.findMany({ where: { active: true }, select: { accountId: true } })).map((c) => c.accountId);
      const scope = chosen ? { ar: `${chosen.code} · ${chosen.nameAr || chosen.name}`, en: `${chosen.code} · ${chosen.name}` } : { ar: "كل الخزن والحسابات البنكية النشطة", en: "All active cash and bank accounts" };
      if (!accounts.length) return { rows: [], scope };
      const [open] = await prisma.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum(l."debit" - l."credit") b FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" WHERE l."accountId" IN (${Prisma.join(accounts)}) AND e."date" < ${p.from}`;
      // One account: each of its lines. All of them: each entry's net effect on them together, so a
      // transfer between two of them nets to nothing and is left out (the balance is the same either way).
      const lines = chosen
        ? await prisma.$queryRaw<{ date: string; number: string; description: string; debit: Prisma.Decimal; credit: Prisma.Decimal }[]>`
          SELECT e."date", e."number", e."description", l."debit", l."credit" FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId"
          WHERE l."accountId" = ${chosen.accountId} AND e."date" BETWEEN ${p.from} AND ${p.to} ORDER BY e."date", e."number"`
        : await prisma.$queryRaw<{ date: string; number: string; description: string; debit: Prisma.Decimal; credit: Prisma.Decimal }[]>`
          SELECT e."date", e."number", e."description", greatest(sum(l."debit" - l."credit"), 0) debit, greatest(sum(l."credit" - l."debit"), 0) credit
          FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId"
          WHERE l."accountId" IN (${Prisma.join(accounts)}) AND e."date" BETWEEN ${p.from} AND ${p.to}
          GROUP BY e."id", e."date", e."number", e."description" HAVING sum(l."debit" - l."credit") <> 0 ORDER BY e."date", e."number"`;
      let bal = D(open?.b);
      const rows: ReportRow[] = [{ date: p.from, number: "", description: "رصيد أول المدة", inflow: null, outflow: null, balance: m2(bal) }];
      for (const l of lines) { bal = bal.plus(l.debit).minus(l.credit); rows.push({ date: l.date, number: l.number, description: l.description, inflow: m2(l.debit), outflow: m2(l.credit), balance: m2(bal), _href: `/accounting?tab=journals&j_q=${enc(l.number)}` }); }
      return { rows, totals: { balance: m2(bal) }, scope };
    },
  },
  {
    key: "cogs-by-product", category: "financial",
    title: { ar: "تكلفة البضاعة المباعة حسب الصنف", en: "Cost of goods sold by product" },
    description: { ar: "اللي خرج للعملاء ناقص المرتجع، بتكلفته في المخزون", en: "What left to customers less returns, at its stock cost" },
    notes: { ar: "من دفتر المخزون (طبقات التقييم) بتاريخ الحركة، زائد فروق التكلفة المؤقتة اللي اتحمّلت على مبيعات. يطابق حساب تكلفة المبيعات في الأستاذ.", en: "From the stock ledger (valuation layers) by movement date, plus provisional-cost differences charged to sales. Agrees with the COGS account." },
    permissions: [...FIN, ...STOCK_VALUE], filters: ["period", "category"],
    columns: [...PARTY_COLS, { key: "qty", label: { ar: "الكمية", en: "Quantity" }, type: "qty" }, { key: "cogs", label: { ar: "التكلفة", en: "Cost" }, type: "money", total: true }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; nameAr: string | null; name: string; qty: Prisma.Decimal; cogs: Prisma.Decimal }[]>`
        SELECT pr."id", pr."nameAr", pr."name", coalesce(x.qty, 0) qty, coalesce(x.cost, 0) + coalesce(r.d, 0) cogs
        FROM "StockProduct" pr
        LEFT JOIN (SELECT m."productId", -sum(m."quantity") qty, -sum(v."value") cost FROM "StockMovement" m JOIN "StockValuationLayer" v ON v."movementId" = m."id"
                   WHERE m."kind" IN ('issue', 'customer_return') AND m."effectiveDate" BETWEEN ${p.from} AND ${p.to} GROUP BY 1) x ON x."productId" = pr."id"
        LEFT JOIN (SELECT "productId", sum("cogsDelta") d FROM "StockRevaluation" WHERE "date" BETWEEN ${p.from} AND ${p.to} GROUP BY 1) r ON r."productId" = pr."id"
        WHERE (x.qty IS NOT NULL OR r.d IS NOT NULL) AND (${p.category ?? null}::text IS NULL OR pr."category" = ${p.category ?? null})
        ORDER BY 5 DESC`;
      return { rows: rows.map((r) => ({ ...name(r.nameAr, r.name), qty: q3(r.qty), cogs: m2(r.cogs), _href: `/stock/inventory?product=${r.id}` })) };
    },
  },
  {
    key: "ppv", category: "financial",
    title: { ar: "فروق أسعار المشتريات", en: "Purchase price variance" },
    description: { ar: "كل قيد على حساب فروق الأسعار: استلامات بتكلفة معيارية، وفواتير موردين بسعر مختلف", en: "Every posting to the PPV account: standard-cost receipts, and supplier bills at a different price" },
    notes: { ar: "من دفتر الأستاذ (حساب فروق أسعار المشتريات). موجب = اشترينا أغلى.", en: "From the general ledger (purchase price variance account). Positive = bought dearer." },
    permissions: FIN, filters: ["period"],
    columns: [{ key: "date", label: { ar: "التاريخ", en: "Date" }, type: "date" }, { key: "number", label: { ar: "القيد", en: "Entry" }, type: "code" }, { key: "description", label: { ar: "البيان", en: "Description" }, type: "text" }, { key: "amount", label: { ar: "الفرق", en: "Variance" }, type: "money", total: true }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ date: string; number: string; description: string; amount: Prisma.Decimal }[]>`
        SELECT e."date", e."number", e."description", sum(l."debit" - l."credit") amount FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
        WHERE a."systemKey" = 'ppv' AND e."date" BETWEEN ${p.from} AND ${p.to} GROUP BY e."date", e."number", e."description" ORDER BY e."date", e."number"`;
      return { rows: rows.map((r) => ({ date: r.date, number: r.number, description: r.description, amount: m2(r.amount), _href: `/accounting?tab=journals&j_q=${enc(r.number)}` })) };
    },
  },
  linked("ar-aging", "financial", { ar: "أعمار ديون العملاء", en: "Receivables aging" }, { ar: "الرصيد المفتوح لكل عميل حسب التأخير", en: "Each customer's open balance by days overdue" }, "/sales?tab=invoices&itab=aging", ["sales.invoices.view", "accounting.view"]),
  linked("ap-aging", "financial", { ar: "أعمار ديون الموردين", en: "Payables aging" }, { ar: "المستحق لكل مورد حسب التأخير", en: "What each supplier is owed by days overdue" }, "/purchasing?tab=bills&btab=payables", ["purchasing.bills.view", "accounting.view"]),
  linked("customer-statement", "financial", { ar: "كشف حساب عميل", en: "Customer statement" }, { ar: "من بطاقة العميل: الفواتير والتحصيلات والإشعارات الدائنة", en: "From the customer card: invoices, receipts and credit notes" }, "/sales", ["sales.invoices.view"]),
  linked("supplier-statement", "financial", { ar: "كشف حساب مورد", en: "Supplier statement" }, { ar: "من بطاقة المورد: الفواتير والسداد والمرتجعات", en: "From the supplier card: bills, payments and returns" }, "/purchasing?tab=bills&btab=payables", ["purchasing.bills.view"]),
  linked("bank-reconciliation", "financial", { ar: "تسوية البنك", en: "Bank reconciliation" }, { ar: "مطابقة كشف البنك مع الدفاتر", en: "Match the bank statement to the books" }, "/accounting?tab=reconcile", ["accounting.manage"]),
  linked("tax-summary", "financial", { ar: "ملخص الضرايب والإقرارات", en: "Tax summary and returns" }, { ar: "ضريبة القيمة المضافة المحصلة والمدفوعة والإقرارات", en: "VAT collected, paid, and the returns" }, "/accounting?tab=vat", FIN),
  linked("integrity", "financial", { ar: "سلامة الدفاتر وقفل الفترات", en: "Books integrity and period close" }, { ar: "مطابقة الأستاذ المساعد مع الأستاذ العام، وحالة الشهور", en: "Subledgers against the general ledger, and the months' status" }, "/accounting?tab=health", FIN),

  // ---------------------------------------------------------------- sales
  {
    key: "sales-by-period", category: "sales",
    title: { ar: "المبيعات حسب الفترة", en: "Sales by period" },
    description: { ar: "صافي المبيعات يوم بيوم أو أسبوع أو شهر أو سنة", en: "Net sales by day, week, month or year" },
    notes: { ar: "فواتير مصدرة ناقص الإشعارات الدائنة، قبل الضريبة، بتاريخ الإصدار.", en: "Issued invoices less credit notes, before tax, by issue date." },
    permissions: SALES, filters: ["period", "groupBy"],
    columns: [{ key: "period", label: { ar: "الفترة", en: "Period" }, type: "date" }, { key: "invoices", label: { ar: "فواتير", en: "Invoices" }, type: "number", total: true }, { key: "gross", label: { ar: "المبيعات", en: "Invoiced" }, type: "money", total: true }, { key: "credits", label: { ar: "الإشعارات الدائنة", en: "Credit notes" }, type: "money", total: true }, { key: "net", label: { ar: "صافي المبيعات", en: "Net sales" }, type: "money", total: true }, { key: "tax", label: { ar: "الضريبة", en: "Tax" }, type: "money", total: true }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ p: Date; n: bigint | null; net: Prisma.Decimal | null; tax: Prisma.Decimal | null; cn: Prisma.Decimal | null }[]>`
        WITH inv AS (SELECT date_trunc(${p.groupBy}, i."issueDate"::date) p, count(*) n, sum(i."net") net, sum(i."taxTotal") tax FROM "SalesInvoice" i WHERE i."status" = 'issued' AND i."issueDate" BETWEEN ${p.from} AND ${p.to} GROUP BY 1),
             cn AS (SELECT date_trunc(${p.groupBy}, c."issueDate"::date) p, sum(c."net") cn FROM "CreditNote" c WHERE c."issueDate" BETWEEN ${p.from} AND ${p.to} GROUP BY 1)
        SELECT coalesce(inv.p, cn.p) p, inv.n, inv.net, inv.tax, cn.cn FROM inv FULL JOIN cn ON cn.p = inv.p ORDER BY 1`;
      return { rows: rows.map((r) => ({ period: r.p.toISOString().slice(0, 10), invoices: Number(r.n ?? 0), gross: m2(r.net), credits: m2(r.cn), net: m2(D(r.net).minus(D(r.cn))), tax: m2(r.tax), _href: `/reports/sales-by-customer?${periodSpan(r.p.toISOString().slice(0, 10), p.groupBy, p)}` })) };
    },
  },
  {
    key: "sales-by-customer", category: "sales",
    title: { ar: "المبيعات والربح حسب العميل", en: "Sales and margin by customer" },
    description: { ar: "صافي المبيعات، التكلفة، ومجمل الربح لكل عميل", en: "Net sales, cost and gross margin per customer" },
    notes: { ar: "المبيعات من الفواتير (ناقص الإشعارات الدائنة) بتاريخ الإصدار؛ التكلفة من صرف أوردرات العميل في نفس الفترة بتاريخ الصرف — ممكن يختلفوا شوية على أطراف الفترة.", en: "Sales from invoices (less credit notes) by issue date; cost from the customer's order issues in the same period by issue date — the two can differ slightly at the period's edges." },
    permissions: SALES, filters: ["period"],
    columns: [...PARTY_COLS, { key: "code", label: { ar: "الكود", en: "Code" }, type: "code" }, { key: "net", label: { ar: "صافي المبيعات", en: "Net sales" }, type: "money", total: true }, { key: "cost", label: { ar: "التكلفة", en: "Cost" }, type: "money", total: true, cost: true }, { key: "margin", label: { ar: "مجمل الربح", en: "Gross margin" }, type: "money", total: true, cost: true }, { key: "margin_pct", label: { ar: "هامش %", en: "Margin %" }, type: "percent", cost: true }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string; nameAr: string | null; net: Prisma.Decimal | null; cost: Prisma.Decimal | null }[]>`
        SELECT c."id", c."code", c."name", c."nameAr",
          (SELECT coalesce(sum(i."net"), 0) FROM "SalesInvoice" i WHERE i."customerId" = c."id" AND i."status" = 'issued' AND i."issueDate" BETWEEN ${p.from} AND ${p.to})
            - (SELECT coalesce(sum(n."net"), 0) FROM "CreditNote" n WHERE n."customerId" = c."id" AND n."issueDate" BETWEEN ${p.from} AND ${p.to}) net,
          (SELECT -coalesce(sum(v."value"), 0) FROM "StockMovement" m JOIN "StockValuationLayer" v ON v."movementId" = m."id" JOIN "InventoryDocument" d ON d."id" = m."documentId" JOIN "Order" o ON o."id" = d."sourceId"
             WHERE d."sourceType" = 'order' AND o."customerAccountId" = c."id" AND m."kind" IN ('issue', 'customer_return') AND m."effectiveDate" BETWEEN ${p.from} AND ${p.to}) cost
        FROM "Customer" c ORDER BY 5 DESC NULLS LAST`;
      return { rows: rows.filter((r) => !D(r.net).isZero() || !D(r.cost).isZero()).map((r) => ({ ...name(r.nameAr, r.name), code: r.code, net: m2(r.net), cost: m2(r.cost), margin: m2(D(r.net).minus(D(r.cost))), margin_pct: pct(D(r.net).minus(D(r.cost)), r.net), _href: `/sales?customer=${r.id}` })) };
    },
  },
  {
    key: "sales-by-product", category: "sales",
    title: { ar: "المبيعات والربح حسب الصنف", en: "Sales and margin by product" },
    description: { ar: "الكمية والقيمة والتكلفة ومجمل الربح لكل صنف", en: "Quantity, value, cost and gross margin per product" },
    notes: { ar: "المبيعات من سطور الفواتير ناقص سطور الإشعارات الدائنة؛ التكلفة من دفتر المخزون في نفس الفترة.", en: "Sales from invoice lines less credit-note lines; cost from the stock ledger in the same period." },
    permissions: SALES, filters: ["period", "category"],
    columns: [...PARTY_COLS, { key: "category", label: { ar: "الفئة", en: "Category" }, type: "text" }, { key: "qty", label: { ar: "الكمية", en: "Quantity" }, type: "qty" }, { key: "net", label: { ar: "صافي المبيعات", en: "Net sales" }, type: "money", total: true }, { key: "cost", label: { ar: "التكلفة", en: "Cost" }, type: "money", total: true, cost: true }, { key: "margin", label: { ar: "مجمل الربح", en: "Gross margin" }, type: "money", total: true, cost: true }, { key: "margin_pct", label: { ar: "هامش %", en: "Margin %" }, type: "percent", cost: true }],
    run: async (p) => salesByProduct(p, false),
  },
  {
    key: "sales-by-category", category: "sales",
    title: { ar: "المبيعات حسب الفئة", en: "Sales by category" },
    description: { ar: "خضار، فاكهة، وغيرها: القيمة ومجمل الربح", en: "Vegetables, fruit and others: value and gross margin" },
    permissions: SALES, filters: ["period"],
    columns: [{ key: "category", label: { ar: "الفئة", en: "Category" }, type: "text" }, { key: "net", label: { ar: "صافي المبيعات", en: "Net sales" }, type: "money", total: true }, { key: "cost", label: { ar: "التكلفة", en: "Cost" }, type: "money", total: true, cost: true }, { key: "margin", label: { ar: "مجمل الربح", en: "Gross margin" }, type: "money", total: true, cost: true }, { key: "margin_pct", label: { ar: "هامش %", en: "Margin %" }, type: "percent", cost: true }],
    run: async (p) => salesByProduct(p, true),
  },
  {
    key: "sales-by-salesperson", category: "sales",
    title: { ar: "المبيعات حسب اللي سجّل الأوردر", en: "Sales by the person who entered the order" },
    description: { ar: "صافي فواتير الأوردرات اللي كل مستخدم سجّلها", en: "Net invoiced on the orders each user entered" },
    notes: { ar: "الأوردر مالوش حقل \"مندوب\": المستخدم هنا هو اللي سجّل الأوردر (من سجل المراجعة). أوردرات n8n بتظهر باسم النظام.", en: "Orders have no salesperson field: the user here is whoever entered the order (from the audit trail). n8n orders show as the system." },
    permissions: SALES, filters: ["period"],
    columns: [{ key: "user", label: { ar: "المستخدم", en: "User" }, type: "text" }, { key: "orders", label: { ar: "أوردرات", en: "Orders" }, type: "number", total: true }, { key: "net", label: { ar: "صافي الفواتير", en: "Net invoiced" }, type: "money", total: true }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ who: string | null; orders: bigint; net: Prisma.Decimal | null }[]>`
        SELECT coalesce(a."userName", 'n8n / النظام') who, count(DISTINCT i."orderId") orders, sum(i."net") net
        FROM "SalesInvoice" i LEFT JOIN LATERAL (SELECT x."userName" FROM "AuditLog" x WHERE x."orderId" = i."orderId" AND x."action" = 'order_created' ORDER BY x."timestamp" LIMIT 1) a ON true
        WHERE i."status" = 'issued' AND i."issueDate" BETWEEN ${p.from} AND ${p.to} GROUP BY 1 ORDER BY 3 DESC`;
      return { rows: rows.map((r) => ({ user: r.who ?? "", orders: Number(r.orders), net: m2(r.net) })) };
    },
  },
  {
    key: "price-exceptions", category: "sales",
    title: { ar: "الخصومات واستثناءات الأسعار", en: "Discounts and pricing exceptions" },
    description: { ar: "طلبات استثناء السعر (تحت التكلفة أو خصم أكبر من المسموح) وقراراتها", en: "Price-exception requests (below cost or above the discount limit) and their decisions" },
    permissions: SALES, filters: ["period"],
    columns: [{ key: "date", label: { ar: "التاريخ", en: "Date" }, type: "date" }, { key: "title", label: { ar: "الأوردر", en: "Order" }, type: "text" }, { key: "summary", label: { ar: "التفاصيل", en: "Detail" }, type: "text", cost: true }, { key: "status", label: { ar: "القرار", en: "Decision" }, type: "text" }, { key: "by", label: { ar: "طلبه", en: "Requested by" }, type: "text" }],
    run: async (p) => {
      const rows = await prisma.approvalRequest.findMany({ where: { type: "sales.price_exception", createdAt: businessDayRange(p.from, p.to) }, orderBy: { createdAt: "desc" }, take: 2000 });
      return { rows: rows.map((r) => ({ date: businessDate(r.createdAt), title: r.title, summary: r.summary ?? "", status: r.status, by: r.requestedBy ?? "", _href: `/orders/${r.entityId}` })) };
    },
  },
  {
    key: "credit-notes", category: "sales",
    title: { ar: "المرتجعات والإشعارات الدائنة", en: "Returns and credit notes" },
    description: { ar: "كل إشعار دائن: العميل، الفاتورة، السبب، والقيمة", en: "Every credit note: customer, invoice, reason and amount" },
    permissions: SALES, filters: ["period", "customer"],
    columns: [{ key: "date", label: { ar: "التاريخ", en: "Date" }, type: "date" }, { key: "number", label: { ar: "الإشعار", en: "Credit note" }, type: "code" }, ...PARTY_COLS, { key: "reason", label: { ar: "السبب", en: "Reason" }, type: "text" }, { key: "goods", label: { ar: "بضاعة رجعت", en: "Goods back" }, type: "text" }, { key: "net", label: { ar: "الصافي", en: "Net" }, type: "money", total: true }, { key: "total", label: { ar: "الإجمالي", en: "Total" }, type: "money", total: true }],
    run: async (p) => {
      const rows = await prisma.creditNote.findMany({ where: { issueDate: { gte: p.from, lte: p.to }, ...(p.customerId ? { customerId: p.customerId } : {}) }, include: { customer: { select: { id: true, name: true, nameAr: true } } }, orderBy: { issueDate: "desc" }, take: 5000 });
      return { rows: rows.map((r) => ({ date: r.issueDate, number: r.number, ...name(r.customer.nameAr, r.customer.name), reason: r.reason, goods: r.returnDocumentId ? "✓" : "", net: m2(r.net), total: m2(r.total), _href: `/sales?customer=${r.customer.id}` })) };
    },
  },
  {
    key: "outstanding-invoices", category: "sales",
    title: { ar: "الفواتير المفتوحة", en: "Outstanding customer invoices" },
    description: { ar: "كل فاتورة لسه عليها فلوس، بالتأخير", en: "Every invoice with money still due, with days overdue" },
    notes: { ar: "المتبقي = الإجمالي ناقص الإشعارات الدائنة والتحصيلات المخصصة (غير المعكوسة).", en: "Open = total less credit notes and allocated, unreversed receipts." },
    permissions: SALES, filters: ["customer"],
    columns: [{ key: "number", label: { ar: "الفاتورة", en: "Invoice" }, type: "code" }, ...PARTY_COLS, { key: "issued", label: { ar: "الإصدار", en: "Issued" }, type: "date" }, { key: "due", label: { ar: "الاستحقاق", en: "Due" }, type: "date" }, { key: "days", label: { ar: "أيام تأخير", en: "Days overdue" }, type: "number" }, { key: "total", label: { ar: "الإجمالي", en: "Total" }, type: "money", total: true }, { key: "open", label: { ar: "المتبقي", en: "Open" }, type: "money", total: true }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; number: string; cid: string; name: string; nameAr: string | null; issueDate: string; dueDate: string; total: Prisma.Decimal; paid: Prisma.Decimal; credited: Prisma.Decimal }[]>`
        SELECT i."id", i."number", c."id" cid, c."name", c."nameAr", i."issueDate", i."dueDate", i."total",
          coalesce((SELECT sum(a."amount") FROM "ReceiptAllocation" a JOIN "CustomerReceipt" r ON r."id" = a."receiptId" WHERE a."invoiceId" = i."id" AND NOT EXISTS (SELECT 1 FROM "CustomerReceiptReversal" x WHERE x."receiptId" = r."id")), 0) paid,
          coalesce((SELECT sum(n."total") FROM "CreditNote" n WHERE n."invoiceId" = i."id"), 0) credited
        FROM "SalesInvoice" i JOIN "Customer" c ON c."id" = i."customerId" WHERE i."status" = 'issued' AND (${p.customerId ?? null}::text IS NULL OR c."id" = ${p.customerId ?? null}) ORDER BY i."dueDate"`;
      const today = todayLocalISO();
      const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;
      return { rows: rows.map((r) => ({ open: D(r.total).minus(r.paid).minus(r.credited), r })).filter((x) => x.open.gt(0)).map(({ open, r }) => { const late = Math.max(0, Math.round(day(today) - day(r.dueDate))); return { number: r.number, ...name(r.nameAr, r.name), issued: r.issueDate, due: r.dueDate, days: late, total: m2(r.total), open: m2(open), _tone: late > 30 ? "danger" : late > 0 ? "warn" : null, _href: `/sales?customer=${r.cid}` }; }) };
    },
  },

  // ---------------------------------------------------------------- purchasing
  {
    key: "purchases-by-supplier", category: "purchasing",
    title: { ar: "المشتريات حسب المورد", en: "Purchases by supplier" },
    description: { ar: "فواتير الموردين المترحّلة ناقص الإشعارات المدينة", en: "Posted supplier bills less debit notes" },
    permissions: PURCH, filters: ["period"],
    columns: [...PARTY_COLS, { key: "code", label: { ar: "الكود", en: "Code" }, type: "code" }, { key: "bills", label: { ar: "فواتير", en: "Bills" }, type: "number", total: true }, { key: "net", label: { ar: "المشتريات", en: "Purchases" }, type: "money", total: true }, { key: "debits", label: { ar: "الإشعارات المدينة", en: "Debit notes" }, type: "money", total: true }, { key: "netnet", label: { ar: "الصافي", en: "Net" }, type: "money", total: true }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string; nameAr: string | null; bills: bigint; net: Prisma.Decimal | null; debits: Prisma.Decimal | null }[]>`
        SELECT s."id", s."code", s."name", s."nameAr",
          (SELECT count(*) FROM "SupplierBill" b WHERE b."supplierId" = s."id" AND b."status" = 'posted' AND b."billDate" BETWEEN ${p.from} AND ${p.to}) bills,
          (SELECT sum(b."net") FROM "SupplierBill" b WHERE b."supplierId" = s."id" AND b."status" = 'posted' AND b."billDate" BETWEEN ${p.from} AND ${p.to}) net,
          (SELECT sum(d."net") FROM "DebitNote" d WHERE d."supplierId" = s."id" AND d."issueDate" BETWEEN ${p.from} AND ${p.to}) debits
        FROM "Supplier" s ORDER BY 6 DESC NULLS LAST`;
      return { rows: rows.filter((r) => Number(r.bills) > 0 || !D(r.debits).isZero()).map((r) => ({ ...name(r.nameAr, r.name), code: r.code, bills: Number(r.bills), net: m2(r.net), debits: m2(r.debits), netnet: m2(D(r.net).minus(D(r.debits))), _href: `/purchasing?supplier=${r.id}` })) };
    },
  },
  {
    key: "purchases-by-product", category: "purchasing",
    title: { ar: "المشتريات حسب الصنف وأسعارها", en: "Purchases by product and price" },
    description: { ar: "الكمية والقيمة ومتوسط وأقل وأعلى سعر لكل صنف", en: "Quantity, value, and average/min/max price per product" },
    permissions: PURCH, filters: ["period", "category"],
    columns: [...PARTY_COLS, { key: "qty", label: { ar: "الكمية", en: "Quantity" }, type: "qty" }, { key: "net", label: { ar: "القيمة", en: "Value" }, type: "money", total: true }, { key: "avg", label: { ar: "متوسط السعر", en: "Average price" }, type: "money" }, { key: "min", label: { ar: "أقل سعر", en: "Lowest" }, type: "money" }, { key: "max", label: { ar: "أعلى سعر", en: "Highest" }, type: "money" }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; name: string; nameAr: string | null; qty: Prisma.Decimal; net: Prisma.Decimal; mn: Prisma.Decimal; mx: Prisma.Decimal }[]>`
        SELECT pr."id", pr."name", pr."nameAr", sum(l."quantity") qty, sum(l."net") net, min(l."unitPrice") mn, max(l."unitPrice") mx
        FROM "SupplierBillLine" l JOIN "SupplierBill" b ON b."id" = l."billId" JOIN "StockProduct" pr ON pr."id" = l."productId"
        WHERE b."status" = 'posted' AND NOT l."released" AND b."billDate" BETWEEN ${p.from} AND ${p.to} AND (${p.category ?? null}::text IS NULL OR pr."category" = ${p.category ?? null})
        GROUP BY pr."id", pr."name", pr."nameAr" ORDER BY 5 DESC`;
      return { rows: rows.map((r) => ({ ...name(r.nameAr, r.name), qty: q3(r.qty), net: m2(r.net), avg: D(r.qty).isZero() ? null : m2(D(r.net).div(D(r.qty))), min: m2(r.mn), max: m2(r.mx), _href: `/stock/inventory?product=${r.id}` })) };
    },
  },
  {
    key: "purchase-price-trend", category: "purchasing",
    title: { ar: "اتجاه أسعار الشراء", en: "Purchase price trend" },
    description: { ar: "متوسط سعر الشراء لكل صنف شهر بشهر (أو أسبوع)", en: "Average purchase price per product by month (or week)" },
    permissions: PURCH, filters: ["period", "product", "groupBy"],
    columns: [{ key: "period", label: { ar: "الفترة", en: "Period" }, type: "date" }, ...PARTY_COLS, { key: "qty", label: { ar: "الكمية", en: "Quantity" }, type: "qty" }, { key: "avg", label: { ar: "متوسط السعر", en: "Average price" }, type: "money" }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ per: Date; name: string; nameAr: string | null; qty: Prisma.Decimal; net: Prisma.Decimal }[]>`
        SELECT date_trunc(${p.groupBy}, b."billDate"::date) per, pr."name", pr."nameAr", sum(l."quantity") qty, sum(l."net") net
        FROM "SupplierBillLine" l JOIN "SupplierBill" b ON b."id" = l."billId" JOIN "StockProduct" pr ON pr."id" = l."productId"
        WHERE b."status" = 'posted' AND NOT l."released" AND b."billDate" BETWEEN ${p.from} AND ${p.to} AND (${p.productId ?? null}::text IS NULL OR pr."id" = ${p.productId ?? null})
        GROUP BY 1, pr."name", pr."nameAr" ORDER BY pr."name", 1`;
      return { rows: rows.map((r) => ({ period: r.per.toISOString().slice(0, 10), ...name(r.nameAr, r.name), qty: q3(r.qty), avg: D(r.qty).isZero() ? null : m2(D(r.net).div(D(r.qty))) })) };
    },
  },
  {
    key: "po-outstanding", category: "purchasing",
    title: { ar: "أوامر الشراء: المطلوب والمستلم", en: "Purchase orders: ordered vs received" },
    description: { ar: "لكل سطر أمر شراء: المطلوب، المستلم، والباقي", en: "Per purchase-order line: ordered, received and outstanding" },
    permissions: ["purchasing.orders.view"], filters: ["period", "supplier"],
    columns: [{ key: "number", label: { ar: "أمر الشراء", en: "PO" }, type: "code" }, ...SUPPLIER_COLS, ...PARTY_COLS, { key: "ordered", label: { ar: "المطلوب", en: "Ordered" }, type: "qty" }, { key: "received", label: { ar: "المستلم", en: "Received" }, type: "qty" }, { key: "outstanding", label: { ar: "الباقي", en: "Outstanding" }, type: "qty" }, { key: "fill", label: { ar: "نسبة الاستلام %", en: "Fill %" }, type: "percent" }, { key: "status", label: { ar: "الحالة", en: "Status" }, type: "text" }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; number: string; status: string; sname: string; snameAr: string | null; name: string; nameAr: string | null; ordered: Prisma.Decimal; received: Prisma.Decimal | null }[]>`
        SELECT o."id", o."number", o."status", s."name" sname, s."nameAr" "snameAr", pr."name", pr."nameAr", l."baseQuantity" ordered,
          (SELECT sum(i."goodQty" + i."gradeBQty" + i."wasteQty") FROM "StockIntake" i WHERE i."purchaseOrderLineId" = l."id" AND i."status" = 'posted') received
        FROM "PurchaseOrderLine" l JOIN "PurchaseOrder" o ON o."id" = l."poId" JOIN "Supplier" s ON s."id" = o."supplierId" JOIN "StockProduct" pr ON pr."id" = l."productId"
        WHERE o."orderDate" BETWEEN ${p.from} AND ${p.to} AND o."status" NOT IN ('cancelled', 'draft') AND (${p.supplierId ?? null}::text IS NULL OR s."id" = ${p.supplierId ?? null}) ORDER BY o."orderDate" DESC, o."number"`;
      return { rows: rows.map((r) => { const rec = D(r.received); const out = Prisma.Decimal.max(0, D(r.ordered).minus(rec)); return { _href: `/purchasing?po=${r.id}`, number: r.number, ...supplierName(r.snameAr, r.sname), ...name(r.nameAr, r.name), ordered: q3(r.ordered), received: q3(rec), outstanding: q3(out), fill: pct(rec, r.ordered), status: r.status, _tone: out.gt(0) ? "warn" : null }; }) };
    },
  },
  {
    key: "supplier-performance", category: "purchasing",
    title: { ar: "أداء الموردين", en: "Supplier performance" },
    description: { ar: "الكميات المستلمة ونِسب الفرزة والهالك والمرفوض لكل مورد", en: "Quantities received and grade-B, waste and rejected rates per supplier" },
    notes: { ar: "من الاستلامات المترحّلة بالكيلو. نسبة الهالك العالية = جودة أضعف أو نقل أسوأ.", en: "From posted receipts weighed in kilos. A high waste rate = weaker quality or worse transport." },
    permissions: [...PURCH, ...STOCK], filters: ["period"],
    columns: [...PARTY_COLS, { key: "receipts", label: { ar: "استلامات", en: "Receipts" }, type: "number", total: true }, { key: "received", label: { ar: "المستلم (كجم)", en: "Received (kg)" }, type: "qty", total: true }, { key: "gradeb_pct", label: { ar: "فرزة %", en: "Grade B %" }, type: "percent" }, { key: "waste_pct", label: { ar: "هالك %", en: "Waste %" }, type: "percent" }, { key: "rejected_pct", label: { ar: "مرفوض %", en: "Rejected %" }, type: "percent" }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; name: string; nameAr: string | null; n: bigint; rec: Prisma.Decimal; b: Prisma.Decimal; w: Prisma.Decimal; r: Prisma.Decimal }[]>`
        SELECT s."id", s."name", s."nameAr", count(*) n, sum(i."receivedQty") rec, sum(i."gradeBQty") b, sum(i."wasteQty") w, sum(i."rejectedQty") r
        FROM "StockIntake" i JOIN "Supplier" s ON s."id" = i."supplierId" JOIN "StockProduct" pr ON pr."id" = i."productId"
        WHERE i."status" = 'posted' AND pr."unit" = 'KG' AND i."receivedDate" BETWEEN ${p.from} AND ${p.to} GROUP BY s."id", s."name", s."nameAr" ORDER BY 5 DESC`;
      return { rows: rows.map((r) => { const w = pct(r.w, r.rec); return { _href: `/purchasing?supplier=${r.id}`, ...name(r.nameAr, r.name), receipts: Number(r.n), received: q3(r.rec), gradeb_pct: pct(r.b, r.rec), waste_pct: w, rejected_pct: pct(r.r, r.rec), _tone: (w ?? 0) > 5 ? "warn" : null }; }) };
    },
  },

  // ---------------------------------------------------------------- inventory
  {
    key: "stock-by-product", category: "inventory",
    title: { ar: "المخزون الحالي حسب الصنف", en: "Current stock by product" },
    description: { ar: "الموجود، المحجوز، المتاح للبيع، الهالك، والقيمة لكل صنف", en: "On hand, reserved, available to sell, waste and value per product" },
    notes: { ar: "الكمية من دفتر المخزون؛ القيمة من طبقات التقييم (تطابق حساب المخزون في الأستاذ). المتاح = المخزون القابل للبيع ناقص المحجوز. صنف موقوف أو غير متتبَّع لسه عليه مخزون أو قيمة بيظهر برضه، عشان الإجمالي يطابق.", en: "Quantities from the stock ledger; value from the valuation layers (agrees with the inventory account). Available = sellable stock less reservations. A deactivated or untracked product that still holds stock or value is listed too, so the total agrees." },
    permissions: STOCK, filters: ["category"],
    columns: [...PARTY_COLS, { key: "category", label: { ar: "الفئة", en: "Category" }, type: "text" }, { key: "unit", label: { ar: "الوحدة", en: "Unit" }, type: "code" }, { key: "sellable", label: { ar: "قابل للبيع", en: "Sellable" }, type: "qty" }, { key: "reserved", label: { ar: "محجوز", en: "Reserved" }, type: "qty" }, { key: "available", label: { ar: "متاح", en: "Available" }, type: "qty" }, { key: "held", label: { ar: "في الحجر", en: "Quarantine" }, type: "qty" }, { key: "waste", label: { ar: "هالك", en: "Waste" }, type: "qty" }, { key: "value", label: { ar: "القيمة", en: "Value" }, type: "money", total: true, cost: true }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; name: string; nameAr: string | null; category: string | null; unit: string; reorder: Prisma.Decimal | null; sellable: Prisma.Decimal; held: Prisma.Decimal; waste: Prisma.Decimal; reserved: Prisma.Decimal; value: Prisma.Decimal }[]>`
        SELECT pr."id", pr."name", pr."nameAr", pr."category", pr."unit", pr."reorderPointQty" reorder,
          coalesce(sum(m."quantity") FILTER (WHERE l."type" NOT IN ('waste', 'quarantine')), 0) sellable,
          coalesce(sum(m."quantity") FILTER (WHERE l."type" = 'quarantine'), 0) held,
          coalesce(sum(m."quantity") FILTER (WHERE l."type" = 'waste'), 0) waste,
          coalesce((SELECT sum(r."quantity") FROM "StockReservation" r WHERE r."productId" = pr."id" AND r."status" = 'active'), 0) reserved,
          coalesce((SELECT sum(v."value") FROM "StockValuationLayer" v WHERE v."productId" = pr."id"), 0) value
        FROM "StockProduct" pr LEFT JOIN "StockMovement" m ON m."productId" = pr."id" LEFT JOIN "StorageLocation" l ON l."id" = m."locationId"
        WHERE ((pr."active" AND pr."stockTracked") OR EXISTS (SELECT 1 FROM "StockValuationLayer" hv WHERE hv."productId" = pr."id" HAVING sum(hv."value") <> 0) OR EXISTS (SELECT 1 FROM "StockMovement" hm WHERE hm."productId" = pr."id" HAVING sum(hm."quantity") <> 0)) AND (${p.category ?? null}::text IS NULL OR pr."category" = ${p.category ?? null})
        GROUP BY pr."id", pr."name", pr."nameAr", pr."category", pr."unit", pr."reorderPointQty" ORDER BY pr."name"`;
      return {
        rows: rows.map((r) => { const avail = D(r.sellable).minus(D(r.reserved)); return { ...name(r.nameAr, r.name), category: r.category ?? "", unit: r.unit, sellable: q3(r.sellable), reserved: q3(r.reserved), available: q3(avail), held: q3(r.held), waste: q3(r.waste), value: m2(r.value), _tone: r.reorder != null && avail.lte(D(r.reorder)) ? "warn" : null, _href: `/stock/inventory?product=${r.id}` }; }),
        // Layers carry 4 decimals: the total is their exact sum rounded once, not the sum of rounded rows.
        totals: { value: m2(rows.reduce((t, r) => t.plus(D(r.value)), D(0))) },
      };
    },
  },
  {
    key: "stock-by-category", category: "inventory",
    title: { ar: "المخزون حسب الفئة", en: "Stock by category" },
    description: { ar: "عدد الأصناف وقيمة المخزون لكل فئة", en: "Number of products and stock value per category" },
    permissions: STOCK_VALUE, filters: [],
    columns: [{ key: "category", label: { ar: "الفئة", en: "Category" }, type: "text" }, { key: "products", label: { ar: "أصناف", en: "Products" }, type: "number", total: true }, { key: "value", label: { ar: "القيمة", en: "Value" }, type: "money", total: true }],
    run: async () => {
      const rows = await prisma.$queryRaw<{ category: string | null; n: bigint; value: Prisma.Decimal }[]>`
        SELECT pr."category", count(DISTINCT pr."id") n, coalesce(sum(v."value"), 0) value FROM "StockProduct" pr LEFT JOIN "StockValuationLayer" v ON v."productId" = pr."id"
        WHERE ((pr."active" AND pr."stockTracked") OR EXISTS (SELECT 1 FROM "StockValuationLayer" hv WHERE hv."productId" = pr."id" HAVING sum(hv."value") <> 0) OR EXISTS (SELECT 1 FROM "StockMovement" hm WHERE hm."productId" = pr."id" HAVING sum(hm."quantity") <> 0)) GROUP BY 1 ORDER BY 3 DESC`;
      return { rows: rows.map((r) => ({ category: r.category ?? "—", products: Number(r.n), value: m2(r.value), _href: r.category ? `/reports/stock-by-product?category=${enc(r.category)}` : null })), totals: { value: m2(rows.reduce((t, r) => t.plus(D(r.value)), D(0))) } };
    },
  },
  {
    key: "stock-by-lot", category: "inventory",
    title: { ar: "المخزون حسب اللوت والمكان", en: "Stock by lot and location" },
    description: { ar: "كل دفعة في كل مكان: الكمية وتاريخ الاستلام والصلاحية", en: "Each lot in each location: quantity, received and expiry dates" },
    permissions: STOCK, filters: ["product", "category"],
    columns: [...PARTY_COLS, { key: "lot", label: { ar: "اللوت", en: "Lot" }, type: "code" }, { key: "location", label: { ar: "المكان", en: "Location" }, type: "code" }, { key: "received", label: { ar: "اتستلم", en: "Received" }, type: "date" }, { key: "expiry", label: { ar: "الصلاحية", en: "Expiry" }, type: "date" }, { key: "qty", label: { ar: "الكمية", en: "Quantity" }, type: "qty" }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; name: string; nameAr: string | null; lot: string | null; loc: string; received: string | null; expiry: string | null; qty: Prisma.Decimal }[]>`
        SELECT pr."id", pr."name", pr."nameAr", lt."lotNumber" lot, l."code" loc, lt."receivedDate" received, lt."expiryDate" expiry, sum(m."quantity") qty
        FROM "StockMovement" m JOIN "StockProduct" pr ON pr."id" = m."productId" JOIN "StorageLocation" l ON l."id" = m."locationId" LEFT JOIN "StockLot" lt ON lt."id" = m."lotId"
        WHERE (${p.productId ?? null}::text IS NULL OR pr."id" = ${p.productId ?? null}) AND (${p.category ?? null}::text IS NULL OR pr."category" = ${p.category ?? null})
        GROUP BY pr."id", pr."name", pr."nameAr", lt."lotNumber", l."code", lt."receivedDate", lt."expiryDate" HAVING sum(m."quantity") <> 0 ORDER BY pr."name", lt."expiryDate" NULLS LAST`;
      const today = todayLocalISO();
      return { rows: rows.map((r) => ({ ...name(r.nameAr, r.name), lot: r.lot ?? "—", location: r.loc, received: r.received, expiry: r.expiry, qty: q3(r.qty), _tone: r.expiry && r.expiry < today ? "danger" : null, _href: `/stock/inventory?product=${r.id}` })) };
    },
  },
  linked("stock-movements", "inventory", { ar: "سجل حركات المخزون", en: "Stock movement history" }, { ar: "كل حركة دخول وخروج وتحويل لكل صنف", en: "Every in, out and transfer per product" }, "/stock/ledger", STOCK),
  linked("inventory-valuation", "inventory", { ar: "تقييم المخزون حسب طريقة التكلفة", en: "Inventory valuation by costing method" }, { ar: "الكمية والقيمة ومتوسط التكلفة لكل صنف", en: "Quantity, value and average cost per product" }, "/stock/inventory?tab=valuation", STOCK_VALUE),
  {
    key: "stock-aging", category: "inventory",
    title: { ar: "عمر المخزون", en: "Stock aging" },
    description: { ar: "الموجود حسب عدد الأيام من الاستلام — المنتجات الطازجة بتقل قيمتها مع الوقت", en: "Stock by days since receipt — fresh produce loses value with time" },
    permissions: STOCK, filters: ["category"],
    columns: [...PARTY_COLS, { key: "d0_2", label: { ar: "0–2 يوم", en: "0–2 days" }, type: "qty" }, { key: "d3_5", label: { ar: "3–5 أيام", en: "3–5 days" }, type: "qty" }, { key: "d6_10", label: { ar: "6–10 أيام", en: "6–10 days" }, type: "qty" }, { key: "d11", label: { ar: "أكتر من 10", en: "Over 10 days" }, type: "qty" }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; name: string; nameAr: string | null; age: number | null; qty: Prisma.Decimal }[]>`
        SELECT pr."id", pr."name", pr."nameAr", (${todayLocalISO()}::date - lt."receivedDate"::date) age, sum(m."quantity") qty
        FROM "StockMovement" m JOIN "StockProduct" pr ON pr."id" = m."productId" JOIN "StorageLocation" l ON l."id" = m."locationId" LEFT JOIN "StockLot" lt ON lt."id" = m."lotId"
        WHERE l."type" NOT IN ('waste') AND (${p.category ?? null}::text IS NULL OR pr."category" = ${p.category ?? null})
        GROUP BY pr."id", pr."name", pr."nameAr", 4 HAVING sum(m."quantity") > 0`;
      const by = new Map<string, ReportRow>();
      for (const r of rows) {
        const row = by.get(r.id) ?? { ...name(r.nameAr, r.name), d0_2: 0, d3_5: 0, d6_10: 0, d11: 0, _href: `/stock/inventory?product=${r.id}` };
        const k = r.age == null || r.age > 10 ? "d11" : r.age <= 2 ? "d0_2" : r.age <= 5 ? "d3_5" : "d6_10";
        row[k] = Number(((row[k] as number) + q3(r.qty)).toFixed(3));
        if (k === "d11") row._tone = "warn";
        by.set(r.id, row);
      }
      return { rows: [...by.values()] };
    },
  },
  {
    key: "goods-received", category: "inventory",
    title: { ar: "البضاعة المستلمة والفرز", en: "Goods received and grading" },
    description: { ar: "كل استلام: المستلم، السليم، الفرزة، الهالك، المرفوض، والتكلفة", en: "Every receipt: received, good, grade B, waste, rejected and cost" },
    permissions: STOCK, filters: ["period", "supplier", "product"],
    columns: [{ key: "date", label: { ar: "التاريخ", en: "Date" }, type: "date" }, { key: "number", label: { ar: "الاستلام", en: "Receipt" }, type: "code" }, ...SUPPLIER_COLS, ...PARTY_COLS, { key: "received", label: { ar: "المستلم", en: "Received" }, type: "qty", total: true }, { key: "good", label: { ar: "سليم", en: "Good" }, type: "qty", total: true }, { key: "gradeb", label: { ar: "فرزة", en: "Grade B" }, type: "qty", total: true }, { key: "waste", label: { ar: "هالك", en: "Waste" }, type: "qty", total: true }, { key: "rejected", label: { ar: "مرفوض", en: "Rejected" }, type: "qty", total: true }, { key: "unit_cost", label: { ar: "سعر الكيلو", en: "Unit cost" }, type: "money", cost: true }],
    run: async (p) => {
      const rows = await prisma.stockIntake.findMany({ where: { status: "posted", receivedDate: { gte: p.from, lte: p.to }, ...(p.supplierId ? { supplierId: p.supplierId } : {}), ...(p.productId ? { productId: p.productId } : {}) }, include: { supplier: { select: { name: true, nameAr: true } }, product: { select: { name: true, nameAr: true } } }, orderBy: [{ receivedDate: "desc" }, { createdAt: "desc" }], take: 5000 });
      return { rows: rows.map((r) => ({ date: r.receivedDate, number: r.receiptNumber, ...supplierName(r.supplier?.nameAr, r.supplier?.name), ...name(r.product.nameAr, r.product.name), received: q3(r.receivedQty), good: q3(r.goodQty), gradeb: q3(r.gradeBQty), waste: q3(r.wasteQty), rejected: q3(r.rejectedQty), unit_cost: r.unitCost == null ? null : D(r.unitCost).toFixed(2), _href: `/stock/entries?in_q=${enc(r.receiptNumber)}` })) };
    },
  },
  {
    key: "waste-trend", category: "inventory",
    title: { ar: "اتجاه الهالك والفرزة", en: "Waste and grade-B trend" },
    description: { ar: "نِسب السليم والفرزة والهالك أسبوع بأسبوع، وقيمة الهالك", en: "Good, grade-B and waste rates by week, and the waste value" },
    notes: { ar: "من الاستلامات بالكيلو. القيمة = هالك × تكلفة الاستلام.", en: "From receipts weighed in kilos. Value = waste × receipt cost." },
    permissions: STOCK, filters: ["period", "groupBy"],
    columns: [{ key: "period", label: { ar: "الفترة", en: "Period" }, type: "date" }, { key: "received", label: { ar: "المستلم", en: "Received" }, type: "qty", total: true }, { key: "good_pct", label: { ar: "سليم %", en: "Good %" }, type: "percent" }, { key: "gradeb_pct", label: { ar: "فرزة %", en: "Grade B %" }, type: "percent" }, { key: "waste_pct", label: { ar: "هالك %", en: "Waste %" }, type: "percent" }, { key: "waste_value", label: { ar: "قيمة الهالك", en: "Waste value" }, type: "money", total: true, cost: true }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ per: Date; rec: Prisma.Decimal; g: Prisma.Decimal; b: Prisma.Decimal; w: Prisma.Decimal; wv: Prisma.Decimal | null }[]>`
        SELECT date_trunc(${p.groupBy}, i."receivedDate"::date) per, sum(i."receivedQty") rec, sum(i."goodQty") g, sum(i."gradeBQty") b, sum(i."wasteQty") w, sum(i."wasteQty" * i."unitCost") wv
        FROM "StockIntake" i JOIN "StockProduct" pr ON pr."id" = i."productId" WHERE i."status" = 'posted' AND pr."unit" = 'KG' AND i."receivedDate" BETWEEN ${p.from} AND ${p.to} GROUP BY 1 ORDER BY 1`;
      return { rows: rows.map((r) => ({ period: r.per.toISOString().slice(0, 10), received: q3(r.rec), good_pct: pct(r.g, r.rec), gradeb_pct: pct(r.b, r.rec), waste_pct: pct(r.w, r.rec), waste_value: m2(r.wv), _href: `/reports/goods-received?${periodSpan(r.per.toISOString().slice(0, 10), p.groupBy, p)}` })) };
    },
  },
  {
    key: "adjustments", category: "inventory",
    title: { ar: "التسويات والإعدام", en: "Inventory adjustments and write-offs" },
    description: { ar: "كل تسوية وإعدام: الصنف، الكمية، القيمة، والسبب", en: "Every adjustment and write-off: product, quantity, value and reason" },
    permissions: STOCK_VALUE, filters: ["period", "product"],
    columns: [{ key: "date", label: { ar: "التاريخ", en: "Date" }, type: "date" }, { key: "number", label: { ar: "المستند", en: "Document" }, type: "code" }, { key: "kind", label: { ar: "النوع", en: "Kind" }, type: "text" }, ...PARTY_COLS, { key: "qty", label: { ar: "الكمية", en: "Quantity" }, type: "qty" }, { key: "value", label: { ar: "القيمة", en: "Value" }, type: "money", total: true }, { key: "reason", label: { ar: "السبب", en: "Reason" }, type: "text" }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ date: string; doc: string | null; number: string | null; kind: string; name: string; nameAr: string | null; qty: Prisma.Decimal; value: Prisma.Decimal | null; reason: string | null }[]>`
        SELECT m."effectiveDate" date, d."id" doc, d."number", m."kind", pr."name", pr."nameAr", m."quantity" qty, v."value", coalesce(m."reason", d."reason") reason
        FROM "StockMovement" m JOIN "StockProduct" pr ON pr."id" = m."productId" LEFT JOIN "InventoryDocument" d ON d."id" = m."documentId" LEFT JOIN "StockValuationLayer" v ON v."movementId" = m."id"
        WHERE m."kind" IN ('adjustment', 'scrap') AND m."effectiveDate" BETWEEN ${p.from} AND ${p.to} AND (${p.productId ?? null}::text IS NULL OR pr."id" = ${p.productId ?? null}) ORDER BY m."effectiveDate" DESC`;
      return { rows: rows.map((r) => ({ _href: r.doc ? `/stock/inventory?tab=documents&doc=${r.doc}` : null, date: r.date, number: r.number ?? "", kind: r.kind === "scrap" ? "إعدام" : "تسوية", ...name(r.nameAr, r.name), qty: q3(r.qty), value: m2(r.value), reason: r.reason ?? "" })) };
    },
  },
  {
    key: "expiry", category: "inventory",
    title: { ar: "المنتهي والقريب من الانتهاء", en: "Expired and near-expiry stock" },
    description: { ar: "الدفعات اللي صلاحيتها خلصت أو هتخلص خلال عدد الأيام المختار", en: "Lots expired or expiring within the chosen number of days" },
    permissions: STOCK, filters: ["days", "category"],
    columns: [...PARTY_COLS, { key: "lot", label: { ar: "اللوت", en: "Lot" }, type: "code" }, { key: "expiry", label: { ar: "الصلاحية", en: "Expiry" }, type: "date" }, { key: "days_left", label: { ar: "أيام باقية", en: "Days left" }, type: "number" }, { key: "qty", label: { ar: "الكمية", en: "Quantity" }, type: "qty" }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; name: string; nameAr: string | null; lot: string; expiry: string; left: number; qty: Prisma.Decimal }[]>`
        SELECT pr."id", pr."name", pr."nameAr", lt."lotNumber" lot, lt."expiryDate" expiry, (lt."expiryDate"::date - ${todayLocalISO()}::date) "left", sum(m."quantity") qty
        FROM "StockMovement" m JOIN "StockLot" lt ON lt."id" = m."lotId" JOIN "StockProduct" pr ON pr."id" = m."productId" JOIN "StorageLocation" l ON l."id" = m."locationId"
        WHERE lt."expiryDate" IS NOT NULL AND l."type" <> 'waste' AND lt."expiryDate"::date <= ${todayLocalISO()}::date + ${p.days}::int AND (${p.category ?? null}::text IS NULL OR pr."category" = ${p.category ?? null})
        GROUP BY pr."id", pr."name", pr."nameAr", lt."lotNumber", lt."expiryDate" HAVING sum(m."quantity") > 0 ORDER BY lt."expiryDate"`;
      return { rows: rows.map((r) => ({ ...name(r.nameAr, r.name), lot: r.lot, expiry: r.expiry, days_left: r.left, qty: q3(r.qty), _tone: r.left < 0 ? "danger" : "warn", _href: `/stock/inventory?product=${r.id}` })) };
    },
  },
  {
    key: "low-stock", category: "inventory",
    title: { ar: "أصناف تحت حد إعادة الطلب", en: "Low stock and reorder" },
    description: { ar: "الأصناف اللي المتاح منها وصل لحد إعادة الطلب أو أقل", en: "Products whose available stock is at or below their reorder point" },
    permissions: STOCK, filters: ["category"],
    columns: [...PARTY_COLS, { key: "available", label: { ar: "المتاح", en: "Available" }, type: "qty" }, { key: "reorder", label: { ar: "حد إعادة الطلب", en: "Reorder point" }, type: "qty" }, { key: "max", label: { ar: "الحد الأقصى", en: "Maximum" }, type: "qty" }, { key: "suggest", label: { ar: "مقترح للطلب", en: "Suggested order" }, type: "qty" }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; name: string; nameAr: string | null; reorder: Prisma.Decimal; max: Prisma.Decimal | null; sellable: Prisma.Decimal; reserved: Prisma.Decimal }[]>`
        SELECT pr."id", pr."name", pr."nameAr", pr."reorderPointQty" reorder, pr."maxStockQty" max,
          coalesce((SELECT sum(m."quantity") FROM "StockMovement" m JOIN "StorageLocation" l ON l."id" = m."locationId" WHERE m."productId" = pr."id" AND l."type" NOT IN ('waste', 'quarantine')), 0) sellable,
          coalesce((SELECT sum(r."quantity") FROM "StockReservation" r WHERE r."productId" = pr."id" AND r."status" = 'active'), 0) reserved
        FROM "StockProduct" pr WHERE pr."active" AND pr."reorderPointQty" IS NOT NULL AND (${p.category ?? null}::text IS NULL OR pr."category" = ${p.category ?? null})`;
      return { rows: rows.map((r) => ({ r, avail: D(r.sellable).minus(D(r.reserved)) })).filter((x) => x.avail.lte(D(x.r.reorder))).map(({ r, avail }) => ({ ...name(r.nameAr, r.name), available: q3(avail), reorder: q3(r.reorder), max: r.max == null ? null : q3(r.max), suggest: r.max == null ? null : q3(Prisma.Decimal.max(0, D(r.max).minus(avail))), _tone: avail.lte(0) ? "danger" : "warn", _href: `/stock/inventory?product=${r.id}` })) };
    },
  },
  {
    key: "reservations", category: "inventory",
    title: { ar: "الحجوزات والمتاح", en: "Reservations and availability" },
    description: { ar: "كل حجز نشط: الصنف، الكمية، والمستند اللي حاجزه", en: "Every active reservation: product, quantity and the document holding it" },
    permissions: STOCK, filters: ["product"],
    columns: [...PARTY_COLS, { key: "qty", label: { ar: "الكمية", en: "Quantity" }, type: "qty", total: true }, { key: "source", label: { ar: "المصدر", en: "Source" }, type: "text" }, { key: "since", label: { ar: "من", en: "Since" }, type: "date" }, { key: "by", label: { ar: "بواسطة", en: "By" }, type: "text" }],
    run: async (p) => {
      const rows = await prisma.stockReservation.findMany({ where: { status: "active", ...(p.productId ? { productId: p.productId } : {}) }, include: { product: { select: { name: true, nameAr: true } } }, orderBy: { createdAt: "desc" }, take: 5000 });
      return { rows: rows.map((r) => ({ ...name(r.product.nameAr, r.product.name), qty: q3(r.quantity), source: r.sourceType, since: businessDate(r.createdAt), by: r.createdBy ?? "", _href: r.sourceType === "order" ? `/orders/${r.sourceId}` : null })) };
    },
  },
  linked("inventory-reconciliation", "inventory", { ar: "مطابقة المخزون مع الحسابات", en: "Inventory reconciliation" }, { ar: "قيمة المخزون = حساب المخزون في الأستاذ", en: "Stock value = the inventory account" }, "/accounting?tab=health", FIN),

  // ---------------------------------------------------------------- operations
  {
    key: "order-lifecycle", category: "operations",
    title: { ar: "دورة الأوردرات والتسليم", en: "Order lifecycle and fulfilment" },
    description: { ar: "الأوردرات حسب الحالة، والوقت من التسجيل للخروج", en: "Orders by status, and the time from entry to dispatch" },
    notes: { ar: "الوقت = من تسجيل الأوردر لحد مستند الصرف (خروج البضاعة).", en: "Time = from order entry to its stock issue (goods leaving)." },
    permissions: OPS, filters: ["period"],
    columns: [{ key: "status", label: { ar: "الحالة", en: "Status" }, type: "text" }, { key: "orders", label: { ar: "أوردرات", en: "Orders" }, type: "number", total: true }, { key: "avg_hours", label: { ar: "متوسط الساعات للخروج", en: "Average hours to dispatch" }, type: "number" }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ status: string; n: bigint; hrs: number | null }[]>`
        SELECT o."status", count(*) n, avg(EXTRACT(EPOCH FROM (d."createdAt" - o."createdAt")) / 3600) hrs
        FROM "Order" o LEFT JOIN LATERAL (SELECT x."createdAt" FROM "InventoryDocument" x WHERE x."type" = 'issue' AND x."sourceType" = 'order' AND x."sourceId" = o."id" AND x."status" = 'posted' ORDER BY x."createdAt" LIMIT 1) d ON true
        WHERE o."deliveryDate" BETWEEN ${p.from} AND ${p.to} GROUP BY 1 ORDER BY 2 DESC`;
      return { rows: rows.map((r) => ({ status: r.status, orders: Number(r.n), avg_hours: r.hrs == null ? null : Number(Number(r.hrs).toFixed(1)) })) };
    },
  },
  {
    key: "delayed-orders", category: "operations",
    title: { ar: "الأوردرات المتأخرة", en: "Delayed orders" },
    description: { ar: "أوردرات مفتوحة فات معاد تسليمها، أو خرجت بعد معادها", en: "Open orders past their delivery date, or dispatched after it" },
    permissions: OPS, filters: ["period"],
    columns: [{ key: "number", label: { ar: "الأوردر", en: "Order" }, type: "code" }, { key: "customer", label: { ar: "العميل", en: "Customer" }, type: "text" }, { key: "delivery", label: { ar: "معاد التسليم", en: "Delivery date" }, type: "date" }, { key: "status", label: { ar: "الحالة", en: "Status" }, type: "text" }, { key: "dispatched", label: { ar: "خرج يوم", en: "Dispatched" }, type: "date" }, { key: "days_late", label: { ar: "أيام تأخير", en: "Days late" }, type: "number" }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ id: string; orderNumber: string; customerName: string; deliveryDate: string; status: string; issued: string | null }[]>`
        SELECT o."id", o."orderNumber", o."customerName", o."deliveryDate", o."status",
          (SELECT min(x."businessDate") FROM "InventoryDocument" x WHERE x."type" = 'issue' AND x."sourceType" = 'order' AND x."sourceId" = o."id" AND x."status" = 'posted') issued
        FROM "Order" o WHERE o."deliveryDate" BETWEEN ${p.from} AND ${p.to} AND o."status" <> 'cancelled'`;
      const today = todayLocalISO();
      const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;
      return { rows: rows.map((r) => ({ r, late: r.issued ? day(r.issued) - day(r.deliveryDate) : r.status !== "dispatched" ? day(today) - day(r.deliveryDate) : 0 })).filter((x) => x.late > 0).sort((a, b) => b.late - a.late).map(({ r, late }) => ({ number: r.orderNumber, customer: r.customerName, delivery: r.deliveryDate, status: r.status, dispatched: r.issued, days_late: late, _tone: r.issued ? "warn" : "danger", _href: `/orders/${r.id}` })) };
    },
  },
  {
    key: "shortages", category: "operations",
    title: { ar: "نواقص التجهيز والتحميل", en: "Order shortages" },
    description: { ar: "الأوردرات اللي اتجهزت أو اتحملت ناقص وطلبت موافقة المشرف", en: "Orders prepared or loaded short that needed a supervisor's approval" },
    permissions: OPS, filters: ["period"],
    columns: [{ key: "date", label: { ar: "التاريخ", en: "Date" }, type: "date" }, { key: "title", label: { ar: "الأوردر", en: "Order" }, type: "text" }, { key: "summary", label: { ar: "أكبر فرق", en: "Largest shortfall" }, type: "text" }, { key: "status", label: { ar: "القرار", en: "Decision" }, type: "text" }],
    run: async (p) => {
      const rows = await prisma.approvalRequest.findMany({ where: { type: "orders.shortage", createdAt: businessDayRange(p.from, p.to) }, orderBy: { createdAt: "desc" }, take: 2000 });
      return { rows: rows.map((r) => ({ date: businessDate(r.createdAt), title: r.title, summary: r.summary ?? "", status: r.status, _href: `/orders/${r.entityId}` })) };
    },
  },
  {
    key: "floor-activity", category: "operations",
    title: { ar: "نشاط التجهيز والتحميل حسب الموظف", en: "Preparation and loading activity by employee" },
    description: { ar: "عدد السطور اللي كل موظف جهّزها أو حمّلها", en: "Lines each employee prepared or loaded" },
    notes: { ar: "من سجل المراجعة (كل تسجيل كمية). بيقيس الحجم، مش الجودة.", en: "From the audit trail (every quantity recorded). It measures volume, not quality." },
    permissions: ["reports.view", "audit.view"], filters: ["period"],
    columns: [{ key: "user", label: { ar: "الموظف", en: "Employee" }, type: "text" }, { key: "prepared", label: { ar: "سطور اتجهزت", en: "Lines prepared" }, type: "number", total: true }, { key: "loaded", label: { ar: "سطور اتحملت", en: "Lines loaded" }, type: "number", total: true }],
    run: async (p) => {
      const days = businessDayRange(p.from, p.to);
      const rows = await prisma.$queryRaw<{ who: string; prepared: bigint; loaded: bigint }[]>`
        SELECT "userName" who, count(*) FILTER (WHERE "action" = 'item_marked_prepared') prepared, count(*) FILTER (WHERE "action" = 'item_marked_loaded') loaded
        FROM "AuditLog" WHERE "action" IN ('item_marked_prepared', 'item_marked_loaded') AND "timestamp" >= ${days.gte} AND "timestamp" < ${days.lt} GROUP BY 1 ORDER BY 2 DESC`;
      return { rows: rows.map((r) => ({ user: r.who, prepared: Number(r.prepared), loaded: Number(r.loaded) })) };
    },
  },
  {
    key: "dispatch-activity", category: "operations",
    title: { ar: "التوزيع والخروج", en: "Dispatch activity" },
    description: { ar: "الأوردرات اللي خرجت كل يوم، بعدد البرانيك", en: "Orders dispatched each day, with crate counts" },
    permissions: OPS, filters: ["period"],
    columns: [{ key: "date", label: { ar: "اليوم", en: "Day" }, type: "date" }, { key: "orders", label: { ar: "أوردرات خرجت", en: "Orders dispatched" }, type: "number", total: true }, { key: "crates", label: { ar: "برانيك", en: "Crates" }, type: "number", total: true }],
    run: async (p) => {
      const rows = await prisma.$queryRaw<{ day: string; n: bigint; crates: bigint | null }[]>`
        SELECT x."businessDate" AS "day", count(DISTINCT x."sourceId") n, sum(o."crateCount") crates FROM "InventoryDocument" x JOIN "Order" o ON o."id" = x."sourceId"
        WHERE x."type" = 'issue' AND x."sourceType" = 'order' AND x."status" = 'posted' AND x."businessDate" BETWEEN ${p.from} AND ${p.to} GROUP BY 1 ORDER BY 1`;
      return { rows: rows.map((r) => ({ date: r.day, orders: Number(r.n), crates: Number(r.crates ?? 0), _href: `/reports/order-lifecycle?from=${r.day}&to=${r.day}` })) };
    },
  },
  {
    key: "exceptions", category: "operations",
    title: { ar: "المرتجعات والاستثناءات التشغيلية", en: "Returns and operational exceptions" },
    description: { ar: "استثناءات صرف المخزون ومرتجعات العملاء في الفترة", en: "Stock-issue exceptions and customer returns in the period" },
    permissions: [...OPS, ...STOCK], filters: ["period"],
    columns: [{ key: "date", label: { ar: "التاريخ", en: "Date" }, type: "date" }, { key: "kind", label: { ar: "النوع", en: "Kind" }, type: "text" }, { key: "reference", label: { ar: "المرجع", en: "Reference" }, type: "code" }, { key: "detail", label: { ar: "التفاصيل", en: "Detail" }, type: "text" }, { key: "status", label: { ar: "الحالة", en: "Status" }, type: "text" }],
    run: async (p) => {
      const [ex, ret] = await Promise.all([
        prisma.stockIssueException.findMany({ where: { createdAt: businessDayRange(p.from, p.to) }, include: { order: { select: { id: true, orderNumber: true } } }, take: 2000 }),
        prisma.inventoryDocument.findMany({ where: { type: "customer_return", businessDate: { gte: p.from, lte: p.to } }, take: 2000 }),
      ]);
      const rows: ReportRow[] = [
        ...ex.map((e) => ({ date: businessDate(e.createdAt), kind: "استثناء صرف", reference: e.order?.orderNumber ?? "", detail: e.reason, status: e.status, _href: e.order ? `/orders/${e.order.id}` : null, _tone: e.status === "open" ? ("warn" as const) : null })),
        ...ret.map((d) => ({ date: d.businessDate, kind: "مرتجع عميل", reference: d.number, detail: d.reason ?? "", status: d.status })),
      ];
      return { rows: rows.sort((a, b) => String(b.date).localeCompare(String(a.date))) };
    },
  },
];

async function salesByProduct(p: ReportParams, byCategory: boolean): Promise<ReportResult> {
  const rows = await prisma.$queryRaw<{ id: string; name: string; nameAr: string | null; category: string | null; qty: Prisma.Decimal | null; net: Prisma.Decimal | null; cost: Prisma.Decimal | null }[]>`
    SELECT pr."id", pr."name", pr."nameAr", pr."category",
      (SELECT sum(l."quantity") FROM "SalesInvoiceLine" l JOIN "SalesInvoice" i ON i."id" = l."invoiceId" WHERE l."productId" = pr."id" AND i."status" = 'issued' AND i."issueDate" BETWEEN ${p.from} AND ${p.to}) qty,
      coalesce((SELECT sum(l."net") FROM "SalesInvoiceLine" l JOIN "SalesInvoice" i ON i."id" = l."invoiceId" WHERE l."productId" = pr."id" AND i."status" = 'issued' AND i."issueDate" BETWEEN ${p.from} AND ${p.to}), 0)
        - coalesce((SELECT sum(cl."net") FROM "CreditNoteLine" cl JOIN "CreditNote" c ON c."id" = cl."creditNoteId" JOIN "SalesInvoiceLine" l ON l."id" = cl."invoiceLineId" WHERE l."productId" = pr."id" AND c."issueDate" BETWEEN ${p.from} AND ${p.to}), 0) net,
      (SELECT -sum(v."value") FROM "StockMovement" m JOIN "StockValuationLayer" v ON v."movementId" = m."id" WHERE m."productId" = pr."id" AND m."kind" IN ('issue', 'customer_return') AND m."effectiveDate" BETWEEN ${p.from} AND ${p.to}) cost
    FROM "StockProduct" pr WHERE (${p.category ?? null}::text IS NULL OR pr."category" = ${p.category ?? null})`;
  const active = rows.filter((r) => !D(r.net).isZero() || !D(r.cost).isZero());
  if (!byCategory) {
    return { rows: active.sort((a, b) => D(b.net).comparedTo(D(a.net))).map((r) => ({ ...name(r.nameAr, r.name), category: r.category ?? "", qty: q3(r.qty), net: m2(r.net), cost: m2(r.cost), margin: m2(D(r.net).minus(D(r.cost))), margin_pct: pct(D(r.net).minus(D(r.cost)), r.net), _href: `/stock/inventory?product=${r.id}` })) };
  }
  const by = new Map<string, { net: Prisma.Decimal; cost: Prisma.Decimal }>();
  for (const r of active) { const k = r.category ?? "—"; const g = by.get(k) ?? { net: D(0), cost: D(0) }; g.net = g.net.plus(D(r.net)); g.cost = g.cost.plus(D(r.cost)); by.set(k, g); }
  return { rows: [...by.entries()].sort((a, b) => b[1].net.comparedTo(a[1].net)).map(([category, g]) => ({ _href: category === "—" ? null : `/reports/sales-by-product?from=${p.from}&to=${p.to}&category=${enc(category)}`, category, net: m2(g.net), cost: m2(g.cost), margin: m2(g.net.minus(g.cost)), margin_pct: pct(g.net.minus(g.cost), g.net) })) };
}

export function reportByKey(key: string) {
  return REPORTS.find((r) => r.key === key) ?? null;
}
