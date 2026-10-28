"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CheckCheck, ChevronLeft, ChevronRight, History, Plus, RefreshCw, Trash2 } from "lucide-react";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { Modal, useDialogs } from "@/components/ui/Dialog";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { todayLocalISO } from "@/lib/localDate";
import { Field, Tabs } from "@/components/stock/inventory/shared";
import { useLocale } from "@/lib/locale";

/**
 * Attendance (docs/erp/DESIGN_SYSTEM.md §8.2): the daily register (tablet-first: one row per
 * employee, status + in/out), the month grid, corrections, and the calendar it is measured
 * against (schedules, public holidays, device sources). The server decides every rule —
 * confirmed and locked days are read-only here because the API refuses to change them.
 */

type SchedDay = { isWorkingDay: boolean; start: string | null; end: string | null; breakMinutes: number; nightStart: string | null; nightEnd: string | null } | null;
type Day = {
  id: string; status: string; state: string; source: string; version: number; notes: string | null; firstIn: string | null; lastOut: string | null;
  workedMinutes: number; lateMinutes: number; earlyLeaveMinutes: number; overtimeDayMinutes: number; overtimeNightMinutes: number;
  overtimeRestDayMinutes: number; overtimeHolidayMinutes: number; enteredBy: string;
};
type RegisterRow = {
  employee: { id: string; code: string; name: string; jobTitle: string | null; department: { name: string } | null };
  schedule: { code: string; nameAr: string; nameEn: string | null; day: SchedDay } | null;
  suggested: string | null; pendingCorrection: string | null; day: Day | null;
};
type Register = { date: string; holiday: { nameAr: string; nameEn: string | null; paid: boolean } | null; rows: RegisterRow[] };
type Tab = "register" | "month" | "corrections" | "settings";

const STATUSES = ["present", "absent", "absent_unpaid", "holiday", "rest_day", "suspended"] as const;
const STATUS_TONE: Record<string, Tone> = { present: "success", absent: "danger", absent_unpaid: "danger", leave: "info", holiday: "info", rest_day: "neutral", suspended: "warn" };
const STATE_TONE: Record<string, Tone> = { draft: "warn", confirmed: "success", locked: "neutral" };

const fail = (t: (k: string) => string, err: unknown) => (err instanceof ApiClientError ? err.message : t("hr.error"));
const shiftDate = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const hours = (min: number) => (min ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}` : "—");

export function AttendanceView() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [tab, setTab] = useState<Tab>("register");
  const [date, setDate] = useState(todayLocalISO());
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("tab");
    if (p === "month" || p === "corrections" || p === "settings") setTab(p);
  }, []);
  const record = can("hr.attendance.record");
  return (
    <div className="page-container">
      <PageHeader back={{ href: "/hr", label: t("hr.profile.back") }} title={t("att.title")} description={t("att.description")} />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: "register", label: t("att.tab.register") },
          { key: "month", label: t("att.tab.month") },
          { key: "corrections", label: t("att.tab.corrections") },
          { key: "settings", label: t("att.tab.settings") },
        ]}
      />
      {tab === "register" && <RegisterTab date={date} setDate={setDate} canRecord={record} />}
      {tab === "month" && <MonthTab onOpenDay={(d) => { setDate(d); setTab("register"); }} />}
      {tab === "corrections" && <CorrectionsTab />}
      {tab === "settings" && <SettingsTab canManage={can("hr.employees.manage")} canRecord={record} />}
    </div>
  );
}

// ── Daily register ─────────────────────────────────────────────────────────

type Edit = { status: string; first_in: string; last_out: string; notes: string };

function RegisterTab({ date, setDate, canRecord }: { date: string; setDate: (d: string) => void; canRecord: boolean }) {
  const { t, isEN } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hr", "attendance", "day", date], queryFn: () => apiFetch<Register>(`/api/hr/attendance?date=${date}`) });
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [busy, setBusy] = useState(false);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [correct, setCorrect] = useState<RegisterRow | null>(null);
  useEffect(() => setEdits({}), [date]);

  const today = todayLocalISO();
  const rows = q.data?.rows ?? [];
  const editable = (r: RegisterRow) => canRecord && (!r.day || r.day.state === "draft");
  const valueOf = (r: RegisterRow): Edit =>
    edits[r.employee.id] ?? { status: r.day?.status ?? r.suggested ?? "", first_in: r.day?.firstIn?.replace("+1", "") ?? "", last_out: r.day?.lastOut?.replace("+1", "") ?? "", notes: r.day?.notes ?? "" };
  const setRow = (r: RegisterRow, patch: Partial<Edit>) => setEdits((e) => ({ ...e, [r.employee.id]: { ...valueOf(r), ...patch } }));
  const dirty = Object.keys(edits).length;
  const drafts = rows.filter((r) => r.day?.state === "draft").length;
  const missing = rows.filter((r) => !r.day && !edits[r.employee.id]?.status).length;

  const save = async () => {
    const payload = rows
      .filter((r) => edits[r.employee.id] && editable(r) && edits[r.employee.id].status)
      .map((r) => {
        const e = edits[r.employee.id];
        const times = e.status === "present" && e.first_in && e.last_out;
        return { employee_id: r.employee.id, status: e.status, first_in: times ? e.first_in : null, last_out: times ? e.last_out : null, notes: e.notes.trim() || null, ...(r.day ? { expected_version: r.day.version } : {}) };
      });
    if (!payload.length) return;
    setBusy(true);
    try {
      const res = await apiPost<{ created: number; updated: number }>("/api/hr/attendance/days", { date, rows: payload });
      toast.show(t("att.saved", { n: res.created + res.updated }), "success");
      setEdits({});
      void qc.invalidateQueries({ queryKey: ["hr", "attendance"] });
    } catch (err) {
      toast.show(fail(t, err), "error");
    } finally {
      setBusy(false);
    }
  };
  const confirmDay = async () => {
    setBusy(true);
    try {
      const res = await apiPost<{ confirmed: number }>("/api/hr/attendance/confirm", { date });
      toast.show(t("att.confirmed", { n: res.confirmed }), "success");
      void qc.invalidateQueries({ queryKey: ["hr", "attendance"] });
    } catch (err) {
      toast.show(fail(t, err), "error");
    } finally {
      setBusy(false);
    }
  };
  const markPresent = () => {
    const next = { ...edits };
    for (const r of rows) {
      if (!editable(r) || r.day || next[r.employee.id]?.status) continue;
      if (r.suggested) next[r.employee.id] = { ...valueOf(r), status: r.suggested };
      else if (r.schedule?.day?.isWorkingDay) next[r.employee.id] = { ...valueOf(r), status: "present" };
    }
    setEdits(next);
  };

  return (
    <section className="card overflow-hidden">
      <div className="card-header flex-wrap gap-3">
        <div className="flex items-center gap-1.5">
          <button type="button" className="btn-secondary w-11 px-0" aria-label={t("att.prev_day")} onClick={() => setDate(shiftDate(date, -1))}>
            {isEN ? <ChevronLeft size={18} aria-hidden /> : <ChevronRight size={18} aria-hidden />}
          </button>
          <input type="date" className="field w-auto" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label={t("att.date")} />
          <button type="button" className="btn-secondary w-11 px-0" aria-label={t("att.next_day")} disabled={date >= today} onClick={() => setDate(shiftDate(date, 1))}>
            {isEN ? <ChevronRight size={18} aria-hidden /> : <ChevronLeft size={18} aria-hidden />}
          </button>
          {date !== today && <button type="button" className="btn-ghost btn-sm" onClick={() => setDate(today)}>{t("att.today")}</button>}
        </div>
        {canRecord && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={markPresent} disabled={busy || !missing}>{t("att.fill_suggested")}</button>
            <button type="button" className="btn-primary btn-sm" onClick={save} disabled={busy || !dirty}>{busy ? t("ui.saving") : t("att.save_drafts", { n: dirty })}</button>
            <button type="button" className="btn-secondary btn-sm gap-1.5" onClick={confirmDay} disabled={busy || !!dirty || !drafts}>
              <CheckCheck size={16} aria-hidden />{t("att.confirm_day", { n: drafts })}
            </button>
          </div>
        )}
      </div>
      {q.data?.holiday && (
        <div className="border-b border-united-border bg-united-info/10 px-5 py-2 text-sm font-medium text-united-dark">
          <CalendarDays size={16} className="me-1.5 inline" aria-hidden />
          {t("att.holiday_banner", { name: isEN ? q.data.holiday.nameEn || q.data.holiday.nameAr : q.data.holiday.nameAr })}
        </div>
      )}
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !rows.length ? <EmptyState title={t("att.empty")} /> : (
        <div className="overflow-x-auto">
          <table className="data-table min-w-[860px]">
            <thead>
              <tr>
                <th>{t("att.col.employee")}</th>
                <th>{t("att.col.schedule")}</th>
                <th>{t("att.col.status")}</th>
                <th>{t("att.col.in")}</th>
                <th>{t("att.col.out")}</th>
                <th className="num">{t("att.col.worked")}</th>
                <th className="num">{t("att.col.late")}</th>
                <th className="num">{t("att.col.overtime")}</th>
                <th>{t("att.col.state")}</th>
                <th aria-label={t("att.col.actions")} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const v = valueOf(r);
                const can = editable(r);
                const sd = r.schedule?.day;
                const ot = r.day ? r.day.overtimeDayMinutes + r.day.overtimeNightMinutes + r.day.overtimeRestDayMinutes + r.day.overtimeHolidayMinutes : 0;
                return (
                  <tr key={r.employee.id} className={edits[r.employee.id] ? "bg-united-warn/5" : undefined}>
                    <td>
                      <div className="font-semibold text-united-dark">{r.employee.name}</div>
                      <div className="text-xs text-united-muted"><span dir="ltr">{r.employee.code}</span>{r.employee.department ? ` · ${r.employee.department.name}` : ""}</div>
                    </td>
                    <td className="whitespace-nowrap text-sm text-united-muted">
                      {!r.schedule ? t("att.no_schedule") : sd?.isWorkingDay ? <span dir="ltr">{sd.start}–{sd.end}</span> : t("att.status.rest_day")}
                    </td>
                    <td>
                      {can ? (
                        <select className="field min-h-[44px] min-w-[150px]" value={v.status} onChange={(e) => setRow(r, { status: e.target.value })} aria-label={t("att.col.status")}>
                          <option value="">{t("att.choose")}</option>
                          {STATUSES.map((s) => <option key={s} value={s}>{t(`att.status.${s}`)}</option>)}
                        </select>
                      ) : r.day ? <StatusPill tone={STATUS_TONE[r.day.status] ?? "neutral"}>{t(`att.status.${r.day.status}`)}</StatusPill> : <span className="text-united-muted">—</span>}
                    </td>
                    <td>
                      {can ? <input type="time" className="field min-h-[44px] w-[120px]" value={v.first_in} disabled={v.status !== "present"} onChange={(e) => setRow(r, { first_in: e.target.value })} aria-label={t("att.col.in")} />
                        : <span dir="ltr">{r.day?.firstIn ?? "—"}</span>}
                    </td>
                    <td>
                      {can ? <input type="time" className="field min-h-[44px] w-[120px]" value={v.last_out} disabled={v.status !== "present"} onChange={(e) => setRow(r, { last_out: e.target.value })} aria-label={t("att.col.out")} />
                        : <span dir="ltr">{r.day?.lastOut ?? "—"}</span>}
                    </td>
                    <td className="num" dir="ltr">{r.day ? hours(r.day.workedMinutes) : "—"}</td>
                    <td className="num" dir="ltr">{r.day ? hours(r.day.lateMinutes) : "—"}</td>
                    <td className="num" dir="ltr">{r.day ? hours(ot) : "—"}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {r.day ? <StatusPill tone={STATE_TONE[r.day.state] ?? "neutral"}>{t(`att.state.${r.day.state}`)}</StatusPill> : <StatusPill tone="neutral">{t("att.state.missing")}</StatusPill>}
                        {r.day && r.day.source !== "manual" && <StatusPill tone="info">{t(`att.source.${r.day.source}`)}</StatusPill>}
                        {r.pendingCorrection && <StatusPill tone="warn">{r.pendingCorrection}</StatusPill>}
                      </div>
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        {r.day && (
                          <button type="button" className="btn-ghost w-11 px-0" aria-label={t("att.history")} title={t("att.history")} onClick={() => setHistoryOf(r.day!.id)}>
                            <History size={16} aria-hidden />
                          </button>
                        )}
                        {canRecord && r.day && r.day.state !== "draft" && !r.pendingCorrection && (
                          <button type="button" className="btn-secondary btn-sm whitespace-nowrap" onClick={() => setCorrect(r)}>{t("att.request_correction")}</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {historyOf && <DayHistory id={historyOf} onClose={() => setHistoryOf(null)} />}
      {correct && <CorrectionDialog row={correct} date={date} onClose={() => setCorrect(null)} />}
    </section>
  );
}

type Revision = { id: string; revision: number; action: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; changedBy: string; changedAt: string; correction: { number: string } | null };

function DayHistory({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useLocale();
  const { can } = usePermissions();
  const dialogs = useDialogs();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hr", "attendance", "detail", id], queryFn: () => apiFetch<{ day: Day & { date: string; employee: { name: string; code: string } }; revisions: Revision[] }>(`/api/hr/attendance/days/${id}`) });
  const reopen = async () => {
    const reason = await dialogs.prompt({ title: t("att.reopen"), label: t("att.reason"), required: true });
    if (!reason) return;
    try {
      await apiPost(`/api/hr/attendance/days/${id}/reopen`, { reason });
      toast.show(t("att.reopened"), "success");
      void qc.invalidateQueries({ queryKey: ["hr", "attendance"] });
      onClose();
    } catch (err) {
      toast.show(fail(t, err), "error");
    }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={q.data ? `${q.data.day.employee.name} · ${q.data.day.date}` : t("att.history")}
      footer={<>
        {q.data?.day.state === "confirmed" && can("hr.attendance.approve") && <button type="button" className="btn-secondary" onClick={reopen}>{t("att.reopen")}</button>}
        <button type="button" className="btn-primary" onClick={onClose}>{t("ui.close")}</button>
      </>}>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} /> : (
        <ol className="divide-y divide-united-border">
          {q.data!.revisions.map((r) => (
            <li key={r.id} className="py-2.5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-united-dark">v{r.revision} · {t(`att.action.${r.action}`)}{r.correction ? ` · ${r.correction.number}` : ""}</span>
                <span className="text-xs text-united-muted" dir="ltr">{new Date(r.changedAt).toLocaleString("en-GB")}</span>
              </div>
              <div className="text-united-muted">
                {r.before && r.before.status !== r.after.status ? `${t(`att.status.${r.before.status}`)} → ` : ""}{t(`att.status.${String(r.after.status)}`)} · {t(`att.state.${String(r.after.state)}`)} · {r.changedBy}
              </div>
              {r.reason && <div className="text-xs text-united-muted">{t("att.reason")}: {r.reason}</div>}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

function CorrectionDialog({ row, date, onClose }: { row: RegisterRow; date: string; onClose: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const d = row.day!;
  const [f, setF] = useState({ status: d.status === "leave" ? "present" : d.status, first_in: d.firstIn?.replace("+1", "") ?? "", last_out: d.lastOut?.replace("+1", "") ?? "", notes: d.notes ?? "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const times = f.status === "present" && f.first_in && f.last_out;
      await apiPost("/api/hr/attendance/corrections", { employee_id: row.employee.id, date, status: f.status, first_in: times ? f.first_in : null, last_out: times ? f.last_out : null, notes: f.notes.trim() || null, reason: f.reason.trim() });
      toast.show(t("att.correction_sent"), "success");
      void qc.invalidateQueries({ queryKey: ["hr", "attendance"] });
      onClose();
    } catch (err) {
      setError(fail(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`${t("att.request_correction")} · ${row.employee.name}`} description={d.state === "locked" ? t("att.correction_locked_hint") : t("att.correction_hint")}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button>
        <button type="submit" form="correction-form" className="btn-primary" disabled={busy || !f.reason.trim()}>{busy ? t("ui.saving") : t("att.send_for_approval")}</button>
      </>}>
      <form id="correction-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (!busy && f.reason.trim()) void save(); }}>
        <Field label={t("att.col.status")} required>
          <select className="field" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`att.status.${s}`)}</option>)}
          </select>
        </Field>
        <div />
        <Field label={t("att.col.in")}><input type="time" className="field" value={f.first_in} disabled={f.status !== "present"} onChange={(e) => setF({ ...f, first_in: e.target.value })} /></Field>
        <Field label={t("att.col.out")}><input type="time" className="field" value={f.last_out} disabled={f.status !== "present"} onChange={(e) => setF({ ...f, last_out: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label={t("att.notes")}><input className="field" maxLength={300} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field></div>
        <div className="sm:col-span-2"><Field label={t("att.reason")} required><textarea className="field min-h-[80px]" maxLength={500} required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>
        {error && <p role="alert" className="sm:col-span-2 text-sm font-medium text-united-danger">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Month grid ─────────────────────────────────────────────────────────────

type MonthData = {
  month: string; dates: string[]; holidays: string[];
  rows: { employee: { id: string; code: string; name: string }; cells: { date: string; employed: boolean; status?: string | null; state?: string | null; suggested?: string | null }[]; totals: { present: number; absent: number; absentUnpaid: number; leave: number; lateMinutes: number; overtimeMinutes: number; missing: number; draft: number } }[];
};

const CELL_CLASS: Record<string, string> = {
  present: "bg-united-green/15 text-united-green", absent: "bg-united-danger/15 text-united-danger", absent_unpaid: "bg-united-danger/25 text-united-danger",
  leave: "bg-united-info/15 text-united-info", holiday: "bg-united-info/10 text-united-info", rest_day: "bg-united-subtle text-united-muted", suspended: "bg-united-warn/15 text-united-warn",
};

function MonthTab({ onOpenDay }: { onOpenDay: (d: string) => void }) {
  const { t } = useLocale();
  const [month, setMonth] = useState(todayLocalISO().slice(0, 7));
  const q = useQuery({ queryKey: ["hr", "attendance", "month", month], queryFn: () => apiFetch<MonthData>(`/api/hr/attendance/month?month=${month}`) });
  return (
    <section className="card overflow-hidden">
      <div className="card-header flex-wrap gap-3">
        <input type="month" className="field w-auto" value={month} max={todayLocalISO().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label={t("att.month")} />
        <div className="flex flex-wrap gap-1.5 text-xs">
          {["present", "absent", "absent_unpaid", "leave", "holiday", "rest_day", "suspended"].map((s) => (
            <span key={s} className={`rounded px-1.5 py-0.5 font-semibold ${CELL_CLASS[s]}`}>{t(`att.code.${s}`)} = {t(`att.status.${s}`)}</span>
          ))}
        </div>
      </div>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !q.data!.rows.length ? <EmptyState title={t("att.empty")} /> : (
        <div className="overflow-x-auto">
          <table className="text-xs">
            <thead>
              <tr className="text-united-muted">
                <th className="sticky start-0 z-10 bg-white p-2 text-start font-semibold">{t("att.col.employee")}</th>
                {q.data!.dates.map((d) => (
                  <th key={d} className={`min-w-[30px] p-1 text-center font-semibold ${q.data!.holidays.includes(d) ? "text-united-info" : ""}`} dir="ltr">{Number(d.slice(8))}</th>
                ))}
                <th className="p-2 font-semibold">{t("att.total.present")}</th>
                <th className="p-2 font-semibold">{t("att.total.absent")}</th>
                <th className="p-2 font-semibold">{t("att.col.late")}</th>
                <th className="p-2 font-semibold">{t("att.col.overtime")}</th>
                <th className="p-2 font-semibold">{t("att.total.missing")}</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.rows.map((r) => (
                <tr key={r.employee.id} className="border-t border-united-border">
                  <td className="sticky start-0 z-10 whitespace-nowrap bg-white p-2 font-semibold text-united-dark">{r.employee.name}</td>
                  {r.cells.map((c) => (
                    <td key={c.date} className="p-0.5 text-center">
                      {!c.employed ? <span className="text-united-border">·</span> : (
                        <button type="button" onClick={() => onOpenDay(c.date)} title={`${c.date}${c.status ? ` · ${t(`att.status.${c.status}`)} · ${t(`att.state.${c.state}`)}` : ""}`}
                          className={`h-7 w-7 rounded font-bold ${c.status ? CELL_CLASS[c.status] ?? "" : "border border-dashed border-united-border text-united-muted"} ${c.state === "draft" ? "ring-1 ring-united-warn" : ""}`}>
                          {c.status ? t(`att.code.${c.status}`) : c.suggested ? <span className="opacity-50">{t(`att.code.${c.suggested}`)}</span> : ""}
                        </button>
                      )}
                    </td>
                  ))}
                  <td className="p-2 text-center font-semibold" dir="ltr">{r.totals.present}</td>
                  <td className="p-2 text-center font-semibold" dir="ltr">{r.totals.absent + r.totals.absentUnpaid}</td>
                  <td className="p-2 text-center" dir="ltr">{hours(r.totals.lateMinutes)}</td>
                  <td className="p-2 text-center" dir="ltr">{hours(r.totals.overtimeMinutes)}</td>
                  <td className={`p-2 text-center font-semibold ${r.totals.missing ? "text-united-warn" : ""}`} dir="ltr">{r.totals.missing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Corrections ────────────────────────────────────────────────────────────

type Correction = {
  id: string; number: string; date: string; status: string; reason: string; requestedBy: string; decidedBy: string | null; decisionComment: string | null; retroStatus: string;
  requested: { status: string; first_in: string | null; last_out: string | null; notes: string | null }; approvalRequestId: string | null; createdAt: string;
  employee: { id: string; code: string; name: string }; canDecide: boolean; canCancel: boolean;
};
const CORR_TONE: Record<string, Tone> = { pending: "warn", approved: "success", rejected: "danger", cancelled: "neutral" };

function CorrectionsTab() {
  const { t } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const q = useQuery({ queryKey: ["hr", "attendance", "corrections", filter], queryFn: () => apiFetch<{ corrections: Correction[] }>(`/api/hr/attendance/corrections${filter === "pending" ? "?status=pending" : ""}`).then((r) => r.corrections) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["hr", "attendance"] });
  const decide = async (c: Correction, decision: "approve" | "reject") => {
    let comment: string | null | undefined;
    if (decision === "reject") {
      comment = await dialogs.prompt({ title: t("att.reject"), label: t("att.reason"), required: true });
      if (!comment) return;
    } else if (!(await dialogs.confirm({ title: t("att.approve"), body: t("att.approve_confirm", { number: c.number }) }))) return;
    try {
      await apiPost(`/api/approvals/${c.approvalRequestId}/decide`, { decision, comment: comment ?? undefined });
      toast.show(decision === "approve" ? t("att.correction_applied") : t("att.correction_rejected"), "success");
      refresh();
    } catch (err) {
      toast.show(fail(t, err), "error");
    }
  };
  const cancel = async (c: Correction) => {
    if (!(await dialogs.confirm({ title: t("att.withdraw"), body: t("att.withdraw_confirm", { number: c.number }) }))) return;
    try {
      await apiPost(`/api/hr/attendance/corrections/${c.id}/cancel`, {});
      refresh();
    } catch (err) {
      toast.show(fail(t, err), "error");
    }
  };
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <Segmented value={filter} onChange={setFilter} items={[{ key: "pending", label: t("att.filter.pending") }, { key: "all", label: t("att.filter.all") }]} />
      </div>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !q.data!.length ? <EmptyState title={t("att.corrections_empty")} /> : (
        <ul className="divide-y divide-united-border">
          {q.data!.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-united-dark" dir="ltr">{c.number}</span>
                  <StatusPill tone={CORR_TONE[c.status] ?? "neutral"}>{t(`att.corr.${c.status}`)}</StatusPill>
                  {c.retroStatus === "pending" && <StatusPill tone="info">{t("att.retro_pending")}</StatusPill>}
                </div>
                <div className="mt-0.5 text-sm text-united-dark">
                  {c.employee.name} · <span dir="ltr">{c.date}</span> → {t(`att.status.${c.requested.status}`)}{c.requested.first_in ? <span dir="ltr"> ({c.requested.first_in}–{c.requested.last_out})</span> : ""}
                </div>
                <div className="mt-0.5 text-xs text-united-muted">{c.reason} · {c.requestedBy}{c.decidedBy ? ` · ${t("att.decided_by")} ${c.decidedBy}` : ""}{c.decisionComment ? `: ${c.decisionComment}` : ""}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {c.canDecide && c.approvalRequestId && (
                  <>
                    <button type="button" className="btn-primary btn-sm" onClick={() => decide(c, "approve")}>{t("att.approve")}</button>
                    <button type="button" className="btn-danger btn-sm" onClick={() => decide(c, "reject")}>{t("att.reject")}</button>
                  </>
                )}
                {c.canCancel && <button type="button" className="btn-secondary btn-sm" onClick={() => cancel(c)}>{t("att.withdraw")}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Settings: schedules, holidays, devices ─────────────────────────────────

type Schedule = { id: string; code: string; nameAr: string; nameEn: string | null; weeklyHours: string; isDefault: boolean; active: boolean; version: number; assigned: number; days: { weekday: number; isWorkingDay: boolean; start: string | null; end: string | null; breakMinutes: number; nightStart: string | null; nightEnd: string | null }[] };
type Holiday = { id: string; date: string; nameAr: string; nameEn: string | null; paid: boolean; reference: string | null; createdBy: string };

function SettingsTab({ canManage, canRecord }: { canManage: boolean; canRecord: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <SchedulesCard canManage={canManage} />
      <HolidaysCard canManage={canManage} />
      <DevicesCard canManage={canManage} canRecord={canRecord} />
    </div>
  );
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

function SchedulesCard({ canManage }: { canManage: boolean }) {
  const { t, isEN } = useLocale();
  const q = useQuery({ queryKey: ["hr", "schedules"], queryFn: () => apiFetch<{ schedules: Schedule[] }>("/api/hr/schedules").then((r) => r.schedules) });
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <div>
          <h2 className="section-title">{t("att.schedules")}</h2>
          <p className="text-sm text-united-muted">{t("att.schedules_hint")}</p>
        </div>
        {canManage && <button type="button" className="btn-primary btn-sm gap-1.5" onClick={() => setEditing("new")}><Plus size={16} aria-hidden />{t("att.schedule_add")}</button>}
      </div>
      {q.isLoading ? <LoadingState /> : !q.data?.length ? <EmptyState title={t("att.schedules_empty")} /> : (
        <ul className="divide-y divide-united-border">
          {q.data.map((s) => (
            <li key={s.id} className={`flex flex-wrap items-center justify-between gap-3 px-5 py-3 ${s.active ? "" : "opacity-60"}`}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-united-dark">{isEN ? s.nameEn || s.nameAr : s.nameAr}</span>
                  <span className="text-xs text-united-muted" dir="ltr">{s.code} · {Number(s.weeklyHours)}h</span>
                  {s.isDefault && <StatusPill tone="info">{t("att.default")}</StatusPill>}
                  {!s.active && <StatusPill tone="neutral">{t("att.inactive")}</StatusPill>}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1 text-xs text-united-muted">
                  {s.days.map((d) => <span key={d.weekday} className="rounded bg-united-subtle px-1.5 py-0.5">{t(`att.weekday.${d.weekday}`)} {d.isWorkingDay ? <span dir="ltr">{d.start}–{d.end}</span> : "—"}</span>)}
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm text-united-muted">
                {t("att.assigned", { n: s.assigned })}
                {canManage && <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(s)}>{t("ui.edit")}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && <ScheduleDialog schedule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ScheduleDialog({ schedule, onClose }: { schedule: Schedule | null; onClose: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ code: schedule?.code ?? "", name_ar: schedule?.nameAr ?? "", name_en: schedule?.nameEn ?? "", is_default: schedule?.isDefault ?? false, active: schedule?.active ?? true });
  const [days, setDays] = useState(() =>
    WEEKDAYS.map((w) => {
      const d = schedule?.days.find((x) => x.weekday === w);
      return { weekday: w, is_working_day: d?.isWorkingDay ?? false, start: d?.start ?? "", end: d?.end ?? "", break_minutes: d?.breakMinutes ?? 0, night_start: d?.nightStart ?? "", night_end: d?.nightEnd ?? "" };
    })
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setDay = (w: number, patch: Partial<(typeof days)[number]>) => setDays((ds) => ds.map((d) => (d.weekday === w ? { ...d, ...patch } : d)));
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      ...f, name_en: f.name_en.trim() || null,
      days: days.map((d) => ({ weekday: d.weekday, is_working_day: d.is_working_day, start: d.is_working_day ? d.start || null : null, end: d.is_working_day ? d.end || null : null, break_minutes: d.is_working_day ? Number(d.break_minutes) || 0 : 0, night_start: d.night_start || null, night_end: d.night_end || null })),
      ...(schedule ? { expected_version: schedule.version } : {}),
    };
    try {
      if (schedule) await apiPatch(`/api/hr/schedules/${schedule.id}`, body);
      else await apiPost("/api/hr/schedules", body);
      toast.show(t("att.schedule_saved"), "success");
      void qc.invalidateQueries({ queryKey: ["hr"] });
      onClose();
    } catch (err) {
      setError(fail(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={schedule ? t("att.schedule_edit") : t("att.schedule_add")} description={t("att.schedule_dialog_hint")}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>{t("ui.cancel")}</button>
        <button type="submit" form="schedule-form" className="btn-primary" disabled={busy || !f.code.trim() || !f.name_ar.trim()}>{busy ? t("ui.saving") : t("ui.save")}</button>
      </>}>
      <form id="schedule-form" className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (!busy) void save(); }}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("att.code")} required><input className="field" dir="ltr" maxLength={30} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <Field label={t("att.name_ar")} required><input className="field" maxLength={100} value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} /></Field>
          <Field label={t("att.name_en")}><input className="field" dir="ltr" maxLength={100} value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} /></Field>
        </div>
        <div className="flex flex-wrap gap-5 text-sm font-medium">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.is_default} onChange={(e) => setF({ ...f, is_default: e.target.checked })} />{t("att.default_hint")}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{t("att.active")}</label>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table min-w-[640px]">
            <thead><tr><th>{t("att.weekday")}</th><th>{t("att.working")}</th><th>{t("att.start")}</th><th>{t("att.end")}</th><th>{t("att.break")}</th><th>{t("att.night")}</th></tr></thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.weekday}>
                  <td className="font-semibold">{t(`att.weekday.${d.weekday}`)}</td>
                  <td><input type="checkbox" checked={d.is_working_day} onChange={(e) => setDay(d.weekday, { is_working_day: e.target.checked })} aria-label={t("att.working")} /></td>
                  <td><input type="time" className="field w-[110px]" disabled={!d.is_working_day} value={d.start} onChange={(e) => setDay(d.weekday, { start: e.target.value })} aria-label={t("att.start")} /></td>
                  <td><input type="time" className="field w-[110px]" disabled={!d.is_working_day} value={d.end} onChange={(e) => setDay(d.weekday, { end: e.target.value })} aria-label={t("att.end")} /></td>
                  <td><input type="number" min={0} max={600} className="field w-[80px]" disabled={!d.is_working_day} value={d.break_minutes} onChange={(e) => setDay(d.weekday, { break_minutes: Number(e.target.value) })} aria-label={t("att.break")} /></td>
                  <td className="whitespace-nowrap">
                    <input type="time" className="field inline-block w-[105px]" value={d.night_start} onChange={(e) => setDay(d.weekday, { night_start: e.target.value })} aria-label={t("att.night_start")} />
                    <span className="mx-1 text-united-muted">–</span>
                    <input type="time" className="field inline-block w-[105px]" value={d.night_end} onChange={(e) => setDay(d.weekday, { night_end: e.target.value })} aria-label={t("att.night_end")} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-united-muted">{t("att.night_hint")}</p>
        {error && <p role="alert" className="text-sm font-medium text-united-danger">{error}</p>}
      </form>
    </Modal>
  );
}

function HolidaysCard({ canManage }: { canManage: boolean }) {
  const { t, isEN } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const [year, setYear] = useState(todayLocalISO().slice(0, 4));
  const q = useQuery({ queryKey: ["hr", "holidays", year], queryFn: () => apiFetch<{ holidays: Holiday[] }>(`/api/hr/holidays?year=${year}`).then((r) => r.holidays) });
  const [f, setF] = useState({ date: "", name_ar: "", name_en: "", paid: true, reference: "" });
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await apiPost("/api/hr/holidays", { ...f, name_en: f.name_en.trim() || null, reference: f.reference.trim() || null });
      setF({ date: "", name_ar: "", name_en: "", paid: true, reference: "" });
      void qc.invalidateQueries({ queryKey: ["hr"] });
    } catch (err) {
      toast.show(fail(t, err), "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (h: Holiday) => {
    if (!(await dialogs.confirm({ title: t("att.holiday_remove"), body: `${h.date} · ${h.nameAr}`, tone: "danger" }))) return;
    try {
      await fetchDelete(`/api/hr/holidays/${h.id}`);
      void qc.invalidateQueries({ queryKey: ["hr"] });
    } catch (err) {
      toast.show(fail(t, err), "error");
    }
  };
  const years = useMemo(() => { const y = Number(todayLocalISO().slice(0, 4)); return [y - 1, y, y + 1].map(String); }, []);
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <div>
          <h2 className="section-title">{t("att.holidays")}</h2>
          <p className="text-sm text-united-muted">{t("att.holidays_hint")}</p>
        </div>
        <Segmented value={year} onChange={setYear} items={years.map((y) => ({ key: y, label: y }))} />
      </div>
      {canManage && (
        <form className="grid gap-3 border-b border-united-border p-4 sm:grid-cols-6" onSubmit={(e) => { e.preventDefault(); if (f.date && f.name_ar.trim() && !busy) void add(); }}>
          <input type="date" className="field" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} aria-label={t("att.date")} />
          <input className="field" required maxLength={100} placeholder={t("att.name_ar")} value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} />
          <input className="field" dir="ltr" maxLength={100} placeholder={t("att.name_en")} value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} />
          <input className="field" maxLength={200} placeholder={t("att.reference")} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={f.paid} onChange={(e) => setF({ ...f, paid: e.target.checked })} />{t("att.paid")}</label>
          <button type="submit" className="btn-primary" disabled={busy || !f.date || !f.name_ar.trim()}>{t("att.holiday_add")}</button>
        </form>
      )}
      {q.isLoading ? <LoadingState /> : !q.data?.length ? <EmptyState title={t("att.holidays_empty")} /> : (
        <ul className="divide-y divide-united-border">
          {q.data.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5 text-sm">
              <span><span className="font-semibold" dir="ltr">{h.date}</span> · {isEN ? h.nameEn || h.nameAr : h.nameAr}{h.paid ? "" : ` · ${t("att.unpaid")}`}{h.reference ? <span className="text-united-muted"> · {h.reference}</span> : ""}</span>
              {canManage && <button type="button" className="btn-ghost w-11 px-0" aria-label={t("att.holiday_remove")} onClick={() => remove(h)}><Trash2 size={16} aria-hidden /></button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

async function fetchDelete(path: string) {
  const res = await fetch(path, { method: "DELETE", headers: { "accept-language": document.documentElement.lang === "en" ? "en" : "ar" } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiClientError((body as { error?: string }).error ?? res.statusText);
  }
}

type Source = {
  id: string; code: string; name: string; kind: string; active: boolean; integration: { code: string; keyPrefix: string; active: boolean } | null;
  identities: { id: string; externalUserId: string; employee: { id: string; code: string; name: string } }[];
  batches: { id: string; receivedAt: string; eventCount: number; accepted: number; duplicates: number; unmatched: number }[];
};

function DevicesCard({ canManage, canRecord }: { canManage: boolean; canRecord: boolean }) {
  const { t } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hr", "attendance", "sources"], queryFn: () => apiFetch<{ sources: Source[]; keys: { id: string; code: string; name: string }[] }>("/api/hr/attendance/sources") });
  const emps = useQuery({ queryKey: ["hr", "employees"], queryFn: () => apiFetch<{ employees: { id: string; code: string; name: string; active: boolean }[] }>("/api/hr/employees"), enabled: canManage });
  const [src, setSrc] = useState({ code: "", name: "", integration_id: "" });
  const [map, setMap] = useState<Record<string, { external_user_id: string; employee_id: string }>>({});
  const [range, setRange] = useState({ from: todayLocalISO(), to: todayLocalISO() });
  const [busy, setBusy] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["hr", "attendance"] });
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); refresh(); } catch (err) { toast.show(fail(t, err), "error"); } finally { setBusy(false); }
  };
  const devices = (q.data?.sources ?? []).filter((s) => s.kind !== "manual");
  const ingestKeys = q.data?.keys ?? [];
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <div>
          <h2 className="section-title">{t("att.devices")}</h2>
          <p className="text-sm text-united-muted">{t("att.devices_hint")}</p>
        </div>
      </div>
      {canRecord && (
        <form className="flex flex-wrap items-end gap-3 border-b border-united-border p-4" onSubmit={(e) => { e.preventDefault(); void run(async () => {
          const r = await apiPost<{ created: number; updated: number; kept: number; incomplete: number; unmapped: number }>("/api/hr/attendance/compile", range);
          toast.show(t("att.compiled", { created: r.created, updated: r.updated, kept: r.kept, incomplete: r.incomplete, unmapped: r.unmapped }), "success");
        }); }}>
          <Field label={t("att.from")}><input type="date" className="field" max={todayLocalISO()} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label={t("att.to")}><input type="date" className="field" max={todayLocalISO()} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          <button type="submit" className="btn-secondary gap-1.5" disabled={busy || !devices.length}><RefreshCw size={16} aria-hidden />{t("att.compile")}</button>
          <p className="basis-full text-xs text-united-muted">{t("att.compile_hint")}</p>
        </form>
      )}
      {canManage && (
        <form className="grid gap-3 border-b border-united-border p-4 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void run(async () => {
          await apiPost("/api/hr/attendance/sources", { ...src, kind: "device" });
          setSrc({ code: "", name: "", integration_id: "" });
        }); }}>
          <input className="field" dir="ltr" required placeholder={t("att.device_code")} value={src.code} onChange={(e) => setSrc({ ...src, code: e.target.value })} />
          <input className="field" required placeholder={t("att.device_name")} value={src.name} onChange={(e) => setSrc({ ...src, name: e.target.value })} />
          <select className="field" required value={src.integration_id} onChange={(e) => setSrc({ ...src, integration_id: e.target.value })} aria-label={t("att.device_key")}>
            <option value="">{ingestKeys.length ? t("att.device_key") : t("att.device_no_key")}</option>
            {ingestKeys.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
          </select>
          <button type="submit" className="btn-primary" disabled={busy || !src.code || !src.name || !src.integration_id}>{t("att.device_add")}</button>
        </form>
      )}
      {q.isLoading ? <LoadingState /> : !devices.length ? <EmptyState title={t("att.devices_empty")} /> : (
        <ul className="divide-y divide-united-border">
          {devices.map((s) => (
            <li key={s.id} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-united-dark">{s.name}</span>
                <span className="text-xs text-united-muted" dir="ltr">{s.code}{s.integration ? ` · ${s.integration.code} · ${s.integration.keyPrefix}…` : ""}</span>
                {s.integration && !s.integration.active && <StatusPill tone="danger">{t("att.key_revoked")}</StatusPill>}
              </div>
              {s.batches[0] && <div className="mt-0.5 text-xs text-united-muted">{t("att.last_batch", { at: new Date(s.batches[0].receivedAt).toLocaleString("en-GB"), accepted: s.batches[0].accepted, duplicates: s.batches[0].duplicates, unmatched: s.batches[0].unmatched })}</div>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {s.identities.map((i) => (
                  <span key={i.id} className="inline-flex items-center gap-1 rounded bg-united-subtle px-2 py-0.5 text-xs">
                    <span dir="ltr">#{i.externalUserId}</span> → {i.employee.name}
                    {canManage && <button type="button" className="text-united-muted hover:text-united-danger" aria-label={t("att.unmap")} onClick={() => run(() => fetchDelete(`/api/hr/attendance/identities/${i.id}`))}>×</button>}
                  </span>
                ))}
              </div>
              {canManage && (
                <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const m = map[s.id]; if (m?.external_user_id && m.employee_id) void run(async () => { await apiPost("/api/hr/attendance/identities", { source_id: s.id, ...m }); setMap({ ...map, [s.id]: { external_user_id: "", employee_id: "" } }); }); }}>
                  <input className="field w-[140px]" dir="ltr" placeholder={t("att.device_user")} value={map[s.id]?.external_user_id ?? ""} onChange={(e) => setMap({ ...map, [s.id]: { employee_id: map[s.id]?.employee_id ?? "", external_user_id: e.target.value } })} />
                  <select className="field w-auto" value={map[s.id]?.employee_id ?? ""} onChange={(e) => setMap({ ...map, [s.id]: { external_user_id: map[s.id]?.external_user_id ?? "", employee_id: e.target.value } })} aria-label={t("att.col.employee")}>
                    <option value="">{t("att.col.employee")}</option>
                    {emps.data?.employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
                  </select>
                  <button type="submit" className="btn-secondary btn-sm" disabled={busy}>{t("att.map")}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-united-border px-5 py-2 text-xs text-united-muted">
        {t("att.ingest_doc")} <code dir="ltr">POST /api/integrations/attendance/events</code> · <Link className="underline" href="/admin">{t("att.manage_keys")}</Link>
      </div>
    </section>
  );
}

