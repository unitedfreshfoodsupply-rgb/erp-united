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

export function IntakeList() {
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
    <div className="p-4 max-w-3xl mx-auto pb-10">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-2xl font-extrabold text-united-dark">الاستلامات</h1>
        <LiveIndicator dataUpdatedAt={dataUpdatedAt} isLoading={isLoading} />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value || todayLocalISO())}
          className="tap-target border-2 border-united-dark/10 rounded-xl px-3 font-bold bg-white focus:border-united-green outline-none"
          aria-label="تاريخ"
        />
        <button
          type="button"
          onClick={() => setShowVoided((v) => !v)}
          aria-pressed={showVoided}
          className={`tap-target px-4 rounded-xl font-extrabold text-sm ${
            showVoided ? "bg-united-dark text-white" : "bg-united-dark/5 text-united-dark"
          }`}
        >
          يشمل الملغي
        </button>
        {posted.length > 0 && (
          <span dir="ltr" className="text-sm font-bold text-united-muted mr-auto">
            {fmtKg(good)} / {fmtKg(received)} كجم · {posted.length} استلام
          </span>
        )}
      </div>

      {isLoading && <LoadingState />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && intakes.length === 0 && (
        <EmptyState icon="📋" title="مفيش استلامات مسجلة في اليوم ده" />
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
  const { locale } = useLocale();
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
      const msg = err instanceof ApiClientError ? err.message : "حصل خطأ";
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
      toast.show(`اتعدّل ${intake.receiptNumber}`, "success");
    });

  const doVoid = () =>
    run(async () => {
      await apiPost(`/api/stock/intakes/${intake.id}/void`, {
        reason,
        expected_version: intake.version,
      });
      toast.show(`اتلغى ${intake.receiptNumber}`, "success");
    });

  return (
    <div className={`card p-4 ${voided ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-extrabold text-united-dark">{intake.product.name}</span>
            {voided && (
              <span className="text-[11px] font-extrabold bg-united-danger/10 text-united-danger px-2 py-0.5 rounded-full">
                ملغي
              </span>
            )}
          </div>
          <div className="text-xs font-bold text-united-muted">
            {localName(intake.supplier, locale)} · {intake.receiptNumber}{intake.purchaseOrderLine ? ` · ${intake.purchaseOrderLine.po.number}` : ""} · {intake.recordedBy}
          </div>
        </div>
        <span dir="ltr" className={`text-xl font-extrabold shrink-0 ${YIELD_TONE_CLASS[yieldTone(pct)]}`}>
          {fmtYield(pct)}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2 mt-3 text-center">
        <Cell label="مستلم" value={fmtKg(intake.receivedKg)} />
        <Cell label="مرفوض" value={fmtKg(intake.rejectedKg)} tone="text-united-warn" />
        <Cell label="صالح" value={fmtKg(intake.goodKg)} tone="text-united-green" />
        <Cell label="أقفاص" value={intake.crateCount == null ? "—" : String(intake.crateCount)} />
      </div>

      {(Number(intake.gradeBQty) > 0 || Number(intake.wasteQty) > 0) && (
        <div className="grid grid-cols-2 gap-2 mt-2 text-center">
          {Number(intake.gradeBQty) > 0 && (
            <Cell label="فرزة (ب)" value={fmtKg(Number(intake.gradeBQty))} tone="text-united-dark" />
          )}
          {Number(intake.wasteQty) > 0 && (
            <Cell label="هالك" value={fmtKg(Number(intake.wasteQty))} tone="text-united-danger" />
          )}
        </div>
      )}

      {intake.notes && <p className="text-xs font-bold text-united-dark/70 mt-2">{intake.notes}</p>}
      {error && <p className="text-united-danger font-bold text-sm mt-2">{error}</p>}

      {!voided && mode === "view" && (
        <div className="flex gap-2 mt-3">
          <button onClick={() => setMode("edit")} className="btn-secondary flex-1 text-sm">
            تعديل
          </button>
          {can("stock.adjust") && (
            <button onClick={() => setMode("sort")} className="btn-primary flex-1 text-sm">
              فرز
            </button>
          )}
          <button onClick={() => setMode("void")} className="btn-danger flex-1 text-sm">
            إلغاء الاستلام
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
            <EditField label="مستلم" value={receivedKg} onChange={setReceivedKg} />
            <EditField label="مرفوض" value={rejectedKg} onChange={setRejectedKg} />
            <EditField label="أقفاص" value={crates} onChange={setCrates} integer />
          </div>
          <input
            placeholder="سبب التعديل (إجباري)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="field"
          />
          <p className="text-[11px] font-bold text-united-muted">
            التعديل بيتسجل كحركة تصحيح في السجل — الحركة الأصلية بتفضل زي ما هي.
          </p>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy || !reason.trim()} className="btn-primary flex-1 text-sm">
              حفظ
            </button>
            <button onClick={() => setMode("view")} className="btn-secondary flex-1 text-sm">
              رجوع
            </button>
          </div>
        </div>
      )}

      {mode === "void" && (
        <div className="flex flex-col gap-2 mt-3">
          <input
            placeholder="سبب الإلغاء (إجباري)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="field"
          />
          <p className="text-[11px] font-bold text-united-muted">
            مفيش حاجة بتتمسح — بيتسجل قيد عكسي بيرجّع الرصيد لمكانه.
          </p>
          <div className="flex gap-2">
            <button onClick={doVoid} disabled={busy || !reason.trim()} className="btn-danger flex-1 text-sm">
              تأكيد الإلغاء
            </button>
            <button onClick={() => setMode("view")} className="btn-secondary flex-1 text-sm">
              رجوع
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
