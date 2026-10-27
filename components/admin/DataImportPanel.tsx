"use client";

import { useMemo, useState } from "react";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { apiPostForm } from "@/lib/api-client";
import { isValidISODate } from "@/lib/dates";

type Kind = "customers" | "customer_groups" | "customer_legal_entities" | "suppliers" | "products" | "product_settings" | "product_packaging" | "opening_stock" | "opening_balances" | "sales_prices" | "supplier_prices";
type Preview = { rows: { rowNumber: number; label: string; labelAr?: string; code?: string; errors: string[] }[]; rowCount: number; errorCount: number };
type Commit = { created: number; failed: number; results: { rowNumber: number | null; status: string; code?: string; document?: string; error?: string }[] };

const KIND_TKEY: Record<Kind, string> = {
  customers: "admin.label.kind.customers",
  customer_groups: "admin.label.kind.customer_groups",
  customer_legal_entities: "admin.label.kind.customer_legal_entities",
  suppliers: "admin.label.kind.suppliers",
  products: "admin.label.kind.products",
  product_settings: "admin.label.kind.product_settings",
  product_packaging: "admin.label.kind.product_packaging",
  opening_stock: "admin.label.kind.opening_stock",
  opening_balances: "admin.label.kind.opening_balances",
  sales_prices: "admin.label.kind.sales_prices",
  supplier_prices: "admin.label.kind.supplier_prices",
};

function localISODate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** Kinds whose rows carry an English name (`name` / `name_en`) and an Arabic one (`name_ar`). */
const BILINGUAL_KINDS = new Set<Kind>(["customers", "customer_groups", "customer_legal_entities", "suppliers", "products"]);

/** The import API reports row status as fixed Arabic words; show them in the UI locale. */
const STATUS_KEYS: Record<string, string> = {
  "تم": "admin.data-import.status.done",
  "فشل": "admin.data-import.status.failed",
  "موجود — لم يتكرر": "admin.data-import.status.exists",
  "تم تسجيل مستند الرصيد الافتتاحي": "admin.data-import.status.opening-stock",
};

export function DataImportPanel({ allowed }: { allowed: Partial<Record<Kind, boolean>> }) {
  const { t, locale } = useLocale();
  const statusLabel = (status: string) => (STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : status);
  const kinds = useMemo(() => (Object.keys(KIND_TKEY) as Kind[]).filter((kind) => allowed[kind]), [allowed]);
  const [kind, setKind] = useState<Kind>(kinds[0] ?? "customers");
  const [file, setFile] = useState<File | null>(null);
  const [businessDate, setBusinessDate] = useState(localISODate);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Commit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function chooseFile(next: File | null) {
    setFile(next); setPreview(null); setResult(null); setError(null);
    if (!next) return;
    if (!/\.(csv|xlsx)$/i.test(next.name)) { setFile(null); setError(t("admin.data-import.error-invalid-file")); return; }
    if (next.size > 2_000_000) { setFile(null); setError(t("admin.data-import.error-file-too-large")); return; }
  }

  async function submit(action: "preview" | "commit") {
    setBusy(true); setError(null); setResult(null);
    try {
      if (!file) throw new Error(t("admin.data-import.error-no-file"));
      const form = new FormData();
      form.append("action", action);
      form.append("kind", kind);
      form.append("file", file);
      if (kind === "opening_stock") form.append("business_date", businessDate);
      const response = await apiPostForm<Preview | Commit>("/api/admin/data-import", form);
      if (action === "preview") setPreview(response as Preview);
      else { setResult(response as Commit); setPreview(null); }
    } catch (e) { setError(e instanceof Error ? e.message : t("admin.data-import.error-generic")); }
    finally { setBusy(false); }
  }

  if (!kinds.length) return <section className="card p-4">{t("admin.data-import.no-permission")}</section>;
  return (
    <div className="flex flex-col gap-4">
      <section className="card p-4 flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-extrabold text-united-dark">{t("admin.data-import.header-title")}</h2>
          <p className="text-sm font-bold text-united-muted mt-1">{t("admin.data-import.header-desc")}</p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-extrabold text-united-muted">{t("admin.data-import.label-type")}</span>
          <select className="input" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setFile(null); setPreview(null); setResult(null); setError(null); }}>
            {kinds.map((value) => <option key={value} value={value}>{t(KIND_TKEY[value] as Parameters<typeof t>[0])}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <a className="btn-secondary" href={`/api/admin/data-import?template=${kind}`}>{t("admin.data-import.download-template")}</a>
          <label className="btn-secondary cursor-pointer">{t("admin.data-import.choose-file")}<input className="sr-only" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} /></label>
          <span className="text-xs font-bold text-united-muted">{file?.name ?? t("admin.data-import.no-file")}</span>
        </div>
        {kind === "opening_stock" && <label className="flex flex-col gap-1 max-w-xs"><span className="text-xs font-extrabold text-united-muted">{t("admin.data-import.business-date-label")}</span><input className="input" type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} /></label>}
        {BILINGUAL_KINDS.has(kind) && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.names")}</p>}
        {kind === "opening_stock" && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.opening_stock")}</p>}
        {file?.name.toLowerCase().endsWith(".xlsx") && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.xlsx")}</p>}
        {kind === "opening_balances" && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.opening_balances")}</p>}
        {kind === "sales_prices" && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.sales_prices")}</p>}
        {kind === "supplier_prices" && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.supplier_prices")}</p>}
        {kind === "products" && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.products")}</p>}
        {kind === "product_settings" && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.product_settings")}</p>}
        {kind === "product_packaging" && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.product_packaging")}</p>}
        {kind === "customers" && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.customers")}</p>}
        {kind === "customer_groups" && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.customer_groups")}</p>}
        {kind === "customer_legal_entities" && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.help.customer_legal_entities")}</p>}
        {error && <p role="alert" className="rounded-xl bg-united-danger/10 p-3 text-sm font-bold text-united-danger">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={busy || !file || (kind === "opening_stock" && !isValidISODate(businessDate))} onClick={() => submit("preview")}>{busy ? t("admin.data-import.loading-preview") : t("admin.data-import.preview-btn")}</button>
          <button type="button" className="btn-secondary" disabled={busy || !file || !preview || preview.errorCount > 0} onClick={() => submit("commit")}>{busy ? t("admin.data-import.loading-commit") : t("admin.data-import.commit-btn")}</button>
        </div>
      </section>

      {preview && <section className="card p-4 flex flex-col gap-3">
        <h3 className="font-extrabold text-united-dark">{t("admin.data-import.preview-title", { rowCount: preview.rowCount, errorCount: preview.errorCount })}</h3>
        {preview.errorCount === 0 ? <p className="text-sm font-bold text-united-green">{t("admin.data-import.preview-passed")}</p> : null}
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-start"><th className="p-2">{t("admin.data-import.table-row")}</th><th className="p-2">{t("admin.data-import.table-label")}</th><th className="p-2">{t("admin.data-import.table-status")}</th></tr></thead><tbody>
          {preview.rows.slice(0, 50).map((row) => <tr className="border-t border-united-border" key={row.rowNumber}><td className="p-2">{row.rowNumber}</td><td className="p-2" dir="auto">{row.code && row.code !== row.label ? `${row.code} · ` : ""}{localName({ name: row.label, nameAr: row.labelAr }, locale)}</td><td className={`p-2 font-bold ${row.errors.length ? "text-united-danger" : "text-united-green"}`}>{row.errors.length ? row.errors.join(" · ") : t("admin.data-import.ready")}</td></tr>)}
        </tbody></table></div>
        {preview.rows.length > 50 && <p className="text-xs font-bold text-united-muted">{t("admin.data-import.preview-truncated")}</p>}
      </section>}

      {result && <section className="card p-4 flex flex-col gap-3">
        <h3 className="font-extrabold text-united-dark">{t("admin.data-import.commit-saved")} {result.created}{t("admin.data-import.commit-separator")} {t("admin.data-import.commit-failed")} {result.failed}</h3>
        <p className="text-xs font-bold text-united-muted">{t("admin.data-import.commit-note")}</p>
        <div className="max-h-72 overflow-auto"><ul className="divide-y divide-united-border">{result.results.map((row, i) => <li className="py-2 text-sm" key={`${row.rowNumber}-${i}`}><span className="font-extrabold">{row.rowNumber ? `${t("admin.data-import.result-row-prefix")}${row.rowNumber}` : t("admin.data-import.result-doc")}:</span> {statusLabel(row.status)}{row.code ? ` · ${row.code}` : ""}{row.document ? ` · ${row.document}` : ""}{row.error ? <span className="text-united-danger"> · {row.error}</span> : null}</li>)}</ul></div>
      </section>}
    </div>
  );
}
