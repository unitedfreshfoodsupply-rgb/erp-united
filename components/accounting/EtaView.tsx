"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, apiPut, ApiClientError, errorMessage } from "@/lib/api-client";
import { ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { Field, Tabs, fmtMoney } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

/** The document's ETA state in the screen's language; the server's Arabic label covers an unknown state. */
function statusLabel(t: (k: string) => string, d: { etaStatus: string | null; etaStatusLabel: string }) {
  const k = `eta.status.${d.etaStatus ?? "pending"}`;
  const label = t(k);
  return label === k ? d.etaStatusLabel : label;
}
import { PageHeader } from "@/components/ui/PageHeader";
import { intlLocale, unitLabel } from "@/lib/format";
import type { TranslationKey } from "@/lib/locale/dictionary";
import { useDialogs } from "@/components/ui/Dialog";
import { AlertTriangle } from "lucide-react";

/**
 * E-invoicing (ETA): which invoices went to the Tax Authority and what came back, what
 * each one still lacks, and the codes UNITED's own data does not hold. Finance submits;
 * supervisors follow. Server credentials are never shown — only which are missing.
 */

type Issue = { level: "error" | "warning"; field: string; message: string };
type Address = { country: string | null; governate: string | null; regionCity: string | null; street: string | null; buildingNumber: string | null };
type Overview = {
  config: { configured: boolean; missing: string[]; environment: string | null };
  issuer: { name: string | null; registrationNumber: string | null; profile: (Address & { eta_branch_id: string | null; activity_code: string | null }) | null };
  units: { code: string; name: string; nameAr: string | null; nameEn: string; etaUnitType: string | null }[];
  taxes: { code: string; name: string; nameAr: string; rate: string; etaType: string | null; etaSubtype: string | null }[];
  products: { id: string; name: string; sku: string | null; unit: string; itemType: string | null; itemCode: string | null }[];
  customers: { id: string; code: string; name: string; nameAr?: string | null; taxRegistrationNo: string | null; profile: (Address & { receiverType: string | null; receiverId: string | null }) | null }[];
  invoices: { id: string; number: string; issueDate: string; buyerName: string; total: string; etaStatus: string | null; etaStatusLabel: string; uuid: string | null }[];
  creditNotes?: { id: string; number: string; issueDate: string; total: string; invoiceNumber: string | null; buyerName: string | null; etaStatus: string | null; etaStatusLabel: string; uuid: string | null }[];
};

// Shared address field labels used in Setup and ReceiverRow
const ADDRESS: [keyof Address, TranslationKey][] = [
  ["country", "eta.field.country" as TranslationKey],
  ["governate", "eta.field.governorate" as TranslationKey],
  ["regionCity", "eta.field.city-region" as TranslationKey],
  ["street", "eta.field.street" as TranslationKey],
  ["buildingNumber", "eta.field.building-number" as TranslationKey],
];

const fail = (toast: ReturnType<typeof useToast>, err: unknown) => toast.show(err instanceof ApiClientError ? err.message : "error.generic", "error");
const TONE: Record<string, string> = { valid: "bg-united-green/15 text-united-green", submitted: "bg-united-green/10 text-united-dark", rejected: "bg-united-danger/10 text-united-danger", invalid: "bg-united-danger/10 text-united-danger", unknown: "bg-united-warn/15 text-united-warn", failed: "bg-united-warn/15 text-united-warn" };

export function EtaView() {
  const { t } = useLocale();
  const [tab, setTab] = useState<"invoices" | "credit-notes" | "setup">("invoices");
  const q = useQuery({ queryKey: ["eta"], queryFn: () => apiFetch<{ eta: Overview }>("/api/eta").then((r) => r.eta) });
  return (
    <div className="page-container">
      <PageHeader title={t("eta.title")} />
      {q.isLoading ? <LoadingState /> : q.isError || !q.data ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : (
        <>
          <section className={`card p-3 text-sm font-bold ${q.data.config.configured ? "text-united-green" : "text-united-warn"}`}>
            {q.data.config.configured
              ? `${t("eta.config.connected")}${q.data.config.environment ? ` (${q.data.config.environment})` : ""}`
              : (
                <div className="flex flex-col gap-1">
                  <span className="inline-flex items-center gap-1.5"><AlertTriangle size={16} aria-hidden /> {t("eta.config.disconnected-plain")}</span>
                  <details className="text-xs font-medium text-united-muted">
                    <summary className="cursor-pointer">{t("eta.config.technical-details")}</summary>
                    <p className="mt-1">{t("eta.config.missing-settings")} {q.data.config.missing.map((m) => <code key={m} dir="ltr" className="me-1 rounded bg-united-subtle px-1">{m}</code>)}</p>
                  </details>
                </div>
              )}
          </section>
          <Tabs value={tab} onChange={setTab} items={[{ key: "invoices", label: t("eta.tab.invoices") }, { key: "credit-notes", label: t("eta.tab.credit-notes") }, { key: "setup", label: t("eta.tab.setup") }]} />
          {tab === "invoices" ? <Invoices data={q.data} /> : tab === "credit-notes" ? <CreditNotes data={q.data} /> : <Setup data={q.data} />}
        </>
      )}
    </div>
  );
}

function Invoices({ data }: { data: Overview }) {
  const { t } = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="flex flex-col gap-2">
      {data.invoices.length === 0 && <li className="card p-4 text-sm font-bold text-united-muted">{t("eta.empty-invoices")}</li>}
      {data.invoices.map((i) => (
        <li key={i.id} className="card p-3 flex flex-col gap-2">
          <button type="button" className="flex min-h-10 items-center justify-between gap-2 text-sm font-bold text-start" onClick={() => setOpen(open === i.id ? null : i.id)}>
            <span><span dir="ltr">{i.number}</span> · {i.buyerName} · {i.issueDate}</span>
            <span className="flex items-center gap-2"><span dir="ltr">{fmtMoney(i.total)}</span><span className={`rounded-full px-2 py-0.5 text-xs ${TONE[i.etaStatus ?? ""] ?? "bg-united-dark/5 text-united-muted"}`}>{statusLabel(t, i)}</span></span>
          </button>
          {open === i.id && <InvoiceEta id={i.id} />}
        </li>
      ))}
    </ul>
  );
}

/** Credit notes go to ETA after the invoice they credit is accepted; same flow as invoices. */
function CreditNotes({ data }: { data: Overview }) {
  const { t } = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  const rows = data.creditNotes ?? [];
  return (
    <ul className="flex flex-col gap-2">
      {rows.length === 0 && <li className="card p-4 text-sm font-bold text-united-muted">{t("eta.empty-credit-notes")}</li>}
      {rows.map((c) => (
        <li key={c.id} className="card p-3 flex flex-col gap-2">
          <button type="button" className="flex min-h-10 items-center justify-between gap-2 text-sm font-bold text-start" onClick={() => setOpen(open === c.id ? null : c.id)}>
            <span><span dir="ltr">{c.number}</span> · {t("eta.credit-note-on")} <span dir="ltr">{c.invoiceNumber}</span> · {c.buyerName} · {c.issueDate}</span>
            <span className="flex items-center gap-2"><span dir="ltr">{fmtMoney(c.total)}</span><span className={`rounded-full px-2 py-0.5 text-xs ${TONE[c.etaStatus ?? ""] ?? "bg-united-dark/5 text-united-muted"}`}>{statusLabel(t, c)}</span></span>
          </button>
          {open === c.id && <InvoiceEta id={c.id} base="credit-notes" />}
        </li>
      ))}
    </ul>
  );
}

function InvoiceEta({ id, base = "invoices" }: { id: string; base?: "invoices" | "credit-notes" }) {
  const dialogs = useDialogs();
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["eta", base, id], queryFn: () => apiFetch<{ ready: boolean; issues: Issue[]; eta: { status: string; statusLabel: string; uuid: string | null; longId: string | null; submissionId: string | null; attempts: number; lastError: unknown; events: { action: string; toStatus: string; actorName: string; createdAt: string }[] } | null; document: unknown }>(`/api/eta/${base}/${id}`) });
  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    try { await apiPost(`/api/eta/${base}/${id}/${path}`, body); toast.show("orders.item.done", "success"); } catch (err) { fail(toast, err); } finally { setBusy(false); void qc.invalidateQueries({ queryKey: ["eta"] }); }
  };
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const { issues, eta } = q.data;
  const errors = issues.filter((x) => x.level === "error");
  const warnings = issues.filter((x) => x.level === "warning");
  const status = eta?.status ?? "pending";
  const canSend = can("accounting.eta.manage") && ["pending", "failed", "rejected", "invalid"].includes(status);
  return (
    <div className="flex flex-col gap-2 text-sm font-bold border-t border-united-dark/10 pt-2">
      {eta && (
        <div className="text-xs text-united-muted flex flex-wrap gap-x-4">
          <span>{t("eta.status-label")} {eta.statusLabel}</span>
          {eta.uuid && <span>UUID <span dir="ltr">{eta.uuid}</span></span>}
          {eta.longId && <span>Long ID <span dir="ltr">{eta.longId}</span></span>}
          {eta.submissionId && <span>Submission <span dir="ltr">{eta.submissionId}</span></span>}
          <span>{t("eta.attempts-label")} {eta.attempts}</span>
        </div>
      )}
      {eta?.lastError != null && <pre className="text-xs whitespace-pre-wrap text-united-danger bg-united-danger/5 rounded p-2" dir="ltr">{JSON.stringify(eta.lastError, null, 1)}</pre>}
      {errors.length > 0 ? (
        <div>
          <div className="text-united-danger">{t("eta.missing-before-send", { count: String(errors.length) })}</div>
          <ul className="list-disc ps-5 text-xs">{errors.map((e, k) => <li key={k}>{e.message}</li>)}</ul>
        </div>
      ) : <div className="text-united-green text-xs">{t("eta.data-complete")}</div>}
      {warnings.length > 0 && <ul className="list-disc ps-5 text-xs text-united-warn">{warnings.map((w, k) => <li key={k}>{w.message}</li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        {canSend && <button type="button" className="btn-primary" disabled={busy || errors.length > 0} onClick={() => act("submit")}>{status === "pending" ? t("eta.submit-btn-send") : t("eta.submit-btn-resend")}</button>}
        {can("accounting.eta.manage") && eta?.uuid && <button type="button" className="btn-secondary" disabled={busy} onClick={() => act("refresh")}>{t("eta.refresh-btn")}</button>}
        {can("accounting.eta.manage") && (status === "unknown" || status === "submitting") && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={async () => {
            // Step 1: the UUID found on the ETA portal, or nothing if the portal has no such document.
            const uuid = await dialogs.prompt({ title: t("eta.uuid-prompt"), label: "UUID", inputDir: "ltr" });
            if (uuid === null) return;
            if (uuid) return void act("reconcile", { uuid });
            const reason = await dialogs.prompt({ title: t("eta.not-found-confirm-prompt"), label: t("ui.reason-label"), required: true, multiline: true });
            if (reason) void act("reconcile", { not_received: true, reason });
          }}>{t("eta.manual-reconcile-btn")}</button>
        )}
      </div>
      {q.data.document != null && (
        <details className="text-xs"><summary className="cursor-pointer text-united-muted">{t("eta.document-summary")}</summary><pre className="whitespace-pre-wrap" dir="ltr">{JSON.stringify(q.data.document, null, 1)}</pre></details>
      )}
      {eta && eta.events.length > 0 && (
        <ul className="text-xs text-united-muted">{eta.events.map((e, k) => <li key={k}>{new Date(e.createdAt).toLocaleString(intlLocale(locale))} · {e.action} → {e.toStatus} · {e.actorName}</li>)}</ul>
      )}
    </div>
  );
}

function Setup({ data }: { data: Overview }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const manage = can("accounting.eta.manage");
  const toast = useToast();
  const qc = useQueryClient();
  const save = async (path: string, body: unknown) => {
    try { await apiPut(path, body); toast.show("orders.edit.save_success", "success"); void qc.invalidateQueries({ queryKey: ["eta"] }); } catch (err) { fail(toast, err); }
  };
  const p = data.issuer.profile;
  const [issuer, setIssuer] = useState<Record<string, string>>({ eta_branch_id: p?.eta_branch_id ?? "", activity_code: p?.activity_code ?? "", ...Object.fromEntries(ADDRESS.map(([k]) => [k, p?.[k] ?? ""])) });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-bold text-united-muted">{t("eta.codes-intro")}</p>

      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("eta.issuer-title")} — {data.issuer.name ?? t("eta.issuer-missing-data")}</h3>
        <div className="text-xs text-united-muted">{t("eta.tax-registration-num")} <span dir="ltr">{data.issuer.registrationNumber ?? t("orders.empty")}</span></div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Field label={t("eta.branch-code")}><input className="field" dir="ltr" disabled={!manage} value={issuer.eta_branch_id} onChange={(e) => setIssuer({ ...issuer, eta_branch_id: e.target.value })} /></Field>
          <Field label={t("eta.activity-code")}><input className="field" dir="ltr" disabled={!manage} value={issuer.activity_code} onChange={(e) => setIssuer({ ...issuer, activity_code: e.target.value })} /></Field>
          {ADDRESS.map(([k, labelKey]) => (
            <Field key={k} label={t(labelKey)}><input className="field" disabled={!manage} value={issuer[k]} onChange={(e) => setIssuer({ ...issuer, [k]: e.target.value })} /></Field>
          ))}
        </div>
        {manage && <button type="button" className="btn-primary self-start" onClick={() => save("/api/eta/issuer", issuer)}>{t("accounting.save")}</button>}
      </section>

      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("eta.tax-classification")}</h3>
        <p className="text-xs text-united-muted">{t("eta.tax-info")}</p>
        <ul className="text-sm font-bold">{data.taxes.map((t) => <li key={t.code} className="flex justify-between"><span>{localName(t, locale)} ({t.rate}%)</span><span dir="ltr">{t.etaType ?? "—"} / {t.etaSubtype ?? "—"}</span></li>)}</ul>
      </section>

      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("eta.units-title")}</h3>
        <ul className="flex flex-col gap-1">{data.units.map((u) => <CodeRow key={u.code} label={`${localName(u, locale)} (${u.code})`} value={u.etaUnitType} placeholder={t("eta.unit-placeholder")} manage={manage} onSave={(v) => save(`/api/eta/units/${u.code}`, { eta_unit_type: v })} />)}</ul>
      </section>

      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("eta.items-title")}</h3>
        <ul className="flex flex-col gap-1">{data.products.map((p) => <ItemRow key={p.id} p={p} manage={manage} onSave={(type, code) => save(`/api/eta/items/${p.id}`, { item_type: type, item_code: code })} />)}</ul>
      </section>

      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("eta.receivers-title")}</h3>
        <ul className="flex flex-col gap-2">{data.customers.map((c) => <ReceiverRow key={c.id} c={c} manage={manage} onSave={(body) => save(`/api/eta/receivers/${c.id}`, body)} />)}</ul>
      </section>
    </div>
  );
}

function CodeRow({ label, value, placeholder, manage, onSave }: { label: string; value: string | null; placeholder: string; manage: boolean; onSave: (v: string) => void }) {
  const { t } = useLocale();
  const [v, setV] = useState(value ?? "");
  return (
    <li className="flex items-center justify-between gap-2 text-sm font-bold">
      <span>{value ? "✓" : "✗"} {label}</span>
      <span className="flex gap-1"><input className="field w-32" dir="ltr" placeholder={placeholder} aria-label={`${label} — ${placeholder}`} disabled={!manage} value={v} onChange={(e) => setV(e.target.value)} />{manage && <button type="button" className="btn-secondary" disabled={!v.trim() || v === value} onClick={() => onSave(v.trim())}>{t("orders.edit.save")}</button>}</span>
    </li>
  );
}

function ItemRow({ p, manage, onSave }: { p: Overview["products"][number]; manage: boolean; onSave: (type: string, code: string) => void }) {
  const { t, locale } = useLocale();
  const [type, setType] = useState(p.itemType ?? "EGS");
  const [code, setCode] = useState(p.itemCode ?? "");
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-sm font-bold">
      <span>{p.itemCode ? "✓" : "✗"} {localName(p, locale)} <span className="text-xs text-united-muted">({unitLabel(p.unit)}{p.sku ? ` · ${p.sku}` : ""})</span></span>
      <span className="flex gap-1">
        <select className="field w-20" disabled={!manage} value={type} onChange={(e) => setType(e.target.value)}><option>EGS</option><option>GS1</option></select>
        <input className="field w-48" dir="ltr" placeholder={t("eta.item-system-code-placeholder")} disabled={!manage} value={code} onChange={(e) => setCode(e.target.value)}  aria-label={t("eta.item-system-code-placeholder")}/>
        {manage && <button type="button" className="btn-secondary" disabled={!code.trim()} onClick={() => onSave(type, code.trim())}>{t("orders.edit.save")}</button>}
      </span>
    </li>
  );
}

function ReceiverRow({ c, manage, onSave }: { c: Overview["customers"][number]; manage: boolean; onSave: (body: unknown) => void }) {
  const { t, locale } = useLocale();
  const [f, setF] = useState<Record<string, string>>({ receiver_type: c.profile?.receiverType ?? "", receiver_id: c.profile?.receiverId ?? "", ...Object.fromEntries(ADDRESS.map(([k]) => [k, c.profile?.[k] ?? ""])) });
  const derived = c.taxRegistrationNo ? "B" : "P";
  const complete = (f.receiver_type || derived) !== "B" || ADDRESS.every(([k]) => f[k]);
  return (
    <li className="border-b border-united-dark/5 pb-2">
      <details>
        <summary className="cursor-pointer text-sm font-bold">{complete ? "✓" : "✗"} {localName(c, locale)} · {c.taxRegistrationNo ? <span dir="ltr">{c.taxRegistrationNo} {t("eta.receiver-tax-reg")}</span> : t("eta.receiver-no-tax")}</summary>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
          <Field label={t("eta.receiver-type")}><select className="field" disabled={!manage} value={f.receiver_type} onChange={(e) => setF({ ...f, receiver_type: e.target.value })}><option value="">{t("eta.receiver-auto", { derived })}</option><option value="B">{t("eta.receiver-company")}</option><option value="P">{t("eta.receiver-person")}</option><option value="F">{t("eta.receiver-foreign")}</option></select></Field>
          <Field label={t("eta.receiver-national-id")}><input className="field" dir="ltr" disabled={!manage} value={f.receiver_id} onChange={(e) => setF({ ...f, receiver_id: e.target.value })} /></Field>
          {ADDRESS.map(([k, labelKey]) => <Field key={k} label={t(labelKey)}><input className="field" disabled={!manage} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
        </div>
        {manage && <button type="button" className="btn-secondary mt-2" onClick={() => onSave({ ...f, receiver_type: f.receiver_type || null })}>{t("orders.edit.save")}</button>}
      </details>
    </li>
  );
}
