import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { isValidISODate } from "@/lib/dates";

/**
 * Comparative statements and financial ratios, read straight from the ledger.
 *
 *  - P&L by account for a range and its comparison range — the same length immediately
 *    before ("prior_period") or the same dates a year earlier ("prior_year") — with the
 *    variance and the variance %. Year-end closing entries are left out (a closed year
 *    still shows its result), exactly as the P&L report does.
 *  - Balance sheet by account at the end of each range (cumulative, closing entries
 *    included — they only move the result into retained earnings).
 *  - Ratios at each range's end. The chart of accounts does not split current from
 *    non-current, so the basis is stated, not guessed: current assets are every asset except
 *    fixed assets (the 1700 group and accounts the asset register controls); liabilities are
 *    taken as a whole (all treated as current — the liquidity ratios are therefore the
 *    conservative reading). Turnover days use the range's own revenue and cost of sales.
 *    A ratio whose denominator is zero is null, never infinity.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const day = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const daysIn = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / day) + 1;

function shiftYear(d: string, k: number) {
  const y = Number(d.slice(0, 4)) + k, m = d.slice(5, 7), dd = Number(d.slice(8, 10));
  const last = new Date(Date.UTC(y, Number(m), 0)).getUTCDate();
  return `${y}-${m}-${String(Math.min(dd, last)).padStart(2, "0")}`;
}

export function comparisonRange(from: string, to: string, basis: "prior_period" | "prior_year") {
  if (basis === "prior_year") return { from: shiftYear(from, -1), to: shiftYear(to, -1) };
  const len = daysIn(from, to);
  const cto = iso(Date.parse(`${from}T00:00:00Z`) - day);
  return { from: iso(Date.parse(`${cto}T00:00:00Z`) - (len - 1) * day), to: cto };
}

type Acc = { id: string; code: string; name: string; nameAr: string; type: string; systemKey: string | null; parentId: string | null; controlledBy: string | null };

async function plByAccount(from: string, to: string) {
  return prisma.$queryRaw<{ accountId: string; amount: Prisma.Decimal }[]>`
    SELECT l."accountId", sum(CASE WHEN a."type" = 'revenue' THEN l."credit" - l."debit" ELSE l."debit" - l."credit" END) AS amount
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE a."type" IN ('revenue', 'expense') AND e."date" BETWEEN ${from} AND ${to} AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')
    GROUP BY l."accountId"`;
}

async function balancesAt(asOf: string) {
  return prisma.$queryRaw<{ accountId: string; balance: Prisma.Decimal }[]>`
    SELECT l."accountId", sum(l."debit" - l."credit") AS balance
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE e."date" <= ${asOf} GROUP BY l."accountId"`;
}

const pct = (a: Prisma.Decimal, b: Prisma.Decimal) => (b.isZero() ? null : a.dividedBy(b.abs()).times(100).toDecimalPlaces(1).toFixed(1));
const ratio = (a: Prisma.Decimal, b: Prisma.Decimal, dp = 2) => (b.isZero() ? null : a.dividedBy(b).toDecimalPlaces(dp).toFixed(dp));

export async function comparativeStatements(opts: { from: string; to: string; basis?: string }) {
  const { from, to } = opts;
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "الفترة غير صالحة");
  const basis = opts.basis === "prior_period" ? "prior_period" : "prior_year";
  const cmp = comparisonRange(from, to, basis);
  const [accounts, cashAccounts, plCur, plCmp, bsCur, bsCmp] = await Promise.all([
    prisma.account.findMany({ select: { id: true, code: true, name: true, nameAr: true, type: true, systemKey: true, parentId: true, controlledBy: true } }),
    prisma.cashAccount.findMany({ select: { accountId: true } }),
    plByAccount(from, to), plByAccount(cmp.from, cmp.to), balancesAt(to), balancesAt(cmp.to),
  ]);
  const byId = new Map<string, Acc>(accounts.map((a) => [a.id, a]));
  // Fixed assets: the 1700 group (any depth) and accounts the asset register controls.
  const fixed = new Set<string>();
  const isFixed = (a: Acc | undefined): boolean => {
    for (let x = a, i = 0; x && i < 20; x = x.parentId ? byId.get(x.parentId) : undefined, i++) if (x.id === "acc_1700" || x.controlledBy === "fixed_assets") return true;
    return false;
  };
  for (const a of accounts) if (a.type === "asset" && isFixed(a)) fixed.add(a.id);

  const line = (a: Acc, cur: Prisma.Decimal, prev: Prisma.Decimal) => ({ accountId: a.id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, current: cur.toFixed(2), comparison: prev.toFixed(2), variance: cur.minus(prev).toFixed(2), variancePct: pct(cur.minus(prev), prev) });
  const mapOf = (rows: { accountId: string; amount?: Prisma.Decimal; balance?: Prisma.Decimal }[]) => new Map(rows.map((r) => [r.accountId, D(r.amount ?? r.balance)]));
  const pc = mapOf(plCur), pp = mapOf(plCmp), bc = mapOf(bsCur), bp = mapOf(bsCmp);

  const plIds = [...new Set([...pc.keys(), ...pp.keys()])].filter((id) => !(pc.get(id) ?? D(0)).isZero() || !(pp.get(id) ?? D(0)).isZero());
  const plLines = plIds.map((id) => line(byId.get(id)!, pc.get(id) ?? D(0), pp.get(id) ?? D(0))).sort((a, b) => a.code.localeCompare(b.code));
  const sumPl = (m: Map<string, Prisma.Decimal>, t: string, key?: string) => [...m].filter(([id]) => byId.get(id)?.type === t && (!key || byId.get(id)?.systemKey === key)).reduce((s, [, v]) => s.plus(v), D(0));
  const pl = (m: Map<string, Prisma.Decimal>) => { const revenue = sumPl(m, "revenue"), expenses = sumPl(m, "expense"), cogs = sumPl(m, "expense", "cogs"); return { revenue, expenses, cogs, net: revenue.minus(expenses), gross: revenue.minus(cogs) }; };
  const plC = pl(pc), plP = pl(pp);

  // Balance sheet: assets as debit balances, liabilities and equity as credit balances; the
  // result not yet closed into retained earnings is shown as its own equity line.
  const bsSide = (m: Map<string, Prisma.Decimal>) => {
    const s = (t: string) => [...m].filter(([id]) => byId.get(id)?.type === t).reduce((x, [, v]) => x.plus(v), D(0));
    const key = (k: string) => [...m].filter(([id]) => byId.get(id)?.systemKey === k).reduce((x, [, v]) => x.plus(v), D(0));
    const assets = s("asset"), liabilities = s("liability").negated(), equity = s("equity").negated(), result = s("revenue").plus(s("expense")).negated();
    const fixedAssets = [...m].filter(([id]) => fixed.has(id)).reduce((x, [, v]) => x.plus(v), D(0));
    const cashIds = new Set(cashAccounts.map((c) => c.accountId));
    return { assets, liabilities, equity: equity.plus(result), result, currentAssets: assets.minus(fixedAssets), fixedAssets, inventory: key("inventory"), receivables: key("ar"), payables: key("ap").negated(), cash: [...m].filter(([id]) => cashIds.has(id)).reduce((x, [, v]) => x.plus(v), D(0)) };
  };
  const bsIds = [...new Set([...bc.keys(), ...bp.keys()])].filter((id) => { const t = byId.get(id)?.type; return (t === "asset" || t === "liability" || t === "equity") && (!(bc.get(id) ?? D(0)).isZero() || !(bp.get(id) ?? D(0)).isZero()); });
  const sign = (a: Acc, v: Prisma.Decimal) => (a.type === "asset" ? v : v.negated());
  const bsLines = bsIds.map((id) => { const a = byId.get(id)!; return line(a, sign(a, bc.get(id) ?? D(0)), sign(a, bp.get(id) ?? D(0))); }).sort((a, b) => a.code.localeCompare(b.code));
  const bC = bsSide(bc), bP = bsSide(bp);

  const ratios = (p: ReturnType<typeof pl>, b: ReturnType<typeof bsSide>, days: number) => ({
    grossMarginPct: pct(p.gross, p.revenue), netMarginPct: pct(p.net, p.revenue),
    currentRatio: ratio(b.currentAssets, b.liabilities), quickRatio: ratio(b.currentAssets.minus(b.inventory), b.liabilities), cashRatio: ratio(b.cash, b.liabilities),
    debtToEquity: ratio(b.liabilities, b.equity), workingCapital: b.currentAssets.minus(b.liabilities).toFixed(2),
    receivableDays: p.revenue.isZero() ? null : b.receivables.dividedBy(p.revenue).times(days).toDecimalPlaces(0).toFixed(0),
    inventoryDays: p.cogs.isZero() ? null : b.inventory.dividedBy(p.cogs).times(days).toDecimalPlaces(0).toFixed(0),
    payableDays: p.cogs.isZero() ? null : b.payables.dividedBy(p.cogs).times(days).toDecimalPlaces(0).toFixed(0),
  });
  const tot = (p: ReturnType<typeof pl>) => ({ revenue: p.revenue.toFixed(2), costOfSales: p.cogs.toFixed(2), grossProfit: p.gross.toFixed(2), expenses: p.expenses.toFixed(2), netIncome: p.net.toFixed(2) });
  const btot = (b: ReturnType<typeof bsSide>) => ({ assets: b.assets.toFixed(2), currentAssets: b.currentAssets.toFixed(2), fixedAssets: b.fixedAssets.toFixed(2), liabilities: b.liabilities.toFixed(2), equity: b.equity.toFixed(2), balanced: b.assets.minus(b.liabilities).minus(b.equity).abs().lt(0.005) });
  return {
    basis, current: { from, to }, comparison: cmp,
    profitAndLoss: { lines: plLines, current: tot(plC), comparison: tot(plP) },
    balanceSheet: { lines: bsLines, current: btot(bC), comparison: btot(bP) },
    ratios: { current: ratios(plC, bC, daysIn(from, to)), comparison: ratios(plP, bP, daysIn(cmp.from, cmp.to)) },
    ratioBasis: "current_assets_exclude_fixed; liabilities_all_current",
  };
}
