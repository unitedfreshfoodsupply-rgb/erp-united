"use client";

import { ErrorState } from "@/components/States";
import { unitLabel } from "@/lib/format";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { todayLocalISO } from "@/lib/localDate";
import { fmtKg, fmtYield } from "@/lib/stockPresentation";
import { invalidateStockData } from "@/lib/stockInvalidation";
import { newClientKey } from "@/lib/clientKey";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import type { IntakeDTO, StockProductDTO } from "@/lib/stock-client-types";
import { localName } from "@/lib/locale/names";

/**
 * F-08 — the grading / فرز screen.
 *
 * Turns one posted intake's raw stock into Good / Grade B / Waste through the
 * existing server workflow (POST /api/stock/intakes/:id/sort). The server is the
 * hard gate on quantity conservation, availability, permissions, and idempotency;
 * this form mirrors the rules live (conservation bar, remaining cap) so a mistake
 * is caught before the round-trip, then proves the post with the returned
 * document + movements + costing basis.
 */

type MovementDTO = {
  id: string;
  kind: string;
  quantity: string;
  quantityKg: number;
  local?: string;
  reason?: string;
  unitCost?: string | null;
  location: { code: string } | null;
  product: { name: string; unit: string } | null;
};

type SortDocumentDTO = {
  id: string;
  number: string;
  type: string;
  status: string;
  reason: string | null;
  payload: {
    inputKg?: string;
    goodKg?: string;
    gradeBKg?: string;
    wasteKg?: string;
    costBasis?: string;
    fallbackReason?: string | null;
    goodUnitCost?: string | null;
    gradeBUnitCost?: string | null;
    wasteUnitCost?: string | null;
    wasteLoss?: string;
  } | null;
  movements: MovementDTO[];
};

type LedgerMove = {
  id: string;
  intakeId: string | null;
  quantityKg: number;
  kind: string;
  location?: { id: string; code: string } | null;
};

// Runtime value → dictionary key lookup for localized labels
const SOURCE_TKEY: Record<string, string> = {
  sorting_out: "stock.movement.sorting_out_label",
  sorting_in: "stock.movement.sorting_in_label",
};

const COST_BASIS_TKEY: Record<string, string> = {
  proportional: "stock.cost-basis.proportional",
  nrv: "stock.cost-basis.nrv",
  nrv_fallback_proportional: "stock.cost-basis.nrv_fallback_proportional",
};

const p3 = (v: number) => Math.round(v * 1000) / 1000;

export function GradingForm({
  intake,
  onClose,
  onPosted,
}: {
  intake: IntakeDTO;
  onClose: () => void;
  onPosted?: (doc: SortDocumentDTO) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = usePermissions();
  const canSeeCosts = can("stock.valuation.view");
  const { t, dir, locale } = useLocale();

  const [inputKg, setInputKg] = useState("");
  const [goodKg, setGoodKg] = useState("");
  const [gradeBKg, setGradeBKg] = useState("");
  const [wasteKg, setWasteKg] = useState("");
  const [gradeBProductId, setGradeBProductId] = useState("");
  const [reason, setReason] = useState("");
  const [businessDate, setBusinessDate] = useState(todayLocalISO());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitKey, setSubmitKey] = useState(newClientKey);
  const [result, setResult] = useState<SortDocumentDTO | null>(null);

  const productsQ = useQuery({
    queryKey: ["stock", "products"],
    queryFn: () => apiFetch<{ products: StockProductDTO[] }>("/api/stock/products"),
    staleTime: 60_000,
  });
  const ledgerQ = useQuery({
    queryKey: ["stock", "ledger", intake.productId],
    queryFn: () => apiFetch<{ movements: LedgerMove[] }>(`/api/stock/ledger?product_id=${intake.productId}&limit=500`),
    staleTime: 15_000,
  });

  // The intake's own bucket — what is left to sort from THIS receipt in ITS location
  // (intake +, sorting_out −, sorting_in good back +). Movements that landed in other
  // locations (waste bucket) are not part of this bucket and therefore not re-sortable
  // from it. The server re-checks the same bucket at post time.
    const remaining = useMemo(() => {
      const moves = ledgerQ.data?.movements ?? [];
      const locId = intake.location?.id;
      const own = locId ? moves.filter((m) => m.intakeId === intake.id && m.location?.id === locId) : moves.filter((m) => m.intakeId === intake.id);
      return p3(own.reduce((s, m) => s + m.quantityKg, 0));
    }, [ledgerQ.data, intake.id, intake.location?.id]);

  const gbProducts = (productsQ.data?.products ?? []).filter((p) => p.stockTracked && p.unit === "KG");

  const i = Number(inputKg) || 0;
  const g = Number(goodKg) || 0;
  const b = Number(gradeBKg) || 0;
  const w = Number(wasteKg) || 0;
  const total = p3(g + b + w);
  const residual = p3(total - i);
  const conservationOk = Math.abs(residual) < 0.0006;
  const remainingOk = i > 0 && i <= remaining + 0.0006;
  const reasonOk = reason.trim().length > 0;
  const valid =
    conservationOk &&
    remainingOk &&
    g >= 0 &&
    b >= 0 &&
    w >= 0 &&
    (g > 0 || b > 0 || w > 0) &&
    reasonOk;

  async function submit() {
    if (busy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ document: SortDocumentDTO; replayed?: boolean }>(
        `/api/stock/intakes/${intake.id}/sort`,
        {
          input_kg: i,
          good_kg: g,
          grade_b_kg: b,
          waste_kg: w,
          grade_b_product_id: gradeBProductId || null,
          reason: reason.trim(),
          business_date: businessDate,
          idempotency_key: submitKey,
        }
      );
      setResult(res.document);
      setSubmitKey(newClientKey); // a fresh key for the next grading event
      await invalidateStockData(qc);
      onPosted?.(res.document);
      toast.show(res.replayed ? t("stock.grading.record-toast-replayed") : t("stock.grading.record-toast-success"), res.replayed ? "info" : "success");
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : t("stock.error-generic");
      setError(msg);
      toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  const yieldPct = i > 0 ? (g / i) * 100 : null;

  return (
    <div className="rounded-2xl bg-united-dark/[0.03] border-2 border-united-green/30 p-3 flex flex-col gap-3">
      {!result ? (
        <>
          <div className="flex items-center justify-between">
            <div className="text-sm font-extrabold text-united-dark" dir={dir}>
              {t("grading.title", { number: intake.receiptNumber, product: localName(intake.product, locale) })}
            </div>
            <span dir="ltr" className="text-xs font-bold text-united-muted">
              {t("grading.remaining", { qty: fmtKg(remaining) })}
            </span>
          </div>

          {ledgerQ.isError && <ErrorState message={errorMessage(ledgerQ.error)} onRetry={() => ledgerQ.refetch()} />}
          {ledgerQ.isSuccess && remaining <= 0 && (
            <p className="text-united-danger font-bold text-sm">{t("grading.nothing-left")}</p>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <QtyField label={t("stock.grading.total-input")} value={inputKg} onChange={setInputKg} hint={t("stock.grading.total-input-hint")} tone={remainingOk || !inputKg ? "" : "danger"} />
            <QtyField label={t("stock.grading.good")} value={goodKg} onChange={setGoodKg} hint={t("stock.grading.good-hint")} tone="good" />
            <QtyField label={t("stock.grading.grade-b")} value={gradeBKg} onChange={setGradeBKg} hint={t("stock.grading.grade-b-hint")} />
            <QtyField label={t("stock.waste")} value={wasteKg} onChange={setWasteKg} hint={t("stock.grading.waste-hint")} tone={Number(wasteKg) > 0 ? "warn" : ""} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex flex-col gap-1 min-w-[180px] flex-1">
              <span className="text-[11px] font-extrabold text-united-muted">{t("stock.grade-b-product-hint")}</span>
              <select className="field" value={gradeBProductId} onChange={(e) => setGradeBProductId(e.target.value)}>
                <option value="">{t("stock.grade-b-same-product")}</option>
                {gbProducts
                  .filter((p) => p.id !== intake.productId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {localName(p, locale)}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-extrabold text-united-muted">{t("stock.date")}</span>
              <input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value || todayLocalISO())} className="field tap-target" />
            </label>
          </div>

          <input
            placeholder={t("stock.grading.reason-placeholder")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="field"
            disabled={busy}
          />

          {/* Live conservation bar — the server is still the hard gate. */}
          <div
            className={`rounded-xl px-3 py-2 text-sm font-extrabold flex items-center justify-between ${
              conservationOk ? "bg-united-green/10 text-united-green" : "bg-united-danger/10 text-united-danger"
            }`}
          >
            <span>
              {t("grading.equation", { total: fmtKg(total), good: fmtKg(g), gradeB: fmtKg(b), waste: fmtKg(w) })}
            </span>
            <span dir="ltr">
              {conservationOk ? t("stock.conservation.equal") : `${t("stock.conservation.diff")} ${fmtKg(residual)}`}
            </span>
          </div>

          {!conservationOk && (
            <p className="text-[11px] font-bold text-united-danger">
              {t("grading.must-balance")}
            </p>
          )}
          {i > remaining && (
            <p className="text-[11px] font-bold text-united-danger">
              {t("grading.over-remaining", { qty: fmtKg(remaining) })}
            </p>
          )}

          {error && <p className="text-united-danger font-bold text-sm">{error}</p>}

          <div className="flex gap-2">
            <button onClick={submit} disabled={busy || !valid} className="btn-primary flex-1 text-sm" data-testid="grading-submit">
              {busy ? t("stock.submit.saving") : t("stock.submit.label")}
            </button>
            <button onClick={onClose} disabled={busy} className="btn-secondary text-sm">
              {t("grading.back")}
            </button>
          </div>
        </>
      ) : (
        <SortResult doc={result} canSeeCosts={canSeeCosts} yieldPct={yieldPct} onClose={onClose} />
      )}
    </div>
  );
}

function SortResult({
  doc,
  canSeeCosts,
  yieldPct,
  onClose,
}: {
  doc: SortDocumentDTO;
  canSeeCosts: boolean;
  yieldPct: number | null;
  onClose: () => void;
}) {
  const { t, dir, locale } = useLocale();
  const p = doc.payload;
  const moved = (kind: string) => doc.movements.filter((m) => m.kind === kind).reduce((s, m) => s + (m.quantityKg ?? 0), 0);
  const fallback = p?.costBasis === "nrv_fallback_proportional";

  const costBasisKey = p?.costBasis ? COST_BASIS_TKEY[p.costBasis] : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-united-green/10 border-2 border-united-green/40 p-3">
        <div className="flex items-center justify-between">
          <span className="font-extrabold text-united-dark text-lg">{t("stock.result.recorded")}</span>
          <span dir="ltr" className="font-bold text-united-muted text-sm">
            {doc.number}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1 mt-2 text-center text-xs font-extrabold">
          <ResultCell label={t("stock.movement.sorting_out_label")} value={fmtKg(moved("sorting_out"))} />
          <ResultCell label={t("stock.grading.good")} value={fmtKg(moved("sorting_in") - 0)} tone="text-united-green" />
          <ResultCell label={t("stock.waste")} value={fmtKg(moved("sorting_in"))} />
          <ResultCell label={t("stock.result.yield")} value={yieldPct == null ? "—" : fmtYield(yieldPct)} />
        </div>
      </div>

      {/* Costing basis from the backend — allocated costs only for valuation users. */}
      {p?.costBasis && (
        <div className={`rounded-xl px-3 py-2 text-sm font-bold ${fallback ? "bg-united-warn/10 text-united-warn" : "bg-united-dark/[0.04] text-united-muted"}`}>
          {t("grading.cost-basis", { basis: costBasisKey ? t(costBasisKey as Parameters<typeof t>[0]) : p.costBasis })}
          {fallback && p.fallbackReason ? t("grading.fallback-reason", { reason: p.fallbackReason }) : ""}
        </div>
      )}
      {canSeeCosts && p?.goodUnitCost != null && (
        <div className="rounded-xl bg-united-dark/[0.04] px-3 py-2 text-xs font-extrabold text-united-dark grid grid-cols-2 gap-1" dir={dir}>
          <span>{t("grading.cost.good", { cost: p.goodUnitCost })}</span>
          {p.gradeBUnitCost != null && <span>{t("grading.cost.grade-b", { cost: p.gradeBUnitCost })}</span>}
          {p.wasteUnitCost != null && <span>{t("grading.cost.waste", { cost: p.wasteUnitCost })}</span>}
          {p.wasteLoss != null && <span>{t("grading.cost.waste-loss", { cost: p.wasteLoss })}</span>}
        </div>
      )}

      <div className="flex flex-col divide-y divide-united-border rounded-xl bg-white overflow-hidden">
        {doc.movements.map((m) => {
          const labelKey = SOURCE_TKEY[m.kind];
          return (
            <div key={m.id} className="flex items-center justify-between px-3 py-2 text-sm font-bold">
              <span>
                {labelKey ? t(labelKey as Parameters<typeof t>[0]) : m.kind} · {m.product ? localName(m.product, locale) : ""}
                {m.location ? ` · ${localName(m.location, locale)}` : ""}
              </span>
              <span dir="ltr" className="font-extrabold">
                {m.quantityKg > 0 ? "+" : ""}
                {fmtKg(m.quantityKg)} {unitLabel(m.product?.unit)}
              </span>
            </div>
          );
        })}
      </div>

      <button onClick={onClose} className="btn-secondary text-sm">
        {t("stock.close")}
      </button>
    </div>
  );
}

function QtyField({
  label,
  value,
  onChange,
  hint,
  tone,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  tone?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-extrabold text-united-muted">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step="0.001"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`tap-target w-full text-center text-lg font-extrabold border-2 rounded-xl focus:border-united-green outline-none bg-white ${
          tone === "danger" ? "border-united-danger/50" : tone === "good" ? "border-united-green/30" : tone === "warn" ? "border-united-warn/50" : "border-united-dark/10"
        }`}
      />
      {hint && <span className="text-[10px] font-bold text-united-muted">{hint}</span>}
    </label>
  );
}

function ResultCell({ label, value, tone = "text-united-dark" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-white/70 py-1.5">
      <div dir="ltr" className={`font-extrabold ${tone}`}>
        {value}
      </div>
      <div className="text-[10px] font-bold text-united-muted">{label}</div>
    </div>
  );
}
