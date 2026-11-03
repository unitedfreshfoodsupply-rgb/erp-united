"use client";

import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { localName, otherLocalName } from "@/lib/locale/names";
import { unitLabel } from "@/lib/format";
import { maySeeSection } from "@/lib/profiles/access";
import { ErrorState, LoadingState } from "@/components/States";
import { errorMessage } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { ProductStock } from "@/components/stock/inventory/InventoryView";
import { DocSection, Figures, ProfileTabs, useSummary, useTabParam } from "./ProfileParts";

/**
 * One product, everything about it (Nov 2026): what it is and how it is counted and packed,
 * what is where now, every movement with its document, who supplied it and at what cost,
 * who bought it and at what price, and its price history. Each tab is gated on the server.
 */

type Tab = "overview" | "movements" | "purchases" | "sales" | "prices";
type Summary = {
  product: { id: string; sku: string | null; name: string; nameAr: string | null; unit: string; category: string | null; active: boolean; stockTracked: boolean; costingMethod: string; removalStrategy: string; shelfLifeDays: number | null; coldChain: boolean; salesTaxCode: string; minStockQty: string | null; reorderPointQty: string | null; maxStockQty: string | null; aliases: { alias: string }[]; packagings: { uomCode: string; qtyInBaseUnit: string; barcode: string | null }[] };
  receipts: number; lastReceiptDate: string | null; suppliers: number; orderLines?: number; lastOrderDate?: string | null; customers?: number;
};

export function ProductProfile({ productId }: { productId: string }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const summary = useSummary<Summary>("product", productId);
  const sees = (s: string) => maySeeSection("product", s, can);
  const items: { key: Tab; label: string }[] = [
    { key: "overview", label: t("profile.tab.overview") },
    { key: "movements", label: t("profile.tab.movements") },
    { key: "purchases", label: t("profile.tab.purchases") },
    ...(sees("sales") ? [{ key: "sales" as Tab, label: t("profile.tab.sales") }] : []),
    ...(sees("prices") ? [{ key: "prices" as Tab, label: t("profile.tab.prices") }] : []),
  ];
  const [tab, setTab] = useTabParam(items.map((i) => i.key), "overview");
  if (summary.isLoading) return <div className="page-container"><LoadingState /></div>;
  if (summary.isError || !summary.data) return <div className="page-container"><ErrorState message={errorMessage(summary.error)} onRetry={() => summary.refetch()} /></div>;
  const s = summary.data, p = s.product;
  const facts: [string, React.ReactNode][] = [
    [t("profile.product.sku"), p.sku ? <span dir="ltr">{p.sku}</span> : null],
    [t("profile.product.category"), p.category],
    [t("profile.product.unit"), unitLabel(p.unit)],
    [t("profile.product.packaging"), p.packagings.length ? p.packagings.map((k) => `1 ${unitLabel(k.uomCode)} = ${Number(k.qtyInBaseUnit)} ${unitLabel(p.unit)}`).join(" · ") : null],
    [t("profile.product.costing"), t(`stock.costing.${p.costingMethod}`)],
    [t("profile.product.picking"), p.removalStrategy === "fefo" ? "FEFO" : "FIFO"],
    [t("profile.product.shelf-life"), p.shelfLifeDays != null ? t("profile.product.days", { n: p.shelfLifeDays }) : null],
    [t("profile.product.levels"), [p.minStockQty, p.reorderPointQty, p.maxStockQty].some((x) => x != null) ? <span dir="ltr">{[p.minStockQty, p.reorderPointQty, p.maxStockQty].map((x) => (x == null ? "—" : Number(x))).join(" / ")}</span> : null],
    [t("profile.product.tax"), <span key="tax" dir="ltr">{p.salesTaxCode}</span>],
    [t("profile.product.aliases"), p.aliases.length ? p.aliases.map((a) => a.alias).join("، ") : null],
  ];
  return (
    <div className="page-container">
      <PageHeader
        back={{ href: "/stock/inventory", label: t("profile.back.stock") }}
        title={localName(p, locale)}
        description={<>{p.sku ? <span dir="ltr">{p.sku}</span> : null}{otherLocalName(p, locale) ? `${p.sku ? " · " : ""}${otherLocalName(p, locale)}` : ""}</>}
        actions={<>{!p.active && <StatusPill tone="neutral" size="md">{t("sales.label.inactive")}</StatusPill>}{p.coldChain && <StatusPill tone="info" size="md">{t("profile.product.cold-chain")}</StatusPill>}{!p.stockTracked && <StatusPill tone="neutral" size="md">{t("profile.product.not-tracked")}</StatusPill>}</>}
      />
      <Figures items={[
        { label: t("profile.fig.receipts"), value: s.receipts.toLocaleString("en-US") },
        { label: t("profile.fig.suppliers"), value: s.suppliers.toLocaleString("en-US") },
        { label: t("profile.fig.last-receipt-goods"), value: s.lastReceiptDate ? <span dir="ltr">{s.lastReceiptDate}</span> : null },
        { label: t("profile.fig.order-lines"), value: s.orderLines == null ? null : s.orderLines.toLocaleString("en-US") },
        { label: t("profile.fig.customers"), value: s.customers == null ? null : s.customers.toLocaleString("en-US") },
        { label: t("profile.fig.last-order"), value: s.lastOrderDate ? <span dir="ltr">{s.lastOrderDate}</span> : null },
      ]} />
      <ProfileTabs value={tab} onChange={setTab} items={items} />
      {tab === "overview" && (
        <div className="flex flex-col gap-4">
          <section className="card p-4">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              {facts.map(([k, v]) => <div key={k}><dt className="text-xs font-extrabold text-united-muted">{k}</dt><dd className="font-bold">{v || "—"}</dd></div>)}
            </dl>
          </section>
          <ProductStock productId={productId} />
        </div>
      )}
      {tab === "movements" && <DocSection kind="product" id={productId} section="movements" movement />}
      {tab === "purchases" && <DocSection kind="product" id={productId} section="purchases" groupsTitle={t("profile.by-supplier")} linesTitle={t("profile.receipts-lines")} />}
      {tab === "sales" && <DocSection kind="product" id={productId} section="sales" groupsTitle={t("profile.by-customer")} linesTitle={t("profile.order-lines")} />}
      {tab === "prices" && <DocSection kind="product" id={productId} section="prices" />}
    </div>
  );
}
