"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiPost, apiPatch, ApiClientError } from "@/lib/api-client";
import { apiFetch } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { EmptyState } from "@/components/States";
import { invalidateStockData } from "@/lib/stockInvalidation";
import { useLocale } from "@/lib/locale";
import { localName, otherLocalName } from "@/lib/locale/names";
import type { StockProductDTO } from "@/lib/stock-client-types";
import { useDialogs } from "@/components/ui/Dialog";
import { unitLabel } from "@/lib/format";

/** Product Master entries: canonical identity plus every name that resolves to it. */
export function ProductsPanel({
  products,
  canManage,
}: {
  products: StockProductDTO[];
  canManage: boolean;
}) {
  const { t } = useLocale();
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {canManage &&
        (creating ? (
          <ProductForm onDone={() => setCreating(false)} />
        ) : (
          <button onClick={() => setCreating(true)} className="btn-primary self-start text-sm">
            {t("stock.btn-create-product")}
          </button>
        ))}

      {products.length === 0 && (
        <EmptyState
          icon="📖"
          title={t("stock.empty-catalog")}
        />
      )}

      {products.map((p) => (
        <ProductCard key={p.id} product={p} canManage={canManage} />
      ))}
    </div>
  );
}

function ProductForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [sku, setSku] = useState("");
  const [category, setCategory] = useState("");
  const [unit, setUnit] = useState("KG");
  const [stockTracked, setStockTracked] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await apiPost("/api/stock/products", {
        name,
        name_ar: nameAr || null,
        sku: sku || null,
        category: category || null,
        unit,
        stock_tracked: stockTracked,
      });
      invalidateStockData(qc);
      await qc.invalidateQueries({ queryKey: ["stock", "coverage"] });
      toast.show(t("stock.toast-created", { name }), "success");
      onDone();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : t("ui.error");
      setError(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card p-4 flex flex-col gap-3">
      <h2 className="font-extrabold text-united-dark">{t("stock.form-new-title")}</h2>
      {error && <p className="text-united-danger font-bold text-sm">{error}</p>}
      <div className="grid sm:grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-extrabold text-united-muted">{t("stock.field-name-en")}</span>
          <input dir="ltr" value={name} onChange={(e) => setName(e.target.value)} className="field" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-extrabold text-united-muted">{t("stock.field-name-ar")}</span>
          <input value={nameAr} onChange={(e) => setNameAr(e.target.value)} className="field" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-extrabold text-united-muted">{t("stock.field-sku")}</span>
          <input dir="ltr" value={sku} onChange={(e) => setSku(e.target.value)} className="field" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-extrabold text-united-muted">{t("stock.field-category")}</span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} className="field" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-extrabold text-united-muted">{t("stock.field-unit")}</span>
          <input dir="ltr" value={unit} onChange={(e) => setUnit(e.target.value)} className="field" />
        </label>
        <label className="flex items-center gap-2 mt-5">
          <input
            type="checkbox"
            checked={stockTracked}
            onChange={(e) => setStockTracked(e.target.checked)}
            className="w-5 h-5 accent-[#3f8f3f]"
          />
          <span className="text-sm font-bold text-united-dark">{t("stock.field-track-stock")}</span>
        </label>
      </div>
      {stockTracked && !unit.trim() && (
        <p className="text-united-warn font-bold text-xs">
          {t("stock.warning-unit-required")}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !name.trim()} className="btn-primary flex-1 text-sm">
          {busy ? t("stock.btn-saving") : t("stock.btn-add")}
        </button>
        <button type="button" onClick={onDone} className="btn-secondary flex-1 text-sm">
          {t("ui.back")}
        </button>
      </div>
    </form>
  );
}

function ProductCard({ product, canManage }: { product: StockProductDTO; canManage: boolean }) {
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const toast = useToast();
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(false);
  const [newAlias, setNewAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aliases = product.aliases ?? [];
  const manualAliases = aliases.filter((a) => a.kind === "manual");

  async function run(fn: () => Promise<unknown>, msg: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      invalidateStockData(qc);
      await qc.invalidateQueries({ queryKey: ["stock", "coverage"] });
      toast.show(msg, "success");
      setNewAlias("");
    } catch (err) {
      const m = err instanceof ApiClientError ? err.message : t("ui.error");
      setError(m);
      toast.show(m, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`card p-4 ${product.active ? "" : "opacity-60"}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span dir="auto" className="font-extrabold text-united-dark">{localName(product, locale)}</span>
            {otherLocalName(product, locale) && <span dir="auto" className="font-bold text-united-dark/70">· {otherLocalName(product, locale)}</span>}
            {!product.active && (
              <span className="text-[11px] font-extrabold bg-united-danger/10 text-united-danger px-2 py-0.5 rounded-full">
                {t("stock.badge-suspended")}
              </span>
            )}
            {!product.stockTracked && (
              <span className="text-[11px] font-extrabold bg-united-dark/10 text-united-muted px-2 py-0.5 rounded-full">
                {t("stock.badge-no-tracking")}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 text-xs font-bold text-united-muted mt-0.5">
            <span dir="ltr">{t("stock.label-unit")} {unitLabel(product.unit)}</span>
            {product.sku && <span dir="ltr">{t("stock.label-code")} {product.sku}</span>}
            {product.category && <span>{product.category}</span>}
            {product._count && <span>{product._count.orderItems} {t("stock.label-order-lines")}</span>}
          </div>
        </div>
        <button onClick={() => setOpen(!open)} className="btn-secondary text-xs px-3">
          {open ? t("stock.action-hide") : t("stock.action-toggle-aliases", { n: manualAliases.length })}
        </button>
      </div>

      {error && <p className="text-united-danger font-bold text-sm mt-2">{error}</p>}

      {canManage && (
        <div className="flex gap-2 mt-3">
          <button
            onClick={async () => {
              const question = product.active
                ? t("stock.deactivate-confirm", { name: product.name })
                : t("stock.activate-confirm", { name: product.name });
              if (!(await dialogs.confirm({ title: question, tone: product.active ? "danger" : "primary" }))) return;
              run(
                () =>
                  apiPatch(`/api/stock/products/${product.id}`, {
                    active: !product.active,
                    expected_version: product.version,
                  }),
                product.active ? t("stock.toast-deactivated") : t("stock.toast-activated")
              );
            }}
            disabled={busy}
            className={`${product.active ? "btn-danger" : "btn-primary"} text-sm px-4`}
          >
            {product.active ? t("stock.btn-deactivate") : t("stock.btn-activate")}
          </button>
        </div>
      )}

      {open && (
        <div className="mt-3 pt-3 border-t border-united-border">
          <p className="text-xs font-bold text-united-muted mb-2">
            {t("stock.alias-explanation")}
          </p>
          <ul className="flex flex-col gap-1 mb-3">
            {aliases.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 py-1">
                <div className="min-w-0">
                  <span className="font-bold text-united-dark">{a.alias}</span>
                  {a.kind !== "manual" && (
                    <span className="text-[10px] font-extrabold bg-united-green/10 text-united-green px-1.5 py-0.5 rounded ms-2">
                      {t("stock.alias-kind-primary")}
                    </span>
                  )}
                  <div dir="ltr" className="text-[10px] text-united-muted">{a.normalized}</div>
                </div>
                {canManage && a.kind === "manual" && (
                  <button
                    onClick={() =>
                      run(
                        () =>
                          apiFetch(`/api/stock/products/${product.id}/aliases/${a.id}`, { method: "DELETE" }),
                        t("stock.toast-alias-removed")
                      )
                    }
                    disabled={busy}
                    className="btn-danger text-xs px-3 shrink-0"
                  >
                    {t("stock.action-hide")}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <div className="flex gap-2">
              <input
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
                placeholder={t("stock.placeholder-alias")}
                className="field flex-1"
              />
              <button
                onClick={() =>
                  run(
                    () => apiPost(`/api/stock/products/${product.id}/aliases`, { alias: newAlias }),
                    t("stock.toast-alias-added")
                  )
                }
                disabled={busy || !newAlias.trim()}
                className="btn-primary text-sm px-4"
              >
                {t("stock.btn-add")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
