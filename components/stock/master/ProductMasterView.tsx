"use client";

import { useState } from "react";
import { useLocale } from "@/lib/locale";
import { PageHeader } from "@/components/ui/PageHeader";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { LoadingState, ErrorState } from "@/components/States";
import { usePermissions } from "@/lib/use-session";
import { ProductsPanel } from "@/components/stock/master/ProductsPanel";
import { CoveragePanel } from "@/components/stock/master/CoveragePanel";
import { SuppliersPanel } from "@/components/stock/master/SuppliersPanel";
import { StatTile } from "@/components/stock/StatTile";
import type { CoverageDTO, StockProductDTO } from "@/lib/stock-client-types";

type Tab = "products" | "coverage" | "suppliers";

/**
 * Product Master.
 *
 * Two questions this screen exists to answer: what does the business officially call
 * each product, and how much of what orders actually say is understood. The second is
 * the one that matters operationally — an order line the master cannot identify is a
 * line no stock decision can ever be based on.
 */
export function ProductMasterView() {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>("products");
  const { can } = usePermissions();
  const canManage = can("stock.manage_products");

  const productsQ = useQuery({
    queryKey: ["stock", "products", "all"],
    queryFn: () => apiFetch<{ products: StockProductDTO[] }>("/api/stock/products?all=1"),
  });
  const coverageQ = useQuery({
    queryKey: ["stock", "coverage"],
    queryFn: () => apiFetch<CoverageDTO>("/api/stock/products/coverage"),
  });

  const summary = coverageQ.data?.summary;
  const products = productsQ.data?.products ?? [];

  return (
    <div className="page-narrow max-w-4xl">
      <PageHeader title={t("master.title")} description={t("master.description")} />

      {summary && (
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatTile label={t("master.stat-tile-products")} value={String(products.length)} sub={`${products.filter((p) => p.active).length} ${t("master.stat-active")}`} />
          <StatTile label={t("master.stat-order-names")} value={String(summary.distinctNames)} />
          <StatTile label={t("master.stat-connected")} value={String(summary.mapped)} tone={summary.mapped > 0 ? "good" : "muted"} />
          <StatTile
            label={t("master.stat-disconnected")}
            value={String(summary.unmapped)}
            tone={summary.unmapped > 0 ? "warn" : "good"}
            sub={summary.ambiguous > 0 ? `${summary.ambiguous} ${t("master.stat-ambiguous")}` : undefined}
          />
        </section>
      )}

      <div className="flex gap-2">
        <TabButton active={tab === "products"} onClick={() => setTab("products")} label={t("master.tab-products")} />
        <TabButton
          active={tab === "coverage"}
          onClick={() => setTab("coverage")}
          label={summary && summary.unmapped > 0 ? `${t("master.tab-coverage")} (${summary.unmapped})` : t("master.tab-coverage")}
        />
        <TabButton active={tab === "suppliers"} onClick={() => setTab("suppliers")} label={t("master.tab-suppliers")} />
      </div>

      {tab === "products" && (
        <>
          {productsQ.isLoading && <LoadingState label={t("master.loading-products")} />}
          {productsQ.isError && <ErrorState message={errorMessage(productsQ.error)} onRetry={() => productsQ.refetch()} />}
          {productsQ.data && <ProductsPanel products={products} canManage={canManage} />}
        </>
      )}

      {tab === "coverage" && (
        <>
          {coverageQ.isLoading && <LoadingState label={t("master.loading-coverage")} />}
          {coverageQ.isError && <ErrorState message={errorMessage(coverageQ.error)} onRetry={() => coverageQ.refetch()} />}
          {coverageQ.data && (
            <CoveragePanel coverage={coverageQ.data} products={products} canManage={canManage} />
          )}
        </>
      )}

      {tab === "suppliers" && <SuppliersPanel canManage={can("stock.manage_suppliers")} />}
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="chip flex-1"
    >
      {label}
    </button>
  );
}
