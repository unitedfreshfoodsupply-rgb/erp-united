"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialog";
import { StatusPill } from "@/components/ui/StatusPill";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { todayLocalISO } from "@/lib/localDate";
import { Field, fmtMoney } from "@/components/stock/inventory/shared";
import { CashAccountSelect } from "@/components/accounting/CashAccountSelect";

/**
 * VAT returns: preview what a period's return would set off (from the ledger's own
 * balances), file it, pay what is due, or void an unpaid return to correct it. While a
 * return is live its period is closed for VAT documents.
 */

type VatReturn = { id: string; number: string; periodFrom: string; periodTo: string; status: "filed" | "paid" | "voided"; outputTax: string; inputTax: string; inputUsed: string; payable: string; carryForward: string; documentsOutputTax: string; documentsInputTax: string; reference: string | null; filedBy: string; paymentDate: string | null; voidReason: string | null };
type Preview = { from: string; to: string; expectedFrom: string | null; outputTax: string; inputTax: string; inputUsed: string; payable: string; carryForward: string; documents: { outputTax: string; inputTax: string }; reconciled: boolean; problems: string[] };

const monthBounds = () => {
  const d = new Date(`${todayLocalISO().slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const from = d.toISOString().slice(0, 10);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { from, to: end };
};

export function VatReturnsView() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const manage = can("accounting.manage");
  const toast = useToast();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["acc", "vat-returns"], queryFn: () => apiFetch<{ returns: VatReturn[]; balances: { input: string; output: string }; nextFrom: string | null }>("/api/accounting/vat-returns") });
  const [range, setRange] = useState(monthBounds);
  const [paying, setPaying] = useState<VatReturn | null>(null);
  const from = q.data?.nextFrom ?? range.from;
  const preview = useQuery({ queryKey: ["acc", "vat-preview", from, range.to], queryFn: () => apiFetch<{ preview: Preview }>(`/api/accounting/vat-returns/preview?from=${from}&to=${range.to}`).then((r) => r.preview), enabled: manage && !!q.data && from <= range.to });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["acc"] });
  const file = async () => {
    const p = preview.data;
    if (!p) return;
    if (!(await dialogs.confirm({ title: t("vat.confirm-file", { from: p.from, to: p.to }), body: t("vat.file-body", { payable: fmtMoney(p.payable), carry: fmtMoney(p.carryForward) }), confirmLabel: t("vat.file") }))) return;
    try { await apiPost("/api/accounting/vat-returns", { period_from: p.from, period_to: p.to }); toast.show(t("vat.toast-filed"), "success"); refresh(); }
    catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  const voidIt = async (r: VatReturn) => {
    const reason = await dialogs.prompt({ title: t("vat.prompt-void", { number: r.number }), label: t("ui.reason-label"), required: true, multiline: true, tone: "danger", confirmLabel: t("vat.void") });
    if (!reason) return;
    try { await apiPost(`/api/accounting/vat-returns/${r.id}/void`, { reason }); toast.show(t("vat.toast-voided"), "success"); refresh(); }
    catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
  };
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const p = preview.data;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="vat-returns">
      <h2 id="vat-returns" className="section-title">{t("vat.returns-title")}</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="card p-3"><div className="text-xs font-bold text-united-muted">{t("vat.balance-output")}</div><div className="text-lg font-extrabold" dir="ltr">{fmtMoney(q.data.balances.output)}</div></div>
        <div className="card p-3"><div className="text-xs font-bold text-united-muted">{t("vat.balance-input")}</div><div className="text-lg font-extrabold" dir="ltr">{fmtMoney(q.data.balances.input)}</div></div>
      </div>
      {manage && (
        <div className="card p-4 flex flex-col gap-2">
          <h3 className="font-extrabold">{t("vat.new-return")}</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field label={t("vat.period-from")} hint={q.data.nextFrom ? t("vat.from-fixed") : undefined}><input type="date" className="field" value={from} disabled={!!q.data.nextFrom} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
            <Field label={t("vat.period-to")}><input type="date" className="field" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          </div>
          {preview.isLoading ? <LoadingState /> : p ? (
            <>
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
                {([["vat.output", p.outputTax], ["vat.input", p.inputTax], ["vat.set-off", p.inputUsed], ["vat.payable", p.payable], ["vat.carry", p.carryForward]] as const).map(([k, v]) => (
                  <div key={k}><dt className="font-bold text-united-muted">{t(k)}</dt><dd className="font-extrabold" dir="ltr">{fmtMoney(v)}</dd></div>
                ))}
              </dl>
              {p.problems.length > 0 && <ul className="text-sm font-bold text-united-danger">{p.problems.map((x) => <li key={x}>{t(`vat.problem.${x}`, { from: p.expectedFrom ?? "" })}</li>)}</ul>}
              <div><button type="button" className="btn-primary" disabled={p.problems.length > 0} onClick={file}>{t("vat.file")}</button></div>
            </>
          ) : null}
        </div>
      )}
      {paying && <PayForm r={paying} onDone={() => { setPaying(null); refresh(); }} />}
      {q.data.returns.length === 0 ? <EmptyState icon="🧾" title={t("vat.no-returns")} /> : (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>{t("treasury.col.number")}</th><th>{t("vat.col.period")}</th><th className="num">{t("vat.output")}</th><th className="num">{t("vat.input")}</th><th className="num">{t("vat.payable")}</th><th className="num">{t("vat.carry")}</th><th>{t("treasury.col.status")}</th>{manage && <th><span className="sr-only">{t("treasury.col.actions")}</span></th>}</tr></thead>
            <tbody>
              {q.data.returns.map((r) => (
                <tr key={r.id} className={r.status === "voided" ? "opacity-60" : ""}>
                  <td><bdi dir="ltr">{r.number}</bdi></td>
                  <td><bdi dir="ltr">{r.periodFrom} – {r.periodTo}</bdi></td>
                  <td className="num" dir="ltr">{fmtMoney(r.outputTax)}</td>
                  <td className="num" dir="ltr">{fmtMoney(r.inputUsed)}</td>
                  <td className="num" dir="ltr">{fmtMoney(r.payable)}</td>
                  <td className="num" dir="ltr">{fmtMoney(r.carryForward)}</td>
                  <td><StatusPill tone={r.status === "paid" ? "success" : r.status === "filed" ? "warn" : "neutral"} strike={r.status === "voided"}>{t(`vat.status.${r.status}`)}</StatusPill></td>
                  {manage && (
                    <td className="whitespace-nowrap">
                      {r.status === "filed" && <button type="button" className="btn-primary btn-sm" onClick={() => setPaying(r)}>{t("vat.pay")}</button>}
                      {(r.status === "filed" || (r.status === "paid" && Number(r.payable) === 0)) && <button type="button" className="btn-danger btn-sm ms-1" onClick={() => voidIt(r)}>{t("vat.void")}</button>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PayForm({ r, onDone }: { r: VatReturn; onDone: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const [f, setF] = useState({ cash_account_id: "bank_main", date: todayLocalISO(), reference: "" });
  const [busy, setBusy] = useState(false);
  return (
    <form className="card p-4 grid grid-cols-1 gap-2 sm:grid-cols-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true);
      try { await apiPost(`/api/accounting/vat-returns/${r.id}/pay`, f); toast.show(t("vat.toast-paid"), "success"); onDone(); }
      catch (err) { toast.show(errorMessage(err) ?? t("ui.error.generic"), "error"); }
      finally { setBusy(false); }
    }}>
      <div className="sm:col-span-4 font-extrabold">{t("vat.pay-title", { number: r.number, amount: fmtMoney(r.payable) })}</div>
      <Field label={t("accounting.form.account.label")} required><CashAccountSelect value={f.cash_account_id} onChange={(id) => setF({ ...f, cash_account_id: id })} /></Field>
      <Field label={t("treasury.field.date")} required><input type="date" className="field" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
      <Field label={t("treasury.field.reference")}><input className="field" dir="ltr" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      <div className="flex gap-2 self-end"><button type="submit" className="btn-primary" disabled={busy}>{t("vat.pay")}</button><button type="button" className="btn-secondary" onClick={onDone}>{t("ui.cancel")}</button></div>
    </form>
  );
}
