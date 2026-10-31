import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { isValidISODate } from "@/lib/dates";
import { todayLocalISO } from "@/lib/localDate";
import { profitLoss } from "@/lib/accounting/ledger";
import { valuationReport } from "@/lib/inventory/reports";
import { agingReport } from "@/lib/sales/invoicing";
import { apAgingReport } from "@/lib/purchasing/bills";
import { cashPosition } from "@/lib/accounting/cash";
import { getSetting } from "@/lib/core/settings-service";

/**
 * Management reporting — read-only queries over the sources of truth (invoices, the
 * stock ledger and its valuation layers, the journal, orders, trips, exceptions,
 * audit). Nothing here is stored; every figure can be traced to the documents.
 *
 * Gross margin uses the cost of what was actually issued (valuation layers of issues
 * and customer returns), not an estimate, and revenue from issued invoices net of
 * credit notes — so it is right even before the period's stock valuation is posted.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const f2 = (d: Prisma.Decimal) => d.toFixed(2);

function range(from?: string, to?: string) {
  const t = to ?? todayLocalISO();
  const f = from ?? `${t.slice(0, 7)}-01`;
  if (!isValidISODate(f) || !isValidISODate(t) || f > t) throw new ApiError(400, "الفترة غير صالحة");
  return { from: f, to: t };
}

// ---------------------------------------------------------------------------
// Finance (reports.finance)
// ---------------------------------------------------------------------------

export async function financeReport(opts: { from?: string; to?: string }) {
  const { from, to } = range(opts.from, opts.to);

  // Every query below is independent: they run together (the pool caps concurrency at
  // connection_limit) instead of one after another.
  // Revenue by product: invoice lines − credit note lines, net of discount, before tax.
  const revenueQ = prisma.$queryRaw<{ productId: string | null; description: string; net: Prisma.Decimal; qty: Prisma.Decimal }[]>`
    SELECT l."productId", min(l."description") AS description, sum(l."net") AS net, sum(l."quantity") AS qty
    FROM "SalesInvoiceLine" l JOIN "SalesInvoice" i ON i."id" = l."invoiceId"
    WHERE i."status" = 'issued' AND i."issueDate" BETWEEN ${from} AND ${to}
    GROUP BY l."productId"`;
  const creditsQ = prisma.$queryRaw<{ productId: string | null; net: Prisma.Decimal }[]>`
    SELECT il."productId", sum(cl."net") AS net
    FROM "CreditNoteLine" cl JOIN "CreditNote" c ON c."id" = cl."creditNoteId" JOIN "SalesInvoiceLine" il ON il."id" = cl."invoiceLineId"
    WHERE c."issueDate" BETWEEN ${from} AND ${to}
    GROUP BY il."productId"`;
  // Cost of what left (issues) less what came back (customer returns), by product.
  const cogsQ = prisma.$queryRaw<{ productId: string; cost: Prisma.Decimal }[]>`
    SELECT v."productId", -sum(v."value") AS cost
    FROM "StockValuationLayer" v JOIN "StockMovement" m ON m."id" = v."movementId"
    WHERE m."kind" IN ('issue', 'customer_return') AND m."effectiveDate" BETWEEN ${from} AND ${to}
    GROUP BY v."productId"`;
  const cardsQ = prisma.stockProduct.findMany({ select: { id: true, name: true, nameAr: true } });
  // Quantity issued at an UNKNOWN cost (received without a price, sold before the
  // supplier cost was recorded). Its COGS is zero, so the margin above is provisional
  // for exactly this quantity — surface it instead of letting a zero-cost sale pass
  // as confirmed actual cost.
  const unknownCostQ = prisma.$queryRaw<{ productId: string; qty: Prisma.Decimal }[]>`
    SELECT v."productId", sum(CASE m."kind" WHEN 'customer_return' THEN v."quantity" ELSE -v."quantity" END) AS qty
    FROM "StockValuationLayer" v JOIN "StockMovement" m ON m."id" = v."movementId"
    WHERE m."kind" IN ('issue', 'customer_return') AND v."costSource" = 'unknown' AND m."effectiveDate" BETWEEN ${from} AND ${to}
    GROUP BY v."productId"`;
  // Sales by customer.
  const byCustomerQ = prisma.$queryRaw<{ customerId: string; name: string; nameAr: string | null; nameEn: string; net: Prisma.Decimal; invoices: bigint }[]>`
    SELECT i."customerId", coalesce(c."nameAr", c."name") AS name, c."nameAr" AS "nameAr", c."name" AS "nameEn", sum(i."net") AS net, count(*) AS invoices
    FROM "SalesInvoice" i JOIN "Customer" c ON c."id" = i."customerId"
    WHERE i."status" = 'issued' AND i."issueDate" BETWEEN ${from} AND ${to}
    GROUP BY i."customerId", c."nameAr", c."name" ORDER BY sum(i."net") DESC LIMIT 15`;
  // Profit and loss from the journal (what has been posted).
  const plQ = prisma.$queryRaw<{ type: string; systemKey: string | null; code: string; name: string; nameAr: string; nameEn: string; amount: Prisma.Decimal }[]>`
    SELECT a."type", a."systemKey", a."code", a."nameAr" AS name, a."nameAr" AS "nameAr", a."name" AS "nameEn", sum(l."credit" - l."debit") AS amount
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE a."type" IN ('revenue', 'expense') AND e."date" BETWEEN ${from} AND ${to} AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')
    GROUP BY a."type", a."systemKey", a."code", a."nameAr", a."name" ORDER BY a."code"`;

  const [revenue, credits, cogs, cardRows, unknownCost, byCustomer, pl, valuation, ar, ap, cash, movement] = await Promise.all([
    revenueQ, creditsQ, cogsQ, cardsQ, unknownCostQ, byCustomerQ, plQ,
    valuationReport(),
    agingReport(to),
    apAgingReport(to),
    cashPosition(),
    prisma.$queryRaw<{ kind: string; qty: Prisma.Decimal; value: Prisma.Decimal }[]>`
      SELECT m."kind", sum(m."quantity") AS qty, coalesce(sum(v."value"), 0) AS value
      FROM "StockMovement" m LEFT JOIN "StockValuationLayer" v ON v."movementId" = m."id"
      WHERE m."effectiveDate" BETWEEN ${from} AND ${to}
      GROUP BY m."kind" ORDER BY m."kind"`,
  ]);

  const cards = new Map(cardRows.map((p) => [p.id, p]));
  const products = new Map([...cards].map(([id, p]) => [id, p.nameAr ?? p.name]));
  // `name` keeps its Arabic-first value for existing consumers (exports); nameAr/nameEn
  // let the screen show the product in the selected language.
  const byProduct = new Map<string, { name: string; nameAr: string | null; nameEn: string | null; revenue: Prisma.Decimal; cost: Prisma.Decimal; qty: Prisma.Decimal }>();
  const row = (id: string | null, name: string) => {
    const k = id ?? `—${name}`;
    const card = id ? cards.get(id) : undefined;
    const r = byProduct.get(k) ?? { name: id ? products.get(id) ?? name : name, nameAr: card?.nameAr ?? null, nameEn: card?.name ?? null, revenue: D(0), cost: D(0), qty: D(0) };
    byProduct.set(k, r);
    return r;
  };
  for (const r of revenue) { const x = row(r.productId, r.description); x.revenue = x.revenue.plus(r.net); x.qty = x.qty.plus(r.qty); }
  for (const c of credits) { const x = row(c.productId, "—"); x.revenue = x.revenue.minus(c.net); }
  for (const c of cogs) { const x = row(c.productId, products.get(c.productId) ?? "—"); x.cost = x.cost.plus(c.cost); }
  const unknownQty = new Map(unknownCost.map((u) => [u.productId, D(u.qty)]));
  const lines = [...byProduct.entries()].map(([k, r]) => ({ product: r.name, productNameAr: r.nameAr, productNameEn: r.nameEn, quantity: r.qty.toString(), revenue: f2(r.revenue), cost: f2(r.cost), margin: f2(r.revenue.minus(r.cost)), marginPct: r.revenue.gt(0) ? r.revenue.minus(r.cost).dividedBy(r.revenue).times(100).toFixed(1) : null, costUnknownQty: f2(k.startsWith("—") ? D(0) : unknownQty.get(k) ?? D(0)) })).sort((a, b) => Number(b.revenue) - Number(a.revenue));
  const totalRevenue = [...byProduct.values()].reduce((s, r) => s.plus(r.revenue), D(0));
  const totalCost = [...byProduct.values()].reduce((s, r) => s.plus(r.cost), D(0));

  const plRevenue = pl.filter((x) => x.type === "revenue").reduce((s, x) => s.plus(x.amount), D(0));
  const plExpense = pl.filter((x) => x.type === "expense").reduce((s, x) => s.minus(x.amount), D(0));

  return {
    from, to,
    sales: { revenue: f2(totalRevenue), cost: f2(totalCost), grossMargin: f2(totalRevenue.minus(totalCost)), grossMarginPct: totalRevenue.gt(0) ? totalRevenue.minus(totalCost).dividedBy(totalRevenue).times(100).toFixed(1) : null, byProduct: lines.slice(0, 30), byCustomer: byCustomer.map((c) => ({ customerId: c.customerId, name: c.name, nameAr: c.nameAr, nameEn: c.nameEn, net: f2(D(c.net)), invoices: Number(c.invoices) })) },
    profitAndLoss: { lines: pl.map((x) => ({ code: x.code, name: x.name, nameAr: x.nameAr, nameEn: x.nameEn, type: x.type, amount: f2(D(x.amount)) })), revenue: f2(plRevenue), expenses: f2(plExpense), net: f2(plRevenue.minus(plExpense)) },
    receivables: { totals: ar.totals, top: ar.rows.slice(0, 10) },
    payables: { totals: ap.totals, top: ap.rows.slice(0, 10) },
    inventory: { value: valuation.totalValue.toFixed(2), top: valuation.rows.slice(0, 15).map((r) => ({ product: r.productNameAr ?? r.productName, productNameAr: r.productNameAr, productNameEn: r.productName, unit: r.unit, quantity: r.quantity.toString(), value: r.value.toFixed(2) })) },
    stockMovement: movement.map((m) => ({ kind: m.kind, quantity: D(m.qty).toString(), value: f2(D(m.value)) })),
    cash,
  };
}

// ---------------------------------------------------------------------------
// Cash Flow Statement (indirect method) — reports.finance
// ---------------------------------------------------------------------------

/** Classification of accounts into cash flow categories, by systemKey.
 *  Accounts not in this map are classified by their type:
 *    asset(not cash/bank) → investing (working capital changes get explicit labels)
 *    liability → financing (working capital → operating)
 *    equity → financing (net income → operating)
 *  except accounts the configuration itself says are working capital (operatingAccountIds).
 */
const CF_CLASSIFY: Record<string, "operating" | "investing" | "financing"> = {
  // Cash & bank — what we're measuring the change in; not classified.
  cash: "operating", bank: "operating",
  // Working capital (operating)
  ar: "operating", inventory: "operating", vat_input: "operating", vat_output: "operating",
  ap: "operating", employee_advances: "operating", employee_payable: "operating",
  grni: "operating", ppv: "operating",
  cogs: "operating", sales: "operating", sales_returns: "operating",
  inventory_adjustment: "operating",
  general_expenses: "operating", transport_expenses: "operating", salaries: "operating",
  // Financing
  capital: "financing", retained_earnings: "financing", opening_equity: "financing",
};

/** System keys for cash & bank accounts (whose balance change is the target). */
const CASH_ACCOUNT_KEYS = new Set(["cash", "bank"]);

/**
 * Accounts the configuration names as working capital: the payroll liability and expense
 * accounts of pay components, every account a payroll entry posted to, and the accounts
 * configured for receipt/payment deductions. Without this they would fall to the type
 * default (a non-system liability → financing), which a salary or tax payable is not.
 */
async function operatingAccountIds() {
  const [components, runs, payrollPosted] = await Promise.all([
    prisma.payComponent.findMany({ select: { expenseAccountId: true, liabilityAccountId: true } }),
    prisma.payrollRun.findMany({ where: { netPayAccountId: { not: null } }, distinct: ["netPayAccountId"], select: { netPayAccountId: true } }),
    // Accounts payroll actually posted to stay operating after a component is re-mapped.
    prisma.journalLine.findMany({ where: { entry: { sourceType: "payroll_run" } }, distinct: ["accountId"], select: { accountId: true } }),
  ]);
  const ids = new Set<string>(payrollPosted.map((l) => l.accountId));
  for (const c of components) for (const id of [c.expenseAccountId, c.liabilityAccountId]) if (id) ids.add(id);
  for (const r of runs) if (r.netPayAccountId) ids.add(r.netPayAccountId);
  const codes = (await Promise.all((["hr.payroll_net_pay_account", "accounting.withholding_receivable_account", "accounting.withholding_payable_account", "accounting.bank_charges_account", "accounting.write_off_account"] as const).map((k) => getSetting(k))))
    .map((v) => String(v ?? "").trim()).filter(Boolean);
  if (codes.length) for (const a of await prisma.account.findMany({ where: { code: { in: codes } }, select: { id: true } })) ids.add(a.id);
  return ids;
}

export async function cashFlowReport(opts: { from: string; to: string }) {
  const { from, to } = range(opts.from, opts.to);
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "الفترة غير صالحة");

  // 1. Net income (indirect method starting point).
  const pl = await profitLoss(from, to);
  const netIncome = D(pl.netIncome);

  // 2. Opening and closing per-account balances.
  // We need two balance snapshots: beginning-of-period (day before 'from') and as-of 'to'.
  const fromDay = new Date(new Date(from).getTime() - 86400000).toISOString().slice(0, 10);
  const [openRows, closeRows] = await Promise.all([
    prisma.$queryRaw<{ accountId: string; balance: Prisma.Decimal }[]>`
      SELECT l."accountId", coalesce(sum(l."debit" - l."credit"), 0) AS balance
      FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId"
      WHERE e."date" <= ${fromDay} AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')
      GROUP BY l."accountId"`,
    prisma.$queryRaw<{ accountId: string; balance: Prisma.Decimal }[]>`
      SELECT l."accountId", coalesce(sum(l."debit" - l."credit"), 0) AS balance
      FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId"
      WHERE e."date" <= ${to} AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')
      GROUP BY l."accountId"`,
  ]);
  // Year-end closing entries only move P&L balances into retained earnings — no cash, no
  // working capital — so they are left out of both snapshots (net income still counts once).
  // Period change per account: closing − opening = debit-style change.
  // We store the signed balance (debit minus credit) at each point.
  const open = new Map(openRows.map((r) => [r.accountId, D(r.balance)]));
  const close = new Map(closeRows.map((r) => [r.accountId, D(r.balance)]));
  const allIds = [...new Set([...open.keys(), ...close.keys()])];

  // 3. Fetch account details.
  const accounts = new Map((await prisma.account.findMany({ where: { id: { in: allIds } } })).map((a) => [a.id, a]));
  const byKey = new Map<string, { id: string; type: string; systemKey: string }>();
  for (const a of accounts.values()) {
    if (a.systemKey) byKey.set(a.systemKey, { id: a.id, type: a.type, systemKey: a.systemKey });
  }

  // Cash = every account behind a cash box or bank account (not only the two seeded ones).
  const cashIds = new Set((await prisma.cashAccount.findMany({ select: { accountId: true } })).map((c) => c.accountId));
  for (const a of accounts.values()) if (a.systemKey && CASH_ACCOUNT_KEYS.has(a.systemKey)) cashIds.add(a.id);
  const isCash = (id: string) => cashIds.has(id);

  // Net change in each account (debit-style: positive = more debit / less credit).
  const changes = new Map<string, Prisma.Decimal>();
  for (const id of allIds) {
    const delta = (close.get(id) ?? D(0)).minus(open.get(id) ?? D(0));
    if (!delta.isZero()) changes.set(id, delta);
  }

  // 4. Classify each account's change into operating / investing / financing.
  // For a cash-flow classification, we consider the SIGN of the account's normal balance:
  //   asset (debit-normal):    +change = increase in asset = cash outflow (use of cash)
  //   liability (credit-normal): +change = increase in liability = cash inflow (source of cash)
  //   equity (credit-normal):   +change = increase in equity = cash inflow
  // We then negate to get the cash effect.
  // But the indirect method works differently: we adjust net income for changes in
  // working capital accounts. A simpler approach using the balance sheet changes
  // directly:
  //   Operating CF = net income + decrease in operating assets + increase in operating liabilities
  //   Investing CF = decrease in investing assets + increase in investing liabilities (negated)
  //   Financing CF = decrease in financing assets + increase in financing liabilities

  const operating = await operatingAccountIds();
  type CfLine = { kind: "net_income" | "change" | "adjustment"; label: string; amount: string; accountCode?: string; accountName?: string; accountNameAr?: string | null; unclassified?: boolean; adjustment?: "disposal_noncash" | "disposal_proceeds" };
  const unclassified: { code: string; name: string; nameAr: string }[] = [];
  const sections: Record<string, { lines: CfLine[]; total: string }> = {
    operating: { lines: [], total: "0.00" },
    investing: { lines: [], total: "0.00" },
    financing: { lines: [], total: "0.00" },
  };

  for (const [accountId, delta] of changes) {
    const a = accounts.get(accountId);
    if (!a) continue;
    // Skip cash accounts themselves — we track these separately.
    if (isCash(a.id)) continue;

    const sk = a.systemKey;
    const acctLabel = `${a.code} ${a.nameAr}`;

    // Classification: what the accountant set on the account; else the system key's; else
    // an account the configuration names as working capital; else not classified — shown
    // under operating and flagged, never guessed from the account type (a prepaid expense
    // is not an investment, an accrual is not financing).
    let cf: "operating" | "investing" | "financing";
    let flagged = false;
    if (a.cashFlowCategory === "operating" || a.cashFlowCategory === "investing" || a.cashFlowCategory === "financing") {
      cf = a.cashFlowCategory;
    } else if (sk && CF_CLASSIFY[sk]) {
      cf = CF_CLASSIFY[sk];
    } else if (operating.has(a.id)) {
      cf = "operating";
    } else {
      cf = "operating";
      flagged = a.type === "asset" || a.type === "liability" || a.type === "equity";
    }

    // Convert balance-sheet change to cash-flow effect.
    // Asset increase (positive delta) = cash outflow = negative cash effect.
    // Liability/equity increase (positive delta) = cash inflow = positive cash effect.
    // For revenue/expense accounts (P&L), their balance directly reflects
    // net income which is the starting point; we double-count if we include them.
    // So we skip P&L accounts here — net income is the starting point and
    // working capital adjustments handle the rest.
    if (a.type === "revenue" || a.type === "expense") continue;

    // `delta` is debit-style (debit − credit). Debits and credits sum to zero, so
    //   cash change = net income − Σ delta over every other balance-sheet account,
    // whatever the account's type: an asset that grows (delta > 0) used cash; a
    // liability or equity that grows (credited, delta < 0) brought cash in.
    const cashEffect = delta.negated();

    if (cashEffect.isZero()) continue;

    sections[cf].lines.push({
      kind: "change",
      label: `تغير في ${acctLabel}`,
      amount: cashEffect.toFixed(2),
      accountCode: a.code,
      accountName: a.name,
      accountNameAr: a.nameAr,
      ...(flagged ? { unclassified: true } : {}),
    });
    if (flagged) unclassified.push({ code: a.code, name: a.name, nameAr: a.nameAr });
  }

  // Add net income as the first operating line.
  sections.operating.lines.unshift({
    kind: "net_income",
    label: "صافي الدخل",
    amount: netIncome.toFixed(2),
  });

  // Asset disposals: the balance changes put the asset's cost under investing and its
  // accumulated depreciation (with the gain or loss, inside net income) under operating.
  // Move them so investing shows what the sale brought in and operating nothing of it.
  const [disp] = await prisma.$queryRaw<{ acc: Prisma.Decimal | null; gain: Prisma.Decimal | null }[]>`
    SELECT coalesce(sum(-"accumulatedDelta"), 0) AS acc, coalesce(sum("gainLoss"), 0) AS gain FROM "AssetEvent" WHERE "type" = 'disposal' AND "date" BETWEEN ${from} AND ${to}`;
  const shift = D(disp?.acc ?? 0).minus(D(disp?.gain ?? 0));
  if (!shift.isZero()) {
    sections.operating.lines.push({ kind: "adjustment", adjustment: "disposal_noncash", label: "استبعاد أصول: مجمع الإهلاك والربح/الخسارة (غير نقدي)", amount: shift.toFixed(2) });
    sections.investing.lines.push({ kind: "adjustment", adjustment: "disposal_proceeds", label: "استبعاد أصول: الفرق بين التكلفة وثمن البيع", amount: shift.negated().toFixed(2) });
  }

  // Compute section totals.
  for (const key of ["operating", "investing", "financing"] as const) {
    const sum = sections[key].lines.reduce((s, l) => s.plus(D(l.amount)), D(0));
    sections[key].total = sum.toFixed(2);
  }

  // Net cash flow = the three sections together; equals the cash and bank change.
  const netCashFlow = ["operating", "investing", "financing"].reduce((s, key) => s.plus(D(sections[key].total)), D(0));

  // Cash balances: compute opening and closing balances of cash/bank accounts.
  const cashAccountEntries = allIds
    .map((id) => {
      const a = accounts.get(id);
      if (!a || !isCash(id)) return null;
      return {
        accountId: id,
        code: a.code,
        name: a.nameAr ?? a.name,
        nameAr: a.nameAr,
        nameEn: a.name,
        opening: (open.get(id) ?? D(0)).toFixed(2),
        closing: (close.get(id) ?? D(0)).toFixed(2),
        change: (close.get(id) ?? D(0)).minus(open.get(id) ?? D(0)).toFixed(2),
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  const totalOpening = cashAccountEntries.reduce((s, e) => s.plus(D(e.opening)), D(0)).toFixed(2);
  const totalClosing = cashAccountEntries.reduce((s, e) => s.plus(D(e.closing)), D(0)).toFixed(2);
  const totalChange = D(totalClosing).minus(D(totalOpening)).toFixed(2);

  return {
    from, to,
    netIncome: netIncome.toFixed(2),
    sections,
    netCashFlow: netCashFlow.toFixed(2),
    cashAccounts: cashAccountEntries,
    cashTotal: { opening: totalOpening, closing: totalClosing, change: totalChange },
    unclassified,
    _balanced: netCashFlow.toFixed(2) === totalChange,
  };
}

// ---------------------------------------------------------------------------
// Operations (reports.view) — quantities, times and counts; no money.
// ---------------------------------------------------------------------------

export async function operationsReport(opts: { from?: string; to?: string }) {
  const { from, to } = range(opts.from, opts.to);

  // Fulfilment: required → prepared → loaded → delivered, over orders due in the range.
  const [fill] = await prisma.$queryRaw<{ orders: bigint; required: number; prepared: number; loaded: number; dispatched: bigint; cancelled: bigint }[]>`
    SELECT count(DISTINCT o."id") AS orders, coalesce(sum(i."requiredQuantity"), 0) AS required, coalesce(sum(i."preparedQuantity"), 0) AS prepared, coalesce(sum(i."loadedQuantity"), 0) AS loaded,
      count(DISTINCT o."id") FILTER (WHERE o."status" = 'dispatched') AS dispatched, count(DISTINCT o."id") FILTER (WHERE o."status" = 'cancelled') AS cancelled
    FROM "Order" o JOIN "OrderItem" i ON i."orderId" = o."id"
    WHERE o."deliveryDate" BETWEEN ${from} AND ${to}`;
  const [delivered] = await prisma.$queryRaw<{ shipped: Prisma.Decimal; delivered: Prisma.Decimal; shortage: Prisma.Decimal; damaged: Prisma.Decimal; rejected: Prisma.Decimal }[]>`
    SELECT coalesce(sum(d."shippedQty"), 0) AS shipped, coalesce(sum(d."deliveredQty"), 0) AS delivered, coalesce(sum(d."shortageQty"), 0) AS shortage, coalesce(sum(d."damagedQty"), 0) AS damaged, coalesce(sum(d."rejectedQty"), 0) AS rejected
    FROM "DeliveryLine" d JOIN "TripStop" s ON s."id" = d."stopId" JOIN "Trip" t ON t."id" = s."tripId"
    WHERE t."tripDate" BETWEEN ${from} AND ${to}`;
  const pct = (a: number, b: number) => (b > 0 ? ((a / b) * 100).toFixed(1) : null);

  // Preparation: per preparer, orders and the time from "preparing" to "ready".
  const prep = await prisma.$queryRaw<{ preparer: string | null; orders: bigint; avgMinutes: number | null }[]>`
    WITH s AS (
      SELECT a."orderId", min(a."timestamp") FILTER (WHERE a."newValue" = 'preparing') AS started, min(a."timestamp") FILTER (WHERE a."newValue" = 'ready_for_loading') AS ready
      FROM "AuditLog" a WHERE a."fieldChanged" = 'status' AND a."orderId" IS NOT NULL GROUP BY a."orderId"
    )
    SELECT o."assignedToName" AS preparer, count(*) AS orders, avg(extract(epoch FROM (s.ready - s.started)) / 60) AS "avgMinutes"
    FROM s JOIN "Order" o ON o."id" = s."orderId"
    WHERE s.started IS NOT NULL AND s.ready IS NOT NULL AND o."deliveryDate" BETWEEN ${from} AND ${to}
    GROUP BY o."assignedToName" ORDER BY count(*) DESC`;

  // Loading and delivery, from trips.
  const [trips] = await prisma.$queryRaw<{ trips: bigint; completed: bigint; avgLoadMinutes: number | null; avgDispatchToDoneMinutes: number | null }[]>`
    SELECT count(*) AS trips, count(*) FILTER (WHERE "status" = 'completed') AS completed,
      avg(extract(epoch FROM ("loadedAt" - "loadingStartedAt")) / 60) AS "avgLoadMinutes",
      avg(extract(epoch FROM ("completedAt" - "dispatchedAt")) / 60) AS "avgDispatchToDoneMinutes"
    FROM "Trip" WHERE "tripDate" BETWEEN ${from} AND ${to} AND "status" <> 'cancelled'`;
  const stops = await prisma.$queryRaw<{ driver: string; delivered: bigint; partial: bigint; failed: bigint; pending: bigint }[]>`
    SELECT d."name" AS driver, count(*) FILTER (WHERE s."status" = 'delivered') AS delivered, count(*) FILTER (WHERE s."status" = 'partial') AS partial,
      count(*) FILTER (WHERE s."status" = 'failed') AS failed, count(*) FILTER (WHERE s."status" = 'pending') AS pending
    FROM "TripStop" s JOIN "Trip" t ON t."id" = s."tripId" JOIN "Driver" d ON d."id" = t."driverId"
    WHERE s."active" AND t."tripDate" BETWEEN ${from} AND ${to}
    GROUP BY d."name" ORDER BY d."name"`;

  // Exceptions raised in the range.
  const exceptions = await prisma.$queryRaw<{ type: string; open: bigint; resolved: bigint; avgHoursToResolve: number | null }[]>`
    SELECT "type", count(*) FILTER (WHERE "status" = 'open') AS open, count(*) FILTER (WHERE "status" = 'resolved') AS resolved,
      avg(extract(epoch FROM ("resolvedAt" - "createdAt")) / 3600) AS "avgHoursToResolve"
    FROM "OperationalException" WHERE "createdAt"::date BETWEEN ${from}::date AND ${to}::date GROUP BY "type" ORDER BY "type"`;

  // Inventory aging: what is on hand now, by how long ago its lot was received.
  const aging = await prisma.$queryRaw<{ bucket: string; qty: Prisma.Decimal; lots: bigint }[]>`
    WITH b AS (
      SELECT m."lotId", sum(m."quantity") AS qty FROM "StockMovement" m WHERE m."lotId" IS NOT NULL GROUP BY m."lotId" HAVING sum(m."quantity") > 0
    )
    SELECT CASE WHEN ${to}::date - l."receivedDate"::date <= 2 THEN '0-2' WHEN ${to}::date - l."receivedDate"::date <= 7 THEN '3-7'
                WHEN ${to}::date - l."receivedDate"::date <= 14 THEN '8-14' ELSE '15+' END AS bucket,
      sum(b.qty) AS qty, count(*) AS lots
    FROM b JOIN "StockLot" l ON l."id" = b."lotId" GROUP BY 1 ORDER BY 1`;

  const num = (x: number | null) => (x == null ? null : Math.round(Number(x)));
  return {
    from, to,
    fulfilment: {
      orders: Number(fill?.orders ?? 0), dispatched: Number(fill?.dispatched ?? 0), cancelled: Number(fill?.cancelled ?? 0),
      required: Number(fill?.required ?? 0), prepared: Number(fill?.prepared ?? 0), loaded: Number(fill?.loaded ?? 0),
      preparedPct: pct(Number(fill?.prepared ?? 0), Number(fill?.required ?? 0)), loadedPct: pct(Number(fill?.loaded ?? 0), Number(fill?.required ?? 0)),
      delivery: { shipped: D(delivered?.shipped).toString(), delivered: D(delivered?.delivered).toString(), shortage: D(delivered?.shortage).toString(), damaged: D(delivered?.damaged).toString(), rejected: D(delivered?.rejected).toString(), deliveredPct: pct(Number(delivered?.delivered ?? 0), Number(delivered?.shipped ?? 0)) },
    },
    preparation: prep.map((p) => ({ preparer: p.preparer ?? "غير موزّع", orders: Number(p.orders), avgMinutes: num(p.avgMinutes) })),
    loading: { trips: Number(trips?.trips ?? 0), completed: Number(trips?.completed ?? 0), avgLoadMinutes: num(trips?.avgLoadMinutes ?? null), avgDispatchToDoneMinutes: num(trips?.avgDispatchToDoneMinutes ?? null) },
    delivery: stops.map((s) => ({ driver: s.driver, delivered: Number(s.delivered), partial: Number(s.partial), failed: Number(s.failed), pending: Number(s.pending) })),
    exceptions: exceptions.map((e) => ({ type: e.type, open: Number(e.open), resolved: Number(e.resolved), avgHoursToResolve: e.avgHoursToResolve == null ? null : Number(Number(e.avgHoursToResolve).toFixed(1)) })),
    inventoryAging: aging.map((a) => ({ bucket: a.bucket, quantity: D(a.qty).toString(), lots: Number(a.lots) })),
  };
}
