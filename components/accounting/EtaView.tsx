"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, apiPut, ApiClientError, errorMessage } from "@/lib/api-client";
import { ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { usePermissions, useSession } from "@/lib/use-session";
import { Field, Tabs, fmtMoney } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

/** The document's ETA state in the screen's language; the server's Arabic label covers an unknown state. */
function statusLabel(t: (k: string) => string, d: { etaStatus: string | null; etaStatusLabel: string; origin?: string | null }) {
  const k = d.origin === "portal" && d.etaStatus === "valid" ? "eta.status.portal" : `eta.status.${d.etaStatus ?? "pending"}`;
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
  config: { configured: boolean; missing: string[]; invalid?: string[]; environment: string | null };
  api?: { enabled: boolean; from: string | null };
  issuer: { name: string | null; registrationNumber: string | null; profile: (Address & { eta_branch_id: string | null; activity_code: string | null }) | null };
  units: { code: string; name: string; nameAr: string | null; nameEn: string; etaUnitType: string | null }[];
  taxes: { code: string; name: string; nameAr: string; rate: string; etaType: string | null; etaSubtype: string | null }[];
  products: { id: string; name: string; sku: string | null; unit: string; itemType: string | null; itemCode: string | null }[];
  customers: { id: string; code: string; name: string; nameAr?: string | null; taxRegistrationNo: string | null; legalEntity: { id: string; code: string; name: string; nameAr: string | null } | null; receiver: { type: string | null; personalId: string | null; address: Address; origin: "legal_entity" | "eta_profile_legacy" | "none" }; effectiveType: "B" | "P" | "F"; gaps: string[]; personIdOnlyAbove: boolean; editHref: string }[];
  invoices: { id: string; number: string; issueDate: string; buyerName: string; total: string; etaStatus: string | null; etaStatusLabel: string; origin?: string | null; uuid: string | null }[];
  creditNotes?: { id: string; number: string; issueDate: string; total: string; invoiceNumber: string | null; buyerName: string | null; etaStatus: string | null; etaStatusLabel: string; origin?: string | null; uuid: string | null }[];
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
const TONE: Record<string, string> = { valid: "bg-united-green/15 text-united-green", submitted: "bg-united-green/10 text-united-dark", rejected: "bg-united-danger/10 text-united-danger", invalid: "bg-united-danger/10 text-united-danger", receiver_rejected: "bg-united-danger/10 text-united-danger", unknown: "bg-united-warn/15 text-united-warn", failed: "bg-united-warn/15 text-united-warn" };

export function EtaView() {
  const { t } = useLocale();
  const [tab, setTab] = useState<"invoices" | "credit-notes" | "pending" | "setup">("invoices");
  const q = useQuery({ queryKey: ["eta"], queryFn: () => apiFetch<{ eta: Overview }>("/api/eta").then((r) => r.eta) });
  return (
    <div className="page-container">
      <PageHeader title={t("eta.title")} />
      {q.isLoading ? <LoadingState /> : q.isError || !q.data ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : (
        <>
          <section className={`card p-3 text-sm font-bold ${q.data.config.configured ? "text-united-green" : "text-united-warn"}`}>
            {q.data.config.configured
              ? `${t("eta.config.connected")}${q.data.config.environment ? ` (${q.data.config.environment})` : ""}${q.data.api?.enabled ? "" : ` — ${t("eta.api-off")}`}`
              : (
                <div className="flex flex-col gap-1">
                  <span className="inline-flex items-center gap-1.5"><AlertTriangle size={16} aria-hidden /> {t("eta.config.disconnected-plain")}</span>
                  <details className="text-xs font-medium text-united-muted">
                    <summary className="cursor-pointer">{t("eta.config.technical-details")}</summary>
                    <p className="mt-1">{t("eta.config.missing-settings")} {[...q.data.config.missing, ...(q.data.config.invalid ?? [])].map((m) => <code key={m} dir="ltr" className="me-1 rounded bg-united-subtle px-1">{m}</code>)}</p>
                  </details>
                </div>
              )}
          </section>
          <Tabs value={tab} onChange={setTab} items={[{ key: "invoices", label: t("eta.tab.invoices") }, { key: "credit-notes", label: t("eta.tab.credit-notes") }, { key: "pending", label: t("eta.tab.pending") }, { key: "setup", label: t("eta.tab.setup") }]} />
          {tab === "invoices" ? <Invoices data={q.data} /> : tab === "credit-notes" ? <CreditNotes data={q.data} /> : tab === "pending" ? <Pending /> : <Setup data={q.data} />}
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
  const me = useSession().data?.user?.id ?? null;
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["eta", base, id], queryFn: () => apiFetch<{ ready: boolean; issues: Issue[]; api: { enabled: boolean; from: string | null; eligible: boolean }; eta: EtaState | null; document: unknown; documentSource?: "signed" | "draft"; receiverEditHref?: string | null }>(`/api/eta/${base}/${id}`) });
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
  const manage = can("accounting.eta.manage");
  const { api } = q.data;
  // The server decides what is resendable (never a portal filing, never a possibly-registered one).
  const resendable = eta ? eta.resendable : true;
  const canSend = manage && resendable && api.eligible;
  // Nothing registered per UNITED's record: a portal filing may be recorded instead.
  const canRecordPortal = manage && (!eta || (!eta.uuid && ["pending", "failed", "rejected"].includes(status)));
  const proposal = eta?.pendingProposal ?? null;
  return (
    <div className="flex flex-col gap-2 text-sm font-bold border-t border-united-dark/10 pt-2">
      {eta && (
        <div className="text-xs text-united-muted flex flex-wrap gap-x-4">
          <span>{t("eta.status-label")} {eta.statusLabel}</span>
          {eta.uuid && <span>UUID <span dir="ltr">{eta.uuid}</span></span>}
          {eta.longId && <span>Long ID <span dir="ltr">{eta.longId}</span></span>}
          {eta.submissionId && <span>Submission <span dir="ltr">{eta.submissionId}</span></span>}
          {eta.priorUuids.length > 0 && <span>Prior UUID <span dir="ltr">{eta.priorUuids.join(", ")}</span></span>}
          <span>{t("eta.attempts-label")} {eta.attempts}</span>
        </div>
      )}
      {!resendable || api.eligible ? null : <div className="text-xs text-united-warn">{api.enabled ? t("eta.api-before-start", { from: api.from ?? "" }) : t("eta.api-off")}</div>}
      {eta?.uncertain && eta.decisionOpensAt && <div className="text-xs text-united-warn">{t("eta.decision-opens", { time: new Date(eta.decisionOpensAt).toLocaleString(intlLocale(locale)) })}</div>}
      {proposal && <div className="text-xs text-united-warn">{t("eta.pending-proposal", { name: proposal.actorName, reason: proposal.reason ?? "" })}</div>}
      {eta?.lastError != null && <pre className="text-xs whitespace-pre-wrap text-united-danger bg-united-danger/5 rounded p-2" dir="ltr">{JSON.stringify(eta.lastError, null, 1)}</pre>}
      {errors.length > 0 ? (
        <div>
          <div className="text-united-danger">{t("eta.missing-before-send", { count: String(errors.length) })}</div>
          <ul className="list-disc ps-5 text-xs">{errors.map((e, k) => <li key={k}>{e.message}</li>)}</ul>
          {q.data.receiverEditHref && errors.some((e) => e.field.startsWith("receiver.")) && <a className="link text-xs" href={q.data.receiverEditHref}>{t("eta.receiver-open-customer")}</a>}
        </div>
      ) : <div className="text-united-green text-xs">{t("eta.data-complete")}</div>}
      {warnings.length > 0 && <ul className="list-disc ps-5 text-xs text-united-warn">{warnings.map((w, k) => <li key={k}>{w.message}</li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        {canSend && <button type="button" className="btn-primary" disabled={busy || errors.length > 0} onClick={() => act("submit")}>{status === "pending" ? t("eta.submit-btn-send") : t("eta.submit-btn-resend")}</button>}
        {manage && eta?.uuid && <button type="button" className="btn-secondary" disabled={busy} onClick={() => act("refresh")}>{t("eta.refresh-btn")}</button>}
        {manage && eta?.uncertain && (
          <>
            {/* First: ask ETA itself (Get Submission / Search by internal ID). */}
            <button type="button" className="btn-primary" disabled={busy} onClick={() => act("lookup")}>{t("eta.lookup-btn")}</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={async () => {
              const uuid = await dialogs.prompt({ title: t("eta.reconcile-uuid-prompt"), label: "UUID", inputDir: "ltr", required: true });
              if (uuid) void act("reconcile", { uuid: uuid.trim() });
            }}>{t("eta.reconcile-uuid-btn")}</button>
            {!proposal && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={async () => {
                const reason = await dialogs.prompt({ title: t("eta.not-received-reason-prompt"), label: t("ui.reason-label"), required: true, multiline: true });
                if (!reason) return;
                const evidence = await dialogs.prompt({ title: t("eta.not-received-evidence-prompt"), label: t("eta.not-received-evidence-prompt"), required: true, multiline: true });
                if (evidence) void act("reconcile", { propose_not_received: true, reason, portal_evidence: evidence });
              }}>{t("eta.propose-not-received-btn")}</button>
            )}
            {proposal && proposal.actorId !== me && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={async () => {
                const evidence = await dialogs.prompt({ title: t("eta.confirm-evidence-prompt"), label: t("eta.not-received-evidence-prompt"), required: true, multiline: true });
                if (evidence) void act("reconcile", { confirm_not_received: proposal.id, portal_evidence: evidence });
              }}>{t("eta.confirm-not-received-btn")}</button>
            )}
          </>
        )}
        {canRecordPortal && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={async () => {
            const uuid = await dialogs.prompt({ title: t("eta.portal-uuid-prompt"), label: "UUID", inputDir: "ltr", required: true });
            if (!uuid) return;
            const when = await dialogs.prompt({ title: t("eta.portal-date-prompt"), label: t("eta.portal-date-prompt"), inputDir: "ltr", required: true });
            if (!when) return;
            const evidence = await dialogs.prompt({ title: t("eta.portal-evidence-prompt"), label: t("eta.portal-evidence-prompt"), required: true, multiline: true });
            if (evidence) void act("portal", { uuid: uuid.trim(), submitted_at: when.trim(), evidence_note: evidence });
          }}>{t("eta.portal-record-btn")}</button>
        )}
      </div>
      {q.data.document != null && (
        <details className="text-xs"><summary className="cursor-pointer text-united-muted">{t("eta.document-summary")}</summary>{q.data.documentSource === "signed" && <p className="text-united-muted">{t("eta.document-signed")}</p>}<pre className="whitespace-pre-wrap" dir="ltr">{JSON.stringify(q.data.document, null, 1)}</pre></details>
      )}
      {eta && eta.events.length > 0 && (
        <ul className="text-xs text-united-muted">{eta.events.map((e, k) => <li key={k}>{new Date(e.createdAt).toLocaleString(intlLocale(locale))} · {e.action} → {e.toStatus} · {e.actorName}</li>)}</ul>
      )}
    </div>
  );
}

type EtaState = {
  status: string; statusLabel: string; origin: string; uuid: string | null; longId: string | null; submissionId: string | null; priorUuids: string[]; attempts: number; lastError: unknown;
  resendable: boolean; uncertain: boolean; decisionOpensAt: string | null;
  pendingProposal: { id: string; actorId: string | null; actorName: string; reason: string | null } | null;
  events: { action: string; toStatus: string; actorName: string; createdAt: string }[];
};

type PendingRow = { kind: "sales_invoice" | "credit_note"; id: string; number: string | null; issueDate: string | null; buyerName: string | null; total: string; etaStatus: string | null; etaStatusLabel: string; ageHours: number | null; apiEligible: boolean };
const KIND_LABEL: Record<PendingRow["kind"], TranslationKey> = { sales_invoice: "eta.kind.sales_invoice", credit_note: "eta.kind.credit_note" };

/** Issued documents not yet registered at ETA, oldest first, with their age (read only). */
function Pending() {
  const { t } = useLocale();
  const q = useQuery({ queryKey: ["eta", "pending"], queryFn: () => apiFetch<{ pending: { rows: PendingRow[] } }>("/api/eta/pending").then((r) => r.pending) });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-bold text-united-muted">{t("eta.pending-intro")}</p>
      <ul className="flex flex-col gap-2">
        {q.data.rows.length === 0 && <li className="card p-4 text-sm font-bold text-united-muted">{t("eta.empty-pending")}</li>}
        {q.data.rows.map((r) => (
          <li key={`${r.kind}:${r.id}`} className="card p-3 flex flex-wrap min-h-10 items-center justify-between gap-2 text-sm font-bold">
            <span>{t(KIND_LABEL[r.kind])} <span dir="ltr">{r.number}</span> · {r.buyerName} · {r.issueDate}</span>
            <span className="flex flex-wrap items-center gap-2">
              <span dir="ltr">{fmtMoney(r.total)}</span>
              {r.ageHours !== null && <span className={`rounded-full px-2 py-0.5 text-xs ${r.ageHours >= 72 ? "bg-united-danger/10 text-united-danger" : "bg-united-warn/15 text-united-warn"}`}>{t("eta.age-hours", { hours: String(r.ageHours) })}</span>}
              <span className={`rounded-full px-2 py-0.5 text-xs ${TONE[r.etaStatus ?? ""] ?? "bg-united-dark/5 text-united-muted"}`}>{statusLabel(t, r)}</span>
              {!r.apiEligible && <span className="text-xs text-united-muted">{t("eta.api-portal-only")}</span>}
            </span>
          </li>
        ))}
      </ul>
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
        <p className="text-xs text-united-muted">{t("eta.receiver-from-master")}</p>
        <ul className="flex flex-col gap-2">{data.customers.map((c) => <ReceiverRow key={c.id} c={c} />)}</ul>
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
        <select className="field w-20" disabled={!manage} value={type} onChange={(e) => setType(e.target.value)} aria-label={t("form.code-type")}><option>EGS</option><option>GS1</option></select>
        <Field label={t("eta.item-system-code-placeholder")} className="w-48"><input className="field" dir="ltr" disabled={!manage} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        {manage && <button type="button" className="btn-secondary" disabled={!code.trim()} onClick={() => onSave(type, code.trim())}>{t("orders.edit.save")}</button>}
      </span>
    </li>
  );
}

const GAP_LABEL: Record<string, TranslationKey> = {
  tax_registration_no: "eta.gap.tax_registration_no", legal_entity: "eta.gap.legal_entity", receiver_id: "eta.gap.receiver_id",
  ...Object.fromEntries(ADDRESS.map(([k, label]) => [k, label])),
};

/** Read-only: the receiver as the customer record gives it, what is missing, and where to fix it. */
function ReceiverRow({ c }: { c: Overview["customers"][number] }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const r = c.receiver;
  const source = r.origin === "legal_entity" && c.legalEntity ? t("eta.receiver-source.legal_entity", { code: c.legalEntity.code }) : t(`eta.receiver-source.${r.origin}` as TranslationKey);
  return (
    <li className="border-b border-united-dark/5 pb-2 text-sm">
      <div className="font-bold">{c.gaps.length === 0 ? "✓" : "✗"} {localName(c, locale)} · {c.taxRegistrationNo ? <span dir="ltr">{c.taxRegistrationNo} {t("eta.receiver-tax-reg")}</span> : t("eta.receiver-no-tax")} · {c.effectiveType}</div>
      <div className="text-xs text-united-muted">{source}{ADDRESS.some(([k]) => r.address[k]) ? ` · ${ADDRESS.map(([k]) => r.address[k]).filter(Boolean).join("، ")}` : ""}</div>
      {c.gaps.length > 0 && <div className="text-xs text-united-danger">{t("eta.receiver-missing", { fields: c.gaps.map((g) => t(GAP_LABEL[g] ?? ("eta.receiver-type" as TranslationKey))).join("، ") })}</div>}
      {c.personIdOnlyAbove && <div className="text-xs text-united-muted">{t("eta.receiver-person-id-above")}</div>}
      {(c.gaps.length > 0 || r.origin === "eta_profile_legacy") && (can("sales.customers.manage")
        ? <a className="link text-xs" href={c.editHref}>{t("eta.receiver-open-customer")}</a>
        : <div className="text-xs text-united-muted">{t("eta.receiver-ask-sales")}</div>)}
    </li>
  );
}
