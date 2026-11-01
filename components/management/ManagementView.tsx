"use client";

import { useState } from "react";
import { MOVEMENT_LABEL, movementLabel } from "@/lib/stockPresentation";
import type { MovementKind } from "@/lib/inventory/ledger";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { ErrorState, LoadingState } from "@/components/States";
import { todayLocalISO } from "@/lib/localDate";
import { fmtMoney, fmtQty } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { PageHeader } from "@/components/ui/PageHeader";
import { localName } from "@/lib/locale/names";
import type { Jsonified } from "@/lib/core/json-type";
import type { cashFlowReport, financeReport, operationsReport } from "@/lib/management/reports";
import { ManagementSwitch } from "@/components/management/ManagementSwitch";

// The report shapes as the API serialises them; the kind in the URL picks which one arrives.
type FinanceReport = Jsonified<Awaited<ReturnType<typeof financeReport>>>;
type CashFlowReport = Jsonified<Awaited<ReturnType<typeof cashFlowReport>>>;
type OperationsReport = Jsonified<Awaited<ReturnType<typeof operationsReport>>>;

/** Management reports: finance (sales, margin, balances, stock value, cash, P&L) or operations (fulfilment, prep, loading, delivery, exceptions, stock age). */

/** A figure. Colour is reserved for a figure that is wrong-way (a loss, a negative balance):
 * a healthy number stays ink, so red is never diluted by decorative green. */
const Tile = ({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) => (
  <div className="card px-4 py-3">
    <div className="text-xs font-medium text-united-muted">{label}</div>
    <div className={`mt-1 text-xl font-bold ${tone === "bad" ? "text-united-danger" : "text-united-dark"}`}><span dir="ltr">{value}</span></div>
  </div>
);
/** First column is the label; every other column is a figure (tabular, aligned to the page's end).
 * `total` styles the last row as the table's total. */
const Table = ({ head, rows, total }: { head: string[]; rows: (string | number | null)[][]; total?: boolean }) => {
  const body = total ? rows.slice(0, -1) : rows;
  const foot = total ? rows[rows.length - 1] : null;
  // Figures arrive as plain decimal strings ("21000.00"); grouped digits read at a glance.
  // Anything that is not a plain number (a percentage, "—", a label) is shown as given.
  const fig = (c: string | number | null) => {
    if (c === null || c === "") return "—";
    const s = String(c);
    if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
    const dp = s.includes(".") ? s.split(".")[1].length : 0;
    return Number(s).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  };
  const cells = (r: (string | number | null)[]) => r.map((c, j) => (j ? <td key={j} className="num whitespace-nowrap tabular-nums" dir="ltr">{fig(c)}</td> : <td key={j} className="font-medium">{c ?? "—"}</td>));
  return (
    <div className="card overflow-x-auto">
      <table className="data-table">
        <thead><tr>{head.map((h, i) => <th key={i} className={i ? "num" : undefined}>{h}</th>)}</tr></thead>
        <tbody>{body.map((r, i) => <tr key={i}>{cells(r)}</tr>)}</tbody>
        {foot && <tfoot><tr>{cells(foot)}</tr></tfoot>}
      </table>
    </div>
  );
};
const H = ({ children }: { children: React.ReactNode }) => <h2 className="section-title mt-3">{children}</h2>;

export function ManagementView({ kind }: { kind: "finance" | "operations" | "cash-flow" }) {
  const { t, locale } = useLocale();
  const [from, setFrom] = useState(`${todayLocalISO().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayLocalISO());
  const apiKind = kind === "cash-flow" ? "cash-flow" : kind;

  // Localized dictionaries for kind/experience code lookups
  // Stock movement kinds: the shared labels (lib/stockPresentation) cover every kind,
  // including sorting and quarantine release.
  const KIND: Record<string, string> = Object.fromEntries(
    (Object.keys(MOVEMENT_LABEL) as MovementKind[]).map((k) => [k, movementLabel(k, locale)])
  );
  const EX: Record<string, string> = {
    shortage: t("mgmt.exceptions.shortage"),
    damage: t("mgmt.exceptions.damage"),
    rejection: t("mgmt.exceptions.rejection"),
    delivery_failure: t("mgmt.exceptions.delivery_failure"),
    loading_discrepancy: t("mgmt.exceptions.loading_discrepancy"),
  };

  const q = useQuery({ queryKey: ["management", kind, from, to], queryFn: () => apiFetch<{ report: FinanceReport | CashFlowReport | OperationsReport }>(`/api/management/${apiKind}?from=${from}&to=${to}`) });
  return (
    <div className="page-container">
      <PageHeader
        title={kind === "finance" ? t("management.title.finance") : kind === "cash-flow" ? t("management.title.cashflow") : t("management.title.operations")}
        actions={
          kind !== "operations" && (
            <ManagementSwitch current={kind === "cash-flow" ? "cash-flow" : "finance"} />
          )
        }
      />
      {/* The period every figure below covers. */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1"><span className="field-label">{t("accounting.date-from")}</span><input type="date" className="field w-auto" value={from} max={to} onChange={(e) => setFrom(e.target.value || from)} /></label>
        <label className="flex flex-col gap-1"><span className="field-label">{t("accounting.date-to")}</span><input type="date" className="field w-auto" value={to} min={from} onChange={(e) => setTo(e.target.value || to)} /></label>
      </div>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && (kind === "cash-flow" ? <CashFlow r={q.data.report as CashFlowReport} t={t} /> : kind === "finance" ? <Finance r={q.data.report as FinanceReport} t={t} kinds={KIND} /> : <Operations r={q.data.report as OperationsReport} t={t} exCodes={EX} />)}
    </div>
  );
}

function Finance({ r, t, kinds }: { r: FinanceReport; t: (k: string) => string; kinds: Record<string, string> }) {
  const { locale } = useLocale();
  // Report rows carry `product` (legacy Arabic-first label) plus productNameAr/En.
  const productLabel = (p: { product: string; productNameAr?: string | null; productNameEn?: string | null }) =>
    p.productNameEn || p.productNameAr ? localName({ name: p.productNameEn, nameAr: p.productNameAr }, locale) : p.product;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={t("mgmt.finance.tile.net_sales")} value={fmtMoney(r.sales.revenue)} />
        <Tile label={t("mgmt.finance.tile.cost_of_sales")} value={fmtMoney(r.sales.cost)} />
        <Tile label={r.sales.grossMarginPct ? `${t("mgmt.finance.tile.gross_margin")} (${r.sales.grossMarginPct}%)` : t("mgmt.finance.tile.gross_margin")} value={fmtMoney(r.sales.grossMargin)} tone={Number(r.sales.grossMargin) >= 0 ? "good" : "bad"} />
        <Tile label={t("mgmt.finance.tile.cash_banks")} value={fmtMoney(r.cash.total)} tone={Number(r.cash.total) < 0 ? "bad" : undefined} />
        <Tile label={t("mgmt.finance.tile.receivables")} value={fmtMoney(r.receivables.totals.total)} />
        <Tile label={t("mgmt.finance.tile.payables")} value={fmtMoney(r.payables.totals.total)} />
        <Tile label={t("mgmt.finance.tile.inventory_value")} value={fmtMoney(r.inventory.value)} />
        <Tile label={t("mgmt.finance.tile.net_profit")} value={fmtMoney(r.profitAndLoss.net)} tone={Number(r.profitAndLoss.net) >= 0 ? "good" : "bad"} />
      </div>
      <H>{t("mgmt.finance.heading.margin_by_product")}</H>
      <Table head={[t("mgmt.finance.table.product.item"), t("mgmt.finance.table.product.quantity"), t("mgmt.finance.table.product.sales"), t("mgmt.finance.table.product.cost"), t("mgmt.finance.table.product.margin"), t("mgmt.finance.table.product.pct"), t("mgmt.finance.table.product.cost_unknown")]} rows={r.sales.byProduct.map((p) => [productLabel(p), fmtQty(p.quantity), p.revenue, p.cost, p.margin, p.marginPct, Number(p.costUnknownQty ?? 0) > 0 ? fmtQty(p.costUnknownQty) : "—"])} />
      <p className="text-xs text-united-muted">{t("mgmt.finance.footnote.cost_unknown")}</p>
      <H>{t("mgmt.finance.heading.top_customers")}</H>
      <Table head={[t("mgmt.finance.head.customer"), t("mgmt.finance.head.invoices"), t("mgmt.finance.tile.net_sales")]} rows={r.sales.byCustomer.map((c) => [localName(c, locale), c.invoices, c.net])} />
      <H>{t("mgmt.finance.heading.debts_aging")}</H>
      <Table head={["", t("mgmt.finance.table.debts.bucket_current"), "1–30", "31–60", "61–90", "+90", t("mgmt.finance.table.debts.total")]} rows={[[t("mgmt.finance.table.debts.labels.customers"), r.receivables.totals.current, r.receivables.totals.d1_30, r.receivables.totals.d31_60, r.receivables.totals.d61_90, r.receivables.totals.d90_plus, r.receivables.totals.total], [t("mgmt.finance.table.debts.labels.suppliers"), r.payables.totals.current, r.payables.totals.d1_30, r.payables.totals.d31_60, r.payables.totals.d61_90, r.payables.totals.d90_plus, r.payables.totals.total]]} />
      <H>{t("mgmt.finance.heading.income_statement")}</H>
      <Table head={[t("mgmt.is.head.account"), t("mgmt.is.head.amount")]} rows={[...r.profitAndLoss.lines.map((l) => [`${l.code} · ${localName(l, locale)}`, l.amount]), [t("mgmt.finance.tile.net_profit"), r.profitAndLoss.net]]} total />
      <H>{t("mgmt.finance.heading.stock_movement")}</H>
      <Table head={[t("mgmt.stock_move.head.type"), t("mgmt.stock_move.head.quantity"), t("mgmt.stock_move.head.value")]} rows={r.stockMovement.map((m) => [kinds[m.kind] ?? m.kind, fmtQty(m.quantity), m.value])} />
      <H>{t("mgmt.finance.heading.top_inventory_items")}</H>
      <Table head={[t("mgmt.inv_top.head.item"), t("mgmt.inv_top.head.quantity"), t("mgmt.inv_top.head.value")]} rows={r.inventory.top.map((p) => [productLabel(p), fmtQty(p.quantity, p.unit), p.value])} />
    </>
  );
}

function CashFlow({ r, t }: { r: CashFlowReport; t: (k: string) => string }) {
  const { locale } = useLocale();
  const lineLabel = (l: CashFlowReport["sections"][string]["lines"][number]) =>
    l.kind === "net_income" ? t("mgmt.cf.row.net_income") : l.kind === "adjustment" ? t(`mgmt.cf.row.${l.adjustment}`) : `${t("mgmt.cf.row.change_in").replace("{}", `${l.accountCode ?? ""} ${localName({ name: l.accountName ?? l.label, nameAr: l.accountNameAr }, locale)}`.trim())}${l.unclassified ? ` — ${t("mgmt.cf.unclassified-tag")}` : ""}`;
  const cashName = (a: CashFlowReport["cashAccounts"][number]) => localName(a, locale);
  const sectionLabels: Record<string, string> = { operating: t("mgmt.cf.section.operating"), investing: t("mgmt.cf.section.investing"), financing: t("mgmt.cf.section.financing") };
  return (
    <>
      {r.unclassified.length > 0 && (
        <p role="note" className="card p-3 text-sm font-bold text-united-warn">{t("mgmt.cf.unclassified-note").replace("{}", r.unclassified.map((u) => `${u.code} ${localName(u, locale)}`).join("، "))}</p>
      )}
      {(r.openingEntriesInRange ?? 0) > 0 && <p role="note" className="card p-3 text-sm text-united-muted">{t("mgmt.cf.opening-note").replace("{n}", String(r.openingEntriesInRange))}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label={t("mgmt.cf.tile.op_total")} value={fmtMoney(r.sections.operating.total)} tone={Number(r.sections.operating.total) >= 0 ? "good" : "bad"} />
        <Tile label={t("mgmt.cf.tile.inv_total")} value={fmtMoney(r.sections.investing.total)} tone={Number(r.sections.investing.total) >= 0 ? "good" : "bad"} />
        <Tile label={t("mgmt.cf.tile.fin_total")} value={fmtMoney(r.sections.financing.total)} tone={Number(r.sections.financing.total) >= 0 ? "good" : "bad"} />
      </div>
      {["operating", "investing", "financing"].map((key) => (
        <div key={key}>
          <H>{sectionLabels[key]}</H>
          <Table head={[t("mgmt.cf.table.head.description"), t("mgmt.cf.table.head.amount")]} rows={[
            ...r.sections[key].lines.map((l) => [lineLabel(l), fmtMoney(l.amount)]),
            [t("mgmt.cf.table.row.total"), fmtMoney(r.sections[key].total)],
          ]} total />
        </div>
      ))}
      <H>{t("mgmt.cf.heading.cash_change")}</H>
      <Table head={[t("mgmt.cf.table.head.description"), t("mgmt.cf.table.head.amount")]} rows={[
        [t("mgmt.cf.row.net_flow"), fmtMoney(r.netCashFlow)],
        ...r.cashAccounts.map((a) => [t("mgmt.cf.row.opening").replace("{}", cashName(a)), fmtMoney(a.opening)]),
        ...r.cashAccounts.map((a) => [t("mgmt.cf.row.closing").replace("{}", cashName(a)), fmtMoney(a.closing)]),
        ...r.cashAccounts.map((a) => [t("mgmt.cf.row.change").replace("{}", cashName(a)), fmtMoney(a.change)]),
        [t("mgmt.cf.row.total_opening"), fmtMoney(r.cashTotal.opening)],
        [t("mgmt.cf.row.total_closing"), fmtMoney(r.cashTotal.closing)],
        [t("mgmt.cf.row.net_change"), fmtMoney(r.cashTotal.change)],
      ]} />
    </>
  );
}

function Operations({ r, t, exCodes }: { r: OperationsReport; t: (k: string) => string; exCodes: Record<string, string> }) {
  const f = r.fulfilment;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={t("mgmt.ops.tile.orders")} value={String(f.orders)} />
        <Tile label={t("mgmt.ops.tile.dispatched")} value={String(f.dispatched)} />
        <Tile label={t("mgmt.ops.tile.prepared_pct")} value={f.preparedPct ? `${f.preparedPct}%` : "—"} />
        <Tile label={t("mgmt.ops.tile.delivery_pct")} value={f.delivery.deliveredPct ? `${f.delivery.deliveredPct}%` : "—"} tone="good" />
        <Tile label={t("mgmt.ops.tile.trips")} value={`${r.loading.completed}/${r.loading.trips}`} />
        <Tile label={t("mgmt.ops.tile.avg_load_min")} value={r.loading.avgLoadMinutes == null ? "—" : String(r.loading.avgLoadMinutes)} />
        <Tile label={t("mgmt.ops.tile.dispatch_to_done_min")} value={r.loading.avgDispatchToDoneMinutes == null ? "—" : String(r.loading.avgDispatchToDoneMinutes)} />
        <Tile label={t("mgmt.ops.tile.cancelled")} value={String(f.cancelled)} />
      </div>
      <H>{t("mgmt.ops.heading.delivery")}</H>
      <Table head={["", t("mgmt.ops.table.delivery.head.shipped"), t("mgmt.ops.table.delivery.head.delivered"), t("mgmt.ops.table.delivery.head.shortage"), t("mgmt.ops.table.delivery.head.damaged"), t("mgmt.ops.table.delivery.head.rejected")]} rows={[[t("mgmt.ops.table.delivery.qty_label"), fmtQty(f.delivery.shipped), fmtQty(f.delivery.delivered), fmtQty(f.delivery.shortage), fmtQty(f.delivery.damaged), fmtQty(f.delivery.rejected)]]} />
      <Table head={[t("mgmt.ops.table.driver.head.driver"), t("mgmt.ops.table.driver.head.delivered"), t("mgmt.ops.table.driver.head.partial"), t("mgmt.ops.table.driver.head.failed"), t("mgmt.ops.table.driver.head.pending")]} rows={r.delivery.map((d) => [d.driver, d.delivered, d.partial, d.failed, d.pending])} />
      <H>{t("mgmt.ops.heading.preparation")}</H>
      <Table head={[t("mgmt.ops.table.prep.head.preparer"), t("mgmt.ops.table.prep.head.orders"), t("mgmt.ops.table.prep.head.avg_minutes")]} rows={r.preparation.map((p) => [p.preparer, p.orders, p.avgMinutes])} />
      <H>{t("mgmt.ops.heading.exceptions")}</H>
      <Table head={[t("mgmt.ops.table.exc.head.type"), t("mgmt.ops.table.exc.head.open"), t("mgmt.ops.table.exc.head.resolved"), t("mgmt.ops.table.exc.head.avg_hours")]} rows={r.exceptions.map((e) => [exCodes[e.type] ?? e.type, e.open, e.resolved, e.avgHoursToResolve])} />
      <H>{t("mgmt.ops.heading.inventory_aging")}</H>
      <Table head={[t("mgmt.ops.table.aging.head.age_bucket"), t("mgmt.ops.table.aging.head.quantity"), t("mgmt.ops.table.aging.head.lots")]} rows={r.inventoryAging.map((a) => [a.bucket, fmtQty(a.quantity), a.lots])} />
    </>
  );
}
