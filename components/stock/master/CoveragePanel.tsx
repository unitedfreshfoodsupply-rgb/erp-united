"use client";

import { useState } from "react";
import { useLocale } from "@/lib/locale";
import { localName, otherLocalName } from "@/lib/locale/names";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { EmptyState } from "@/components/States";
import { invalidateStockData } from "@/lib/stockInvalidation";
import type { CoverageDTO, CoverageRowDTO, StockProductDTO } from "@/lib/stock-client-types";

/**
 * Mapping coverage: every distinct product name orders actually use, and whether the
 * master recognises it.
 *
 * Unmapped names sort first because they are the work. Each one is a line that no
 * stock decision can be based on until a human says what it means.
 */
export function CoveragePanel({
  coverage,
  products,
  canManage,
}: {
  coverage: CoverageDTO;
  products: StockProductDTO[];
  canManage: boolean;
}) {
  const { t } = useLocale();
  const [filter, setFilter] = useState<"all" | "unmapped" | "mapped" | "issues">("all");
  const { summary, rows } = coverage;

  const visible = rows.filter((r) => {
    if (filter === "unmapped") return r.status === "unmapped";
    if (filter === "mapped") return r.status === "mapped";
    if (filter === "issues") return r.status === "ambiguous" || r.inactiveMapping || r.unitMismatch;
    return true;
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="card p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          <Metric label={t("stock.coverage.distinct_names")} value={summary.distinctNames} />
          <Metric label={t("stock.coverage.mapped")} value={summary.mapped} tone="text-united-green" />
          <Metric label={t("stock.coverage.unmapped")} value={summary.unmapped} tone={summary.unmapped ? "text-united-warn" : "text-united-muted"} />
          <Metric label={t("stock.coverage.ambiguous")} value={summary.ambiguous} tone={summary.ambiguous ? "text-united-danger" : "text-united-muted"} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-center mt-3 pt-3 border-t border-united-border">
          <Metric label={t("stock.coverage.order_lines")} value={summary.totalLines} />
          <Metric label={t("stock.coverage.mapped_lines")} value={summary.mappedLines} tone="text-united-green" />
          <Metric
            label={t("stock.coverage.inactive_mappings")}
            value={summary.inactiveMappings}
            tone={summary.inactiveMappings ? "text-united-warn" : "text-united-muted"}
          />
        </div>
        {summary.unitMismatches > 0 && (
          <p className="text-united-warn font-bold text-sm mt-3">
            {t("stock.coverage.unit_mismatch_warning").replace("{count}", String(summary.unitMismatches))}
          </p>
        )}
        <p className="text-[11px] font-bold text-united-muted mt-3">
          {t("stock.coverage.info_note")}
        </p>
      </div>

      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        {([
          ["all", `${t("stock.filter.all").replace("{count}", String(rows.length))}`],
          ["unmapped", `${t("stock.filter.unmapped").replace("{count}", String(summary.unmapped))}`],
          ["mapped", `${t("stock.filter.mapped").replace("{count}", String(summary.mapped))}`],
          ["issues", `${t("stock.filter.issues").replace("{count}", String(summary.ambiguous + summary.inactiveMappings + summary.unitMismatches))}`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-4 py-2 rounded-full text-sm font-extrabold whitespace-nowrap shrink-0 transition ${
              filter === key ? "bg-united-green text-white" : "bg-united-dark/5 text-united-dark"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {visible.length === 0 && (
        <EmptyState
          icon={rows.length === 0 ? "📋" : "✅"}
          title={rows.length === 0 ? t("stock.empty.no-items") : t("stock.empty.filtered")}
        />
      )}

      {visible.map((row) => (
        <CoverageRow
          key={`${row.productName}-${row.unit}`}
          row={row}
          products={products}
          canManage={canManage}
        />
      ))}
    </div>
  );
}

function Metric({ label, value, tone = "text-united-dark" }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div dir="ltr" className={`text-2xl font-extrabold ${tone}`}>{value}</div>
      <div className="text-[11px] font-bold text-united-muted">{label}</div>
    </div>
  );
}

function CoverageRow({
  row,
  products,
  canManage,
}: {
  row: CoverageRowDTO;
  products: StockProductDTO[];
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t, locale } = useLocale();
  const [linking, setLinking] = useState(false);
  const [productId, setProductId] = useState("");
  const [createAlias, setCreateAlias] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeProducts = products.filter((p) => p.active);

  async function run(fn: () => Promise<unknown>, msg: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      invalidateStockData(qc);
      await qc.invalidateQueries({ queryKey: ["stock", "coverage"] });
      toast.show(msg, "success");
      setLinking(false);
    } catch (err) {
      const m = err instanceof ApiClientError && err.message ? err.message : t("ui.error.generic");
      setError(m);
      toast.show(m, "error");
    } finally {
      setBusy(false);
    }
  }

  const badge =
    row.status === "mapped"
      ? { text: t("stock.badge.mapped"), cls: "bg-united-green/10 text-united-green" }
      : row.status === "ambiguous"
      ? { text: t("stock.badge.ambiguous"), cls: "bg-united-danger/10 text-united-danger" }
      : { text: t("stock.badge.unmapped"), cls: "bg-united-warn/10 text-united-warn" };

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-extrabold text-united-dark">{row.productName}</span>
            <span dir="ltr" className="text-xs font-bold text-united-muted">{row.unit}</span>
            <span className={`text-[11px] font-extrabold px-2 py-0.5 rounded-full ${badge.cls}`}>
              {badge.text}
            </span>
          </div>
          <div className="text-xs font-bold text-united-muted mt-0.5">
            {t("stock.row.line_info").replace("{linesCount}", String(row.lineCount)).replace("{ordersCount}", String(row.orderCount))}
          </div>
          {row.product && (
            <div className="text-sm font-bold text-united-green mt-1">
              ← {localName(row.product, locale)}
              {otherLocalName(row.product, locale) ? ` · ${otherLocalName(row.product, locale)}` : ""}
            </div>
          )}
        </div>
      </div>

      {row.inactiveMapping && (
        <p className="text-united-warn font-bold text-sm mt-2">{t("coverage.inactive-mapping")}</p>
      )}
      {row.unitMismatch && row.product && (
        <p className="text-united-warn font-bold text-sm mt-2">
          {t("coverage.unit-mismatch", { orderUnit: row.unit, productUnit: row.product.unit })}
        </p>
      )}
      {row.status === "ambiguous" && (
        <p className="text-united-danger font-bold text-sm mt-2">
          ⚠️ {t("stock.row.needs_resolution")} — {row.candidates.map((c) => localName(c, locale)).join(locale === "en" ? ", " : "، ")}
        </p>
      )}

      {error && <p className="text-united-danger font-bold text-sm mt-2">{error}</p>}

      {canManage && (
        <div className="mt-3">
          {!linking ? (
            <div className="flex gap-2">
              {row.status !== "mapped" && (
                <button onClick={() => setLinking(true)} className="btn-primary text-sm px-4">
                  {t("coverage.link")}
                </button>
              )}
              {row.status === "mapped" && (
                <>
                  <button onClick={() => setLinking(true)} className="btn-secondary text-sm px-4">
                    {t("coverage.relink")}
                  </button>
                  <button
                    onClick={() => {
                      if (!window.confirm(t("coverage.unlink-confirm", { name: row.productName, product: row.product ? localName(row.product, locale) : "" }))) return;
                      run(
                        () =>
                          apiFetchDelete("/api/stock/products/mapping", {
                            product_name: row.productName,
                            remove_alias: true,
                          }),
                        t("coverage.unlinked")
                      );
                    }}
                    disabled={busy}
                    className="btn-danger text-sm px-4"
                  >
                    {t("coverage.unlink")}
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <select
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                className="field font-bold"
              >
                <option value="">{t("stock.select.placeholder")}</option>
                {activeProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {localName(p, locale)}{otherLocalName(p, locale) ? ` · ${otherLocalName(p, locale)}` : ""} ({p.unit})
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={createAlias}
                  onChange={(e) => setCreateAlias(e.target.checked)}
                  className="w-5 h-5 accent-[#3f8f3f]"
                />
                <span className="text-sm font-bold text-united-dark">
                  {t("coverage.create-alias")}
                </span>
              </label>
              <p className="text-[11px] font-bold text-united-muted">
                {t("coverage.audit-note")}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() =>
                    run(
                      () =>
                        apiPost("/api/stock/products/mapping", {
                          product_name: row.productName,
                          product_id: productId,
                          create_alias: createAlias,
                        }),
                      t("coverage.linked")
                    )
                  }
                  disabled={busy || !productId}
                  className="btn-primary flex-1 text-sm"
                >
                  {busy ? t("coverage.linking") : t("coverage.confirm")}
                </button>
                <button onClick={() => setLinking(false)} className="btn-secondary flex-1 text-sm">
                  {t("coverage.back")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** DELETE with a body — the mapping endpoint identifies its target by name, not path.
 * Goes through apiFetch so it carries the session token, the user's language and the
 * shared error handling like every other call. */
function apiFetchDelete(path: string, body: unknown) {
  return apiFetch(path, { method: "DELETE", body: JSON.stringify(body) });
}
