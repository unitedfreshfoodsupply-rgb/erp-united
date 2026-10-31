"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, errorMessage } from "@/lib/api-client";
import { newClientKey } from "@/lib/clientKey";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialog";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { todayLocalISO } from "@/lib/localDate";
import { Field, fmtMoney } from "@/components/stock/inventory/shared";

/**
 * The go-live opening batch: prepare every opening figure (GL accounts, customers,
 * suppliers, stock, fixed assets with their history), see it as one opening trial balance,
 * send it for approval, and it posts once. Lines can be typed or pasted (CSV / tab-separated
 * from a spreadsheet, first row = column names).
 */

type BatchRow = { id: string; number: string; kind: "initial" | "correction"; cutoverDate: string; status: string; createdBy: string; submittedBy: string | null; decidedBy: string | null; _count: { lines: number } };
type Validation = { totals: { debit: string; credit: string; residual: string }; trialBalance: { account: { id: string; code: string; name: string; nameAr: string }; debit: string; credit: string }[]; subledgers: Record<string, string>; problems: { code: string; params?: Record<string, string> }[]; warnings: { code: string; params?: Record<string, string> }[]; lineProblems: { lineNo: number; message: string }[] };
type Batch = BatchRow & { notes: string | null; lines: { id: string; lineNo: number; kind: string; data: Record<string, unknown>; debit: string; credit: string }[]; validation: Validation };
const KINDS = ["gl", "customer", "supplier", "stock", "asset"] as const;
type Kind = (typeof KINDS)[number];

/** The columns each kind accepts (CSV header names, and the form's fields). */
const COLUMNS: Record<Kind, string[]> = {
  gl: ["account_id", "debit", "credit", "description"],
  customer: ["party_id", "amount", "due_date", "reference"],
  supplier: ["party_id", "amount", "due_date", "reference"],
  stock: ["product_id", "quantity", "unit_cost", "expiry_date"],
  asset: ["category_id", "name", "cost", "accumulated", "acquisition_date", "in_service_date", "useful_life_months", "months_used", "plate_number", "serial_number", "location"],
};
const INT_FIELDS = new Set(["useful_life_months", "months_used"]);

function parsePasted(kind: Kind, text: string): Record<string, unknown>[] {
  const rows = text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (rows.length < 2) return [];
  const sep = rows[0].includes("\t") ? "\t" : ",";
  const head = rows[0].split(sep).map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const cells = r.split(sep);
    const o: Record<string, unknown> = { kind };
    head.forEach((h, i) => { const v = (cells[i] ?? "").trim(); if (v !== "") o[h] = INT_FIELDS.has(h) ? Number(v) : v; });
    return o;
  });
}

export function OpeningBatchView() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [cutover, setCutover] = useState(todayLocalISO());
  const q = useQuery({ queryKey: ["acc", "opening-batches"], queryFn: () => apiFetch<{ batches: BatchRow[] }>("/api/accounting/opening-batches").then((r) => r.batches) });
  const initialPosted = q.data?.some((b) => b.kind === "initial" && b.status === "posted");
  const create = async (kind: "initial" | "correction") => {
    try { const r = await apiPost<{ batch: BatchRow }>("/api/accounting/opening-batches", { kind, ...(kind === "initial" ? { cutover_date: cutover } : {}), idempotency_key: newClientKey() }); setOpen(r.batch.id); void qc.invalidateQueries({ queryKey: ["acc"] }); }
    catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  return (
    <section className="flex flex-col gap-3" aria-labelledby="opening-batches">
      <h2 id="opening-batches" className="section-title">{t("opening.title")}</h2>
      <p className="text-sm text-united-muted">{t("opening.explain")}</p>
      {can("accounting.manage") && (
        <div className="card p-3 flex flex-wrap items-end gap-2">
          {!initialPosted ? (
            <>
              <Field label={t("opening.cutover")} hint={t("opening.cutover-hint")}><input type="date" className="field" value={cutover} onChange={(e) => setCutover(e.target.value)} /></Field>
              <button type="button" className="btn-primary" onClick={() => create("initial")}>{t("opening.new-initial")}</button>
            </>
          ) : <button type="button" className="btn-secondary" onClick={() => create("correction")}>{t("opening.new-correction")}</button>}
        </div>
      )}
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !q.data?.length ? <EmptyState icon="📒" title={t("opening.none")} /> : (
        <ul className="flex flex-col gap-2">
          {q.data.map((b) => (
            <li key={b.id} className="card p-3 flex flex-wrap items-center justify-between gap-2">
              <button type="button" className="font-extrabold text-start" onClick={() => setOpen(open === b.id ? null : b.id)}><bdi dir="ltr">{b.number}</bdi> · {t(`opening.kind.${b.kind}`)} · <bdi dir="ltr">{b.cutoverDate}</bdi> · {t("opening.lines-n", { n: String(b._count.lines) })}</button>
              <StatusPill tone={b.status === "posted" ? "success" : b.status === "pending_approval" ? "warn" : b.status === "cancelled" ? "neutral" : "info"}>{t(`opening.status.${b.status}`)}</StatusPill>
            </li>
          ))}
        </ul>
      )}
      {open && <BatchDetail id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function BatchDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["acc", "opening-batch", id], queryFn: () => apiFetch<{ batch: Batch }>(`/api/accounting/opening-batches/${id}`).then((r) => r.batch) });
  const [kind, setKind] = useState<Kind>("gl");
  const [form, setForm] = useState<Record<string, string>>({});
  const [paste, setPaste] = useState("");
  const accounts = useQuery({ queryKey: ["acc", "accounts"], queryFn: () => apiFetch<{ accounts: { id: string; code: string; name: string; nameAr: string; postable: boolean; active: boolean; systemKey: string | null; controlledBy: string | null }[] }>("/api/accounting/accounts").then((r) => r.accounts) });
  const customers = useQuery({ queryKey: ["acc", "parties", "receipts"], queryFn: () => apiFetch<{ customers: { id: string; code: string; name: string; nameAr?: string | null }[] }>("/api/sales/customers").then((r) => r.customers), enabled: kind === "customer" });
  const suppliers = useQuery({ queryKey: ["acc", "parties", "payments"], queryFn: () => apiFetch<{ suppliers: { id: string; code: string; name: string; nameAr?: string | null }[] }>("/api/purchasing/suppliers").then((r) => r.suppliers), enabled: kind === "supplier" });
  const products = useQuery({ queryKey: ["acc", "products"], queryFn: () => apiFetch<{ products: { id: string; name: string; nameAr?: string | null }[] }>("/api/stock/products").then((r) => r.products), enabled: kind === "stock" });
  const cats = useQuery({ queryKey: ["assets", "categories"], queryFn: () => apiFetch<{ categories: { id: string; name: string; nameAr: string }[] }>("/api/assets/categories").then((r) => r.categories), enabled: kind === "asset" && can("accounting.assets.view") });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["acc"] }); };
  const send = async (lines: Record<string, unknown>[]) => {
    try { const r = await apiPost<{ added: number }>(`/api/accounting/opening-batches/${id}/lines`, { lines }); toast.show(t("opening.toast-added", { n: String(r.added) }), "success"); setForm({}); setPaste(""); refresh(); }
    catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  const b = q.data;
  if (!b) return q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : <LoadingState />;
  const v = b.validation;
  const draft = b.status === "draft" && can("accounting.manage");
  const glAccounts = (accounts.data ?? []).filter((a) => a.postable && a.active && !a.controlledBy && !["ar", "ap", "inventory", "grni", "employee_advances", "employee_payable", "vat_input", "vat_output", "vat_payable", "opening_equity"].includes(a.systemKey ?? ""));
  const options: Record<string, { id: string; label: string }[]> = {
    account_id: glAccounts.map((a) => ({ id: a.id, label: `${a.code} · ${localName({ name: a.name, nameAr: a.nameAr }, locale)}` })),
    party_id: ((kind === "customer" ? customers.data : suppliers.data) ?? []).map((p) => ({ id: p.id, label: localName(p, locale) })),
    product_id: (products.data ?? []).map((p) => ({ id: p.id, label: localName(p, locale) })),
    category_id: (cats.data ?? []).map((c) => ({ id: c.id, label: localName(c, locale) })),
  };
  const lineText = (l: Batch["lines"][number]) => {
    const d = l.data as Record<string, string>;
    const acc = accounts.data?.find((a) => a.id === d.account_id);
    return l.kind === "gl" ? `${acc?.code ?? ""} ${acc ? localName({ name: acc.name, nameAr: acc.nameAr }, locale) : ""}` : l.kind === "asset" ? `${d.name} (${d.in_service_date})` : l.kind === "stock" ? `${d.quantity} × ${d.unit_cost}` : `${d.reference ?? ""} ${d.due_date ?? ""}`;
  };
  return (
    <section className="card overflow-hidden" aria-labelledby="batch-detail">
      <div className="card-header">
        <h3 id="batch-detail" className="section-title"><bdi dir="ltr">{b.number}</bdi> · {t(`opening.kind.${b.kind}`)} · <bdi dir="ltr">{b.cutoverDate}</bdi> · {t(`opening.status.${b.status}`)}</h3>
        <button type="button" className="btn-secondary btn-sm" onClick={onClose}>{t("accounting.button.close")}</button>
      </div>
      <div className="p-4 flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div><dt className="font-bold text-united-muted">{t("opening.total-debit")}</dt><dd className="font-extrabold" dir="ltr">{fmtMoney(v.totals.debit)}</dd></div>
          <div><dt className="font-bold text-united-muted">{t("opening.total-credit")}</dt><dd className="font-extrabold" dir="ltr">{fmtMoney(v.totals.credit)}</dd></div>
          <div><dt className="font-bold text-united-muted">{t("opening.residual")}</dt><dd className={`font-extrabold ${Number(v.totals.residual) ? "text-united-danger" : "text-united-green"}`} dir="ltr">{fmtMoney(v.totals.residual)}</dd></div>
          <div><dt className="font-bold text-united-muted">{t("opening.lines")}</dt><dd className="font-extrabold">{b.lines.length}</dd></div>
          {(["customers", "suppliers", "stock", "assetsCost", "assetsAccumulated"] as const).map((k) => <div key={k}><dt className="font-bold text-united-muted">{t(`opening.sub.${k}`)}</dt><dd className="font-extrabold" dir="ltr">{fmtMoney(v.subledgers[k] ?? "0")}</dd></div>)}
        </dl>
        {v.problems.length > 0 && <ul className="text-sm font-bold text-united-danger">{v.problems.map((p) => <li key={p.code}>{t(`opening.problem.${p.code}`, p.params ?? {})}</li>)}</ul>}
        {v.warnings.length > 0 && <ul className="text-sm font-bold text-united-warn">{v.warnings.map((p) => <li key={p.code}>{t(`opening.warning.${p.code}`, p.params ?? {})}</li>)}</ul>}
        {v.lineProblems.length > 0 && <ul className="text-sm text-united-danger">{v.lineProblems.map((p) => <li key={p.lineNo}>{t("opening.line-n", { n: String(p.lineNo) })}: {p.message}</li>)}</ul>}
        {draft && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={v.problems.length > 0} onClick={async () => {
              if (!(await dialogs.confirm({ title: t("opening.confirm-submit", { number: b.number }), body: t("opening.confirm-submit-body"), confirmLabel: t("opening.submit") }))) return;
              try { await apiPost(`/api/accounting/opening-batches/${id}/submit`, {}); toast.show(t("opening.toast-submitted"), "success"); refresh(); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
            }}>{t("opening.submit")}</button>
          </div>
        )}
        {(b.status === "draft" || b.status === "pending_approval") && can("accounting.manage") && (
          <div><button type="button" className="btn-danger btn-sm" onClick={async () => {
            const reason = await dialogs.prompt({ title: t("opening.prompt-cancel", { number: b.number }), label: t("ui.reason-label"), required: true, tone: "danger", confirmLabel: t("opening.cancel") });
            if (!reason) return;
            try { await apiPost(`/api/accounting/opening-batches/${id}/cancel`, { reason }); refresh(); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
          }}>{t("opening.cancel")}</button></div>
        )}
        {draft && (
          <div className="border border-united-border rounded-xl p-3 flex flex-col gap-2">
            <Field label={t("opening.line-kind")}><select className="field" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setForm({}); }}>{KINDS.filter((k) => b.kind === "initial" || k === "gl" || k === "customer" || k === "supplier").map((k) => <option key={k} value={k}>{t(`opening.kind-line.${k}`)}</option>)}</select></Field>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              {COLUMNS[kind].map((c) => options[c] ? (
                <Field key={c} label={t(`opening.col.${c}`)}><select className="field" value={form[c] ?? ""} onChange={(e) => setForm({ ...form, [c]: e.target.value })}><option value="">—</option>{options[c].map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></Field>
              ) : (
                <Field key={c} label={t(`opening.col.${c}`)}><input className="field" type={c.endsWith("_date") ? "date" : "text"} dir={c.endsWith("_date") || /cost|debit|credit|amount|quantity|accumulated|months/.test(c) ? "ltr" : undefined} value={form[c] ?? ""} onChange={(e) => setForm({ ...form, [c]: e.target.value })} /></Field>
              ))}
            </div>
            <div><button type="button" className="btn-secondary" onClick={() => send([Object.fromEntries([["kind", kind], ...Object.entries(form).filter(([, x]) => x !== "").map(([k, x]) => [k, INT_FIELDS.has(k) ? Number(x) : x])])])}>{t("opening.add-line")}</button></div>
            <Field label={t("opening.paste")} hint={t("opening.paste-hint", { cols: COLUMNS[kind].join(", ") })}><textarea className="field font-mono" dir="ltr" rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} /></Field>
            <div><button type="button" className="btn-secondary" disabled={!paste.trim()} onClick={() => { const rows = parsePasted(kind, paste); if (!rows.length) { toast.show(t("opening.paste-empty"), "error"); return; } void send(rows); }}>{t("opening.import")}</button></div>
          </div>
        )}
        {b.lines.length > 0 && (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>#</th><th>{t("opening.line-kind")}</th><th>{t("accounting.description")}</th><th className="num">{t("opening.debit")}</th><th className="num">{t("opening.credit")}</th>{draft && <th><span className="sr-only">{t("treasury.col.actions")}</span></th>}</tr></thead>
              <tbody>
                {b.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.lineNo}</td><td>{t(`opening.kind-line.${l.kind}`)}</td><td>{lineText(l)}</td>
                    <td className="num" dir="ltr">{Number(l.debit) ? fmtMoney(l.debit) : ""}</td><td className="num" dir="ltr">{Number(l.credit) ? fmtMoney(l.credit) : ""}</td>
                    {draft && <td><button type="button" className="btn-ghost text-united-danger btn-sm" aria-label={t("opening.remove-line")} onClick={async () => { try { await apiFetch(`/api/accounting/opening-batches/${id}/lines/${l.id}`, { method: "DELETE" }); refresh(); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); } }}>✕</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {v.trialBalance.length > 0 && (
          <details>
            <summary className="font-extrabold cursor-pointer">{t("opening.tb")}</summary>
            <table className="data-table mt-2">
              <thead><tr><th>{t("chart.col.code")}</th><th>{t("chart.col.name")}</th><th className="num">{t("opening.debit")}</th><th className="num">{t("opening.credit")}</th></tr></thead>
              <tbody>{v.trialBalance.map((r) => <tr key={r.account.id}><td dir="ltr">{r.account.code}</td><td>{localName(r.account, locale)}</td><td className="num" dir="ltr">{Number(r.debit) ? fmtMoney(r.debit) : ""}</td><td className="num" dir="ltr">{Number(r.credit) ? fmtMoney(r.credit) : ""}</td></tr>)}</tbody>
            </table>
          </details>
        )}
      </div>
    </section>
  );
}
