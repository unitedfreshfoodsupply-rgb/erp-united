"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { usePermissions } from "@/lib/use-session";
import { useLocale } from "@/lib/locale";
import { localName, otherLocalName } from "@/lib/locale/names";
import { maySeeSection } from "@/lib/profiles/access";
import { ErrorState, LoadingState } from "@/components/States";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { fmtMoney } from "@/components/stock/inventory/shared";
import { CustomerHistory, CustomerOverview } from "@/components/sales/CustomersView";
import { CustomerStatement } from "@/components/sales/InvoicesView";
import { DocSection, Figures, ProfileTabs, useSummary, useTabParam } from "./ProfileParts";
import { EtaIdentityCard } from "./EtaIdentityCard";

/**
 * One customer, everything about them (Nov 2026): who they are, what they ordered and
 * bought, what they were invoiced and paid, what came back, their statement and every
 * change to the record. Each tab's data comes from its own endpoint, gated on the server.
 */

type Tab = "overview" | "orders" | "invoices" | "payments" | "returns" | "products" | "statement" | "timeline" | "history";
type Summary = { orders?: number; openOrders?: number; lastOrderDate?: string | null; receivable?: string; netSales?: string; netSalesThisYear?: string; received?: string; lastReceiptDate?: string | null; paymentTermsDays?: number; creditLimit?: string | null; creditHold?: boolean };
type Head = { customer: { id: string; code: string; name: string; nameAr: string | null; active: boolean; creditHold: boolean; taxRegistrationNo: string | null; type: string } };

export function CustomerProfile({ customerId }: { customerId: string }) {
  const { t, locale } = useLocale();
  const { can } = usePermissions();
  // Same key as the overview tab (CustomerOverview), which mounts once this has loaded: 15 s
  // fresh, so opening the profile asks for the customer once, not twice (edits invalidate ["sales"]).
  const head = useQuery({ queryKey: ["sales", "customer", customerId], queryFn: () => apiFetch<Head>(`/api/sales/customers/${customerId}`), staleTime: 15_000 });
  const summary = useSummary<Summary>("customer", customerId);
  const sees = (s: string) => maySeeSection("customer", s, can);
  const items: { key: Tab; label: string }[] = [
    { key: "overview", label: t("profile.tab.overview") },
    ...(sees("orders") ? [{ key: "orders" as Tab, label: t("profile.tab.orders") }] : []),
    ...(sees("products") ? [{ key: "products" as Tab, label: t("profile.tab.products-bought") }] : []),
    ...(sees("invoices") ? [{ key: "invoices" as Tab, label: t("profile.tab.invoices") }] : []),
    ...(sees("payments") ? [{ key: "payments" as Tab, label: t("profile.tab.receipts") }] : []),
    ...(sees("returns") ? [{ key: "returns" as Tab, label: t("profile.tab.returns") }] : []),
    ...(can("sales.invoices.view") ? [{ key: "statement" as Tab, label: t("profile.tab.statement") }] : []),
    { key: "timeline", label: t("profile.tab.timeline") },
    { key: "history", label: t("profile.tab.history") },
  ];
  const [tab, setTab] = useTabParam(items.map((i) => i.key), "overview");
  if (head.isLoading) return <div className="page-container"><LoadingState /></div>;
  if (head.isError || !head.data) return <div className="page-container"><ErrorState message={errorMessage(head.error)} onRetry={() => head.refetch()} /></div>;
  const c = head.data.customer;
  const s = summary.data ?? {};
  const money = (v: string | null | undefined) => (v == null ? null : <span dir="ltr">{fmtMoney(v)}</span>);
  return (
    <div className="page-container">
      <PageHeader
        back={{ href: "/sales", label: t("profile.back.customers") }}
        title={localName(c, locale)}
        description={<><span dir="ltr">{c.code}</span>{otherLocalName(c, locale) ? ` · ${otherLocalName(c, locale)}` : ""}{c.taxRegistrationNo ? <> · <span dir="ltr">TAX {c.taxRegistrationNo}</span></> : null}</>}
        actions={!c.active ? <StatusPill tone="neutral" size="md">{t("sales.label.inactive")}</StatusPill> : c.creditHold && (can("sales.invoices.view") || can("sales.credit.manage")) ? <StatusPill tone="danger" size="md">{t("sales.label.on-hold")}</StatusPill> : null}
      />
      <Figures items={[
        { label: t("profile.fig.receivable"), value: money(s.receivable), tone: s.receivable && Number(s.receivable) > 0 ? "danger" : undefined },
        { label: t("profile.fig.net-sales-year"), value: money(s.netSalesThisYear) },
        { label: t("profile.fig.net-sales"), value: money(s.netSales) },
        { label: t("profile.fig.received"), value: money(s.received) },
        { label: t("profile.fig.credit-limit"), value: s.creditLimit === undefined ? null : s.creditLimit === null ? t("sales.credit-not-set") : money(s.creditLimit) },
        { label: t("profile.fig.orders"), value: s.orders == null ? null : `${s.orders.toLocaleString("en-US")}${s.openOrders ? ` · ${t("profile.fig.open", { n: s.openOrders })}` : ""}` },
        { label: t("profile.fig.last-order"), value: s.lastOrderDate ? <span dir="ltr">{s.lastOrderDate}</span> : null },
        { label: t("profile.fig.last-receipt"), value: s.lastReceiptDate ? <span dir="ltr">{s.lastReceiptDate}</span> : null },
      ]} />
      <ProfileTabs value={tab} onChange={setTab} items={items} />
      {tab === "overview" && <><CustomerOverview id={customerId} /><EtaIdentityCard customerId={customerId} /></>}
      {tab === "orders" && <DocSection kind="customer" id={customerId} section="orders" openFilter />}
      {tab === "products" && <DocSection kind="customer" id={customerId} section="products" groupsTitle={t("profile.by-product")} linesTitle={t("profile.order-lines")} />}
      {tab === "invoices" && <DocSection kind="customer" id={customerId} section="invoices" />}
      {tab === "payments" && <DocSection kind="customer" id={customerId} section="payments" />}
      {tab === "returns" && <DocSection kind="customer" id={customerId} section="returns" />}
      {tab === "statement" && <CustomerStatement customerId={customerId} />}
      {tab === "timeline" && <DocSection kind="customer" id={customerId} section="timeline" />}
      {tab === "history" && <CustomerHistory id={customerId} />}
    </div>
  );
}
