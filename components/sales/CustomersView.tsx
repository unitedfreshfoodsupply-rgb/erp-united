"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import { usePermissions } from "@/lib/use-session";
import { Field, Tabs, fmtMoney } from "@/components/stock/inventory/shared";
import { CreateOrderForm } from "@/components/supervisor/CreateOrderForm";
import { PriceListsView } from "@/components/sales/PriceListsView";
import { QuotationsView } from "@/components/sales/QuotationsView";
import { CustomerStatement, InvoicesView } from "@/components/sales/InvoicesView";
import { Landmark, Star } from "lucide-react";
import { useLocale } from "@/lib/locale";
import { intlLocale } from "@/lib/format";
import { localName, otherLocalName } from "@/lib/locale/names";
import { useDialogs } from "@/components/ui/Dialog";

/**
 * Customer accounts for sales and finance: find a customer, see and edit who they
 * are, how they pay, who to call — and clear the queue of customer names on orders
 * that no account claims yet.
 */

type GroupRef = { id: string; code: string; name: string; nameAr: string | null };
type LegalEntityRef = { id: string; code: string; name: string; nameAr: string | null; taxRegistrationNo: string | null };

type CustomerRow = {
  id: string; code: string; name: string; nameAr: string | null; legalName: string | null; legalNameAr: string | null; type: string; phone: string | null; city: string | null; area: string | null;
  paymentTermsDays: number; creditLimit: string | null; creditHold: boolean; active: boolean; _count: { orders: number };
  groups: GroupRef[]; legalEntity: LegalEntityRef | null;
};
type CustomerDetail = CustomerRow & {
  taxRegistrationNo: string | null; commercialRegNo: string | null; email: string | null; address: string | null; deliveryNotes: string | null;
  externalRef: string | null; notes: string | null; creditHoldReason: string | null; version: number; createdBy: string; priceListId: string | null;
  aliases: { id: string; alias: string; kind: string }[];
  contacts: { id: string; name: string; role: string | null; phone: string | null; email: string | null; isPrimary: boolean; active: boolean; version: number }[];
  recentOrders: { id: string; orderNumber: string; deliveryDate: string; status: string }[];
};

const fail = (toast: ReturnType<typeof useToast>, err: unknown) => toast.show(err instanceof ApiClientError ? err.message : "An error occurred", "error");

export function CustomersView() {
  const { t } = useLocale();
  const [tab, setTab] = useState<"list" | "unmapped" | "new" | "order" | "prices" | "quotations" | "invoices">("list");
  const [openId, setOpenId] = useState<string | null>(null);
  const { can } = usePermissions();
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("customer");
    if (id) setOpenId(id);
  }, []);
  const unmapped = useQuery({
    queryKey: ["sales", "unmapped"],
    queryFn: () => apiFetch<{ names: { customerName: string; orders: number; lastDeliveryDate: string | null }[] }>("/api/sales/customers/unmapped"),
    refetchInterval: 60_000,
  });
  return (
    <div className="page-container">
      <h1 className="page-title">{t("sales.title")}</h1>
      <Tabs
        value={tab}
        onChange={(t) => { setTab(t as typeof tab); setOpenId(null); }}
        items={[
          { key: "list", label: t("sales.tab.all") },
          { key: "unmapped", label: t("sales.tab.unmapped"), badge: unmapped.data?.names.length },
          ...(can("sales.customers.manage") ? [{ key: "new" as const, label: "+" + t("sales.tab.new") }] : []),
          ...(can("sales.quotations.view") ? [{ key: "quotations" as const, label: t("sales.tab.quotations") }] : []),
          ...(can("sales.invoices.view") ? [{ key: "invoices" as const, label: t("sales.tab.invoices") }] : []),
          ...(can("sales.pricing.view") ? [{ key: "prices" as const, label: t("sales.tab.prices-label") }] : []),
          ...(can("orders.create") ? [{ key: "order" as const, label: "+" + t("sales.tab.order") }] : []),
        ]}
      />
      {openId ? (
        <CustomerPanel id={openId} onClose={() => setOpenId(null)} />
      ) : tab === "list" ? (
        <CustomerList onOpen={setOpenId} />
      ) : tab === "invoices" ? (
        <InvoicesView />
      ) : tab === "quotations" ? (
        <QuotationsView />
      ) : tab === "prices" ? (
        <PriceListsView />
      ) : tab === "order" ? (
        <CreateOrderForm onDone={() => setTab("list")} />
      ) : tab === "unmapped" ? (
        <Unmapped names={unmapped.data?.names ?? []} loading={unmapped.isLoading} />
      ) : (
        <NewCustomer onCreated={(id) => { setTab("list"); setOpenId(id); }} />
      )}
    </div>
  );
}

function CustomerList({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, locale } = useLocale();
  const [q, setQ] = useState("");
  const [inactive, setInactive] = useState(false);
  const query = useQuery({
    queryKey: ["sales", "customers", q, inactive],
    queryFn: () => apiFetch<{ customers: CustomerRow[] }>(`/api/sales/customers?q=${encodeURIComponent(q)}${inactive ? "&include_inactive=1" : ""}`),
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input className="field" placeholder={t("sales.placeholder.customer-search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" onClick={() => setInactive(!inactive)} aria-pressed={inactive} className="chip">{t("ui.inactive")}</button>
      </div>
      {query.isLoading && <LoadingState />}
      {query.isError && <ErrorState message={errorMessage(query.error)} onRetry={() => query.refetch()} />}
      {query.data && query.data.customers.length === 0 && <EmptyState icon="🏨" title={t("sales.empty.no-customers")} />}
      <ul className="grid gap-2 sm:grid-cols-2">
        {query.data?.customers.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onOpen(c.id)} className={`card p-4 w-full text-start flex flex-col gap-1 ${c.active ? "" : "opacity-60"}`}>
              <div className="flex justify-between gap-2">
                <span className="font-extrabold">{localName(c, locale)}</span>
                <span className="text-xs font-bold text-united-muted" dir="ltr">{c.code}</span>
              </div>
              <div className="flex flex-wrap gap-2 text-xs font-bold text-united-muted">
                <span>{t(`sales.type.${c.type}`) ?? c.type}</span>
                {c.area || c.city ? <span>· {[c.area, c.city].filter(Boolean).join(locale === "en" ? ", " : "، ")}</span> : null}
                <span>· {c.paymentTermsDays ? `${t("sales.label.payment-terms-prefix")}${c.paymentTermsDays} ${t("sales.label.day")}` : t("sales.label.payment-cash")}</span>
                <span>· {c._count.orders} {t("sales.label.orders")}</span>
                {c.creditHold && <span className="text-united-danger">· {t("sales.label.on-hold")}</span>}
                {!c.active && <span className="text-united-danger">· {t("sales.label.inactive")}</span>}
              </div>
              {(c.groups.length > 0 || c.legalEntity) && (
                <div className="flex flex-wrap gap-1.5">
                  {c.groups.map((g) => <span key={g.id} className="rounded-lg bg-united-dark/5 px-2 py-0.5 text-[11px] font-extrabold text-united-dark" dir="ltr">{g.code}</span>)}
                  {c.legalEntity && <span className="rounded-lg bg-united-green/10 px-2 py-0.5 text-[11px] font-extrabold text-united-green" title={t("sales.customer.legal-entity")}><Landmark size={12} className="me-1 inline" aria-hidden />{localName(c.legalEntity, locale)}</span>}
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type FormState = Record<string, string>;
// label is used as a key into the dictionary via t()
const FIELDS: [string, string, string?][] = [
  ["name", "sales.customer.name"], ["name_ar", "sales.customer.nameAr"], ["legal_name", "sales.customer.legal-name", "ltr"], ["legal_name_ar", "sales.customer.legal-name-ar"],
  ["phone", "sales.customer.phone", "ltr"], ["email", "sales.customer.email", "ltr"],
  ["city", "sales.customer.city"], ["area", "sales.customer.area"], ["address", "sales.customer.address"], ["tax_registration_no", "sales.customer.tax", "ltr"],
  ["commercial_reg_no", "sales.customer.commercial-reg", "ltr"], ["external_ref", "sales.customer.ext-ref", "ltr"], ["delivery_notes", "sales.customer.delivery-notes"],
];

function CustomerForm({ initial, onSubmit, submitLabel }: { initial: FormState; onSubmit: (f: FormState) => Promise<void>; submitLabel: string }) {
  const { t } = useLocale();
  const [f, setF] = useState<FormState>(initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid grid-cols-1 sm:grid-cols-2 gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await onSubmit(f); } finally { setBusy(false); }
      }}
    >
      {FIELDS.map(([k, label, dir]) => (
        <Field key={k} label={t(label)}>
          <input className="field" dir={dir} value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        </Field>
      ))}
      <Field label={t("sales.customer.type")}>
        <select className="field font-bold" value={f.type ?? "other"} onChange={(e) => setF({ ...f, type: e.target.value })}>
          {Object.entries(customerTypeLabels(t)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <button className="btn-primary sm:col-span-2" disabled={busy}>{busy ? t("sales.form.saving") : submitLabel}</button>
    </form>
  );
}

const CUSTOMER_TYPE_KEYS = ["hotel", "restaurant", "cafe", "retail", "wholesale", "institution", "other"] as const;
function customerTypeLabels(t: (key: string) => string): Record<string, string> {
  return Object.fromEntries(CUSTOMER_TYPE_KEYS.map((k) => [k, t(`sales.type.${k}`)]));
}

function NewCustomer({ onCreated }: { onCreated: (id: string) => void }) {
  const { t } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <section className="card p-4">
      <CustomerForm
        initial={{ type: "other" }}
        submitLabel={t("sales.action.created")}
        onSubmit={async (f) => {
          try {
            const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim() !== ""));
            const { customer } = await apiPost<{ customer: { id: string; code: string } }>("/api/sales/customers", body);
            void qc.invalidateQueries({ queryKey: ["sales"] });
            toast.show(`${t("sales.toast.added")} ${customer.code}`, "success");
            onCreated(customer.id);
          } catch (err) { fail(toast, err); }
        }}
      />
    </section>
  );
}

function CustomerPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = usePermissions();
  const { locale, t } = useLocale();
  // t() returns the key itself when it is missing, so fall back to the raw action
  // explicitly instead of with ??, which never fired.
  const actionLabel = (action: string) => {
    const key = `sales.action.${action.replace("-", "_")}`;
    const label = t(key);
    return label === key ? action : label;
  };
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ["sales", "customer", id], queryFn: () => apiFetch<{ customer: CustomerDetail }>(`/api/sales/customers/${id}`) });
  const history = useQuery({ queryKey: ["sales", "customer", id, "history"], queryFn: () => apiFetch<{ logs: { id: string; action: string; userName: string; timestamp: string; fieldChanged: string | null; oldValue: string | null; newValue: string | null; reason: string | null }[] }>(`/api/sales/customers/${id}/history`) });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const c = q.data.customer;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["sales"] });
  const canManage = can("sales.customers.manage");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-extrabold">{localName(c, locale)}</h2>
          <p className="text-xs font-bold text-united-muted" dir="ltr">{c.code}{c.taxRegistrationNo ? ` · TAX ${c.taxRegistrationNo}` : ""}</p>
        </div>
        <button type="button" className="btn-secondary" onClick={onClose}>{t("ui.back")}</button>
      </div>

      <section className="card p-4 flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <h3 className="font-extrabold">{t("sales.section.data")}</h3>
          {canManage && <button type="button" className="text-sm font-extrabold text-united-green underline" onClick={() => setEditing(!editing)}>{editing ? t("ui.cancel") : t("ui.edit")}</button>}
        </div>
        {editing ? (
          <CustomerForm
            initial={{
              name: c.name, name_ar: c.nameAr ?? "", legal_name: c.legalName ?? "", legal_name_ar: c.legalNameAr ?? "",
              phone: c.phone ?? "", email: c.email ?? "", city: c.city ?? "", area: c.area ?? "", address: c.address ?? "",
              tax_registration_no: c.taxRegistrationNo ?? "", commercial_reg_no: c.commercialRegNo ?? "", external_ref: c.externalRef ?? "", delivery_notes: c.deliveryNotes ?? "", type: c.type,
            }}
            submitLabel={t("ui.save")}
            onSubmit={async (f) => {
              try {
                await apiPatch(`/api/sales/customers/${id}`, { ...f, expected_version: c.version });
                refresh();
                setEditing(false);
                toast.show(t("sales.toast.saved"), "success");
              } catch (err) { fail(toast, err); }
            }}
          />
        ) : (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            {[[t("sales.customer.type"), (customerTypeLabels(t))[c.type] || c.type], [t("sales.customer.legal-name"), c.legalName], [t("sales.customer.nameAr"), c.legalNameAr], [t("sales.customer.phone"), c.phone], [t("sales.customer.email"), c.email], [t("sales.customer.address"), [c.address, c.area, c.city].filter(Boolean).join(locale === "en" ? ", " : "، ")], [t("sales.customer.delivery-notes"), c.deliveryNotes], [t("sales.customer.ext-ref"), c.externalRef]].map(([k, v]) => (
              <div key={String(k)}><dt className="text-xs font-extrabold text-united-muted">{k}</dt><dd className="font-bold">{v || "—"}</dd></div>
            ))}
          </dl>
        )}
        {canManage && (
          <button
            type="button"
            className={c.active ? "btn-danger self-start" : "btn-secondary self-start"}
            onClick={async () => {
              try { await apiPatch(`/api/sales/customers/${id}`, { active: !c.active, expected_version: c.version }); refresh(); } catch (err) { fail(toast, err); }
            }}
          >
            {c.active ? t("sales.button.hold-customer") : t("sales.button.activate-customer")}
          </button>
        )}
      </section>

      <GroupLegalSection c={c} canEdit={canManage} onSaved={refresh} />

      <CreditSection c={c} canEdit={can("sales.credit.manage")} onSaved={refresh} />

      {can("sales.invoices.view") && <CustomerStatement customerId={c.id} />}

      {can("sales.pricing.view") && <CustomerPriceList c={c} canEdit={can("sales.pricing.manage")} onSaved={refresh} />}

      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("sales.aliases-known")}</h3>
        <ul className="flex flex-wrap gap-2">
          {c.aliases.map((a) => (
            <li key={a.id} className="rounded-xl bg-united-dark/5 px-3 py-2 text-sm font-bold flex items-center gap-2">
              {a.alias}
              {a.kind === "manual" && canManage && (
                <button type="button" aria-label={t("ui.delete")} className="text-united-danger font-extrabold" onClick={async () => {
                  try { await apiFetch(`/api/sales/customers/aliases/${a.id}`, { method: "DELETE" }); refresh(); } catch (err) { fail(toast, err); }
                }}>×</button>
              )}
            </li>
          ))}
        </ul>
        {canManage && <AddAlias id={id} onDone={refresh} />}
      </section>

      <Contacts c={c} canEdit={canManage} onSaved={refresh} />

      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("heading-recent-orders")}</h3>
        {c.recentOrders.length === 0 && <p className="text-sm font-bold text-united-muted">{t("empty-recent-orders")}</p>}
        {c.recentOrders.map((o) => (
          <Link key={o.id} href={`/orders/${o.id}`} className="flex justify-between text-sm font-bold py-1 border-b border-united-dark/5">
            <span dir="ltr">{o.orderNumber}</span><span>{o.deliveryDate}</span>
          </Link>
        ))}
      </section>

      <section className="card p-4 flex flex-col gap-2">
        <h3 className="font-extrabold">{t("heading-audit-log")}</h3>
        <ul className="text-sm flex flex-col gap-1">
          {history.data?.logs.map((l) => (
            <li key={l.id} className="border-b border-united-dark/5 py-1">
              <span className="font-bold">{l.userName}</span> · {actionLabel(l.action)}{l.fieldChanged && FIELD_LABEL[l.fieldChanged] ? ` · ${t(FIELD_LABEL[l.fieldChanged])}` : ""}{l.newValue ? `: ${l.oldValue ?? "—"} ← ${l.newValue}` : ""}
              {l.reason ? <span className="text-united-muted"> ({l.reason})</span> : null}
              <span className="text-xs text-united-muted"> · {new Date(l.timestamp).toLocaleString(intlLocale(locale), { dateStyle: "short", timeStyle: "short" })}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// Audit field names shown in the customer history, as dictionary keys.
const FIELD_LABEL: Record<string, string> = {
  name: "sales.field.name",
  nameAr: "sales.field.nameAr",
  phone: "sales.field.phone",
  email: "sales.field.email",
  type: "sales.field.type",
  city: "sales.field.city",
  area: "sales.field.area",
  address: "sales.field.address",
  taxRegistrationNo: "sales.field.taxRegistrationNo",
  externalRef: "sales.field.externalRef",
  active: "sales.field.active",
  paymentTermsDays: "sales.field.paymentTermsDays",
  creditLimit: "sales.field.creditLimit",
  creditHold: "sales.field.creditHold",
};

function GroupLegalSection({ c, canEdit, onSaved }: { c: CustomerDetail; canEdit: boolean; onSaved: () => void }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const groups = useQuery({ queryKey: ["sales", "customer-groups"], queryFn: () => apiFetch<{ groups: (GroupRef & { hotels: number })[] }>("/api/sales/customer-groups") });
  const legalEntities = useQuery({ queryKey: ["sales", "legal-entities"], queryFn: () => apiFetch<{ legalEntities: (LegalEntityRef & { hotels: number })[] }>("/api/sales/legal-entities") });
  const [selected, setSelected] = useState<Set<string>>(new Set(c.groups.map((g) => g.id)));
  const [legalId, setLegalId] = useState<string>(c.legalEntity?.id ?? "");
  if (!editing) {
    return (
      <section className="card p-4 flex flex-col gap-2">
        <div className="flex justify-between items-center">
          <h3 className="font-extrabold">{t("sales.section.group-legal")}</h3>
          {canEdit && <button type="button" className="text-sm font-extrabold text-united-green underline" onClick={() => { setSelected(new Set(c.groups.map((g) => g.id))); setLegalId(c.legalEntity?.id ?? ""); setEditing(true); }}>{t("ui.edit")}</button>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {c.groups.map((g) => <span key={g.id} className="rounded-lg bg-united-dark/5 px-2 py-0.5 text-xs font-extrabold" dir="auto">{localName(g, locale)}</span>)}
          {c.groups.length === 0 && <span className="text-sm font-bold text-united-muted">—</span>}
        </div>
        {c.legalEntity ? (
          <div className="text-sm font-bold flex flex-col gap-0.5">
            <span className="text-united-green"><Landmark size={14} className="me-1 inline" aria-label={t("sales.customer.legal-entity")} />{localName(c.legalEntity, locale)}{otherLocalName(c.legalEntity, locale) ? ` · ${otherLocalName(c.legalEntity, locale)}` : ""}</span>
            <span className="text-united-muted text-xs" dir="ltr">{c.legalEntity.code}{c.legalEntity.taxRegistrationNo ? ` · TAX ${c.legalEntity.taxRegistrationNo}` : ` · ${t("sales.legal-no-tax")}`}</span>
          </div>
        ) : (
          <p className="text-sm font-bold text-united-muted">{c.taxRegistrationNo ? `${t("sales.invoice-by-hotel")} ${c.taxRegistrationNo}` : t("sales.legal-entity.none")}</p>
        )}
      </section>
    );
  }
  return (
    <section className="card p-4 flex flex-col gap-3">
      <div className="flex justify-between items-center">
        <h3 className="font-extrabold">{t("sales.section.group-legal")}</h3>
        <button type="button" className="text-sm font-extrabold text-united-muted underline" onClick={() => setEditing(false)}>{t("ui.cancel")}</button>
      </div>
      {(groups.data?.groups ?? []).length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-extrabold text-united-muted">{t("sales.group-label")}</span>
          <div className="flex flex-wrap gap-2">
            {(groups.data?.groups ?? []).map((g) => (
              <label key={g.id} className="tap-target flex items-center gap-1.5 rounded-lg bg-united-dark/5 px-3 py-1.5 text-sm font-extrabold">
                <input type="checkbox" className="w-5 h-5" checked={selected.has(g.id)} onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(g.id); else next.delete(g.id); setSelected(next); }} />
                <span dir="auto">{localName(g, locale)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-extrabold text-united-muted">{t("sales.legal-entity-label")}</span>
        <select className="field font-bold" value={legalId} onChange={(e) => setLegalId(e.target.value)}>
          <option value="">{t("sales.option.no-entity")}</option>
          {(legalEntities.data?.legalEntities ?? []).map((l) => <option key={l.id} value={l.id}>{localName(l, locale)}{l.taxRegistrationNo ? ` (TAX ${l.taxRegistrationNo})` : ` (${t("sales.option.no-tax")})`}</option>)}
        </select>
      </div>
      <button
        type="button"
        className="btn-primary self-start"
        onClick={async () => {
          try {
            await apiPatch(`/api/sales/customers/${c.id}`, { group_ids: [...selected], legal_entity_id: legalId || null, expected_version: c.version });
            onSaved();
            setEditing(false);
            toast.show(t("sales.toast.saved"), "success");
          } catch (err) { fail(toast, err); }
        }}
      >{t("sales.button.save-link")}</button>
    </section>
  );
}

function CreditSection({ c, canEdit, onSaved }: { c: CustomerDetail; canEdit: boolean; onSaved: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const [f, setF] = useState({ terms: String(c.paymentTermsDays), limit: c.creditLimit ?? "", hold: c.creditHold, holdReason: c.creditHoldReason ?? "", reason: "" });
  return (
    <section className={`card p-4 flex flex-col gap-3 ${c.creditHold ? "border-2 border-united-danger/40" : ""}`}>
      <h3 className="font-extrabold">{t("sales.credit-heading")}</h3>
      <div className="grid grid-cols-3 gap-2 text-center text-sm font-bold">
        <div className="rounded-xl bg-united-dark/[0.03] p-2"><div className="text-xs text-united-muted">{t("sales.customer.credit-terms")}</div>{c.paymentTermsDays ? `${c.paymentTermsDays} ${t("sales.label.day")}` : t("sales.label.payment-cash")}</div>
        <div className="rounded-xl bg-united-dark/[0.03] p-2"><div className="text-xs text-united-muted">{t("sales.customer.credit-limit")}</div><span dir="ltr">{c.creditLimit === null ? t("sales.credit-not-set") : fmtMoney(c.creditLimit)}</span></div>
        <div className="rounded-xl bg-united-dark/[0.03] p-2"><div className="text-xs text-united-muted">{t("sales.exposure")}</div>{c.creditHold ? <span className="text-united-danger">{t("sales.label.on-hold")}: {c.creditHoldReason}</span> : t("sales.credit-working")}</div>
      </div>
      <Exposure id={c.id} />
      {canEdit && (
        <form
          className="grid grid-cols-2 gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await apiPatch(`/api/sales/customers/${c.id}/credit`, {
                payment_terms_days: Number(f.terms || 0),
                credit_limit: f.limit.trim() === "" ? null : f.limit.trim(),
                credit_hold: f.hold,
                credit_hold_reason: f.hold ? f.holdReason : null,
                reason: f.reason,
                expected_version: c.version,
              });
              onSaved();
              toast.show(t("sales.toast.saved"), "success");
            } catch (err) { fail(toast, err); }
          }}
        >
          <Field label={t("sales.credit-terms-field")}><input className="field" inputMode="numeric" dir="ltr" value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} /></Field>
          <Field label={t("sales.credit-limit-field")}><input className="field" inputMode="decimal" dir="ltr" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} /></Field>
          <label className="tap-target flex items-center gap-2 font-extrabold"><input type="checkbox" className="w-6 h-6" checked={f.hold} onChange={(e) => setF({ ...f, hold: e.target.checked })} />{t("sales.holding-toggle")}</label>
          {f.hold && <input className="field" placeholder={t("sales.customer.credit-hold-reason")} value={f.holdReason} onChange={(e) => setF({ ...f, holdReason: e.target.value })} />}
          <input className="field col-span-2" placeholder={t("sales.field.reason")} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <button className="btn-primary col-span-2">{t("sales.update-credit-button")}</button>
        </form>
      )}
    </section>
  );
}

function CustomerPriceList({ c, canEdit, onSaved }: { c: CustomerDetail; canEdit: boolean; onSaved: () => void }) {
  const dialogs = useDialogs();
  const { t } = useLocale();
  const toast = useToast();
  const lists = useQuery({ queryKey: ["sales", "price-lists"], queryFn: () => apiFetch<{ priceLists: { id: string; name: string; isDefault: boolean; active: boolean }[] }>("/api/sales/price-lists") });
  const current = lists.data?.priceLists.find((l) => l.id === c.priceListId);
  return (
    <section className="card p-4 flex flex-col gap-2">
      <h3 className="font-extrabold">{t("sales.price-list")}</h3>
      {canEdit ? (
        <select
          className="field font-bold"
          value={c.priceListId ?? ""}
          onChange={async (e) => {
            const value = e.target.value;
            const reason = await dialogs.prompt({ title: t("sales.placeholder.price-list-reason"), label: t("ui.reason-label"), required: true, multiline: true });
            if (!reason) return;
            try {
              await apiPatch(`/api/sales/customers/${c.id}/price-list`, { price_list_id: value || null, reason });
              onSaved();
            } catch (err) { fail(toast, err); }
          }}
        >
          <option value="">{t("sales.default-price-list")}</option>
          {(lists.data?.priceLists ?? []).filter((l) => l.active && !l.isDefault).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      ) : (
        <p className="font-bold">{current?.name ?? t("sales.default-price-list")}</p>
      )}
      <p className="text-xs font-bold text-united-muted">{t("sales.info.unpriced-default")}</p>
    </section>
  );
}

function Exposure({ id }: { id: string }) {
  const { t } = useLocale();
  const q = useQuery({ queryKey: ["sales", "customer", id, "exposure"], queryFn: () => apiFetch<{ openOrders: string; receivable: string; exposure: string; available: string | null; unpricedLines: number }>(`/api/sales/customers/${id}/exposure`) });
  if (!q.data) return null;
  const e = q.data;
  return (
    <div className="flex flex-wrap gap-3 text-sm font-bold">
      <span>{t("sales.exposure.open-orders")}: <span dir="ltr">{fmtMoney(e.openOrders)}</span></span>
      <span>{t("sales.exposure.receivable")}: <span dir="ltr">{fmtMoney(e.receivable)}</span></span>
      <span className={e.available !== null && Number(e.available) < 0 ? "text-united-danger" : "text-united-green"}>{t("sales.exposure.available")}: <span dir="ltr">{e.available === null ? "—" : fmtMoney(e.available)}</span></span>
      {e.unpricedLines > 0 && <span className="text-united-warn">{e.unpricedLines} {t("sales.exposure.unpriced")}</span>}
    </div>
  );
}

function AddAlias({ id, onDone }: { id: string; onDone: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const [alias, setAlias] = useState("");
  return (
    <form className="flex gap-2" onSubmit={async (e) => {
      e.preventDefault();
      try { await apiPost(`/api/sales/customers/${id}/aliases`, { alias }); setAlias(""); onDone(); } catch (err) { fail(toast, err); }
    }}>
      <input className="field" placeholder={t("sales.placeholder.alias")} value={alias} onChange={(e) => setAlias(e.target.value)} />
      <button className="btn-secondary shrink-0">{t("ui.create")}</button>
    </form>
  );
}

function Contacts({ c, canEdit, onSaved }: { c: CustomerDetail; canEdit: boolean; onSaved: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const [f, setF] = useState({ name: "", role: "", phone: "", primary: false });
  return (
    <section className="card p-4 flex flex-col gap-2">
      <h3 className="font-extrabold">{t("contacts-heading")}</h3>
      {c.contacts.filter((x) => x.active).map((x) => (
        <div key={x.id} className="flex justify-between text-sm font-bold border-b border-united-dark/5 py-1">
          <span>{x.name}{x.role ? ` · ${x.role}` : ""}{x.isPrimary && <Star size={14} className="ms-1 inline fill-current text-[#E2A33B]" aria-hidden />}</span>
          <a dir="ltr" href={x.phone ? `tel:${x.phone}` : undefined} className="text-united-green">{x.phone ?? ""}</a>
        </div>
      ))}
      {canEdit && (
        <form className="grid grid-cols-2 gap-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            await apiPost(`/api/sales/customers/${c.id}/contacts`, { name: f.name, role: f.role || null, phone: f.phone || null, is_primary: f.primary });
            setF({ name: "", role: "", phone: "", primary: false });
            onSaved();
          } catch (err) { fail(toast, err); }
        }}>
          <input className="field" placeholder={t("placeholder-contact-name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="field" placeholder={t("placeholder-contact-role")} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />
          <input className="field" dir="ltr" placeholder={t("placeholder-contact-phone")} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <label className="flex items-center gap-2 font-bold"><input type="checkbox" className="w-6 h-6" checked={f.primary} onChange={(e) => setF({ ...f, primary: e.target.checked })} />{t("label-primary")}</label>
          <button className="btn-secondary col-span-2">{t("button-add-contact")}</button>
        </form>
      )}
    </section>
  );
}

function Unmapped({ names, loading }: { names: { customerName: string; orders: number; lastDeliveryDate: string | null }[]; loading: boolean }) {
  const { can } = usePermissions();
  const { t, locale } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const customers = useQuery({ queryKey: ["sales", "customers", "", false], queryFn: () => apiFetch<{ customers: CustomerRow[] }>("/api/sales/customers?q=") });
  const [choice, setChoice] = useState<Record<string, string>>({});
  if (loading) return <LoadingState />;
  if (names.length === 0) return <EmptyState icon="✅" title={t("sales.empty.all-mapped")} />;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-bold text-united-muted">{t("sales.heading.unmapped-desc")}</p>
      {names.map((n) => (
        <div key={n.customerName} className="card p-3 flex flex-col sm:flex-row gap-2 sm:items-center">
          <div className="flex-1">
            <div className="font-extrabold">{n.customerName}</div>
            <div className="text-xs font-bold text-united-muted">{n.orders} {t("sales.label.orders")} · {t("sales.unmapped.last-delivery", { date: n.lastDeliveryDate ?? "—" })}</div>
          </div>
          {can("sales.customers.manage") && (
            <div className="flex gap-2">
              <select className="field font-bold" value={choice[n.customerName] ?? ""} onChange={(e) => setChoice({ ...choice, [n.customerName]: e.target.value })}>
                <option value="">{t("sales.select.placeholder")}</option>
                {(customers.data?.customers ?? []).map((c) => <option key={c.id} value={c.id}>{localName(c, locale)}</option>)}
              </select>
              <button type="button" className="btn-primary shrink-0" disabled={!choice[n.customerName]} onClick={async () => {
                try {
                  const r = await apiPost<{ ordersLinked: number }>("/api/sales/customers/map", { customer_name: n.customerName, customer_id: choice[n.customerName] });
                  toast.show(`${t("sales.toast.linked")} ${r.ordersLinked} ${t("sales.label.orders")}`, "success");
                  void qc.invalidateQueries({ queryKey: ["sales"] });
                } catch (err) { fail(toast, err); }
              }}>{t("sales.button.link")}</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
