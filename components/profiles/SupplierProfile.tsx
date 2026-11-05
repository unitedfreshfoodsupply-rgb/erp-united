"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { localName, otherLocalName } from "@/lib/locale/names";
import { intlLocale } from "@/lib/format";
import { changeText } from "@/lib/auditLabels";
import { systemText } from "@/lib/locale/system-text";
import { maySeeSection } from "@/lib/profiles/access";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { fmtMoney } from "@/components/stock/inventory/shared";
import { SupplierOverview } from "@/components/purchasing/PurchasingView";
import { Statement } from "@/components/purchasing/BillsView";
import { DocSection, Figures, ProfileTabs, useSummary, useTabParam } from "./ProfileParts";

/**
 * One supplier, everything about them (Nov 2026): who they are and their terms, purchase
 * orders, goods received and how they graded, bills, payments, returns, the statement, what
 * they supply and every change to the record. Each tab is gated on the server.
 */

type Tab = "overview" | "orders" | "receipts" | "bills" | "payments" | "returns" | "products" | "statement" | "timeline" | "history";
type Summary = { receipts?: number; lastReceiptDate?: string | null; unbilledReceipts?: number; purchaseOrders?: number; openPurchaseOrders?: number; payable?: string; netPurchases?: string; netPurchasesThisYear?: string; paid?: string; lastPaymentDate?: string | null };
type Head = { supplier: { id: string; code: string; name: string; nameAr: string | null; active: boolean; taxRegistrationNo: string | null } };
type Log = { id: string; action: string; userName: string; timestamp: string; fieldChanged: string | null; oldValue: string | null; newValue: string | null; reason: string | null };

export function SupplierProfile({ supplierId }: { supplierId: string }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  // Same key as the overview tab (SupplierOverview), which mounts once this has loaded: 15 s
  // fresh, so opening the profile asks for the supplier once, not twice (edits invalidate ["purchasing"]).
  const head = useQuery({ queryKey: ["purchasing", "supplier", supplierId], queryFn: () => apiFetch<Head>(`/api/purchasing/suppliers/${supplierId}`), staleTime: 15_000 });
  const summary = useSummary<Summary>("supplier", supplierId);
  const sees = (s: string) => maySeeSection("supplier", s, can);
  const items: { key: Tab; label: string }[] = [
    { key: "overview", label: t("profile.tab.overview") },
    ...(sees("orders") ? [{ key: "orders" as Tab, label: t("profile.tab.purchase-orders") }] : []),
    ...(sees("receipts") ? [{ key: "receipts" as Tab, label: t("profile.tab.goods-received") }] : []),
    { key: "products", label: t("profile.tab.products-supplied") },
    ...(sees("bills") ? [{ key: "bills" as Tab, label: t("profile.tab.bills") }] : []),
    ...(sees("payments") ? [{ key: "payments" as Tab, label: t("profile.tab.payments") }] : []),
    ...(sees("returns") ? [{ key: "returns" as Tab, label: t("profile.tab.returns") }] : []),
    ...(can("purchasing.bills.view") ? [{ key: "statement" as Tab, label: t("profile.tab.statement") }] : []),
    { key: "timeline", label: t("profile.tab.timeline") },
    { key: "history", label: t("profile.tab.history") },
  ];
  const [tab, setTab] = useTabParam(items.map((i) => i.key), "overview");
  if (head.isLoading) return <div className="page-container"><LoadingState /></div>;
  if (head.isError || !head.data) return <div className="page-container"><ErrorState message={errorMessage(head.error)} onRetry={() => head.refetch()} /></div>;
  const sp = head.data.supplier;
  const s = summary.data ?? {};
  const money = (v: string | null | undefined) => (v == null ? null : <span dir="ltr">{fmtMoney(v)}</span>);
  return (
    <div className="page-container">
      <PageHeader
        back={{ href: "/purchasing?tab=suppliers", label: t("profile.back.suppliers") }}
        title={localName(sp, locale)}
        description={<><span dir="ltr">{sp.code}</span>{otherLocalName(sp, locale) ? ` · ${otherLocalName(sp, locale)}` : ""}{sp.taxRegistrationNo ? <> · <span dir="ltr">TAX {sp.taxRegistrationNo}</span></> : null}</>}
        actions={!sp.active ? <StatusPill tone="neutral" size="md">{t("sales.label.inactive")}</StatusPill> : null}
      />
      <Figures items={[
        { label: t("profile.fig.payable"), value: money(s.payable), tone: s.payable && Number(s.payable) > 0 ? "danger" : undefined },
        { label: t("profile.fig.net-purchases-year"), value: money(s.netPurchasesThisYear) },
        { label: t("profile.fig.net-purchases"), value: money(s.netPurchases) },
        { label: t("profile.fig.paid"), value: money(s.paid) },
        { label: t("profile.fig.receipts"), value: s.receipts == null ? null : `${s.receipts.toLocaleString("en-US")}${s.unbilledReceipts && can("purchasing.bills.view") ? ` · ${t("profile.fig.unbilled", { n: s.unbilledReceipts })}` : ""}` },
        { label: t("profile.fig.purchase-orders"), value: s.purchaseOrders == null ? null : `${s.purchaseOrders.toLocaleString("en-US")}${s.openPurchaseOrders ? ` · ${t("profile.fig.open", { n: s.openPurchaseOrders })}` : ""}` },
        { label: t("profile.fig.last-receipt-goods"), value: s.lastReceiptDate ? <span dir="ltr">{s.lastReceiptDate}</span> : null },
        { label: t("profile.fig.last-payment"), value: s.lastPaymentDate ? <span dir="ltr">{s.lastPaymentDate}</span> : null },
      ]} />
      <ProfileTabs value={tab} onChange={setTab} items={items} />
      {tab === "overview" && <SupplierOverview id={supplierId} />}
      {tab === "orders" && <DocSection kind="supplier" id={supplierId} section="orders" openFilter />}
      {tab === "receipts" && <DocSection kind="supplier" id={supplierId} section="receipts" />}
      {tab === "products" && <DocSection kind="supplier" id={supplierId} section="products" groupsOnly groupsTitle={t("profile.by-product")} />}
      {tab === "bills" && <DocSection kind="supplier" id={supplierId} section="bills" />}
      {tab === "payments" && <DocSection kind="supplier" id={supplierId} section="payments" />}
      {tab === "returns" && <DocSection kind="supplier" id={supplierId} section="returns" />}
      {tab === "statement" && <Statement supplier={sp} />}
      {tab === "timeline" && <DocSection kind="supplier" id={supplierId} section="timeline" />}
      {tab === "history" && <SupplierHistory id={supplierId} />}
    </div>
  );
}

function SupplierHistory({ id }: { id: string }) {
  const { t, locale } = useLocale();
  const q = useQuery({ queryKey: ["profile", "supplier", id, "history"], queryFn: () => apiFetch<{ data: Log[] }>(`/api/profiles/supplier/${id}/history`) });
  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const logs = q.data?.data ?? [];
  if (!logs.length) return <EmptyState icon="🗂️" title={t("profile.empty")} />;
  const actionLabel = (a: string) => { const k = `profile.audit.${a}`; return t(k) === k ? a : t(k); };
  return (
    <section className="card p-4 flex flex-col gap-2">
      <h3 className="font-extrabold">{t("heading-audit-log")}</h3>
      <ul className="text-sm flex flex-col gap-1">
        {logs.map((l) => (
          <li key={l.id} className="border-b border-united-dark/5 py-1">
            <span className="font-bold">{l.userName}</span> · {actionLabel(l.action)}{l.fieldChanged ? ` · ${l.fieldChanged}` : ""}{l.newValue ? `: ${l.oldValue ? changeText(l.oldValue, l.newValue, locale) : l.newValue}` : ""}
            {l.reason ? <span className="text-united-muted"> ({systemText(l.reason, locale)})</span> : null}
            <span className="text-xs text-united-muted"> · {new Date(l.timestamp).toLocaleString(intlLocale(locale), { dateStyle: "short", timeStyle: "short" })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
