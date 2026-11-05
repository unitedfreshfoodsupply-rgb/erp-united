"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { usePermissions } from "@/lib/use-session";
import { href as profileHref } from "@/lib/profiles/links";
import { DocLink } from "@/components/profiles/EntityLink";

type Row = { id: string; number: string | null; status: string; total: string };

/** The order's invoice(s), for whoever may see invoices: open it, or print it once issued. */
export function OrderInvoices({ orderId }: { orderId: string }) {
  const { t } = useLocale();
  const { can } = usePermissions();
  const allowed = can("sales.invoices.view");
  const q = useQuery({
    queryKey: ["sales", "invoices", "order", orderId],
    queryFn: () => apiFetch<{ invoices: Row[] }>(`/api/sales/invoices?order_id=${encodeURIComponent(orderId)}&limit=10`),
    enabled: allowed,
  });
  if (!allowed || !q.data?.invoices.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm font-bold" data-testid="order-invoices">
      <span className="text-united-muted">{t("doc.order-invoice")}</span>
      {q.data.invoices.map((i) => (
        <span key={i.id} className="flex items-center gap-1">
          <DocLink href={profileHref.invoice(i.id)}>{i.number ?? t("sales.invoice.draft_number")}</DocLink>
          {i.status === "issued" && <Link href={`/sales/invoices/${i.id}/print`} target="_blank" className="text-xs text-united-green underline">{t("doc.print-ar")}</Link>}
          {i.status === "void" && <span className="text-xs text-united-muted">({t("sales.invoice.voided")})</span>}
        </span>
      ))}
    </div>
  );
}
