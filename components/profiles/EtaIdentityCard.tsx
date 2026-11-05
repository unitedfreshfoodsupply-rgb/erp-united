"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import type { TranslationKey } from "@/lib/locale/dictionary";
import { Field } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";

/**
 * The customer's tax and e-invoice identity, on the customer's own page (Nov 2026): the one
 * place it is edited. It lives on the customer's linked legal entity; the ETA screen and every
 * new invoice read it from there. Issued invoices and signed ETA documents keep their copy.
 */

type Address = { country: string | null; governate: string | null; regionCity: string | null; street: string | null; buildingNumber: string | null; postalCode: string | null; floor: string | null; room: string | null; landmark: string | null; additionalInformation: string | null };
type Identity = {
  customer: { id: string; code: string; taxRegistrationNo: string | null };
  legalEntity: (Address & { id: string; code: string; name: string; nameAr: string | null; taxRegistrationNo: string | null; receiverType: string | null; receiverId: string | null; version: number }) | null;
  receiver: { type: string | null; personalId: string | null; address: Address; origin: "legal_entity" | "eta_profile_legacy" | "none" };
  effectiveType: "B" | "P" | "F";
  taxId: string | null;
  gaps: string[];
  personIdOnlyAbove: boolean;
  canEdit: boolean;
};

// Form field → API input key → label. The first five are the ones ETA requires for a company.
const FIELDS: [keyof Address, string, TranslationKey][] = [
  ["country", "country", "eta.field.country"],
  ["governate", "governate", "eta.field.governorate"],
  ["regionCity", "region_city", "eta.field.city-region"],
  ["street", "street", "eta.field.street"],
  ["buildingNumber", "building_number", "eta.field.building-number"],
  ["postalCode", "postal_code", "eta.field.postal-code"],
  ["floor", "floor", "eta.field.floor"],
  ["room", "room", "eta.field.room"],
  ["landmark", "landmark", "eta.field.landmark"],
  ["additionalInformation", "additional_information", "eta.field.additional-information"],
];
const GAP_LABEL: Record<string, TranslationKey> = {
  tax_registration_no: "eta.gap.tax_registration_no", legal_entity: "eta.gap.legal_entity", receiver_id: "eta.gap.receiver_id",
  ...Object.fromEntries(FIELDS.map(([k, , label]) => [k, label])),
};
const TYPE_LABEL: Record<string, TranslationKey> = { B: "eta.receiver-company", P: "eta.receiver-person", F: "eta.receiver-foreign" };

export function EtaIdentityCard({ customerId }: { customerId: string }) {
  const { t } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const key = ["sales", "customer", customerId, "eta-identity"];
  const q = useQuery({ queryKey: key, queryFn: () => apiFetch<Identity>(`/api/sales/customers/${customerId}/eta-identity`) });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => {
      const le = q.data?.legalEntity;
      return le
        ? apiFetch(`/api/sales/legal-entities/${le.id}`, { method: "PATCH", body: JSON.stringify({ ...body, expected_version: le.version }) })
        : apiFetch(`/api/sales/customers/${customerId}/eta-identity`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      setEditing(false);
      toast.show(t("customer.eta.saved"), "success");
      void qc.invalidateQueries({ queryKey: ["sales", "customer", customerId] });
      void qc.invalidateQueries({ queryKey: ["eta"] });
    },
    onError: (err) => toast.show(errorMessage(err) ?? "error.generic", "error"),
  });
  if (q.isLoading || !q.data) return null;
  const d = q.data;
  const le = d.legalEntity;
  const start = () => {
    const src = le ?? d.receiver.address;
    setForm({
      receiver_type: le?.receiverType ?? "", receiver_id: le?.receiverId ?? d.receiver.personalId ?? "",
      // A customer with no legal entity yet: offer what the retired ETA-screen copy held, so it is not retyped.
      ...Object.fromEntries(FIELDS.map(([k, input]) => [input, (src as Address)[k] ?? ""])),
    });
    setEditing(true);
  };
  const submit = () => {
    const body: Record<string, unknown> = { receiver_type: form.receiver_type || null, receiver_id: form.receiver_id || null };
    for (const [, input] of FIELDS) body[input] = form[input] || null;
    save.mutate(body);
  };
  const shown = le ?? d.receiver.address;
  return (
    <section id="eta-identity" className="card mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-bold">{t("customer.eta.title")}</h2>
          <p className="text-xs text-united-muted max-w-2xl">{t("customer.eta.hint")}</p>
        </div>
        {d.canEdit && !editing && <button type="button" className="btn-secondary" onClick={start}>{le ? t("customer.eta.edit") : t("customer.eta.create")}</button>}
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
        <div><dt className="text-xs text-united-muted">{t("customer.eta.legal-entity")}</dt><dd>{le ? <><span dir="ltr">{le.code}</span> · {le.name}</> : t("customer.eta.no-legal-entity")}</dd></div>
        <div><dt className="text-xs text-united-muted">{t("eta.receiver-tax-reg-number")}</dt><dd dir="ltr">{d.taxId ?? "—"}</dd></div>
        <div><dt className="text-xs text-united-muted">{t("eta.receiver-type")}</dt><dd>{t(TYPE_LABEL[d.effectiveType])}{d.receiver.type ? "" : ` · ${t("eta.receiver-auto", { derived: d.effectiveType })}`}</dd></div>
        <div><dt className="text-xs text-united-muted">{t("eta.receiver-national-id")}</dt><dd dir="ltr">{d.receiver.personalId ?? "—"}</dd></div>
        {FIELDS.map(([k, , label]) => <div key={k}><dt className="text-xs text-united-muted">{t(label)}</dt><dd>{(shown as Address)[k] ?? "—"}</dd></div>)}
      </dl>
      {d.gaps.length > 0
        ? <p className="text-sm text-united-danger" role="status">{t("eta.receiver-missing", { fields: d.gaps.map((g) => t(GAP_LABEL[g] ?? ("eta.receiver-type" as TranslationKey))).join("، ") })}</p>
        : <p className="text-sm text-united-green" role="status">✓ {t("eta.receiver-complete")}</p>}
      {d.personIdOnlyAbove && <p className="text-xs text-united-muted">{t("eta.receiver-person-id-above")}</p>}
      {d.receiver.origin === "eta_profile_legacy" && <p className="text-xs text-united-warn">{t("eta.receiver-source.eta_profile_legacy")}</p>}
      {!d.canEdit && d.gaps.length > 0 && <p className="text-xs text-united-muted">{t("eta.receiver-ask-sales")}</p>}
      {editing && (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {!le && <p className="text-xs text-united-muted">{t("customer.eta.create-hint")}</p>}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Field label={t("eta.receiver-type")}>
              <select className="field" value={form.receiver_type} onChange={(e) => setForm({ ...form, receiver_type: e.target.value })}>
                <option value="">{t("eta.receiver-auto", { derived: d.taxId ? "B" : "P" })}</option>
                <option value="B">{t("eta.receiver-company")}</option><option value="P">{t("eta.receiver-person")}</option><option value="F">{t("eta.receiver-foreign")}</option>
              </select>
            </Field>
            <Field label={t("eta.receiver-national-id")}><input className="field" dir="ltr" value={form.receiver_id} onChange={(e) => setForm({ ...form, receiver_id: e.target.value })} /></Field>
            {FIELDS.map(([, input, label]) => <Field key={input} label={t(label)}><input className="field" value={form[input] ?? ""} onChange={(e) => setForm({ ...form, [input]: e.target.value })} /></Field>)}
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={save.isPending}>{t("customer.eta.save")}</button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>{t("customer.eta.cancel")}</button>
          </div>
        </form>
      )}
    </section>
  );
}
