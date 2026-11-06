"use client";

import { useEffect, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { localName } from "@/lib/locale/names";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ListMore } from "@/components/ui/ListMore";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { Field, Tabs, fmtMoney, fmtQty } from "@/components/stock/inventory/shared";
import { DocLink, PartyLink } from "./EntityLink";
import type { ProfileGroup, ProfileRow } from "@/lib/profiles/service";

/**
 * The parts every profile shares (customer, supplier, product): tabs kept in the address
 * (?tab=, so a tab can be shared and survives a reload), a figures strip, and one document
 * list per tab. Columns the viewer has no data for are left out, not shown empty — the
 * server already removed what they may not see.
 */

const PAGE = 50;

/** The tab in the address, and a setter that rewrites it without a navigation. */
export function useTabParam<T extends string>(allowed: readonly T[], fallback: T): [T, (t: T) => void] {
  const [tab, setTab] = useState<T>(fallback);
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("tab") as T | null;
    if (v && allowed.includes(v)) setTab(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list's contents, not its identity
  }, [allowed.join(",")]);
  const set = (t: T) => {
    setTab(t);
    const sp = new URLSearchParams(window.location.search);
    sp.set("tab", t);
    window.history.replaceState(null, "", `${window.location.pathname}?${sp}`);
  };
  return [allowed.includes(tab) ? tab : fallback, set];
}

export function ProfileTabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: string }[] }) {
  return <Tabs value={value} onChange={onChange} items={items} />;
}

/** A strip of figures; a figure the viewer may not see is simply absent. */
export function Figures({ items }: { items: { label: string; value: ReactNode; tone?: "danger" | "success" }[] }) {
  const shown = items.filter((i) => i.value !== null && i.value !== undefined && i.value !== "");
  if (!shown.length) return null;
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      {shown.map((i) => (
        <div key={i.label} className="card p-3 flex flex-col gap-0.5">
          <dt className="text-xs font-extrabold text-united-muted">{i.label}</dt>
          <dd className={`font-extrabold num ${i.tone === "danger" ? "text-united-danger" : i.tone === "success" ? "text-united-green" : "text-united-dark"}`} dir="auto">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const STOCK_KINDS = ["intake", "intake_correction", "intake_void", "adjustment", "transfer_out", "transfer_in", "issue", "customer_return", "supplier_return", "scrap", "sorting_out", "sorting_in", "release_out", "release_in", "revaluation_out", "revaluation_in", "standard_cost_out", "standard_cost_in"];

export function useKindLabel() {
  const { t } = useLocale();
  return (kind: string, movement = false) => (movement && STOCK_KINDS.includes(kind) ? t(`stock.kind-${kind.replace(/_/g, "-")}`) : t(`profile.kind.${kind}`));
}

const STATUS_KEY: Record<string, (s: string) => string> = {
  order: (s) => `orders.status.${s}`,
  order_line: (s) => `orders.status.${s}`,
  invoice: (s) => (s === "void" ? "sales.invoice.voided" : `sales.invoice.${s}`),
  purchase_order: (s) => `purchasing.po.status.${s}`,
  bill: (s) => `bills.status.${s}`,
};
const TONE: Record<string, Tone> = {
  dispatched: "success", issued: "success", posted: "success", billed: "success", received: "success", closed: "neutral",
  draft: "warn", pending_approval: "warn", unbilled: "warn", new: "info", preparing: "info", ready_for_loading: "info", loading: "info", loaded: "info", approved: "info", sent: "info", partially_received: "warn",
  cancelled: "neutral", void: "neutral", voided: "neutral", reversed: "danger", with_goods: "info", inactive: "neutral",
};

function Status({ kind, status }: { kind: string; status: string | null }) {
  const { t } = useLocale();
  if (!status) return null;
  const key = (STATUS_KEY[kind] ?? ((s: string) => `profile.status.${s}`))(status);
  const label = t(key);
  return <StatusPill tone={TONE[status] ?? "neutral"}>{label === key ? t(`profile.status.${status}`) : label}</StatusPill>;
}

/** The row's packed detail (the server sends codes and figures; the words are the viewer's). */
function Detail({ r, movement }: { r: ProfileRow; movement: boolean }) {
  const { t } = useLocale();
  if (!r.detail) return null;
  const p = r.detail.split("|");
  const ltr = (v: string) => <span dir="ltr">{v}</span>;
  // A stock movement's detail is always where, which lot, who and why (an "intake" movement too).
  if (movement) {
    const [loc, lot, actor, reason] = p;
    return <span>{ltr(loc)}{lot ? <> · {ltr(lot)}</> : null} · {actor}{reason ? ` · ${reason}` : ""}</span>;
  }
  switch (r.kind) {
    case "order": {
      const [lines, prepared, loaded, trip, stop] = p;
      // A stop is "pending" from the moment the order is put on the trip: it is on the way only
      // once the order has left with it (dispatched). Before that it is just on the trip (ORD-08).
      const stopKey = stop === "pending" && r.status !== "dispatched" ? "on-trip" : stop;
      return <span>{t(lines === "1" ? "profile.detail.order_one" : "profile.detail.order", { lines, prepared, loaded })}{trip ? <> · {ltr(trip)}{stop ? ` · ${t(`profile.stop.${stopKey}`)}` : ""}</> : null}</span>;
    }
    case "invoice": case "opening_balance": return <span>{t("profile.detail.due", { date: "" })}{ltr(p[0])}</span>;
    case "receipt": case "payment": {
      const [method, ref, withheld, reversedOn] = p;
      const m = `accounting.method.${method.replace(/_/g, "-")}`;
      return <span>{t(m) === m ? method : t(m)}{ref ? <> · {ltr(ref)}</> : null}{withheld ? <> · {t("profile.detail.withheld")} {ltr(withheld)}</> : null}{reversedOn ? <> · {t("profile.detail.reversed-on")} {ltr(reversedOn)}</> : null}</span>;
    }
    case "intake": {
      const [good, gradeB, waste, rejected] = p;
      return <span>{t("profile.detail.grading", { good, gradeB, waste, rejected })}</span>;
    }
    case "purchase_order": return <span>{t("profile.detail.po", { lines: p[0] })}{p[1] ? <> · {t("profile.detail.expected")} {ltr(p[1])}</> : null}</span>;
    case "bill": return <span>{ltr(p[0])} · {t("profile.detail.due", { date: "" })}{ltr(p[1])}</span>;
    case "sales_price": case "supplier_price": return <span>{p[0] ? <>{t("profile.detail.valid-to")} {ltr(p[0])} · </> : null}{p[1]}</span>;
    default:
      return <span>{r.detail}</span>;
  }
}

// ---------------------------------------------------------------------------
// Document lists
// ---------------------------------------------------------------------------

type Section = { rows: ProfileRow[]; total: number; groups?: (ProfileGroup & { agreed?: string | null })[] };

/** The name column's heading: customer, supplier or product — "party" when a list mixes customers and suppliers. */
function entityLabel(rows: ProfileRow[], t: (k: string) => string) {
  const kinds = new Set(rows.map((r) => r.party?.kind ?? (r.product ? "product" : null)).filter(Boolean));
  if (kinds.size > 1) return t("profile.col.party");
  const k = [...kinds][0];
  return t(k === "customer" ? "profile.col.customer" : k === "supplier" ? "profile.col.supplier" : "profile.col.product");
}

/** One profile tab: an optional "by product / customer / supplier" summary, then every document, newest first. */
export function DocSection({ kind, id, section, movement = false, openFilter = false, groupsOnly = false, groupsTitle, linesTitle }: { kind: "customer" | "supplier" | "product"; id: string; section: string; movement?: boolean; openFilter?: boolean; groupsOnly?: boolean; groupsTitle?: string; linesTitle?: string }) {
  const { t, locale } = useLocale();
  const kindLabel = useKindLabel();
  const [limit, setLimit] = useState(PAGE);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState(false);
  const qs = new URLSearchParams({ limit: String(limit), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(open ? { open: "1" } : {}) });
  const q = useQuery({ queryKey: ["profile", kind, id, section, qs.toString()], queryFn: () => apiFetch<Section>(`/api/profiles/${kind}/${id}/${section}?${qs}`), placeholderData: keepPreviousData });
  const rows = q.data?.rows;
  const has = (f: keyof ProfileRow | "unitCost") => (rows ?? []).some((r) => (r as Record<string, unknown>)[f] != null && (r as Record<string, unknown>)[f] !== "");
  const entity = (r: ProfileRow) => r.party ?? r.product ?? null;
  const columns: Column<ProfileRow>[] = [
    { key: "date", label: t("profile.col.date"), sortValue: (r) => r.date, render: (r) => <span dir="ltr" className="whitespace-nowrap">{r.date}</span> },
    { key: "doc", label: t("profile.col.document"), sortValue: (r) => r.number, render: (r) => (
      <span className="flex flex-col">
        <span className="text-xs font-extrabold text-united-muted">{kindLabel(r.kind, movement)}</span>
        {r.number ? <DocLink href={r.href}>{r.number}</DocLink> : null}
        {r.via && <span className="text-xs">{kindLabel(r.via.kind)} <DocLink href={r.via.href}>{r.via.number}</DocLink></span>}
      </span>
    ) },
    ...(rows?.some((r) => r.status) ? [{ key: "status", label: t("list.status"), render: (r: ProfileRow) => <Status kind={r.kind} status={r.status} /> }] : []),
    ...(rows?.some(entity) ? [{ key: "entity", label: entityLabel(rows, t), sortValue: (r: ProfileRow) => (entity(r) ? localName(entity(r)!, locale) : r.kind === "order_line" ? r.detail ?? "" : ""), render: (r: ProfileRow) => (entity(r) ? <PartyLink kind={entity(r)!.kind} id={entity(r)!.id} name={localName(entity(r)!, locale)} /> : r.kind === "order_line" && r.detail ? <span>{r.detail}</span> : <span className="text-united-muted">—</span>) }] : []),
    ...(rows?.some((r) => r.detail && !(r.kind === "order_line")) ? [{ key: "detail", label: t("profile.col.detail"), render: (r: ProfileRow) => <span className="text-sm text-united-muted"><Detail r={r} movement={movement} /></span>, secondary: true }] : []),
    ...(has("qty") ? [{ key: "qty", label: t("profile.col.qty"), numeric: true, sortValue: (r: ProfileRow) => Number(r.qty ?? 0), render: (r: ProfileRow) => (r.qty == null ? "—" : <span dir="ltr" className={Number(r.qty) < 0 ? "text-united-danger" : ""}>{movement && Number(r.qty) > 0 ? "+" : ""}{fmtQty(r.qty, r.uom ?? undefined)}</span>) }] : []),
    ...(has("delivered") ? [{ key: "delivered", label: t("profile.col.delivered"), numeric: true, render: (r: ProfileRow) => (r.delivered == null ? "—" : <span dir="ltr">{fmtQty(r.delivered, r.uom ?? undefined)}</span>), secondary: true }] : []),
    ...(has("price") ? [{ key: "price", label: t("profile.col.price"), numeric: true, render: (r: ProfileRow) => (r.price == null ? "—" : <span dir="ltr">{fmtMoney(r.price)}</span>) }] : []),
    ...(has("unitCost") ? [{ key: "cost", label: t("profile.col.unit-cost"), numeric: true, render: (r: ProfileRow) => { const c = (r as { unitCost?: string | null }).unitCost; return c == null ? "—" : <span dir="ltr">{c}</span>; }, secondary: true }] : []),
    ...(has("amount") ? [{ key: "amount", label: t("profile.col.amount"), numeric: true, sortValue: (r: ProfileRow) => Number(r.amount ?? 0), render: (r: ProfileRow) => (r.unpriced ? <span className="text-united-muted">{t("profile.amount.unpriced")}</span> : r.amount == null ? "—" : <span dir="ltr">{fmtMoney(r.amount)}</span>) }] : []),
    ...(has("open") ? [{ key: "open", label: t("profile.col.open"), numeric: true, render: (r: ProfileRow) => (r.open == null ? "—" : <span dir="ltr" className={Number(r.open) > 0 ? "font-extrabold text-united-dark" : "text-united-muted"}>{fmtMoney(r.open)}</span>) }] : []),
  ];
  const groups = q.data?.groups;
  const gHas = (f: string) => (groups ?? []).some((g) => (g as Record<string, unknown>)[f] != null);
  const gColumns: Column<NonNullable<Section["groups"]>[number]>[] = [
    { key: "entity", label: groups?.[0]?.entity.kind === "customer" ? t("profile.col.customer") : groups?.[0]?.entity.kind === "supplier" ? t("profile.col.supplier") : t("profile.col.product"), sortValue: (g) => localName(g.entity, locale), render: (g) => (g.entity.id ? <PartyLink kind={g.entity.kind as "customer" | "supplier" | "product"} id={g.entity.id} name={localName(g.entity, locale)} /> : <span>{g.entity.name}</span>) },
    { key: "qty", label: t("profile.col.qty"), numeric: true, sortValue: (g) => Number(g.qty), render: (g) => <span dir="ltr">{fmtQty(g.qty, g.uom ?? undefined)}</span> },
    ...(gHas("delivered") ? [{ key: "delivered", label: section === "products" && kind === "supplier" || section === "purchases" ? t("profile.col.accepted") : t("profile.col.delivered"), numeric: true, render: (g: NonNullable<Section["groups"]>[number]) => <span dir="ltr">{fmtQty(g.delivered ?? "0", g.uom ?? undefined)}</span>, secondary: true }] : []),
    { key: "count", label: t("profile.col.documents"), numeric: true, sortValue: (g) => g.count, render: (g) => g.count.toLocaleString("en-US") },
    { key: "last", label: t("profile.col.last"), sortValue: (g) => g.lastDate, render: (g) => <span dir="ltr">{g.lastDate}</span> },
    ...(gHas("lastPrice") ? [{ key: "lastPrice", label: t("profile.col.last-price"), numeric: true, render: (g: NonNullable<Section["groups"]>[number]) => (g.lastPrice == null ? "—" : <span dir="ltr">{fmtMoney(g.lastPrice)}</span>) }] : []),
    ...(gHas("avgPrice") ? [{ key: "avgPrice", label: kind === "customer" || section === "sales" ? t("profile.col.avg-price") : t("profile.col.avg-cost"), numeric: true, render: (g: NonNullable<Section["groups"]>[number]) => (g.avgPrice == null ? "—" : <span dir="ltr">{fmtMoney(g.avgPrice)}</span>), secondary: true }] : []),
    ...(gHas("agreed") ? [{ key: "agreed", label: t("profile.col.agreed"), numeric: true, render: (g: NonNullable<Section["groups"]>[number]) => <span dir="ltr">{g.agreed ?? "—"}</span>, secondary: true }] : []),
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("list.from")}><input type="date" className="field" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setLimit(PAGE); }} /></Field>
        <Field label={t("list.to")}><input type="date" className="field" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setLimit(PAGE); }} /></Field>
        {openFilter && (
          <label className="tap-target flex items-center gap-2 text-sm font-extrabold"><input type="checkbox" className="w-5 h-5" checked={open} onChange={(e) => { setOpen(e.target.checked); setLimit(PAGE); }} />{t("profile.open-only")}</label>
        )}
      </div>
      {groupsOnly ? (
        <DataTable rows={groups} columns={gColumns} rowKey={(g) => g.key} caption={groupsTitle} loading={q.isFetching} error={q.error} onRetry={() => q.refetch()} empty={{ title: from || to ? t("list.empty-filtered") : t("profile.empty") }} />
      ) : groups && groups.length > 0 && (
        <section className="flex flex-col gap-2" aria-label={groupsTitle}>
          {groupsTitle && <h3 className="font-extrabold">{groupsTitle}</h3>}
          <DataTable rows={groups} columns={gColumns} rowKey={(g) => g.key} caption={groupsTitle} maxHeight="40vh" />
        </section>
      )}
      {!groupsOnly && (
        <section className="flex flex-col gap-2" aria-label={linesTitle}>
          {linesTitle && groups && <h3 className="font-extrabold">{linesTitle}</h3>}
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.key}
            loading={q.isFetching}
            error={q.error}
            onRetry={() => q.refetch()}
            empty={{ title: from || to || open ? t("list.empty-filtered") : t("profile.empty") }}
            caption={linesTitle}
          />
          {q.data && <ListMore shown={q.data.rows.length} total={q.data.total} busy={q.isFetching} onMore={() => setLimit(limit + PAGE)} />}
        </section>
      )}
    </div>
  );
}

/** Fetches a profile's figures (the summary section) for its header strip. */
export function useSummary<T>(kind: "customer" | "supplier" | "product", id: string, enabled = true) {
  return useQuery({ queryKey: ["profile", kind, id, "summary"], queryFn: () => apiFetch<T>(`/api/profiles/${kind}/${id}/summary`), enabled });
}
