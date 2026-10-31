"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";

export type CashAccountOption = { id: string; code: string; name: string; nameAr: string | null; type: "cash" | "bank"; active: boolean; balance?: string };

/** The active cash boxes and bank accounts, as every money form offers them (one query, shared cache). */
export function useCashAccounts() {
  return useQuery({ queryKey: ["cash-accounts"], queryFn: () => apiFetch<{ cashAccounts: CashAccountOption[] }>("/api/accounting/cash-accounts").then((r) => r.cashAccounts), staleTime: 60_000 });
}

/**
 * A select of the active cash boxes and bank accounts — never a hard-coded pair, so a box
 * or bank added in Treasury is usable everywhere money moves. `only` narrows to one type.
 */
export function CashAccountSelect({ value, onChange, only, className = "field", id, ariaLabel }: { value: string; onChange: (id: string) => void; only?: "cash" | "bank"; className?: string; id?: string; ariaLabel?: string }) {
  const { t, locale } = useLocale();
  const q = useCashAccounts();
  const rows = (q.data ?? []).filter((r) => r.active && (!only || r.type === only));
  const known = rows.some((r) => r.id === value);
  return (
    <select id={id} aria-label={ariaLabel} className={className} value={value} onChange={(e) => onChange(e.target.value)} disabled={q.isLoading}>
      {!known && <option value={value} disabled>{q.isLoading ? t("ui.loading") : t("treasury.choose-account")}</option>}
      {(["cash", "bank"] as const).filter((type) => rows.some((r) => r.type === type)).map((type) => (
        <optgroup key={type} label={t(type === "cash" ? "treasury.type.cash-plural" : "treasury.type.bank-plural")}>
          {rows.filter((r) => r.type === type).map((r) => <option key={r.id} value={r.id}>{localName(r, locale)}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
