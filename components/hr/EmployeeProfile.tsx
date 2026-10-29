"use client";

import { useState } from "react";
import { systemText } from "@/lib/locale/system-text";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Plus, ShieldAlert } from "lucide-react";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { Modal, useDialogs } from "@/components/ui/Dialog";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { AttachmentsPanel } from "@/components/AttachmentsPanel";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, Tabs, fmtMoney } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

/**
 * One employee's file (docs/erp/DESIGN_SYSTEM.md §8.1): overview, employment history,
 * personal & bank data, documents, and the money statement. Each tab is shown only to the
 * permissions that may read it — and each tab's data comes from its own endpoint, gated on
 * the server, so hiding a tab is a convenience, never the protection.
 */

type History = {
  id: string; event: string; effectiveFrom: string; effectiveTo: string | null; status: string; department: string | null; departmentAr?: string | null; jobTitle: string | null;
  manager: { id: string; code: string; name: string } | null; employmentType: string | null; contractEnd: string | null; probationEnd: string | null;
  reason: string; createdBy: string; superseded: boolean; terminationReason?: string | null;
};
type Profile = {
  employee: { id: string; code: string; name: string; nameAr?: string | null; jobTitle: string | null; active: boolean; hireDate: string | null; department: { id: string; name: string; nameAr?: string | null } | null; version: number; phone?: string | null };
  current: { status: string; employmentType: string | null; since: string; manager: { id: string; name: string } | null; contractEnd: string | null; probationEnd: string | null; schedule: { id: string; code: string; nameAr: string; nameEn: string | null } | null } | null;
  history: History[];
};
type PrivateFile = {
  info: Record<string, string | number | null> | null;
  bankAccounts: { id: string; bankName: string; holderName: string; accountNumberMasked: string; active: boolean; isPrimary: boolean; createdAt: string; createdBy: string }[];
  documents: { id: string; docType: string; documentNumber: string | null; issueDate: string | null; expiryDate: string | null; attachment: { id: string; fileName: string } }[];
};
type Tab = "overview" | "history" | "private" | "documents" | "statement";

const STATUS_TONE: Record<string, Tone> = { active: "success", suspended: "warn", terminated: "neutral" };
const fail = (t: (k: string) => string, err: unknown) => (err instanceof ApiClientError ? err.message : t("hr.error"));

export function EmployeeProfile({ employeeId }: { employeeId: string }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  const [tab, setTab] = useState<Tab>("overview");
  const q = useQuery({ queryKey: ["hr", "profile", employeeId], queryFn: () => apiFetch<Profile>(`/api/hr/employees/${employeeId}`) });
  const canPrivate = can("hr.private.view");
  const manage = can("hr.employees.manage");

  if (q.isLoading) return <div className="page-container"><LoadingState /></div>;
  if (q.isError || !q.data) return <div className="page-container"><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /></div>;
  const { employee, current } = q.data;

  const items: { key: Tab; label: string }[] = [
    { key: "overview", label: t("hr.profile.tab.overview") },
    { key: "history", label: t("hr.profile.tab.history") },
    ...(canPrivate ? [{ key: "private" as Tab, label: t("hr.profile.tab.private") }, { key: "documents" as Tab, label: t("hr.profile.tab.documents") }] : []),
    ...(manage ? [{ key: "statement" as Tab, label: t("hr.profile.tab.statement") }] : []),
  ];

  return (
    <div className="page-container">
      <PageHeader
        back={{ href: "/hr", label: t("hr.profile.back") }}
        title={localName(employee, locale)}
        description={<><span dir="ltr">{employee.code}</span>{employee.jobTitle ? ` · ${employee.jobTitle}` : ""}{employee.department ? ` · ${localName(employee.department, locale)}` : ""}</>}
        actions={current && <StatusPill tone={STATUS_TONE[current.status] ?? "neutral"} size="md">{t(`hr.employment.status.${current.status}`)}</StatusPill>}
      />
      <Tabs value={tab} onChange={setTab} items={items} />
      {tab === "overview" && <Overview data={q.data} />}
      {tab === "history" && <HistoryTab data={q.data} canManage={manage} />}
      {tab === "private" && canPrivate && <PrivateTab employeeId={employeeId} canManage={can("hr.private.manage")} />}
      {tab === "documents" && canPrivate && <DocumentsTab employeeId={employeeId} canManage={can("hr.private.manage")} />}
      {tab === "statement" && manage && <StatementTab employeeId={employeeId} />}
    </div>
  );
}

function Overview({ data }: { data: Profile }) {
  const { t, isEN, locale } = useLocale();
  const { employee, current } = data;
  const rows: [string, React.ReactNode][] = [
    [t("hr.profile.code"), <span key="c" dir="ltr">{employee.code}</span>],
    [t("hr.placeholder.department"), (employee.department ? localName(employee.department, locale) : "—")],
    [t("hr.placeholder.job_title"), employee.jobTitle ?? "—"],
    [t("hr.profile.manager"), current?.manager?.name ?? "—"],
    [t("hr.col.hire_date"), <span key="h" dir="ltr">{employee.hireDate ?? "—"}</span>],
    [t("hr.profile.since"), <span key="s" dir="ltr">{current?.since ?? "—"}</span>],
    [t("hr.profile.employment_type"), current?.employmentType ?? "—"],
    [t("hr.profile.contract_end"), <span key="e" dir="ltr">{current?.contractEnd ?? "—"}</span>],
    [t("hr.profile.probation_end"), <span key="p" dir="ltr">{current?.probationEnd ?? "—"}</span>],
    [t("hr.profile.schedule"), current?.schedule ? (isEN ? current.schedule.nameEn || current.schedule.nameAr : current.schedule.nameAr) : t("hr.employment.schedule_default")],
    ...(employee.phone !== undefined ? [[t("hr.placeholder.phone"), <span key="ph" dir="ltr">{employee.phone || "—"}</span>] as [string, React.ReactNode]] : []),
  ];
  return (
    <section className="card">
      <dl className="grid divide-y divide-united-border sm:grid-cols-2 sm:divide-y-0">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 px-5 py-3 sm:border-b sm:border-united-border">
            <dt className="text-sm text-united-muted">{k}</dt>
            <dd className="text-sm font-medium text-united-dark text-end">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function HistoryTab({ data, canManage }: { data: Profile; canManage: boolean }) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(false);
  const terminated = data.current?.status === "terminated";
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <h2 className="section-title">{t("hr.profile.history_title")}</h2>
        {canManage && (
          <button type="button" className="btn-primary btn-sm gap-1.5" onClick={() => setOpen(true)}>
            <Plus size={16} aria-hidden />
            {terminated ? t("hr.employment.rehire") : t("hr.employment.record_change")}
          </button>
        )}
      </div>
      <ol className="divide-y divide-united-border">
        {data.history.map((h) => (
          <li key={h.id} className={`flex flex-wrap items-start justify-between gap-3 px-5 py-3.5 ${h.superseded ? "opacity-60" : ""}`}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-united-dark">{t(`hr.employment.event.${h.event}`)}</span>
                <StatusPill tone={STATUS_TONE[h.status] ?? "neutral"}>{t(`hr.employment.status.${h.status}`)}</StatusPill>
                {h.superseded && <StatusPill tone="neutral" strike>{t("hr.employment.superseded")}</StatusPill>}
              </div>
              <div className="mt-0.5 text-sm text-united-dark">
                {[h.department ? localName({ name: h.department, nameAr: h.departmentAr }, locale) : null, h.jobTitle, h.manager ? `${t("hr.profile.manager")}: ${localName(h.manager, locale)}` : null, h.employmentType].filter(Boolean).join(" · ") || "—"}
              </div>
              <div className="mt-0.5 text-xs text-united-muted">
                {systemText(h.reason, locale)}{h.terminationReason ? ` · ${t("hr.employment.termination_reason")}: ${h.terminationReason}` : ""} · {h.createdBy}
              </div>
            </div>
            <div dir="ltr" className="whitespace-nowrap text-sm text-united-muted">
              {h.effectiveFrom} → {h.superseded ? "×" : h.effectiveTo ?? t("hr.employment.open")}
            </div>
          </li>
        ))}
      </ol>
      {open && <EmploymentDialog data={data} onClose={() => setOpen(false)} />}
    </section>
  );
}

function EmploymentDialog({ data, onClose }: { data: Profile; onClose: () => void }) {
  const { t, isEN, locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const terminated = data.current?.status === "terminated";
  const deps = useQuery({ queryKey: ["hr", "employees"], queryFn: () => apiFetch<{ employees: { id: string; name: string; active: boolean }[]; departments: { id: string; name: string; active: boolean }[] }>("/api/hr/employees") });
  const [f, setF] = useState({
    event: terminated ? "rehire" : "transfer",
    effective_from: todayLocalISO(),
    department_id: data.employee.department?.id ?? "",
    job_title: data.employee.jobTitle ?? "",
    manager_employee_id: data.current?.manager?.id ?? "",
    employment_type: data.current?.employmentType ?? "",
    contract_end: data.current?.contractEnd ?? "",
    work_schedule_id: data.current?.schedule?.id ?? "",
    status: data.current?.status === "suspended" ? "active" : "suspended",
    termination_reason: "",
    reason: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schedules = useQuery({ queryKey: ["hr", "schedules"], queryFn: () => apiFetch<{ schedules: { id: string; nameAr: string; nameEn: string | null; active: boolean; isDefault: boolean }[] }>("/api/hr/schedules").then((r) => r.schedules) });
  const events = terminated ? ["rehire"] : ["transfer", "promotion", "status_change", "contract_change", "termination"];
  const ready = f.reason.trim() && (f.event !== "termination" || f.termination_reason.trim());

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/hr/employees/${data.employee.id}/employment`, {
        event: f.event,
        effective_from: f.effective_from,
        department_id: f.department_id || null,
        job_title: f.job_title.trim() || null,
        manager_employee_id: f.manager_employee_id || null,
        employment_type: f.employment_type.trim() || null,
        contract_end: f.contract_end || null,
        ...(f.event === "contract_change" || f.event === "rehire" ? { work_schedule_id: f.work_schedule_id || null } : {}),
        ...(f.event === "status_change" ? { status: f.status } : {}),
        ...(f.event === "termination" ? { termination_reason: f.termination_reason.trim() } : {}),
        reason: f.reason.trim(),
      });
      toast.show(t("hr.employment.saved"), "success");
      void qc.invalidateQueries({ queryKey: ["hr"] });
      onClose();
    } catch (err) {
      setError(fail(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={terminated ? t("hr.employment.rehire") : t("hr.employment.record_change")}
      description={t("hr.employment.dialog_hint")}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button>
          <button type="submit" form="employment-form" className={f.event === "termination" ? "btn-danger-solid" : "btn-primary"} disabled={busy || !ready}>{busy ? t("ui.saving") : t("ui.save")}</button>
        </>
      }
    >
      <form id="employment-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void save(); }}>
        <Field label={t("hr.employment.event_label")} required>
          <select className="field" value={f.event} onChange={(e) => setF({ ...f, event: e.target.value })}>
            {events.map((ev) => <option key={ev} value={ev}>{t(`hr.employment.event.${ev}`)}</option>)}
          </select>
        </Field>
        <Field label={t("hr.employment.effective_from")} required hint={t("hr.employment.effective_hint")}>
          <input type="date" className="field" required max={todayLocalISO()} value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} />
        </Field>
        {(f.event === "transfer" || f.event === "promotion" || f.event === "rehire") && (
          <>
            <Field label={t("hr.placeholder.department")}>
              <select className="field" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
                <option value="">{t("hr.department.none")}</option>
                {deps.data?.departments.filter((d) => d.active || d.id === f.department_id).map((d) => <option key={d.id} value={d.id}>{localName(d, locale)}</option>)}
              </select>
            </Field>
            <Field label={t("hr.placeholder.job_title")}>
              <input className="field" maxLength={100} value={f.job_title} onChange={(e) => setF({ ...f, job_title: e.target.value })} />
            </Field>
            <Field label={t("hr.profile.manager")}>
              <select className="field" value={f.manager_employee_id} onChange={(e) => setF({ ...f, manager_employee_id: e.target.value })}>
                <option value="">—</option>
                {deps.data?.employees.filter((e) => e.active && e.id !== data.employee.id).map((e) => <option key={e.id} value={e.id}>{localName(e, locale)}</option>)}
              </select>
            </Field>
          </>
        )}
        {(f.event === "contract_change" || f.event === "rehire") && (
          <>
            <Field label={t("hr.profile.employment_type")} hint={t("hr.employment.type_hint")}>
              <input className="field" maxLength={40} value={f.employment_type} onChange={(e) => setF({ ...f, employment_type: e.target.value })} />
            </Field>
            <Field label={t("hr.profile.contract_end")}>
              <input type="date" className="field" value={f.contract_end} onChange={(e) => setF({ ...f, contract_end: e.target.value })} />
            </Field>
            <Field label={t("hr.profile.schedule")}>
              <select className="field" value={f.work_schedule_id} onChange={(e) => setF({ ...f, work_schedule_id: e.target.value })}>
                <option value="">{t("hr.employment.schedule_default")}</option>
                {schedules.data?.filter((s) => s.active || s.id === f.work_schedule_id).map((s) => <option key={s.id} value={s.id}>{isEN ? s.nameEn || s.nameAr : s.nameAr}</option>)}
              </select>
            </Field>
          </>
        )}
        {f.event === "status_change" && (
          <Field label={t("hr.employment.new_status")} required>
            <select className="field" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="active">{t("hr.employment.status.active")}</option>
              <option value="suspended">{t("hr.employment.status.suspended")}</option>
            </select>
          </Field>
        )}
        {f.event === "termination" && (
          <div className="sm:col-span-2">
            <Field label={t("hr.employment.termination_reason")} required>
              <input className="field" required maxLength={500} value={f.termination_reason} onChange={(e) => setF({ ...f, termination_reason: e.target.value })} />
            </Field>
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-united-warn"><ShieldAlert size={14} className="mt-0.5 shrink-0" aria-hidden />{t("hr.employment.termination_hint")}</p>
          </div>
        )}
        <div className="sm:col-span-2">
          <Field label={t("hr.employment.reason")} required>
            <input className="field" required maxLength={500} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          </Field>
        </div>
        {error && <p role="alert" className="text-sm font-medium text-united-danger sm:col-span-2">{error}</p>}
      </form>
    </Modal>
  );
}

const PRIVATE_FIELDS: { key: string; api: string; labelKey: string; ltr?: boolean; date?: boolean }[] = [
  { key: "nationalId", api: "national_id", labelKey: "hr.private.national_id", ltr: true },
  { key: "birthDate", api: "birth_date", labelKey: "hr.private.birth_date", date: true },
  { key: "nationality", api: "nationality", labelKey: "hr.private.nationality" },
  { key: "insuranceNumber", api: "insurance_number", labelKey: "hr.private.insurance_number", ltr: true },
  { key: "insuranceStartDate", api: "insurance_start_date", labelKey: "hr.private.insurance_start", date: true },
  { key: "taxRegistrationNo", api: "tax_registration_no", labelKey: "hr.private.tax_no", ltr: true },
  { key: "address", api: "address", labelKey: "hr.private.address" },
  { key: "emergencyContactName", api: "emergency_contact_name", labelKey: "hr.private.emergency_name" },
  { key: "emergencyContactPhone", api: "emergency_contact_phone", labelKey: "hr.private.emergency_phone", ltr: true },
];

function PrivateTab({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const { t } = useLocale();
  const q = useQuery({ queryKey: ["hr", "private", employeeId], queryFn: () => apiFetch<PrivateFile>(`/api/hr/employees/${employeeId}/private`) });
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const toast = useToast();
  const qc = useQueryClient();
  const dialogs = useDialogs();
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const info = q.data.info ?? {};
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-start gap-1.5 text-xs text-united-muted"><ShieldAlert size={14} className="mt-0.5 shrink-0" aria-hidden />{t("hr.private.audited_note")}</p>
      <section className="card overflow-hidden">
        <div className="card-header">
          <h2 className="section-title">{t("hr.private.title")}</h2>
          {canManage && <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(true)}>{t("hr.action.edit")}</button>}
        </div>
        <dl className="grid divide-y divide-united-border sm:grid-cols-2 sm:divide-y-0">
          {PRIVATE_FIELDS.map((f) => (
            <div key={f.key} className="flex items-baseline justify-between gap-4 px-5 py-3 sm:border-b sm:border-united-border">
              <dt className="text-sm text-united-muted">{t(f.labelKey)}</dt>
              <dd className="text-sm font-medium text-united-dark text-end" dir={f.ltr || f.date ? "ltr" : undefined}>{(info[f.key] as string) || "—"}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card overflow-hidden">
        <div className="card-header">
          <h2 className="section-title">{t("hr.bank.title")}</h2>
          {canManage && <button type="button" className="btn-secondary btn-sm gap-1.5" onClick={() => setAdding(true)}><Plus size={16} aria-hidden />{t("hr.bank.add")}</button>}
        </div>
        {q.data.bankAccounts.length === 0 ? (
          <EmptyState icon="🏦" title={t("hr.bank.empty")} />
        ) : (
          <table className="data-table">
            <thead><tr><th>{t("hr.bank.bank")}</th><th>{t("hr.bank.holder")}</th><th>{t("hr.bank.number")}</th><th>{t("hr.col.status")}</th><th><span className="sr-only">{t("hr.col.actions")}</span></th></tr></thead>
            <tbody>
              {q.data.bankAccounts.map((a) => (
                <tr key={a.id} className={a.active ? undefined : "text-united-muted"}>
                  <td className="font-medium">{a.bankName}</td>
                  <td>{a.holderName}</td>
                  <td dir="ltr" className="whitespace-nowrap">{revealed[a.id] ?? a.accountNumberMasked}</td>
                  <td><StatusPill tone={a.active ? "success" : "neutral"}>{a.active ? t("hr.bank.active") : t("hr.bank.replaced")}</StatusPill></td>
                  <td className="whitespace-nowrap text-end">
                    {!revealed[a.id] && (
                      <button type="button" className="btn-ghost btn-sm gap-1.5" onClick={async () => {
                        const ok = await dialogs.confirm({ title: t("hr.bank.reveal_title"), body: t("hr.bank.reveal_message"), confirmLabel: t("hr.bank.reveal") });
                        if (!ok) return;
                        try {
                          const r = await apiPost<{ account: { accountNumber: string } }>(`/api/hr/employees/${employeeId}/bank-accounts/${a.id}/reveal`, {});
                          setRevealed({ ...revealed, [a.id]: r.account.accountNumber });
                        } catch (err) { toast.show(fail(t, err), "error"); }
                      }}><Eye size={15} aria-hidden />{t("hr.bank.reveal")}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {editing && <PrivateDialog employeeId={employeeId} info={info} onClose={() => setEditing(false)} />}
      {adding && <BankDialog employeeId={employeeId} onClose={() => setAdding(false)} onSaved={() => void qc.invalidateQueries({ queryKey: ["hr", "private", employeeId] })} />}
    </div>
  );
}

function PrivateDialog({ employeeId, info, onClose }: { employeeId: string; info: Record<string, string | number | null>; onClose: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState<Record<string, string>>(Object.fromEntries(PRIVATE_FIELDS.map((p) => [p.api, (info[p.key] as string) ?? ""])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/hr/employees/${employeeId}/private`, { ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null])), ...(info.version ? { expected_version: info.version } : {}) });
      toast.show(t("hr.employee.saved"), "success");
      void qc.invalidateQueries({ queryKey: ["hr", "private", employeeId] });
      onClose();
    } catch (err) { setError(fail(t, err)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={t("hr.private.edit_title")} description={t("hr.private.audited_note")}
      footer={<><button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button><button type="submit" form="private-form" className="btn-primary" disabled={busy}>{busy ? t("ui.saving") : t("ui.save")}</button></>}>
      <form id="private-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (!busy) void save(); }}>
        {PRIVATE_FIELDS.map((p) => (
          <Field key={p.api} label={t(p.labelKey)}>
            <input className="field" type={p.date ? "date" : "text"} dir={p.ltr ? "ltr" : undefined} value={f[p.api]} onChange={(e) => setF({ ...f, [p.api]: e.target.value })} />
          </Field>
        ))}
        {error && <p role="alert" className="text-sm font-medium text-united-danger sm:col-span-2">{error}</p>}
      </form>
    </Modal>
  );
}

function BankDialog({ employeeId, onClose, onSaved }: { employeeId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const [f, setF] = useState({ bank_name: "", account_number: "", iban: "", holder_name: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = f.bank_name.trim() && f.account_number.trim() && f.holder_name.trim() && f.reason.trim();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/hr/employees/${employeeId}/bank-accounts`, { ...f, iban: f.iban.trim() || null });
      toast.show(t("hr.bank.saved"), "success");
      onSaved();
      onClose();
    } catch (err) { setError(fail(t, err)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={t("hr.bank.add")} description={t("hr.bank.add_hint")}
      footer={<><button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button><button type="submit" form="bank-form" className="btn-primary" disabled={busy || !ready}>{busy ? t("ui.saving") : t("ui.save")}</button></>}>
      <form id="bank-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void save(); }}>
        <Field label={t("hr.bank.bank")} required><input className="field" required value={f.bank_name} onChange={(e) => setF({ ...f, bank_name: e.target.value })} /></Field>
        <Field label={t("hr.bank.holder")} required><input className="field" required value={f.holder_name} onChange={(e) => setF({ ...f, holder_name: e.target.value })} /></Field>
        <Field label={t("hr.bank.number")} required><input className="field" required dir="ltr" autoComplete="off" value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} /></Field>
        <Field label="IBAN"><input className="field" dir="ltr" autoComplete="off" value={f.iban} onChange={(e) => setF({ ...f, iban: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label={t("hr.employment.reason")} required><input className="field" required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>
        {error && <p role="alert" className="text-sm font-medium text-united-danger sm:col-span-2">{error}</p>}
      </form>
    </Modal>
  );
}

const DOC_TYPES = ["id_document", "employment_contract", "insurance_form", "certificate", "medical", "other"];

function DocumentsTab({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const { t } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const file = useQuery({ queryKey: ["hr", "private", employeeId], queryFn: () => apiFetch<PrivateFile>(`/api/hr/employees/${employeeId}/private`) });
  const atts = useQuery({ queryKey: ["attachments", "employee", employeeId], queryFn: () => apiFetch<{ attachments: { id: string; fileName: string; category: string }[] }>(`/api/attachments?entity_type=employee&entity_id=${employeeId}`) });
  const registered = new Set((file.data?.documents ?? []).map((d) => d.attachment.id));
  const unregistered = (atts.data?.attachments ?? []).filter((a) => !registered.has(a.id));
  const [f, setF] = useState({ attachment_id: "", doc_type: "id_document", document_number: "", issue_date: "", expiry_date: "" });
  const today = todayLocalISO();
  const soon = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-4">
      <section className="card overflow-hidden">
        <div className="card-header"><h2 className="section-title">{t("hr.docs.register_title")}</h2></div>
        {(file.data?.documents ?? []).length === 0 ? (
          <EmptyState icon="📄" title={t("hr.docs.empty")} />
        ) : (
          <table className="data-table">
            <thead><tr><th>{t("hr.docs.type")}</th><th>{t("hr.docs.file")}</th><th>{t("hr.docs.number")}</th><th>{t("hr.docs.issue")}</th><th>{t("hr.docs.expiry")}</th></tr></thead>
            <tbody>
              {file.data!.documents.map((d) => {
                const tone: Tone | null = d.expiryDate ? (d.expiryDate < today ? "danger" : d.expiryDate <= soon ? "warn" : null) : null;
                return (
                  <tr key={d.id}>
                    <td className="font-medium">{t(`attach.category.${d.docType}`)}</td>
                    <td><a className="text-united-green hover:underline" href={`/api/attachments/${d.attachment.id}/download`} target="_blank" rel="noopener noreferrer">{d.attachment.fileName}</a></td>
                    <td dir="ltr">{d.documentNumber ?? "—"}</td>
                    <td dir="ltr">{d.issueDate ?? "—"}</td>
                    <td><span dir="ltr">{d.expiryDate ?? "—"}</span>{tone && <span className="ms-2"><StatusPill tone={tone}>{tone === "danger" ? t("hr.docs.expired") : t("hr.docs.expiring")}</StatusPill></span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      <section className="card p-5">
        <h2 className="section-title mb-3">{t("hr.docs.files_title")}</h2>
        <AttachmentsPanel entityType="employee" entityId={employeeId} canManage={canManage} />
        {canManage && unregistered.length > 0 && (
          <form
            className="mt-4 grid gap-3 border-t border-united-border pt-4 sm:grid-cols-5 sm:items-end"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await apiPost(`/api/hr/employees/${employeeId}/documents`, { attachment_id: f.attachment_id, doc_type: f.doc_type, document_number: f.document_number.trim() || null, issue_date: f.issue_date || null, expiry_date: f.expiry_date || null });
                toast.show(t("hr.docs.registered"), "success");
                setF({ ...f, attachment_id: "", document_number: "", issue_date: "", expiry_date: "" });
                void qc.invalidateQueries({ queryKey: ["hr", "private", employeeId] });
              } catch (err) { toast.show(fail(t, err), "error"); }
            }}
          >
            <Field label={t("hr.docs.file")} required>
              <select className="field" required value={f.attachment_id} onChange={(e) => setF({ ...f, attachment_id: e.target.value })}>
                <option value="">{t("hr.placeholder.choose")}</option>
                {unregistered.map((a) => <option key={a.id} value={a.id}>{a.fileName}</option>)}
              </select>
            </Field>
            <Field label={t("hr.docs.type")} required>
              <select className="field" value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value })}>
                {DOC_TYPES.map((d) => <option key={d} value={d}>{t(`attach.category.${d}`)}</option>)}
              </select>
            </Field>
            <Field label={t("hr.docs.number")}><input className="field" dir="ltr" value={f.document_number} onChange={(e) => setF({ ...f, document_number: e.target.value })} /></Field>
            <Field label={t("hr.docs.expiry")}><input type="date" className="field" value={f.expiry_date} onChange={(e) => setF({ ...f, expiry_date: e.target.value })} /></Field>
            <button type="submit" className="btn-primary" disabled={!f.attachment_id}>{t("hr.docs.register")}</button>
          </form>
        )}
      </section>
    </div>
  );
}

function StatementTab({ employeeId }: { employeeId: string }) {
  const { t, locale } = useLocale();
  const q = useQuery({
    queryKey: ["hr", "statement", employeeId],
    queryFn: () => apiFetch<{ statement: { rows: { date: string; number: string; description: string; account: string; debit: string; credit: string }[]; advancesHeld: string; owedToEmployee: string } }>(`/api/hr/employees/${employeeId}/statement`).then((r) => r.statement),
  });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3">
        <div className="card px-4 py-3"><dt className="text-xs font-medium text-united-muted">{t("hr.statement.advances_held")}</dt><dd className="mt-1 text-lg font-bold text-united-dark"><span dir="ltr">{fmtMoney(q.data.advancesHeld)}</span></dd></div>
        <div className="card px-4 py-3"><dt className="text-xs font-medium text-united-muted">{t("hr.statement.owed")}</dt><dd className="mt-1 text-lg font-bold text-united-dark"><span dir="ltr">{fmtMoney(q.data.owedToEmployee)}</span></dd></div>
      </dl>
      <section className="card overflow-x-auto">
        {q.data.rows.length === 0 ? <EmptyState icon="📄" title={t("hr.statement.empty")} /> : (
          <table className="data-table">
            <thead><tr><th>{t("hr.label.date")}</th><th>{t("hr.col.number")}</th><th>{t("hr.label.description")}</th><th>{t("hr.statement.account")}</th><th className="num">{t("hr.statement.debit")}</th><th className="num">{t("hr.statement.credit")}</th></tr></thead>
            <tbody>
              {q.data.rows.map((r, i) => (
                <tr key={`${r.number}-${i}`}>
                  <td dir="ltr" className="whitespace-nowrap">{r.date}</td>
                  <td dir="ltr" className="whitespace-nowrap text-united-muted">{r.number}</td>
                  <td className="min-w-[12rem]">{systemText(r.description, locale)}</td>
                  <td>{r.account === "employee_advances" ? t("hr.statement.acc_advances") : t("hr.statement.acc_payable")}</td>
                  <td className="num" dir="ltr">{Number(r.debit) ? fmtMoney(r.debit) : ""}</td>
                  <td className="num" dir="ltr">{Number(r.credit) ? fmtMoney(r.credit) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
