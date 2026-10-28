"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, type Locale } from "@/lib/locale";
import { intlLocale } from "@/lib/format";
import { apiFetch, apiPatch, apiPost, ApiClientError, errorMessage } from "@/lib/api-client";
import { LoadingState, ErrorState, EmptyState } from "@/components/States";
import { useToast } from "@/components/ui/Toast";
import {
  STORAGE_LOCATION_TYPES,
  storageLocationTypeLabel,
  UOM_CATEGORIES,
  UOM_CATEGORY_LABEL,
  type UomCategory,
} from "@/lib/core/reference-data";
import type {
  BranchDTO,
  CompanyDTO,
  CurrencyDTO,
  MasterDataDTO,
  StorageLocationDTO,
  UomDTO,
  WarehouseDTO,
} from "@/lib/master-client-types";
import { localName } from "@/lib/locale/names";

/**
 * Organisation master data: the company, its branches, warehouses and storage
 * locations, plus units of measure and currencies. Codes are fixed once created (they
 * end up on documents); everything else is editable, versioned and audited server-side.
 * Nothing is deleted — rows are deactivated.
 */

type Entity = "companies" | "branches" | "warehouses" | "locations" | "uoms" | "currencies";

type Field = {
  key: string;
  label: string;
  kind?: "text" | "number" | "select";
  options?: { value: string; label: string }[];
  ltr?: boolean;
  /** Shown on create only (codes, parents, categories — fixed afterwards). */
  createOnly?: boolean;
  required?: boolean;
  hint?: string;
};

export function MasterDataPanel({ canManage }: { canManage: boolean }) {
  const q = useQuery({
    queryKey: ["admin", "master"],
    queryFn: () => apiFetch<MasterDataDTO>("/api/admin/master"),
  });

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const data = q.data!;

  return (
    <div className="flex flex-col gap-4">
      {data.companies.map((c) => (
        <CompanySection key={c.id} company={c} currencies={data.currencies} canManage={canManage} />
      ))}
      <UomSection uoms={data.uoms} canManage={canManage} />
      <CurrencySection currencies={data.currencies} canManage={canManage} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Organisation tree
// ---------------------------------------------------------------------------

function CompanySection({ company, currencies, canManage }: { company: CompanyDTO; currencies: CurrencyDTO[]; canManage: boolean }) {
  const { t, locale } = useLocale();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const currencyOptions = currencies.filter((c) => c.active && c.code === "EGP").map((c) => ({ value: c.code, label: `${c.code} · ${localName(c, locale)}` }));

  return (
    <section className="card p-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-extrabold text-united-dark">
            {localName(company, locale)} <Code>{company.code}</Code>
          </h2>
          <Facts
            items={[
              [t("admin.company.fact-legal"), company.legalName],
              [t("admin.company.fact-tax-reg"), company.taxRegistrationNumber],
              [t("admin.company.fact-commercial-reg"), company.commercialRegistration],
              [t("admin.company.fact-currency"), company.baseCurrencyCode],
            ]}
          />
        </div>
        <div className="flex gap-2 items-center">
          <ActiveBadge active={company.active} />
          {canManage && (
            <button type="button" className="btn-secondary text-sm" onClick={() => setEditing((x) => !x)}>
              {t("admin.company.btn-edit")}
            </button>
          )}
        </div>
      </header>
      {editing && (
        <EntityForm
          entity="companies"
          row={company}
          fields={[
            { key: "legal_name", label: t("admin.company.field-legal-name"), required: true },
            { key: "name_ar", label: t("admin.company.field-name-ar") },
            { key: "trade_name", label: t("admin.company.field-trade-name") },
            { key: "tax_registration_number", label: t("admin.company.field-tax-reg-no"), ltr: true },
            { key: "commercial_registration", label: t("admin.company.field-commercial-reg-no"), ltr: true },
            { key: "base_currency_code", label: t("admin.company.field-base-currency"), kind: "select", options: currencyOptions },
            { key: "phone", label: t("admin.company.field-phone"), ltr: true },
            { key: "email", label: t("admin.company.field-email"), ltr: true },
            { key: "address", label: t("admin.company.field-address") },
          ]}
          initial={{
            legal_name: company.legalName,
            name_ar: company.nameAr,
            trade_name: company.tradeName,
            tax_registration_number: company.taxRegistrationNumber,
            commercial_registration: company.commercialRegistration,
            base_currency_code: company.baseCurrencyCode,
            phone: company.phone,
            email: company.email,
            address: company.address,
          }}
          onDone={() => setEditing(false)}
        />
      )}

      <div className="mt-4 flex flex-col gap-3">
        {company.branches.length === 0 && <EmptyState icon="🏢" title={t("admin.branch.empty")} />}
        {company.branches.map((b) => (
          <BranchBlock key={b.id} branch={b} canManage={canManage} />
        ))}
      </div>
      {canManage && (
        <div className="mt-3">
          {adding ? (
            <EntityForm
              entity="branches"
              fields={[
                { key: "code", label: t("admin.branch.form-code"), ltr: true, createOnly: true, required: true, hint: t("admin.branch.form-code-hint") },
                { key: "name", label: t("admin.branch.form-name"), required: true },
                { key: "name_ar", label: t("admin.branch.form-name-ar") },
                { key: "address", label: t("admin.branch.form-address") },
                { key: "phone", label: t("admin.branch.form-phone"), ltr: true },
              ]}
              fixed={{ company_id: company.id }}
              onDone={() => setAdding(false)}
            />
          ) : (
            <button type="button" className="btn-secondary text-sm" onClick={() => setAdding(true)} disabled={!company.active}>
              {t("admin.branch.add-btn")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function BranchBlock({ branch, canManage }: { branch: BranchDTO; canManage: boolean }) {
  const { t, locale } = useLocale();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  return (
    <div className="rounded-xl border border-united-border p-3">
      <RowHeader
        title={localName(branch, locale)}
        code={branch.code}
        active={branch.active}
        canManage={canManage}
        onEdit={() => setEditing((x) => !x)}
        toggle={{ entity: "branches", id: branch.id, active: branch.active, version: branch.version }}
      />
      {editing && (
        <EntityForm
          entity="branches"
          row={branch}
          fields={[
            { key: "name", label: t("admin.branch.form-name"), required: true },
            { key: "name_ar", label: t("admin.branch.form-name-ar") },
            { key: "address", label: t("admin.branch.form-address") },
            { key: "phone", label: t("admin.branch.form-phone"), ltr: true },
          ]}
          initial={{ name: branch.name, name_ar: branch.nameAr, address: branch.address, phone: branch.phone }}
          onDone={() => setEditing(false)}
        />
      )}
      <div className="mt-2 flex flex-col gap-2 ps-3 border-s-2 border-united-green/20">
        {branch.warehouses.map((w) => (
          <WarehouseBlock key={w.id} warehouse={w} canManage={canManage} />
        ))}
        {canManage &&
          (adding ? (
            <EntityForm
              entity="warehouses"
              fields={(() => {
                const tFn = t;
                return [
                  { key: "code", label: tFn("admin.warehouse.form-code"), ltr: true, createOnly: true, required: true, hint: tFn("admin.warehouse.form-code-hint") },
                  { key: "name", label: tFn("admin.warehouse.form-name"), required: true },
                  { key: "name_ar", label: tFn("admin.warehouse.form-name-ar") },
                  { key: "area_m2", label: tFn("admin.warehouse.form-area"), kind: "number" },
                  { key: "daily_capacity_kg", label: tFn("admin.warehouse.form-daily-capacity"), kind: "number" },
                  { key: "address", label: tFn("admin.warehouse.form-address") },
                ];
              })()}
              fixed={{ branch_id: branch.id }}
              onDone={() => setAdding(false)}
            />
          ) : (
            <button type="button" className="btn-secondary text-sm self-start" onClick={() => setAdding(true)} disabled={!branch.active}>
              {t("admin.warehouse.add-btn")}
            </button>
          ))}
      </div>
    </div>
  );
}

function WarehouseBlock({ warehouse, canManage }: { warehouse: WarehouseDTO; canManage: boolean }) {
  const { t, locale } = useLocale();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const roots = warehouse.locations.filter((l) => !l.parentId);

  return (
    <div className="rounded-xl bg-united-bg p-3">
      <RowHeader
        title={localName(warehouse, locale)}
        code={warehouse.code}
        active={warehouse.active}
        canManage={canManage}
        onEdit={() => setEditing((x) => !x)}
        toggle={{ entity: "warehouses", id: warehouse.id, active: warehouse.active, version: warehouse.version }}
      />
      <Facts
        items={[
          [t("admin.warehouse-fact-area"), warehouse.areaM2 && `${fmt(warehouse.areaM2, locale)} ${locale === "en" ? "m²" : "م²"}`],
          [t("admin.warehouse-fact-daily-capacity"), warehouse.dailyCapacityKg && `${fmtKg(warehouse.dailyCapacityKg, locale)}`],
        ]}
      />
      {editing && (
        <EntityForm
          entity="warehouses"
          row={warehouse}
          fields={[
            { key: "name", label: t("admin.warehouse.form-name"), required: true },
            { key: "name_ar", label: t("admin.warehouse.form-name-ar") },
            { key: "area_m2", label: t("admin.warehouse.form-area"), kind: "number" },
            { key: "daily_capacity_kg", label: t("admin.warehouse.form-daily-capacity"), kind: "number" },
            { key: "address", label: t("admin.warehouse.form-address") },
          ]}
          initial={{
            name: warehouse.name,
            name_ar: warehouse.nameAr,
            area_m2: warehouse.areaM2,
            daily_capacity_kg: warehouse.dailyCapacityKg,
            address: warehouse.address,
          }}
          onDone={() => setEditing(false)}
        />
      )}
      <ul className="mt-2 flex flex-col gap-1.5">
        {roots.map((l) => (
          <LocationNode key={l.id} location={l} all={warehouse.locations} canManage={canManage} depth={0} />
        ))}
      </ul>
      {canManage && (
        <div className="mt-2">
          {adding ? (
            <EntityForm
              entity="locations"
              fields={locationFields(warehouse.locations, t, locale, true)}
              fixed={{ warehouse_id: warehouse.id }}
              onDone={() => setAdding(false)}
            />
          ) : (
            <button type="button" className="btn-secondary text-sm" onClick={() => setAdding(true)} disabled={!warehouse.active}>
              {t("admin.location.add-btn")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function locationFields(siblings: StorageLocationDTO[], t: ReturnType<typeof useLocale>["t"], locale: Locale, creating: boolean, selfId?: string): Field[] {
  return [
    ...((creating ? [{ key: "code", label: t("admin.location.form-code"), ltr: true, createOnly: true, required: true, hint: t("admin.location.form-code-hint") }] as Field[] : []) as Field[]),
    { key: "name", label: t("admin.location.form-name"), required: true },
    { key: "name_ar", label: t("admin.location.form-name-ar") },
    {
      key: "type",
      label: t("admin.location.form-type"),
      kind: "select",
      required: true,
      options: STORAGE_LOCATION_TYPES.map((tType) => ({ value: tType, label: storageLocationTypeLabel(tType, locale) })),
    },
    {
      key: "parent_id",
      label: t("admin.location.form-parent"),
      kind: "select",
      options: [
        { value: "", label: t("admin.location.parent-main") },
        ...siblings.filter((l) => l.active && l.id !== selfId).map((l) => ({ value: l.id, label: `${l.code} · ${localName(l, locale)}` })),
      ],
    },
    { key: "capacity_kg", label: t("admin.location.form-capacity"), kind: "number" },
    { key: "temp_min_c", label: t("admin.location.form-temp-min"), kind: "number" },
    { key: "temp_max_c", label: t("admin.location.form-temp-max"), kind: "number" },
  ];
}

function LocationNode({ location, all, canManage, depth }: { location: StorageLocationDTO; all: StorageLocationDTO[]; canManage: boolean; depth: number }) {
  const { t, locale } = useLocale();
  const [editing, setEditing] = useState(false);
  const children = all.filter((l) => l.parentId === location.id);
  // Spelled out rather than "2 ↔ 6": an arrow between numbers has no reliable
  // reading direction inside right-to-left text.
  const band =
    location.tempMinC != null && location.tempMaxC != null
      ? t("admin.location.temp-range", { min: String(location.tempMinC), max: String(location.tempMaxC) })
      : location.tempMinC != null
      ? t("admin.location.temp-min-only", { min: String(location.tempMinC) })
      : location.tempMaxC != null
      ? t("admin.location.temp-max-only", { max: String(location.tempMaxC) })
      : null;
  return (
    <li style={{ marginInlineStart: depth * 16 }}>
      <div className="rounded-lg bg-white border border-united-border px-3 py-2">
        <RowHeader
          title={localName(location, locale)}
          code={location.code}
          active={location.active}
          canManage={canManage}
          onEdit={() => setEditing((x) => !x)}
          toggle={{ entity: "locations", id: location.id, active: location.active, version: location.version }}
          small
        />
        <Facts
          items={[
            [t("admin.location-fact-type"), storageLocationTypeLabel(location.type, locale)],
            [t("admin.location-fact-capacity"), location.capacityKg && fmtKg(location.capacityKg, locale)],
            [t("admin.location-fact-temp"), band],
          ]}
        />
        {editing && (
          <EntityForm
            entity="locations"
            row={location}
            fields={locationFields(all, t, locale, false, location.id)}
            initial={{
              name: location.name,
              name_ar: location.nameAr,
              type: location.type,
              parent_id: location.parentId ?? "",
              capacity_kg: location.capacityKg,
              temp_min_c: location.tempMinC,
              temp_max_c: location.tempMaxC,
            }}
            onDone={() => setEditing(false)}
          />
        )}
      </div>
      {children.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {children.map((c) => (
            <LocationNode key={c.id} location={c} all={all} canManage={canManage} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Units & currencies
// ---------------------------------------------------------------------------

function UomSection({ uoms, canManage }: { uoms: UomDTO[]; canManage: boolean }) {
  const { t } = useLocale();
  const [adding, setAdding] = useState(false);
  const refByCategory = new Map(uoms.filter((u) => u.isReference).map((u) => [u.category, u.code]));
  return (
    <section className="card p-4">
      <h2 className="text-lg font-extrabold text-united-dark">{t("admin.section.uom")}</h2>
      <p className="text-xs font-bold text-united-muted mb-3">
        {t("admin.section.uom-desc")}
      </p>
      <div className="overflow-x-auto -mx-4 px-4">
        <table className="w-full text-sm min-w-[560px]">
          <thead>
            <tr className="text-united-muted text-xs">
              <th className="text-start p-2">{t("admin.table.col.unit")}</th>
              <th className="text-start p-2">{t("admin.table.col.type")}</th>
              <th className="text-start p-2">{t("admin.table.col.conversion")}</th>
              <th className="text-start p-2">{t("admin.table.col.decimals")}</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {UOM_CATEGORIES.flatMap((cat) => uoms.filter((u) => u.category === cat)).map((u) => (
              <UomRow key={u.id} uom={u} reference={refByCategory.get(u.category)} canManage={canManage} />
            ))}
          </tbody>
        </table>
      </div>
      {canManage && (
        <div className="mt-3">
          {adding ? (
            <EntityForm
              entity="uoms"
              fields={[
                { key: "code", label: t("admin.uom.form-code"), ltr: true, createOnly: true, required: true, hint: t("admin.uom.form-code-hint") },
                { key: "name", label: t("admin.uom.form-name-en"), required: true },
                { key: "name_ar", label: t("admin.uom.form-name-ar") },
                {
                  key: "category",
                  label: t("admin.uom.form-category"),
                  kind: "select",
                  required: true,
                  createOnly: true,
                  options: UOM_CATEGORIES.map((c) => ({ value: c, label: UOM_CATEGORY_LABEL[c] })),
                },
                { key: "ratio_to_reference", label: t("admin.uom.form-ratio"), kind: "number", createOnly: true },
                { key: "precision", label: t("admin.uom.form-precision"), kind: "number" },
              ]}
              onDone={() => setAdding(false)}
            />
          ) : (
            <button type="button" className="btn-secondary text-sm" onClick={() => setAdding(true)}>
              {t("admin.uom.add-btn")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function UomRow({ uom, reference, canManage }: { uom: UomDTO; reference?: string; canManage: boolean }) {
  const { t, locale } = useLocale();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <tr className={`border-t border-united-border ${uom.active ? "" : "opacity-50"}`}>
        <td className="p-2">
          <span className="font-bold text-united-dark">{localName(uom, locale)}</span> <Code>{uom.code}</Code>
          {uom.isReference && <span className="ms-1 text-[10px] font-extrabold text-united-green">{t("admin.uom.reference-badge")}</span>}
        </td>
        <td className="p-2 font-bold text-united-muted">{UOM_CATEGORY_LABEL[uom.category as UomCategory] ?? uom.category}</td>
        <td className="p-2">
          {uom.ratioToReference && reference && !uom.isReference ? (
            <bdi dir="ltr" className="tabular-nums font-bold">
              {/* Latin digits and the stored string as-is: no script mixing inside an LTR
                  formula, and no float round-trip (0.45359237 stays exact). */}
              1 {uom.code} = {uom.ratioToReference} {reference}
            </bdi>
          ) : uom.category === "package" ? (
            <span className="text-xs font-bold text-united-muted">{t("admin.uom.empty-conversion")}</span>
          ) : (
            "—"
          )}
        </td>
        <td className="p-2 tabular-nums">{uom.precision}</td>
        <td className="p-2">
          {canManage && (
            <div className="flex gap-1 justify-end">
              <button type="button" className="btn-secondary !min-h-0 py-1.5 px-3 text-xs" onClick={() => setEditing((x) => !x)}>
                {t("admin.uom.edit-label")}
              </button>
              {!uom.isReference && <ToggleActive entity="uoms" id={uom.id} active={uom.active} version={uom.version} />}
            </div>
          )}
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={5}>
            <EntityForm
              entity="uoms"
              row={uom}
              fields={[
                { key: "name", label: t("admin.uom.form-name-en"), required: true },
                { key: "name_ar", label: t("admin.uom.form-name-ar") },
                { key: "precision", label: t("admin.uom.form-precision"), kind: "number" },
              ]}
              initial={{ name: uom.name, name_ar: uom.nameAr, precision: String(uom.precision) }}
              onDone={() => setEditing(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function CurrencySection({ currencies, canManage }: { currencies: CurrencyDTO[]; canManage: boolean }) {
  const { t } = useLocale();
  return (
    <section className="card p-4">
      <h2 className="text-lg font-extrabold text-united-dark mb-3">{t("admin.section.currencies")}</h2>
      <p className="text-xs font-bold text-united-muted mb-2">{t("admin.section.currencies-desc")}</p>
      <ul className="flex flex-col divide-y divide-united-border">
        {currencies.map((c) => (
          <CurrencyRow key={c.code} currency={c} canManage={canManage && c.code === "EGP"} />
        ))}
      </ul>
    </section>
  );
}

function CurrencyRow({ currency, canManage }: { currency: CurrencyDTO; canManage: boolean }) {
  const { t, locale } = useLocale();
  const [editing, setEditing] = useState(false);
  return (
    <li className="py-2.5">
      <RowHeader
        title={`${localName(currency, locale)}${currency.symbol ? ` (${currency.symbol})` : ""}`}
        code={currency.code}
        active={currency.active}
        canManage={canManage}
        onEdit={() => setEditing((x) => !x)}
        toggle={{ entity: "currencies", id: currency.code, active: currency.active, version: currency.version }}
        small
      />
      {editing && (
        <EntityForm
          entity="currencies"
          row={{ id: currency.code, version: currency.version }}
          fields={[
            { key: "name", label: t("admin.currency.form-name"), required: true },
            { key: "name_ar", label: t("admin.currency.form-name-ar") },
            { key: "symbol", label: t("admin.currency.form-symbol") },
            { key: "decimal_places", label: t("admin.currency.form-decimal"), kind: "number" },
          ]}
          initial={{ name: currency.name, name_ar: currency.nameAr, symbol: currency.symbol, decimal_places: String(currency.decimalPlaces) }}
          onDone={() => setEditing(false)}
        />
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function RowHeader({
  title,
  code,
  active,
  canManage,
  onEdit,
  toggle,
  small,
}: {
  title: string;
  code: string;
  active: boolean;
  canManage: boolean;
  onEdit: () => void;
  toggle: { entity: Entity; id: string; active: boolean; version: number };
  small?: boolean;
}) {
  const { t } = useLocale();
  return (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <span className={`font-extrabold text-united-dark ${small ? "text-sm" : ""} ${active ? "" : "opacity-50"}`}>
        {title} <Code>{code}</Code>
      </span>
      <div className="flex gap-1 items-center">
        <ActiveBadge active={active} />
        {canManage && (
          <>
            <button type="button" className="btn-secondary !min-h-0 py-1.5 px-3 text-xs" onClick={onEdit}>
              {t("admin.btn-edit")}
            </button>
            <ToggleActive {...toggle} />
          </>
        )}
      </div>
    </div>
  );
}

function ToggleActive({ entity, id, active, version }: { entity: Entity; id: string; active: boolean; version: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  async function flip() {
    if (busy) return;
    setBusy(true);
    try {
      await apiPatch(`/api/admin/master/${entity}/${encodeURIComponent(id)}`, { active: !active, expected_version: version });
      await qc.invalidateQueries({ queryKey: ["admin", "master"] });
      toast.show(active ? t("admin.toggle-on") : t("admin.toggle-off"), "success");
    } catch (err) {
      toast.show(err instanceof ApiClientError ? err.message : t("admin.toast-error"), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={flip}
      disabled={busy}
      className={`!min-h-0 py-1.5 px-3 text-xs ${active ? "btn-danger" : "btn-secondary"}`}
    >
      {active ? t("admin.toggle-btn.deactivate") : t("admin.toggle-btn.activate")}
    </button>
  );
}

/**
 * One form for every entity: create when `row` is absent, edit otherwise. An edit
 * sends only the fields that actually changed, plus the version the editor saw.
 */
function EntityForm({
  entity,
  fields,
  row,
  initial = {},
  fixed = {},
  onDone,
}: {
  entity: Entity;
  fields: Field[];
  row?: { id: string; version: number };
  initial?: Record<string, string | number | null | undefined>;
  fixed?: Record<string, string>;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useLocale();
  const start = Object.fromEntries(fields.map((f) => [f.key, initial[f.key] == null ? "" : String(initial[f.key])]));
  const [values, setValues] = useState<Record<string, string>>(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function encode(f: Field, raw: string): unknown {
    const v = raw.trim();
    if (f.kind === "number") {
      if (v === "") return null;
      return Number.isFinite(Number(v)) ? Number(v) : v; // let the server word the error
    }
    return v === "" ? (f.required ? "" : null) : v;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { ...fixed };
      for (const f of fields) {
        if (row && values[f.key] === start[f.key]) continue;
        const encoded = encode(f, values[f.key]);
        if (!row && encoded === null) continue;
        body[f.key] = encoded;
      }
      if (row) {
        if (Object.keys(body).length === 0) {
          onDone();
          return;
        }
        await apiPatch(`/api/admin/master/${entity}/${encodeURIComponent(row.id)}`, { ...body, expected_version: row.version });
      } else {
        await apiPost(`/api/admin/master/${entity}`, body);
      }
      await qc.invalidateQueries({ queryKey: ["admin", "master"] });
      toast.show(row ? t("admin.toast-save") : t("admin.toast-add"), "success");
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("admin.toast-error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded-xl border-2 border-united-green/20 bg-white p-3 grid gap-2 sm:grid-cols-2">
      {fields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1">
          <span className="text-xs font-bold text-united-muted">
            {f.label}
            {f.required && " *"}
            {f.hint && <span className="font-normal"> — {f.hint}</span>}
          </span>
          {f.kind === "select" ? (
            <select
              className="field"
              value={values[f.key]}
              onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
            >
              {!f.required && !f.options?.some((o) => o.value === "") && <option value="">—</option>}
              {f.required && values[f.key] === "" && <option value="">{t("admin.select-prompt")}</option>}
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={`field ${f.kind === "number" ? "tabular-nums" : ""}`}
              dir={f.ltr || f.kind === "number" ? "ltr" : undefined}
              inputMode={f.kind === "number" ? "decimal" : undefined}
              value={values[f.key]}
              onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
            />
          )}
        </label>
      ))}
      {error && <p className="sm:col-span-2 text-sm font-bold text-united-danger">{error}</p>}
      <div className="sm:col-span-2 flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {row ? t("admin.btn-save") : t("admin.btn-add")}
        </button>
        <button type="button" className="btn-secondary" onClick={onDone} disabled={busy}>
          {t("admin.btn-cancel")}
        </button>
      </div>
    </form>
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useLocale();
  return (
    <span
      className={`text-[11px] font-extrabold px-2 py-0.5 rounded-full ${
        active ? "bg-united-green/10 text-united-green" : "bg-united-dark/5 text-united-muted"
      }`}
    >
      {active ? t("admin.badge-active") : t("admin.badge-inactive")}
    </span>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code dir="ltr" className="text-[11px] font-bold text-united-muted bg-united-dark/5 rounded px-1.5 py-0.5">
      {children}
    </code>
  );
}

function Facts({ items }: { items: [string, string | null | undefined | false][] }) {
  const shown = items.filter(([, v]) => v);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-xs font-bold text-united-muted">
      {shown.map(([k, v]) => (
        <span key={k}>
          {k}: <bdi className="text-united-dark">{v}</bdi>
        </span>
      ))}
    </div>
  );
}

const fmt = (v: string, locale: Locale) => Number(v).toLocaleString(intlLocale(locale), { maximumFractionDigits: 3 });
const fmtKg = (v: string, locale: Locale) => {
  const n = Number(v);
  return n >= 1000
    ? `${(n / 1000).toLocaleString(intlLocale(locale), { maximumFractionDigits: 2 })} ${locale === "en" ? "t" : "طن"}`
    : `${fmt(v, locale)} ${locale === "en" ? "kg" : "كجم"}`;
};
