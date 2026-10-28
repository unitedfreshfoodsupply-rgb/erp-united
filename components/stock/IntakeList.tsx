"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { LoadingState, EmptyState, ErrorState } from "@/components/States";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { useToast } from "@/components/ui/Toast";
import { todayLocalISO } from "@/lib/localDate";
import { fmtKg, fmtYield, YIELD_TONE_CLASS, yieldTone } from "@/lib/stockPresentation";
import { invalidateStockData } from "@/lib/stockInvalidation";
import { usePermissions } from "@/lib/use-session";
import { GradingForm } from "@/components/stock/GradingForm";
import type { IntakeDTO } from "@/lib/stock-client-types";
import { localName } from "@/lib/locale/names";
import { useLocale } from "@/lib/locale";
import { StatusPill } from "@/components/ui/StatusPill";
import { PageHeader } from "@/components/ui/PageHeader";

export function IntakeList() {
  const { t } = useLocale();
  const [date, setDate] = useState(todayLocalISO());
  const [showVoided, setShowVoided] = useState(false);

  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["stock", "intakes", date, showVoided],
    queryFn: () =>
      apiFetch<{ intakes: IntakeDTO[] }>(
        `/api/stock/intakes?date=${date}${showVoided ? "&include_voided=1" : ""}`
      ),
    refetchInterval: 15_000,
  });

  const intakes = data?.intakes ?? [];
  const posted = intakes.filter((i) => i.status === "posted");
  const received = posted.reduce((s, i) => s + i.receivedKg, 0);
  const good = posted.reduce((s, i) => s + i.goodKg, 0);

  return (
    <div className="page-narrow">
      <PageHeader title={t("intake.title")} actions={<LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />} />

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value || todayLocalISO())}
          className="field w-auto"
          aria-label={t("intake.date")}
        />
        <button
          type="button"
          onClick={() => setShowVoided((v) => !v)}
          aria-pressed={showVoided}
          className="chip"
        >
          {t("intake.include-voided")}
        </button>
        {posted.length > 0 && (
          <span className="text-sm font-bold text-united-muted ms-auto">
            {t("intake.summary", { good: fmtKg(good), received: fmtKg(received), count: posted.length })}
          </span>
        )}
      </div>

      {isLoading && <LoadingState />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && intakes.length === 0 && (
        <EmptyState icon="📋" title={t("intake.empty")} />
      )}

      <div className="flex flex-col gap-3">
        {intakes.map((intake) => (
          <IntakeCard key={intake.id} intake={intake} />
        ))}
      </div>
    </div>
  );
}

function IntakeCard({ intake }: { intake: IntakeDTO }) {
  const { locale, t } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = usePermissions();
  const [mode, setMode] = useState<"view" | "edit" | "void" | "sort">("view");
  const [receivedKg, setReceivedKg] = useState(String(intake.receivedKg));
  const [rejectedKg, setRejectedKg] = useState(String(intake.rejectedKg));
  const [crates, setCrates] = useState(intake.crateCount == null ? "" : String(intake.crateCount));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const voided = intake.status === "voided";
  const pct = intake.receivedKg > 0 ? Math.round((intake.goodKg / intake.receivedKg) * 1000) / 10 : null;

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await invalidateStockData(qc);
      setMode("view");
      setReason("");
    } catch (err) {
      const msg = err instanceof ApiClientError && err.message ? err.message : t("ui.error.generic");
      setError(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      await apiPatch(`/api/stock/intakes/${intake.id}`, {
        received_kg: Number(receivedKg),
        rejected_kg: rejectedKg === "" ? 0 : Number(rejectedKg),
        crate_count: crates === "" ? null : Number(crates),
        reason,
        expected_version: intake.version,
      });
      toast.show(t("intake.toast-edited", { number: intake.receiptNumber }), "success");
    });

  const doVoid = () =>
    run(async () => {
      await apiPost(`/api/stock/intakes/${intake.id}/void`, {
        reason,
        expected_version: intake.version,
      });
      toast.show(t("intake.toast-voided", { number: intake.receiptNumber }), "success");
    });

  return (
    <div className={`card p-4 ${voided ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-extrabold text-united-dark">{localName(intake.product, locale)}</span>
            {voided && (
              <StatusPill tone="danger">{t("intake.voided")}</StatusPill>
            )}
          </div>
          <div className="text-xs font-bold text-united-muted">
            {localName(intake.supplier, locale)} · <span dir="ltr">{intake.receiptNumber}</span>{intake.purchaseOrderLine ? ` · ${intake.purchaseOrderLine.po.number}` : ""} · {intake.recordedBy}
          </div>
        </div>
        <span dir="ltr" className={`text-xl font-extrabold shrink-0 ${YIELD_TONE_CLASS[yieldTone(pct)]}`}>
          {fmtYield(pct)}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2 mt-3 text-center">
        <Cell label={t("intake.received")} value={fmtKg(intake.receivedKg)} />
        <Cell label={t("intake.rejected")} value={fmtKg(intake.rejectedKg)} tone="text-united-warn" />
        <Cell label={t("intake.good")} value={fmtKg(intake.goodKg)} tone="text-united-green" />
        <Cell label={t("intake.crates")} value={intake.crateCount == null ? "—" : String(intake.crateCount)} />
      </div>

      {(Number(intake.gradeBQty) > 0 || Number(intake.wasteQty) > 0) && (
        <div className="grid grid-cols-2 gap-2 mt-2 text-center">
          {Number(intake.gradeBQty) > 0 && (
            <Cell label={t("intake.grade-b")} value={fmtKg(Number(intake.gradeBQty))} tone="text-united-dark" />
          )}
          {Number(intake.wasteQty) > 0 && (
            <Cell label={t("intake.waste")} value={fmtKg(Number(intake.wasteQty))} tone="text-united-danger" />
          )}
        </div>
      )}

      {intake.notes && <p className="text-xs font-bold text-united-dark/70 mt-2">{intake.notes}</p>}
      {error && <p className="text-united-danger font-bold text-sm mt-2">{error}</p>}

      {!voided && mode === "view" && (
        <div className="mt-3 flex flex-wrap gap-2">
          {/* The everyday action leads; voiding a receipt is rare and destructive, so it
           * is a quiet text action at the end (it still asks for a reason before it acts). */}
          {can("stock.adjust") && (
            <button type="button" onClick={() => setMode("sort")} className="btn-primary flex-1 text-sm">
              {t("intake.sort")}
            </button>
          )}
          <button type="button" onClick={() => setMode("edit")} className="btn-secondary flex-1 text-sm">
            {t("intake.edit")}
          </button>
          <button type="button" onClick={() => setMode("void")} className="btn-ghost text-sm text-united-danger hover:bg-[#FDECEA]">
            {t("intake.void")}
          </button>
        </div>
      )}

      {mode === "sort" && (
        <div className="mt-3">
          <GradingForm
            intake={intake}
            onClose={() => {
              setMode("view");
              setError(null);
            }}
            onPosted={() => {
              // Keep the result card visible — the operator reads the document +
              // movements + costing basis before closing it (the card's إغلاق
              // button returns to view mode). Only refresh the derived views.
              invalidateStockData(qc);
            }}
          />
        </div>
      )}

      {mode === "edit" && (
        <div className="flex flex-col gap-2 mt-3">
          <div className="grid grid-cols-3 gap-2">
            <EditField label={t("intake.received")} value={receivedKg} onChange={setReceivedKg} />
            <EditField label={t("intake.rejected")} value={rejectedKg} onChange={setRejectedKg} />
            <EditField label={t("intake.crates")} value={crates} onChange={setCrates} integer />
          </div>
          <input
            placeholder={t("intake.edit-reason")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="field"
          />
          <p className="text-[11px] font-bold text-united-muted">
            {t("intake.edit-note")}
          </p>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy || !reason.trim()} className="btn-primary flex-1 text-sm">
              {t("intake.save")}
            </button>
            <button onClick={() => setMode("view")} className="btn-secondary flex-1 text-sm">
              {t("intake.back")}
            </button>
          </div>
        </div>
      )}

      {mode === "void" && (
        <div className="flex flex-col gap-2 mt-3">
          <input
            placeholder={t("intake.void-reason")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="field"
          />
          <p className="text-[11px] font-bold text-united-muted">
            {t("intake.void-note")}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={doVoid} disabled={busy || !reason.trim()} className="btn-danger-solid flex-1 text-sm">
              {t("intake.void-confirm")}
            </button>
            <button onClick={() => setMode("view")} className="btn-secondary flex-1 text-sm">
              {t("intake.back")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Cell({ label, value, tone = "text-united-dark" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-united-dark/[0.03] py-2">
      <div dir="ltr" className={`font-extrabold ${tone}`}>
        {value}
      </div>
      <div className="text-[11px] font-bold text-united-muted">{label}</div>
    </div>
  );
}

function EditField({
  label,
  value,
  onChange,
  integer,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  integer?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-extrabold text-united-muted">{label}</span>
      <input
        type="number"
        inputMode={integer ? "numeric" : "decimal"}
        step={integer ? 1 : "any"}
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="tap-target w-full text-center text-lg font-extrabold border-2 border-united-dark/10 rounded-xl focus:border-united-green outline-none"
      />
    </label>
  );
}
