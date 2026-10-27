"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { ErrorState, LoadingState } from "@/components/States";
import { todayLocalISO } from "@/lib/localDate";
import { fmtMoney, fmtQty } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

/** Management reports: finance (sales, margin, balances, stock value, cash, P&L) or operations (fulfilment, prep, loading, delivery, exceptions, stock age). */

const Tile = ({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) => (
  <div className="card p-3">
    <div className="text-xs font-bold text-united-muted">{label}</div>
    <div dir="ltr" className={`text-xl font-extrabold ${tone === "good" ? "text-united-green" : tone === "bad" ? "text-united-danger" : ""}`}>{value}</div>
  </div>
);
const Table = ({ head, rows }: { head: string[]; rows: (string | number | null)[][] }) => (
  <div className="card p-3 overflow-x-auto">
    <table className="w-full text-sm font-bold">
      <thead><tr className="text-xs text-united-muted">{head.map((h, i) => <th key={i} className={`p-1 ${i ? "text-end" : "text-start"}`}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-united-dark/5">{r.map((c, j) => <td key={j} className={`p-1 ${j ? "text-end" : ""}`} dir={j ? "ltr" : undefined}>{c ?? "—"}</td>)}</tr>)}</tbody>
    </table>
  </div>
);
const H = ({ children }: { children: React.ReactNode }) => <h2 className="text-lg font-extrabold mt-2">{children}</h2>;

export function ManagementView({ kind }: { kind: "finance" | "operations" | "cash-flow" }) {
  const { t } = useLocale();
  const [from, setFrom] = useState(`${todayLocalISO().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayLocalISO());
  const apiKind = kind === "cash-flow" ? "cash-flow" : kind;

  // Localized dictionaries for kind/experience code lookups
  const KIND: Record<string, string> = {
    intake: t("mgmt.kinds.intake"),
    intake_correction: t("mgmt.kinds.intake_correction"),
    intake_void: t("mgmt.kinds.intake_void"),
    adjustment: t("mgmt.kinds.adjustment"),
    transfer_out: t("mgmt.kinds.transfer_out"),
    transfer_in: t("mgmt.kinds.transfer_in"),
    issue: t("mgmt.kinds.issue"),
    customer_return: t("mgmt.kinds.customer_return"),
    supplier_return: t("mgmt.kinds.supplier_return"),
    scrap: t("mgmt.kinds.scrap"),
  };
  const EX: Record<string, string> = {
    shortage: t("mgmt.exceptions.shortage"),
    damage: t("mgmt.exceptions.damage"),
    rejection: t("mgmt.exceptions.rejection"),
    delivery_failure: t("mgmt.exceptions.delivery_failure"),
    loading_discrepancy: t("mgmt.exceptions.loading_discrepancy"),
  };

  const q = useQuery({ queryKey: ["management", kind, from, to], queryFn: () => apiFetch<{ report: any }>(`/api/management/${apiKind}?from=${from}&to=${to}`) });
  return (
    <div className="page-container">
      <h1 className="page-title">
        {kind === "finance" ? t("management.title.finance") : kind === "cash-flow" ? t("management.title.cashflow") : t("management.title.operations")}
      </h1>
      <div className="flex gap-2"><input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      <div className="flex gap-2 mb-2 flex-wrap">
        <a href="/management/finance" className={`btn-sm ${kind === "finance" ? "btn-primary" : "btn-ghost"}`}>{t("mgmt.finance.tab.finance")}</a>
        <a href="/management/cash-flow" className={`btn-sm ${kind === "cash-flow" ? "btn-primary" : "btn-ghost"}`}>{t("mgmt.finance.tab.cashflow")}</a>
      </div>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && (kind === "cash-flow" ? <CashFlow r={q.data.report} t={t} /> : kind === "finance" ? <Finance r={q.data.report} t={t} kinds={KIND} /> : <Operations r={q.data.report} t={t} exCodes={EX} />)}
    </div>
  );
}

function Finance({ r, t, kinds }: { r: any; t: (k: string) => string; kinds: Record<string, string> }) {
  const { locale } = useLocale();
  // Report rows carry `product` (legacy Arabic-first label) plus productNameAr/En.
  const productLabel = (p: { product: string; productNameAr?: string | null; productNameEn?: string | null }) =>
    p.productNameEn || p.productNameAr ? localName({ name: p.productNameEn, nameAr: p.productNameAr }, locale) : p.product;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile label={t("mgmt.finance.tile.net_sales")} value={fmtMoney(r.sales.revenue)} />
        <Tile label={t("mgmt.finance.tile.cost_of_sales")} value={fmtMoney(r.sales.cost)} />
        <Tile label={r.sales.grossMarginPct ? `${t("mgmt.finance.tile.gross_margin")} (${r.sales.grossMarginPct}%)` : t("mgmt.finance.tile.gross_margin")} value={fmtMoney(r.sales.grossMargin)} tone={Number(r.sales.grossMargin) >= 0 ? "good" : "bad"} />
        <Tile label={t("mgmt.finance.tile.cash_banks")} value={fmtMoney(r.cash.total)} />
        <Tile label={t("mgmt.finance.tile.receivables")} value={fmtMoney(r.receivables.totals.total)} />
        <Tile label={t("mgmt.finance.tile.payables")} value={fmtMoney(r.payables.totals.total)} />
        <Tile label={t("mgmt.finance.tile.inventory_value")} value={fmtMoney(r.inventory.value)} />
        <Tile label={t("mgmt.finance.tile.net_profit")} value={fmtMoney(r.profitAndLoss.net)} tone={Number(r.profitAndLoss.net) >= 0 ? "good" : "bad"} />
      </div>
      <H>{t("mgmt.finance.heading.margin_by_product")}</H>
      <Table head={[t("mgmt.finance.table.product.item"), t("mgmt.finance.table.product.quantity"), t("mgmt.finance.table.product.sales"), t("mgmt.finance.table.product.cost"), t("mgmt.finance.table.product.margin"), t("mgmt.finance.table.product.pct"), t("mgmt.finance.table.product.cost_unknown")]} rows={r.sales.byProduct.map((p: any) => [productLabel(p), fmtQty(p.quantity), p.revenue, p.cost, p.margin, p.marginPct, Number(p.costUnknownQty ?? 0) > 0 ? fmtQty(p.costUnknownQty) : "—"])} />
      <p className="text-xs font-bold text-united-muted">{t("mgmt.finance.footnote.cost_unknown")}</p>
      <H>{t("mgmt.finance.heading.top_customers")}</H>
      <Table head={[t("mgmt.finance.head.customer"), t("mgmt.finance.head.invoices"), t("mgmt.finance.tile.net_sales")]} rows={r.sales.byCustomer.map((c: any) => [localName(c, locale), c.invoices, c.net])} />
      <H>{t("mgmt.finance.heading.debts_aging")}</H>
      <Table head={["", t("mgmt.finance.table.debts.bucket_current"), "1–30", "31–60", "61–90", "+90", t("mgmt.finance.table.debts.total")]} rows={[[t("mgmt.finance.table.debts.labels.customers"), r.receivables.totals.current, r.receivables.totals.d1_30, r.receivables.totals.d31_60, r.receivables.totals.d61_90, r.receivables.totals.d90_plus, r.receivables.totals.total], [t("mgmt.finance.table.debts.labels.suppliers"), r.payables.totals.current, r.payables.totals.d1_30, r.payables.totals.d31_60, r.payables.totals.d61_90, r.payables.totals.d90_plus, r.payables.totals.total]]} />
      <H>{t("mgmt.finance.heading.income_statement")}</H>
      <Table head={[t("mgmt.is.head.account"), t("mgmt.is.head.amount")]} rows={[...r.profitAndLoss.lines.map((l: any) => [`${l.code} · ${localName(l, locale)}`, l.amount]), [t("mgmt.finance.tile.net_profit"), r.profitAndLoss.net]]} />
      <H>{t("mgmt.finance.heading.stock_movement")}</H>
      <Table head={[t("mgmt.stock_move.head.type"), t("mgmt.stock_move.head.quantity"), t("mgmt.stock_move.head.value")]} rows={r.stockMovement.map((m: any) => [kinds[m.kind] ?? m.kind, fmtQty(m.quantity), m.value])} />
      <H>{t("mgmt.finance.heading.top_inventory_items")}</H>
      <Table head={[t("mgmt.inv_top.head.item"), t("mgmt.inv_top.head.quantity"), t("mgmt.inv_top.head.value")]} rows={r.inventory.top.map((p: any) => [productLabel(p), fmtQty(p.quantity, p.unit), p.value])} />
    </>
  );
}

function CashFlow({ r, t }: { r: any; t: (k: string) => string }) {
  const sectionLabels: Record<string, string> = { operating: t("mgmt.cf.section.operating"), investing: t("mgmt.cf.section.investing"), financing: t("mgmt.cf.section.financing") };
  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <Tile label={t("mgmt.cf.tile.op_total")} value={fmtMoney(r.sections.operating.total)} tone={Number(r.sections.operating.total) >= 0 ? "good" : "bad"} />
        <Tile label={t("mgmt.cf.tile.inv_total")} value={fmtMoney(r.sections.investing.total)} tone={Number(r.sections.investing.total) >= 0 ? "good" : "bad"} />
        <Tile label={t("mgmt.cf.tile.fin_total")} value={fmtMoney(r.sections.financing.total)} tone={Number(r.sections.financing.total) >= 0 ? "good" : "bad"} />
      </div>
      {["operating", "investing", "financing"].map((key) => (
        <div key={key}>
          <H>{sectionLabels[key]}</H>
          <Table head={[t("mgmt.cf.table.head.description"), t("mgmt.cf.table.head.amount")]} rows={[
            ...r.sections[key].lines.map((l: any) => [l.label, fmtMoney(l.amount)]),
            [t("mgmt.cf.table.row.total"), fmtMoney(r.sections[key].total)],
          ]} />
        </div>
      ))}
      <H>{t("mgmt.cf.heading.cash_change")}</H>
      <Table head={[t("mgmt.cf.table.head.description"), t("mgmt.cf.table.head.amount")]} rows={[
        [t("mgmt.cf.row.net_flow"), fmtMoney(r.netCashFlow)],
        ...r.cashAccounts.map((a: any) => [t("mgmt.cf.row.opening").replace("{}", a.name), fmtMoney(a.opening)]),
        ...r.cashAccounts.map((a: any) => [t("mgmt.cf.row.closing").replace("{}", a.name), fmtMoney(a.closing)]),
        ...r.cashAccounts.map((a: any) => [t("mgmt.cf.row.change").replace("{}", a.name), fmtMoney(a.change)]),
        [t("mgmt.cf.row.total_opening"), fmtMoney(r.cashTotal.opening)],
        [t("mgmt.cf.row.total_closing"), fmtMoney(r.cashTotal.closing)],
        [t("mgmt.cf.row.net_change"), fmtMoney(r.cashTotal.change)],
      ]} />
    </>
  );
}

function Operations({ r, t, exCodes }: { r: any; t: (k: string) => string; exCodes: Record<string, string> }) {
  const f = r.fulfilment;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
      <Table head={[t("mgmt.ops.table.driver.head.driver"), t("mgmt.ops.table.driver.head.delivered"), t("mgmt.ops.table.driver.head.partial"), t("mgmt.ops.table.driver.head.failed"), t("mgmt.ops.table.driver.head.pending")]} rows={r.delivery.map((d: any) => [d.driver, d.delivered, d.partial, d.failed, d.pending])} />
      <H>{t("mgmt.ops.heading.preparation")}</H>
      <Table head={[t("mgmt.ops.table.prep.head.preparer"), t("mgmt.ops.table.prep.head.orders"), t("mgmt.ops.table.prep.head.avg_minutes")]} rows={r.preparation.map((p: any) => [p.preparer, p.orders, p.avgMinutes])} />
      <H>{t("mgmt.ops.heading.exceptions")}</H>
      <Table head={[t("mgmt.ops.table.exc.head.type"), t("mgmt.ops.table.exc.head.open"), t("mgmt.ops.table.exc.head.resolved"), t("mgmt.ops.table.exc.head.avg_hours")]} rows={r.exceptions.map((e: any) => [exCodes[e.type] ?? e.type, e.open, e.resolved, e.avgHoursToResolve])} />
      <H>{t("mgmt.ops.heading.inventory_aging")}</H>
      <Table head={[t("mgmt.ops.table.aging.head.age_bucket"), t("mgmt.ops.table.aging.head.quantity"), t("mgmt.ops.table.aging.head.lots")]} rows={r.inventoryAging.map((a: any) => [a.bucket, fmtQty(a.quantity), a.lots])} />
    </>
  );
}
