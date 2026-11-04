"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, errorMessage } from "@/lib/api-client";
import { newClientKey } from "@/lib/clientKey";
import { ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialog";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { todayLocalISO } from "@/lib/localDate";
import { Field, fmtMoney } from "@/components/stock/inventory/shared";

/**
 * The opening migration control center (phased opening balances, Nov 2026). Suppliers first,
 * customers later, then the rest; each phase batch is approved by a second person and posts
 * against the provisional clearing account 3900. Shows each segment by stage, the clearing
 * account traced to its batches, the exception register, pending approvals and the closure
 * checks; the migration closes only when every check passes and someone else approves.
 */

type Status = "not_started" | "in_progress" | "awaiting_approval" | "reconciliation_required" | "ready_for_closure" | "closed";
type Stage = { batches: number; lines: number; debit: string; credit: string; amount: string };
type Check = { key: string; ok: boolean; label: string; labelEn: string; value?: string; count?: number };
type Overview = {
  status: Status;
  blockedBy?: { number: string; status: string } | null;
  migration: null | { id: string; cutoverDate: string; state: string; notes: string | null; createdBy: string; closeRequestedBy: string | null; closedBy: string | null; closedAt: string | null; version: number };
  segments?: Record<"suppliers" | "customers" | "other", Record<"imported" | "pending" | "posted" | "cancelled", Stage>>;
  totals?: { debit: string; credit: string };
  clearing?: { balance: string; traced: string; untraced: string; byBatch: { id: string; number: string; segment: string; sourceFile: string | null; decidedBy: string | null; movement: string }[] };
  openingEquity?: string;
  batches?: { id: string; number: string; segment: string; status: string; sourceFile: string | null; lines: number }[];
  exceptions?: { open: number; resolved: number; excluded: number; openAmount: string; bySegment: Record<string, { open: number; openAmount: string; unmatched: number }> };
  pendingApprovals?: { batches: { id: string; number: string; segment: string }[]; closure: { number: string; requestedBy: string } | null };
  attestations?: Record<string, { by: string; at: string; note: string }>;
  checks?: Check[];
  readyForClosure?: boolean;
};
type ExceptionRow = { id: string; segment: string; sourceFile: string; sourceRow: string; sourceName: string; sourceAmount: string; reason: string; detail: string | null; status: string; resolution: string | null; resolvedBy: string | null; version: number };
type ImportRow = { source_row: string; source_name: string; party_code: string | null; amount: string; outcome: string; reason?: string; detail?: string; party?: { code: string; name: string; nameAr: string | null; category: string | null } };
type ImportResult = { mode: "preview" | "commit"; summary: { rows: number; total: string; matched: number; matchedAmount: string; exceptions: number; exceptionAmount: string; zero: number; alreadyInMigration: number; newExceptions: number }; rows: ImportRow[] };

const SEGMENTS = ["suppliers", "customers", "other"] as const;
type AttestationKey = "suppliers_complete" | "customers_complete" | "cash_bank_verified" | "other_accounts_reconciled";
const STATUS_TONE: Record<Status, Tone> = { not_started: "neutral", in_progress: "info", awaiting_approval: "warn", reconciliation_required: "danger", ready_for_closure: "success", closed: "success" };
/** A check's value: figures formatted ("1283160.00 / 1283160.00" → "1,283,160.00 / 1,283,160.00"), anything else as is. */
const checkValue = (v: string) => v.split(" / ").map((x) => (/^-?\d+(\.\d+)?$/.test(x.trim()) ? fmtMoney(x.trim()) : x)).join(" / ");
/** A signed balance (debit positive) as the amount and its side, in the screen's language. */
const signedWith = (t: (k: string) => string) => (v: string | undefined) => { const n = Number(v ?? 0); return n === 0 ? fmtMoney(0) : `${fmtMoney(Math.abs(n))} ${t(n > 0 ? "openmig.dr" : "openmig.cr")}`; };

export function OpeningMigrationView({ onOpenBatch }: { onOpenBatch: (id: string) => void }) {
  const { t, locale } = useLocale();
  const signed = signedWith(t);
  const { can } = usePermissions();
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const manage = can("accounting.manage");
  const q = useQuery({ queryKey: ["acc", "opening-migration"], queryFn: () => apiFetch<{ overview: Overview }>("/api/accounting/opening-migration").then((r) => r.overview) });
  const [cutover, setCutover] = useState("");
  const [notes, setNotes] = useState("");
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["acc"] }); };
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast.show(ok, "success"); refresh(); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const o = q.data;
  const label = (c: Check) => (locale === "en" ? c.labelEn : c.label);

  if (!o.migration) {
    return (
      <section className="card p-4 flex flex-col gap-3" aria-labelledby="openmig-title">
        <h2 id="openmig-title" className="section-title">{t("openmig.title")}</h2>
        <p className="text-sm text-united-muted">{t("openmig.explain")}</p>
        {o.blockedBy ? <p className="text-sm font-bold text-united-warn">{t("openmig.blocked-by-batch", { number: o.blockedBy.number })}</p> : manage && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t("openmig.cutoff")} hint={t("openmig.cutoff-hint")}><input type="date" className="field" dir="ltr" value={cutover} max={todayLocalISO()} onChange={(e) => setCutover(e.target.value)} /></Field>
            <Field label={t("openmig.notes")}><input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <button type="button" className="btn-primary" disabled={!cutover} onClick={async () => {
              if (!(await dialogs.confirm({ title: t("openmig.confirm-start", { date: cutover }), body: t("openmig.confirm-start-body"), confirmLabel: t("openmig.start") }))) return;
              await act(() => apiPost("/api/accounting/opening-migration", { cutover_date: cutover, notes: notes || undefined }), t("openmig.toast-started"));
            }}>{t("openmig.start")}</button>
          </div>
        )}
      </section>
    );
  }

  const m = o.migration;
  const closed = o.status === "closed";
  const newBatch = (segment: string) => act(async () => { const r = await apiPost<{ batch: { id: string } }>("/api/accounting/opening-batches", { kind: "phase", segment, idempotency_key: newClientKey() }); onOpenBatch(r.batch.id); }, t("openmig.toast-batch-created"));
  return (
    <section className="flex flex-col gap-3" aria-labelledby="openmig-title">
      <div className="card p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="openmig-title" className="section-title">{t("openmig.title")}</h2>
          <StatusPill tone={STATUS_TONE[o.status]} size="md">{t(`openmig.status.${o.status}`)}</StatusPill>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="font-bold text-united-muted">{t("openmig.cutoff")}</dt><dd className="font-extrabold"><bdi dir="ltr">{m.cutoverDate}</bdi></dd></div>
          <div><dt className="font-bold text-united-muted">{t("openmig.clearing")}</dt><dd className={`font-extrabold ${Number(o.clearing?.balance) ? "text-united-warn" : "text-united-green"}`} dir="ltr">{signed(o.clearing?.balance)}</dd></div>
          <div><dt className="font-bold text-united-muted">{t("openmig.opening-equity")}</dt><dd className={`font-extrabold ${Number(o.openingEquity) ? "text-united-warn" : "text-united-green"}`} dir="ltr">{signed(o.openingEquity)}</dd></div>
          <div><dt className="font-bold text-united-muted">{t("openmig.open-exceptions")}</dt><dd className={`font-extrabold ${o.exceptions?.open ? "text-united-danger" : "text-united-green"}`}>{o.exceptions?.open ?? 0} · <span dir="ltr">{fmtMoney(o.exceptions?.openAmount ?? "0")}</span></dd></div>
          <div><dt className="font-bold text-united-muted">{t("openmig.posted-debit")}</dt><dd className="font-extrabold" dir="ltr">{fmtMoney(o.totals?.debit ?? "0")}</dd></div>
          <div><dt className="font-bold text-united-muted">{t("openmig.posted-credit")}</dt><dd className="font-extrabold" dir="ltr">{fmtMoney(o.totals?.credit ?? "0")}</dd></div>
          <div><dt className="font-bold text-united-muted">{t("openmig.pending-approvals")}</dt><dd className="font-extrabold">{(o.pendingApprovals?.batches.length ?? 0) + (o.pendingApprovals?.closure ? 1 : 0)}</dd></div>
          <div><dt className="font-bold text-united-muted">{t("openmig.export")}</dt><dd className="flex flex-col gap-1 text-sm font-bold"><a className="underline" href="/api/accounting/opening-migration/export?part=accounts">{t("openmig.export-accounts")}</a><a className="underline" href="/api/accounting/opening-migration/export?part=parties">{t("openmig.export-parties")}</a></dd></div>
        </dl>
        {!closed && <p role="note" className="rounded-xl border border-united-warn/40 bg-united-warn/10 p-3 text-sm font-bold text-united-warn">{t("openmig.provisional-banner", { amount: signed(o.clearing?.balance) })}</p>}
        {closed && <p className="text-sm font-bold text-united-green">{t("openmig.closed-note", { by: m.closedBy ?? "", at: (m.closedAt ?? "").slice(0, 10) })}</p>}
      </div>

      <div className="card overflow-hidden">
        <div className="card-header"><h3 className="section-title">{t("openmig.segments")}</h3></div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("openmig.segment")}</th><th className="num">{t("openmig.stage.imported")}</th><th className="num">{t("openmig.stage.pending")}</th><th className="num">{t("openmig.stage.posted")}</th><th className="num">{t("openmig.unmatched")}</th>{manage && !closed && <th><span className="sr-only">{t("treasury.col.actions")}</span></th>}</tr></thead>
            <tbody>
              {SEGMENTS.map((seg) => {
                const s = o.segments![seg];
                const cell = (x: Stage) => x.lines ? <><span>{t("openmig.lines-n", { n: String(x.lines) })}</span> · <span dir="ltr">{fmtMoney(seg === "other" ? x.debit : x.amount)}</span></> : "—";
                return (
                  <tr key={seg}>
                    <th scope="row">{t(`openmig.segment.${seg}`)}</th>
                    <td className="num">{cell(s.imported)}</td><td className="num">{cell(s.pending)}</td><td className="num">{cell(s.posted)}</td>
                    <td className="num">{o.exceptions?.bySegment[seg]?.unmatched ?? 0}</td>
                    {manage && !closed && <td><button type="button" className="btn-secondary btn-sm whitespace-nowrap" disabled={m.state !== "open"} onClick={() => newBatch(seg)}>{t("openmig.new-batch")}</button></td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="px-4 pb-3 text-xs text-united-muted">{t("openmig.stage-note")}</p>
        {(o.batches?.length ?? 0) > 0 && (
          <ul className="flex flex-wrap gap-2 px-4 pb-4">
            {o.batches!.map((b) => (
              <li key={b.id}><button type="button" className="btn-ghost btn-sm" onClick={() => onOpenBatch(b.id)}><bdi dir="ltr">{b.number}</bdi> · {t(`openmig.segment.${b.segment}`)} · {t(`opening.status.${b.status}`)}</button></li>
            ))}
          </ul>
        )}
      </div>

      {manage && !closed && m.state === "open" && <ImportPanel batches={(o.batches ?? []).filter((b) => b.status === "draft" && b.segment !== "other")} onDone={refresh} />}

      <div className="card overflow-hidden">
        <div className="card-header"><h3 className="section-title">{t("openmig.trace")}</h3></div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("openmig.batch")}</th><th>{t("openmig.segment")}</th><th>{t("openmig.source-file")}</th><th>{t("openmig.approved-by")}</th><th className="num">{t("openmig.movement")}</th></tr></thead>
            <tbody>
              {o.clearing!.byBatch.length === 0 ? <tr><td colSpan={5} className="text-united-muted">{t("openmig.trace-empty")}</td></tr> : o.clearing!.byBatch.map((b) => (
                <tr key={b.id}><td><button type="button" className="underline font-bold" onClick={() => onOpenBatch(b.id)}><bdi dir="ltr">{b.number}</bdi></button></td><td>{t(`openmig.segment.${b.segment}`)}</td><td>{b.sourceFile ?? "—"}</td><td>{b.decidedBy ?? "—"}</td><td className="num" dir="ltr">{signed(b.movement)}</td></tr>
              ))}
            </tbody>
            <tfoot>
              <tr><th colSpan={4}>{t("openmig.traced-total")}</th><td className="num font-extrabold" dir="ltr">{signed(o.clearing!.traced)}</td></tr>
              <tr><th colSpan={4}>{t("openmig.untraced")}</th><td className={`num font-extrabold ${Number(o.clearing!.untraced) ? "text-united-danger" : ""}`} dir="ltr">{signed(o.clearing!.untraced)}</td></tr>
            </tfoot>
          </table>
        </div>
      </div>

      <ExceptionsPanel canDecide={manage && !closed} onDone={refresh} />

      <div className="card overflow-hidden">
        <div className="card-header"><h3 className="section-title">{t("openmig.closure")}</h3></div>
        <ul className="flex flex-col divide-y divide-united-border">
          {o.checks!.map((c) => {
            const att = c.key.startsWith("attest_") ? (c.key.slice("attest_".length) as AttestationKey) : null;
            const a = att ? o.attestations?.[att] : undefined;
            return (
              <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span className="flex items-center gap-2"><StatusPill tone={c.ok ? "success" : "danger"}>{c.ok ? t("openmig.check-ok") : t("openmig.check-fail")}</StatusPill><span className="font-bold">{label(c)}</span></span>
                <span className="flex items-center gap-2 text-united-muted">
                  {a ? <span>{t("openmig.attested-by", { by: a.by, at: a.at.slice(0, 10) })} — {a.note}</span> : c.value !== undefined && c.value !== "" ? <span dir="ltr">{checkValue(c.value)}</span> : c.count !== undefined ? <span>{c.count}</span> : null}
                  {att && manage && m.state === "open" && (
                    <button type="button" className="btn-secondary btn-sm" onClick={async () => {
                      const note = await dialogs.prompt({ title: t(a ? "openmig.withdraw-attest" : "openmig.attest", { what: label(c) }), label: t("openmig.attest-note"), required: true, confirmLabel: t(a ? "openmig.withdraw" : "openmig.confirm") });
                      if (!note) return;
                      await act(() => apiPost("/api/accounting/opening-migration/attest", { key: att, confirmed: !a, note, expected_version: m.version }));
                    }}>{t(a ? "openmig.withdraw" : "openmig.confirm")}</button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-2 p-4">
          {manage && m.state === "open" && (
            <button type="button" className="btn-primary" disabled={!o.readyForClosure} onClick={async () => {
              if (!(await dialogs.confirm({ title: t("openmig.confirm-close"), body: t("openmig.confirm-close-body"), confirmLabel: t("openmig.request-close") }))) return;
              await act(() => apiPost("/api/accounting/opening-migration/close", { expected_version: m.version }), t("openmig.toast-close-requested"));
            }}>{t("openmig.request-close")}</button>
          )}
          {m.state === "closing" && <span className="text-sm font-bold text-united-warn">{t("openmig.close-pending", { by: m.closeRequestedBy ?? "" })}</span>}
          {manage && m.state === "closing" && (
            <button type="button" className="btn-secondary btn-sm" onClick={async () => {
              const reason = await dialogs.prompt({ title: t("openmig.withdraw-close"), label: t("ui.reason-label"), required: true, confirmLabel: t("openmig.withdraw") });
              if (!reason) return;
              await act(() => apiPost("/api/accounting/opening-migration/close/withdraw", { reason }));
            }}>{t("openmig.withdraw-close")}</button>
          )}
          {!o.readyForClosure && m.state === "open" && <span className="text-xs text-united-muted">{t("openmig.close-hint")}</span>}
        </div>
      </div>
    </section>
  );
}

/** A supplier or customer sheet pasted from a spreadsheet: preview each row's outcome, then add the matched rows to a draft batch. */
function ImportPanel({ batches, onDone }: { batches: { id: string; number: string; segment: string; sourceFile: string | null }[]; onDone: () => void }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [batchId, setBatchId] = useState("");
  const [file, setFile] = useState("");
  const [category, setCategory] = useState("");
  const [due, setDue] = useState("");
  const [paste, setPaste] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const batch = batches.find((b) => b.id === batchId);
  const rows = () => {
    const lines = paste.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const sep = lines[0].includes("\t") ? "\t" : ",";
    const head = lines[0].split(sep).map((h) => h.trim());
    return lines.slice(1).map((l) => { const c = l.split(sep); const o: Record<string, string> = {}; head.forEach((h, i) => { const v = (c[i] ?? "").trim(); if (v) o[h] = v; }); return o; });
  };
  const run = async (mode: "preview" | "commit") => {
    const body = rows();
    if (!body.length) { toast.show(t("opening.paste-empty"), "error"); return; }
    try {
      const r = await apiPost<{ result: ImportResult }>("/api/accounting/opening-migration/import", { mode, segment: batch?.segment, batch_id: batchId, source_file: file || batch?.sourceFile, ...(category ? { category } : {}), ...(due ? { due_date: due } : {}), rows: body });
      setResult(r.result);
      if (mode === "commit") { toast.show(t("openmig.toast-imported", { n: String(r.result.summary.matched), e: String(r.result.summary.newExceptions) }), "success"); onDone(); }
    } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  return (
    <section className="card p-4 flex flex-col gap-3" aria-labelledby="openmig-import">
      <h3 id="openmig-import" className="section-title">{t("openmig.import")}</h3>
      <p className="text-sm text-united-muted">{t("openmig.import-explain")}</p>
      {batches.length === 0 ? <p className="text-sm font-bold text-united-muted">{t("openmig.import-no-batch")}</p> : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <Field label={t("openmig.batch")}><select className="field" value={batchId} onChange={(e) => { setBatchId(e.target.value); setResult(null); const b = batches.find((x) => x.id === e.target.value); if (b?.sourceFile) setFile(b.sourceFile); }}><option value="">—</option>{batches.map((b) => <option key={b.id} value={b.id}>{b.number} · {t(`openmig.segment.${b.segment}`)}</option>)}</select></Field>
            <Field label={t("openmig.source-file")}><input className="field" value={file} disabled={!!batch?.sourceFile} onChange={(e) => setFile(e.target.value)} /></Field>
            {batch?.segment === "suppliers" && <Field label={t("openmig.category")} hint={t("openmig.category-hint")}><select className="field" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">—</option>{["vegetable", "fruit", "other"].map((c) => <option key={c} value={c}>{t(`purchasing.supplier.category.${c}`)}</option>)}</select></Field>}
            <Field label={t("openmig.due-date")} hint={t("openmig.due-date-hint")}><input type="date" className="field" dir="ltr" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          </div>
          <Field label={t("opening.paste")} hint={t("opening.paste-hint", { cols: "source_row, source_name, party_code, amount" })}><textarea className="field font-mono" dir="ltr" rows={5} value={paste} onChange={(e) => { setPaste(e.target.value); setResult(null); }} /></Field>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" disabled={!batchId || !(file || batch?.sourceFile) || !paste.trim()} onClick={() => run("preview")}>{t("openmig.preview")}</button>
            <button type="button" className="btn-primary" disabled={result?.mode !== "preview" || !result.summary.matched && !result.summary.newExceptions} onClick={() => run("commit")}>{t("openmig.commit")}</button>
          </div>
        </>
      )}
      {result && (
        <>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <div><dt className="font-bold text-united-muted">{t("openmig.rows")}</dt><dd className="font-extrabold">{result.summary.rows} · <span dir="ltr">{fmtMoney(result.summary.total)}</span></dd></div>
            <div><dt className="font-bold text-united-muted">{t("openmig.outcome.matched")}</dt><dd className="font-extrabold text-united-green">{result.summary.matched} · <span dir="ltr">{fmtMoney(result.summary.matchedAmount)}</span></dd></div>
            <div><dt className="font-bold text-united-muted">{t("openmig.outcome.exception")}</dt><dd className="font-extrabold text-united-danger">{result.summary.exceptions} · <span dir="ltr">{fmtMoney(result.summary.exceptionAmount)}</span></dd></div>
            <div><dt className="font-bold text-united-muted">{t("openmig.outcome.zero")}</dt><dd className="font-extrabold">{result.summary.zero}</dd></div>
            <div><dt className="font-bold text-united-muted">{t("openmig.outcome.already_in_migration")}</dt><dd className="font-extrabold">{result.summary.alreadyInMigration}</dd></div>
          </dl>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>{t("openmig.source-row")}</th><th>{t("openmig.source-name")}</th><th>{t("openmig.code")}</th><th>{t("openmig.erp-record")}</th><th className="num">{t("openmig.amount")}</th><th>{t("openmig.outcome")}</th></tr></thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.source_row}>
                    <td dir="ltr">{r.source_row}</td><td>{r.source_name}</td><td dir="ltr">{r.party_code ?? "—"}</td>
                    <td>{r.party ? (locale === "en" ? r.party.name : r.party.nameAr ?? r.party.name) : "—"}</td>
                    <td className="num" dir="ltr">{fmtMoney(r.amount)}</td>
                    <td><StatusPill tone={r.outcome === "matched" ? "success" : r.outcome === "exception" ? "danger" : "neutral"}>{t(`openmig.outcome.${r.outcome}`)}</StatusPill>{r.reason && <span className="ms-2 text-xs">{t(`openmig.reason.${r.reason}`)}{r.detail ? ` — ${r.detail}` : ""}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** The exception register: every source row not posted, with its evidence, until decided with a reason. */
function ExceptionsPanel({ canDecide, onDone }: { canDecide: boolean; onDone: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const dialogs = useDialogs();
  const [status, setStatus] = useState("open");
  const q = useQuery({ queryKey: ["acc", "opening-exceptions", status], queryFn: () => apiFetch<{ exceptions: ExceptionRow[] }>(`/api/accounting/opening-migration/exceptions?status=${status}`).then((r) => r.exceptions) });
  const decide = async (e: ExceptionRow, to: "resolved" | "excluded") => {
    const resolution = await dialogs.prompt({ title: t(`openmig.decide.${to}`, { row: `${e.sourceFile} · ${e.sourceRow}` }), label: t("openmig.resolution"), required: true, tone: to === "excluded" ? "danger" : undefined, confirmLabel: t(`openmig.exception-status.${to}`) });
    if (!resolution) return;
    try { await apiPost(`/api/accounting/opening-migration/exceptions/${e.id}`, { status: to, resolution, expected_version: e.version }); onDone(); } catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h3 className="section-title">{t("openmig.exceptions")}</h3>
        <select className="field w-auto" aria-label={t("openmig.exception-filter")} value={status} onChange={(e) => setStatus(e.target.value)}>{["open", "resolved", "excluded"].map((s) => <option key={s} value={s}>{t(`openmig.exception-status.${s}`)}</option>)}</select>
      </div>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("openmig.segment")}</th><th>{t("openmig.source-file")}</th><th>{t("openmig.source-row")}</th><th>{t("openmig.source-name")}</th><th className="num">{t("openmig.amount")}</th><th>{t("openmig.reason")}</th>{status !== "open" ? <th>{t("openmig.resolution")}</th> : canDecide && <th><span className="sr-only">{t("treasury.col.actions")}</span></th>}</tr></thead>
            <tbody>
              {!q.data?.length ? <tr><td colSpan={7} className="text-united-muted">{t("openmig.exceptions-empty")}</td></tr> : q.data.map((e) => (
                <tr key={e.id}>
                  <td>{t(`openmig.segment.${e.segment}`)}</td><td>{e.sourceFile}</td><td dir="ltr">{e.sourceRow}</td><td>{e.sourceName}</td><td className="num" dir="ltr">{fmtMoney(e.sourceAmount)}</td>
                  <td className="min-w-[12rem]">{t(`openmig.reason.${e.reason}`)}{e.detail ? <span className="block text-xs text-united-muted">{e.detail}</span> : null}</td>
                  {status !== "open" ? <td>{e.resolution}<span className="block text-xs text-united-muted">{e.resolvedBy}</span></td> : canDecide && (
                    <td><div className="flex flex-col gap-1"><button type="button" className="btn-secondary btn-sm whitespace-nowrap" onClick={() => decide(e, "resolved")}>{t("openmig.exception-status.resolved")}</button><button type="button" className="btn-ghost btn-sm whitespace-nowrap text-united-danger" onClick={() => decide(e, "excluded")}>{t("openmig.exception-status.excluded")}</button></div></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One line above a financial report while the opening figures are not final (phased migration not closed). */
export function ProvisionalOpeningBanner() {
  const { t } = useLocale();
  const signed = signedWith(t);
  const q = useQuery({ queryKey: ["acc", "opening-position"], queryFn: () => apiFetch<{ opening: { final: boolean; state: string; cutoverDate: string | null; clearing: string } }>("/api/accounting/opening-migration/position").then((r) => r.opening) });
  if (!q.data || q.data.final) return null;
  return (
    <p role="note" className="rounded-xl border border-united-warn/40 bg-united-warn/10 p-3 text-sm font-bold text-united-warn">
      {q.data.state === "none" ? t("openmig.report-banner-none") : t("openmig.report-banner", { date: q.data.cutoverDate ?? "", amount: signed(q.data.clearing) })}
    </p>
  );
}
