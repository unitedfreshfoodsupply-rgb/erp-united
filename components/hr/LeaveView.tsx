"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Paperclip, Plus } from "lucide-react";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { Modal, useDialogs } from "@/components/ui/Dialog";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { AttachmentsPanel } from "@/components/AttachmentsPanel";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, Tabs } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";

/**
 * Leave (docs/erp/DESIGN_SYSTEM.md §8.3): requests and their decisions, balances (the sum of
 * the leave ledger), and the setup — types, policies verified by a second person, and the
 * allocation runs. Every rule is the server's: this screen shows what it allows.
 */

type LeaveType = { id: string; code: string; nameAr: string; nameEn: string | null; payMode: string; paidPercent: string | null; countsDays: string; requiresAttachment: boolean; allowNegativeBalance: boolean; active: boolean; version: number };
type Request = {
  id: string; number: string; startDate: string; endDate: string; days: string; reason: string | null; status: string; requestedBy: string; decidedBy: string | null; decisionComment: string | null;
  cancelReason: string | null; approvalRequestId: string | null; employee: { id: string; code: string; name: string }; leaveType: { id: string; code: string; nameAr: string; nameEn: string | null; requiresAttachment: boolean };
  canDecide: boolean; canCancel: boolean;
};
type Policy = {
  id: string; effectiveFrom: string; effectiveTo: string | null; accrualMethod: string; status: string; sourceReference: string; createdBy: string; verifiedBy: string | null;
  carryOverMaxDays: string | null; leaveType: { id: string; code: string; nameAr: string; nameEn: string | null }; tiers: { minServiceMonths: number; minAge: number | null; daysPerYear: string }[];
};
type Tab = "requests" | "balances" | "setup";

const REQ_TONE: Record<string, Tone> = { pending: "warn", approved: "success", rejected: "danger", cancelled: "neutral" };
const POLICY_TONE: Record<string, Tone> = { draft: "warn", verified: "success", retired: "neutral" };
const fail = (t: (k: string) => string, err: unknown) => (err instanceof ApiClientError ? err.message : t("hr.error"));
const num = (v: string | number) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });

const useTypes = () => useQuery({ queryKey: ["hr", "leave", "types"], queryFn: () => apiFetch<{ types: LeaveType[] }>("/api/hr/leave/types").then((r) => r.types) });

export function LeaveView() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [tab, setTab] = useState<Tab>("requests");
  return (
    <div className="page-container">
      <PageHeader back={{ href: "/hr", label: t("hr.profile.back") }} title={t("leave.title")} description={t("leave.description")} />
      <Tabs value={tab} onChange={setTab} items={[{ key: "requests", label: t("leave.tab.requests") }, { key: "balances", label: t("leave.tab.balances") }, { key: "setup", label: t("leave.tab.setup") }]} />
      {tab === "requests" && <RequestsTab canRequest={can("hr.leave.request")} />}
      {tab === "balances" && <BalancesTab canAdjust={can("hr.leave.configure")} />}
      {tab === "setup" && <SetupTab canConfigure={can("hr.leave.configure")} />}
    </div>
  );
}

const typeName = (isEN: boolean, x: { nameAr: string; nameEn: string | null }) => (isEN ? x.nameEn || x.nameAr : x.nameAr);

// ── Requests ───────────────────────────────────────────────────────────────

function RequestsTab({ canRequest }: { canRequest: boolean }) {
  const { t, isEN } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [creating, setCreating] = useState(false);
  const [files, setFiles] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["hr", "leave", "requests", filter], queryFn: () => apiFetch<{ requests: Request[] }>(`/api/hr/leave/requests${filter === "pending" ? "?status=pending" : ""}`).then((r) => r.requests) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["hr"] });
  const decide = async (r: Request, decision: "approve" | "reject") => {
    let comment: string | null | undefined;
    if (decision === "reject") {
      comment = await dialogs.prompt({ title: t("leave.reject"), label: t("leave.reason"), required: true });
      if (!comment) return;
    } else if (!(await dialogs.confirm({ title: t("leave.approve"), body: t("leave.approve_confirm", { number: r.number, days: num(r.days) }) }))) return;
    try {
      await apiPost(`/api/approvals/${r.approvalRequestId}/decide`, { decision, comment: comment ?? undefined });
      toast.show(decision === "approve" ? t("leave.approved") : t("leave.rejected"), "success");
      refresh();
    } catch (err) {
      toast.show(fail(t, err), "error");
    }
  };
  const cancel = async (r: Request) => {
    const reason = await dialogs.prompt({ title: r.status === "approved" ? t("leave.cancel_approved") : t("leave.withdraw"), body: r.status === "approved" ? t("leave.cancel_approved_hint") : undefined, label: t("leave.reason"), required: r.status === "approved", tone: "danger" });
    if (reason === null) return;
    try {
      await apiPost(`/api/hr/leave/requests/${r.id}/cancel`, { reason: reason || null });
      refresh();
    } catch (err) {
      toast.show(fail(t, err), "error");
    }
  };
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <Segmented value={filter} onChange={setFilter} items={[{ key: "pending", label: t("leave.filter.pending") }, { key: "all", label: t("leave.filter.all") }]} />
        {canRequest && <button type="button" className="btn-primary btn-sm gap-1.5" onClick={() => setCreating(true)}><Plus size={16} aria-hidden />{t("leave.new")}</button>}
      </div>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !q.data!.length ? <EmptyState title={t("leave.requests_empty")} /> : (
        <ul className="divide-y divide-united-border">
          {q.data!.map((r) => (
            <li key={r.id} className="px-5 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-united-dark">{r.employee.name}</span>
                    <span className="text-sm text-united-muted">· {typeName(isEN, r.leaveType)}</span>
                    <StatusPill tone={REQ_TONE[r.status] ?? "neutral"}>{t(`leave.status.${r.status}`)}</StatusPill>
                    {r.leaveType.requiresAttachment && <StatusPill tone="info">{t("leave.needs_document")}</StatusPill>}
                  </div>
                  <div className="mt-0.5 text-sm text-united-dark">
                    <span dir="ltr">{r.startDate} → {r.endDate}</span> · {t("leave.days_n", { n: num(r.days) })} · <span dir="ltr" className="text-united-muted">{r.number}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-united-muted">
                    {r.reason ? `${r.reason} · ` : ""}{r.requestedBy}{r.decidedBy ? ` · ${t("leave.decided_by")} ${r.decidedBy}` : ""}{r.decisionComment ? `: ${r.decisionComment}` : ""}{r.cancelReason ? ` · ${r.cancelReason}` : ""}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-ghost btn-sm gap-1" onClick={() => setFiles(files === r.id ? null : r.id)}><Paperclip size={15} aria-hidden />{t("leave.documents")}</button>
                  {r.canDecide && r.approvalRequestId && (
                    <>
                      <button type="button" className="btn-primary btn-sm" onClick={() => decide(r, "approve")}>{t("leave.approve")}</button>
                      <button type="button" className="btn-danger btn-sm" onClick={() => decide(r, "reject")}>{t("leave.reject")}</button>
                    </>
                  )}
                  {r.canCancel && <button type="button" className="btn-secondary btn-sm" onClick={() => cancel(r)}>{r.status === "approved" ? t("leave.cancel_approved") : t("leave.withdraw")}</button>}
                </div>
              </div>
              {files === r.id && <div className="mt-3"><AttachmentsPanel entityType="leave_request" entityId={r.id} canManage={canRequest && r.status === "pending"} /></div>}
            </li>
          ))}
        </ul>
      )}
      {creating && <RequestDialog onClose={() => setCreating(false)} />}
    </section>
  );
}

function RequestDialog({ onClose }: { onClose: () => void }) {
  const { t, isEN } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const types = useTypes();
  const emps = useQuery({ queryKey: ["hr", "employees"], queryFn: () => apiFetch<{ employees: { id: string; code: string; name: string; active: boolean }[] }>("/api/hr/employees") });
  const [f, setF] = useState({ employee_id: "", leave_type_id: "", start_date: todayLocalISO(), end_date: todayLocalISO(), reason: "" });
  const [preview, setPreview] = useState<{ days: number; available: string; limited: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = f.employee_id && f.leave_type_id && f.start_date && f.end_date;
  const set = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setPreview(null); };
  const body = () => ({ ...f, reason: f.reason.trim() || null });
  const check = async () => {
    setError(null);
    try { setPreview(await apiPost("/api/hr/leave/preview", body())); } catch (err) { setError(fail(t, err)); }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/hr/leave/requests", body());
      toast.show(t("leave.sent"), "success");
      void qc.invalidateQueries({ queryKey: ["hr"] });
      onClose();
    } catch (err) {
      setError(fail(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("leave.new")} description={t("leave.new_hint")}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button>
        <button type="button" className="btn-secondary" onClick={check} disabled={busy || !ready}>{t("leave.check")}</button>
        <button type="submit" form="leave-form" className="btn-primary" disabled={busy || !ready}>{busy ? t("ui.saving") : t("leave.send_for_approval")}</button>
      </>}>
      <form id="leave-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void save(); }}>
        <Field label={t("leave.employee")} required>
          <select className="field" value={f.employee_id} onChange={(e) => set({ employee_id: e.target.value })}>
            <option value="">{t("leave.choose")}</option>
            {emps.data?.employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
          </select>
        </Field>
        <Field label={t("leave.type")} required>
          <select className="field" value={f.leave_type_id} onChange={(e) => set({ leave_type_id: e.target.value })}>
            <option value="">{t("leave.choose")}</option>
            {types.data?.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{typeName(isEN, x)}</option>)}
          </select>
        </Field>
        <Field label={t("leave.from")} required><input type="date" className="field" value={f.start_date} onChange={(e) => set({ start_date: e.target.value })} /></Field>
        <Field label={t("leave.to")} required><input type="date" className="field" min={f.start_date} value={f.end_date} onChange={(e) => set({ end_date: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label={t("leave.reason")}><input className="field" maxLength={500} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>
        {preview && (
          <p className="sm:col-span-2 flex items-center gap-2 rounded-lg bg-united-subtle px-3 py-2 text-sm font-medium text-united-dark">
            <CheckCircle2 size={16} className="text-united-green" aria-hidden />
            {t("leave.preview", { days: preview.days })}{preview.limited ? ` · ${t("leave.available", { n: num(preview.available) })}` : ""}
          </p>
        )}
        {error && <p role="alert" className="sm:col-span-2 text-sm font-medium text-united-danger">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Balances ───────────────────────────────────────────────────────────────

type Balance = { employee: { id: string; code: string; name: string }; types: { leaveType?: { id: string; code: string; nameAr: string; nameEn: string | null }; entitled: string; taken: string; adjustments: string; pending: string; balance: string; available: string }[] };

function BalancesTab({ canAdjust }: { canAdjust: boolean }) {
  const { t, isEN } = useLocale();
  const q = useQuery({ queryKey: ["hr", "leave", "balances"], queryFn: () => apiFetch<{ balances: Balance[] }>("/api/hr/leave/balances").then((r) => r.balances) });
  const [ledgerOf, setLedgerOf] = useState<Balance["employee"] | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const rows = (q.data ?? []).filter((b) => b.types.length);
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <p className="text-sm text-united-muted">{t("leave.balances_hint")}</p>
        {canAdjust && <button type="button" className="btn-secondary btn-sm" onClick={() => setAdjusting(true)}>{t("leave.adjust")}</button>}
      </div>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !rows.length ? <EmptyState title={t("leave.balances_empty")} /> : (
        <div className="overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead><tr><th>{t("leave.employee")}</th><th>{t("leave.type")}</th><th className="num">{t("leave.entitled")}</th><th className="num">{t("leave.taken")}</th><th className="num">{t("leave.adjustments")}</th><th className="num">{t("leave.pending")}</th><th className="num">{t("leave.available_col")}</th></tr></thead>
            <tbody>
              {rows.flatMap((b) => b.types.map((x, i) => (
                <tr key={`${b.employee.id}-${x.leaveType?.id}`}>
                  <td>{i === 0 && <button type="button" className="font-semibold text-united-dark underline-offset-2 hover:underline" onClick={() => setLedgerOf(b.employee)}>{b.employee.name}</button>}</td>
                  <td>{x.leaveType ? typeName(isEN, x.leaveType) : "—"}</td>
                  <td className="num" dir="ltr">{num(x.entitled)}</td>
                  <td className="num" dir="ltr">{num(x.taken)}</td>
                  <td className="num" dir="ltr">{num(x.adjustments)}</td>
                  <td className="num" dir="ltr">{num(x.pending)}</td>
                  <td className={`num font-semibold ${Number(x.available) < 0 ? "text-united-danger" : ""}`} dir="ltr">{num(x.available)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
      {ledgerOf && <LedgerDialog employee={ledgerOf} onClose={() => setLedgerOf(null)} />}
      {adjusting && <AdjustDialog onClose={() => setAdjusting(false)} />}
    </section>
  );
}

function LedgerDialog({ employee, onClose }: { employee: { id: string; name: string }; onClose: () => void }) {
  const { t, isEN } = useLocale();
  const q = useQuery({ queryKey: ["hr", "leave", "ledger", employee.id], queryFn: () => apiFetch<{ entries: { id: string; date: string; kind: string; days: string; note: string | null; createdBy: string; leaveType: { code: string; nameAr: string; nameEn: string | null } }[] }>(`/api/hr/leave/ledger?employee_id=${employee.id}`).then((r) => r.entries) });
  return (
    <Modal open onClose={onClose} size="lg" title={`${t("leave.ledger")} · ${employee.name}`} footer={<button type="button" className="btn-primary" onClick={onClose}>{t("ui.close")}</button>}>
      {q.isLoading ? <LoadingState /> : !q.data?.length ? <EmptyState title={t("leave.ledger_empty")} /> : (
        <table className="data-table">
          <thead><tr><th>{t("leave.date")}</th><th>{t("leave.type")}</th><th>{t("leave.kind")}</th><th className="num">{t("leave.days")}</th><th>{t("leave.note")}</th></tr></thead>
          <tbody>
            {q.data.map((e) => (
              <tr key={e.id}>
                <td dir="ltr">{e.date}</td><td>{typeName(isEN, e.leaveType)}</td><td>{t(`leave.kind.${e.kind}`)}</td>
                <td className={`num ${Number(e.days) < 0 ? "text-united-danger" : "text-united-green"}`} dir="ltr">{Number(e.days) > 0 ? "+" : ""}{num(e.days)}</td>
                <td className="text-xs text-united-muted">{e.note ?? ""} · {e.createdBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function AdjustDialog({ onClose }: { onClose: () => void }) {
  const { t, isEN } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const types = useTypes();
  const emps = useQuery({ queryKey: ["hr", "employees"], queryFn: () => apiFetch<{ employees: { id: string; code: string; name: string; active: boolean }[] }>("/api/hr/employees") });
  const [f, setF] = useState({ employee_id: "", leave_type_id: "", days: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = f.employee_id && f.leave_type_id && Number(f.days) && f.reason.trim();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/hr/leave/adjustments", { ...f, days: Number(f.days) });
      toast.show(t("leave.adjusted"), "success");
      void qc.invalidateQueries({ queryKey: ["hr", "leave"] });
      onClose();
    } catch (err) {
      setError(fail(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("leave.adjust")} description={t("leave.adjust_hint")}
      footer={<><button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button><button type="submit" form="adjust-form" className="btn-primary" disabled={busy || !ready}>{busy ? t("ui.saving") : t("ui.save")}</button></>}>
      <form id="adjust-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void save(); }}>
        <Field label={t("leave.employee")} required>
          <select className="field" value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
            <option value="">{t("leave.choose")}</option>
            {emps.data?.employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
          </select>
        </Field>
        <Field label={t("leave.type")} required>
          <select className="field" value={f.leave_type_id} onChange={(e) => setF({ ...f, leave_type_id: e.target.value })}>
            <option value="">{t("leave.choose")}</option>
            {types.data?.map((x) => <option key={x.id} value={x.id}>{typeName(isEN, x)}</option>)}
          </select>
        </Field>
        <Field label={t("leave.days")} required hint={t("leave.days_signed_hint")}><input type="number" step="0.5" className="field" dir="ltr" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>
        <Field label={t("leave.reason")} required><input className="field" maxLength={300} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        {error && <p role="alert" className="sm:col-span-2 text-sm font-medium text-united-danger">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Setup: types, policies, allocation ─────────────────────────────────────

function SetupTab({ canConfigure }: { canConfigure: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <TypesCard canConfigure={canConfigure} />
      <PoliciesCard canConfigure={canConfigure} />
    </div>
  );
}

function TypesCard({ canConfigure }: { canConfigure: boolean }) {
  const { t, isEN } = useLocale();
  const q = useTypes();
  const [editing, setEditing] = useState<LeaveType | "new" | null>(null);
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <div><h2 className="section-title">{t("leave.types")}</h2><p className="text-sm text-united-muted">{t("leave.types_hint")}</p></div>
        {canConfigure && <button type="button" className="btn-primary btn-sm gap-1.5" onClick={() => setEditing("new")}><Plus size={16} aria-hidden />{t("leave.type_add")}</button>}
      </div>
      {q.isLoading ? <LoadingState /> : !q.data?.length ? <EmptyState title={t("leave.types_empty")} /> : (
        <ul className="divide-y divide-united-border">
          {q.data.map((x) => (
            <li key={x.id} className={`flex flex-wrap items-center justify-between gap-3 px-5 py-3 ${x.active ? "" : "opacity-60"}`}>
              <div className="min-w-0">
                <span className="font-semibold text-united-dark">{typeName(isEN, x)}</span> <span className="text-xs text-united-muted" dir="ltr">{x.code}</span>
                <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs">
                  <StatusPill tone={x.payMode === "unpaid" ? "neutral" : "success"}>{t(`leave.pay.${x.payMode}`)}{x.paidPercent ? ` ${num(x.paidPercent)}%` : ""}</StatusPill>
                  <StatusPill tone="info">{t(`leave.counts.${x.countsDays}`)}</StatusPill>
                  {x.requiresAttachment && <StatusPill tone="info">{t("leave.needs_document")}</StatusPill>}
                  {x.allowNegativeBalance && <StatusPill tone="neutral">{t("leave.no_limit")}</StatusPill>}
                </div>
              </div>
              {canConfigure && <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(x)}>{t("ui.edit")}</button>}
            </li>
          ))}
        </ul>
      )}
      {editing && <TypeDialog type={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function TypeDialog({ type, onClose }: { type: LeaveType | null; onClose: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({
    code: type?.code ?? "", name_ar: type?.nameAr ?? "", name_en: type?.nameEn ?? "", pay_mode: type?.payMode ?? "paid", paid_percent: type?.paidPercent ?? "",
    counts_days: type?.countsDays ?? "working", requires_attachment: type?.requiresAttachment ?? false, allow_negative_balance: type?.allowNegativeBalance ?? false, active: type?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { ...f, name_en: f.name_en.trim() || null, paid_percent: f.pay_mode === "partially_paid" ? Number(f.paid_percent) : null, ...(type ? { expected_version: type.version } : {}) };
    try {
      if (type) await apiPatch(`/api/hr/leave/types/${type.id}`, body);
      else await apiPost("/api/hr/leave/types", body);
      toast.show(t("leave.saved"), "success");
      void qc.invalidateQueries({ queryKey: ["hr", "leave"] });
      onClose();
    } catch (err) {
      setError(fail(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={type ? t("leave.type_edit") : t("leave.type_add")} description={t("leave.type_dialog_hint")}
      footer={<><button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button><button type="submit" form="type-form" className="btn-primary" disabled={busy || !f.code || !f.name_ar.trim()}>{busy ? t("ui.saving") : t("ui.save")}</button></>}>
      <form id="type-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (!busy) void save(); }}>
        <Field label={t("att.code")} required><input className="field" dir="ltr" maxLength={30} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label={t("att.name_ar")} required><input className="field" maxLength={100} value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} /></Field>
        <Field label={t("att.name_en")}><input className="field" dir="ltr" maxLength={100} value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} /></Field>
        <Field label={t("leave.pay_mode")} required>
          <select className="field" value={f.pay_mode} onChange={(e) => setF({ ...f, pay_mode: e.target.value })}>
            {["paid", "unpaid", "partially_paid"].map((m) => <option key={m} value={m}>{t(`leave.pay.${m}`)}</option>)}
          </select>
        </Field>
        {f.pay_mode === "partially_paid" && <Field label={t("leave.paid_percent")} required><input type="number" min={1} max={99} className="field" dir="ltr" value={f.paid_percent} onChange={(e) => setF({ ...f, paid_percent: e.target.value })} /></Field>}
        <Field label={t("leave.counts_days")} required>
          <select className="field" value={f.counts_days} onChange={(e) => setF({ ...f, counts_days: e.target.value })}>
            {["working", "calendar"].map((m) => <option key={m} value={m}>{t(`leave.counts.${m}`)}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-2 flex flex-wrap gap-5 text-sm font-medium">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.requires_attachment} onChange={(e) => setF({ ...f, requires_attachment: e.target.checked })} />{t("leave.needs_document")}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.allow_negative_balance} onChange={(e) => setF({ ...f, allow_negative_balance: e.target.checked })} />{t("leave.no_limit")}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{t("att.active")}</label>
        </div>
        {error && <p role="alert" className="sm:col-span-2 text-sm font-medium text-united-danger">{error}</p>}
      </form>
    </Modal>
  );
}

function PoliciesCard({ canConfigure }: { canConfigure: boolean }) {
  const { t, isEN } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hr", "leave", "policies"], queryFn: () => apiFetch<{ policies: Policy[] }>("/api/hr/leave/policies").then((r) => r.policies) });
  const [creating, setCreating] = useState(false);
  const [alloc, setAlloc] = useState({ policy_id: "", period: todayLocalISO().slice(0, 4) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["hr", "leave"] });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.show(ok, "success"); refresh(); } catch (err) { toast.show(fail(t, err), "error"); }
  };
  const verified = (q.data ?? []).filter((p) => p.status === "verified" && p.accrualMethod !== "none");
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <div><h2 className="section-title">{t("leave.policies")}</h2><p className="text-sm text-united-muted">{t("leave.policies_hint")}</p></div>
        {canConfigure && <button type="button" className="btn-primary btn-sm gap-1.5" onClick={() => setCreating(true)}><Plus size={16} aria-hidden />{t("leave.policy_add")}</button>}
      </div>
      {q.isLoading ? <LoadingState /> : !q.data?.length ? <EmptyState title={t("leave.policies_empty")} /> : (
        <ul className="divide-y divide-united-border">
          {q.data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-united-dark">{typeName(isEN, p.leaveType)}</span>
                  <StatusPill tone={POLICY_TONE[p.status] ?? "neutral"}>{t(`leave.policy.${p.status}`)}</StatusPill>
                  <span className="text-xs text-united-muted">{t(`leave.accrual.${p.accrualMethod}`)} · <span dir="ltr">{p.effectiveFrom} → {p.effectiveTo ?? "…"}</span></span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                  {p.tiers.map((x, i) => <span key={i} className="rounded bg-united-subtle px-1.5 py-0.5">{t("leave.tier_text", { months: x.minServiceMonths, days: num(x.daysPerYear) })}{x.minAge ? ` · ${t("leave.tier_age", { age: x.minAge })}` : ""}</span>)}
                </div>
                <div className="mt-0.5 text-xs text-united-muted">{t("leave.source")}: {p.sourceReference} · {p.createdBy}{p.verifiedBy ? ` · ${t("leave.verified_by")} ${p.verifiedBy}` : ""}</div>
              </div>
              {canConfigure && (
                <div className="flex gap-2">
                  {p.status === "draft" && <button type="button" className="btn-primary btn-sm" onClick={async () => { if (await dialogs.confirm({ title: t("leave.verify"), body: t("leave.verify_confirm") })) void act(() => apiPost(`/api/hr/leave/policies/${p.id}/verify`, {}), t("leave.verified")); }}>{t("leave.verify")}</button>}
                  {p.status !== "retired" && <button type="button" className="btn-secondary btn-sm" onClick={async () => { const reason = await dialogs.prompt({ title: p.status === "draft" ? t("leave.discard") : t("leave.retire"), label: t("leave.reason"), required: true }); if (reason) void act(() => apiPost(`/api/hr/leave/policies/${p.id}/retire`, { reason }), t("leave.saved")); }}>{p.status === "draft" ? t("leave.discard") : t("leave.retire")}</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canConfigure && (
        <form className="flex flex-wrap items-end gap-3 border-t border-united-border p-4" onSubmit={(e) => { e.preventDefault(); void act(async () => {
          const r = await apiPost<{ created: number; already: number; joinedDuring: number; noTier: number; missingBirthDate: number }>("/api/hr/leave/allocate", alloc);
          toast.show(t("leave.allocated", { created: r.created, already: r.already, joined: r.joinedDuring, notier: r.noTier, nobirth: r.missingBirthDate }), "info");
        }, t("leave.saved")); }}>
          <Field label={t("leave.allocate_policy")}>
            <select className="field" value={alloc.policy_id} onChange={(e) => setAlloc({ ...alloc, policy_id: e.target.value })}>
              <option value="">{t("leave.choose")}</option>
              {verified.map((p) => <option key={p.id} value={p.id}>{typeName(isEN, p.leaveType)} · {t(`leave.accrual.${p.accrualMethod}`)}</option>)}
            </select>
          </Field>
          <Field label={t("leave.period")} hint={t("leave.period_hint")}><input className="field w-[140px]" dir="ltr" value={alloc.period} onChange={(e) => setAlloc({ ...alloc, period: e.target.value })} /></Field>
          <button type="submit" className="btn-secondary" disabled={!alloc.policy_id}>{t("leave.allocate")}</button>
          <p className="basis-full text-xs text-united-muted">{t("leave.allocate_hint")}</p>
        </form>
      )}
      {creating && <PolicyDialog onClose={() => setCreating(false)} />}
    </section>
  );
}

function PolicyDialog({ onClose }: { onClose: () => void }) {
  const { t, isEN } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const types = useTypes();
  const [f, setF] = useState({ leave_type_id: "", effective_from: `${todayLocalISO().slice(0, 4)}-01-01`, accrual_method: "annual_upfront", source_reference: "" });
  const [tiers, setTiers] = useState([{ min_service_months: "0", min_age: "", days_per_year: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = f.leave_type_id && f.source_reference.trim() && tiers.every((x) => x.days_per_year !== "");
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/hr/leave/policies", { ...f, tiers: tiers.map((x) => ({ min_service_months: Number(x.min_service_months) || 0, min_age: x.min_age ? Number(x.min_age) : null, days_per_year: Number(x.days_per_year) })) });
      toast.show(t("leave.saved"), "success");
      void qc.invalidateQueries({ queryKey: ["hr", "leave"] });
      onClose();
    } catch (err) {
      setError(fail(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={t("leave.policy_add")} description={t("leave.policy_dialog_hint")}
      footer={<><button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button><button type="submit" form="policy-form" className="btn-primary" disabled={busy || !ready}>{busy ? t("ui.saving") : t("leave.save_draft")}</button></>}>
      <form id="policy-form" className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void save(); }}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("leave.type")} required>
            <select className="field" value={f.leave_type_id} onChange={(e) => setF({ ...f, leave_type_id: e.target.value })}>
              <option value="">{t("leave.choose")}</option>
              {types.data?.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{typeName(isEN, x)}</option>)}
            </select>
          </Field>
          <Field label={t("leave.effective_from")} required><input type="date" className="field" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></Field>
          <Field label={t("leave.accrual")} required>
            <select className="field" value={f.accrual_method} onChange={(e) => setF({ ...f, accrual_method: e.target.value })}>
              {["annual_upfront", "monthly", "none"].map((m) => <option key={m} value={m}>{t(`leave.accrual.${m}`)}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t("leave.source")} required hint={t("leave.source_hint")}><input className="field" maxLength={300} value={f.source_reference} onChange={(e) => setF({ ...f, source_reference: e.target.value })} /></Field>
        <table className="data-table">
          <thead><tr><th>{t("leave.min_service")}</th><th>{t("leave.min_age")}</th><th>{t("leave.days_per_year")}</th><th /></tr></thead>
          <tbody>
            {tiers.map((x, i) => (
              <tr key={i}>
                <td><input type="number" min={0} className="field w-[110px]" dir="ltr" value={x.min_service_months} onChange={(e) => setTiers(tiers.map((y, j) => (j === i ? { ...y, min_service_months: e.target.value } : y)))} aria-label={t("leave.min_service")} /></td>
                <td><input type="number" min={14} max={100} className="field w-[90px]" dir="ltr" value={x.min_age} onChange={(e) => setTiers(tiers.map((y, j) => (j === i ? { ...y, min_age: e.target.value } : y)))} aria-label={t("leave.min_age")} /></td>
                <td><input type="number" min={0} step="0.5" className="field w-[110px]" dir="ltr" value={x.days_per_year} onChange={(e) => setTiers(tiers.map((y, j) => (j === i ? { ...y, days_per_year: e.target.value } : y)))} aria-label={t("leave.days_per_year")} /></td>
                <td>{tiers.length > 1 && <button type="button" className="btn-ghost btn-sm" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>×</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="btn-secondary btn-sm self-start" onClick={() => setTiers([...tiers, { min_service_months: "", min_age: "", days_per_year: "" }])}>{t("leave.tier_add")}</button>
        {error && <p role="alert" className="text-sm font-medium text-united-danger">{error}</p>}
      </form>
    </Modal>
  );
}
