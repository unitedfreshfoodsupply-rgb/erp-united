import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { getOrder } from "@/lib/orders-service";
import { prisma } from "@/lib/prisma";
import { STATUS_LABEL, STATUS_LABEL_EN } from "@/lib/orderPresentation";
import { printDir, printIntl, printLocale, printT } from "@/lib/locale/print";
import { timeLabel } from "@/lib/auditLabels";
import { getBaseUrl } from "@/lib/absoluteUrl";
import { orderQrSvg } from "@/lib/orderQr";
import { PrintBar } from "@/components/print/PrintBar";
import { PrintHeader } from "@/components/print/PrintHeader";
import { qty } from "@/lib/format";
import type { OrderStatus } from "@/lib/types";

export default async function DeliverySheetPage({ params, searchParams }: { params: { orderId: string }; searchParams?: { lang?: string } }) {
  const locale = printLocale(searchParams);
  const t = printT(locale);
  // orders.dispatch, not reports.view: this is the signed delivery/handoff document,
  // and the LOADER role is who's actually handing it to the driver/recipient at
  // dispatch. SUPERVISOR and SUPER_ADMIN already hold orders.dispatch too, so this
  // widens access to the loader without narrowing it for anyone who had it before.
  const gate = await requirePagePermission("orders.dispatch");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  const order = await getOrder(params.orderId).catch(() => null);
  if (!order) notFound();

  const [approval, dispatchLog] = await Promise.all([
    order.needsReview || order.shortage
      ? prisma.auditLog.findFirst({
          where: { orderId: order.id, action: "shortage_approved" },
          orderBy: { timestamp: "desc" },
        })
      : null,
    order.status === "dispatched"
      ? prisma.auditLog.findFirst({
          where: { orderId: order.id, newValue: "dispatched", action: { in: ["status_changed", "status_override"] } },
          orderBy: { timestamp: "desc" },
        })
      : null,
  ]);

  const qrSvg = await orderQrSvg(`${getBaseUrl()}/orders/${order.id}`);
  const preparedCount = order.items.filter((i) => i.preparationStatus === "done").length;
  const loadedCount = order.items.filter((i) => i.loadingStatus === "done").length;

  return (
    <main className="min-h-screen bg-white" dir={printDir(locale)} lang={locale}>
      <PrintBar backHref={`/orders/${order.id}`} />
      <div className="print-sheet max-w-3xl mx-auto p-6 text-united-dark">
        <PrintHeader
          locale={locale}
          titleAr="مستند التسليم"
          titleEn="Order / Delivery Sheet"
          orderNumber={order.orderNumber}
          customerName={order.customerName}
          externalId={order.externalId}
          deliveryDate={order.deliveryDate}
          deliveryTime={order.deliveryTime}
          qrSvg={qrSvg}
        />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-5 print-break-inside-avoid">
          <div className="border border-united-border rounded-lg p-2">
            <div className="text-united-dark/50 text-xs">{t("printdoc.status")}</div>
            <div className="font-extrabold">{(locale === "en" ? STATUS_LABEL_EN : STATUS_LABEL)[order.status as OrderStatus] ?? order.status}</div>
          </div>
          <div className="border border-united-border rounded-lg p-2">
            <div className="text-united-dark/50 text-xs">{t("printdoc.source")}</div>
            <div className="font-extrabold">{t(`printdoc.source.${order.source}`) === `printdoc.source.${order.source}` ? order.source : t(`printdoc.source.${order.source}`)}</div>
          </div>
          <div className="border border-united-border rounded-lg p-2">
            <div className="text-united-dark/50 text-xs">{t("printdoc.preparation")}</div>
            <div className="font-extrabold" dir="ltr">
              {preparedCount} / {order.items.length}
            </div>
          </div>
          <div className="border border-united-border rounded-lg p-2">
            <div className="text-united-dark/50 text-xs">{t("printdoc.loading")}</div>
            <div className="font-extrabold" dir="ltr">
              {loadedCount} / {order.items.length}
            </div>
          </div>
        </div>

        {order.notes && (
          <p className="text-sm bg-united-dark/5 rounded-lg p-3 mb-4 print-break-inside-avoid">
            {t("printdoc.notes", { notes: order.notes })}
          </p>
        )}

        <table className="w-full text-sm border-collapse mb-5">
          <thead>
            <tr className="bg-united-dark text-white">
              <th className="p-2 text-start">#</th>
              <th className="p-2 text-start">{t("printdoc.col.product")}</th>
              <th className="p-2 text-center">{t("printdoc.col.unit")}</th>
              <th className="p-2 text-center">{t("printdoc.col.required")}</th>
              <th className="p-2 text-center">{t("printdoc.col.prepared")}</th>
              <th className="p-2 text-center">{t("printdoc.col.loaded")}</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item, idx) => {
              const short =
                (item.loadedQuantity ?? item.preparedQuantity) != null &&
                (item.loadedQuantity ?? item.preparedQuantity)! < item.requiredQuantity;
              return (
                <tr key={item.id} className={`border-b border-united-border print-break-inside-avoid ${short ? "bg-red-50" : ""}`}>
                  <td className="p-2 text-start text-united-dark/50">{idx + 1}</td>
                  <td className="p-2 text-start font-bold">{item.productName}</td>
                  <td className="p-2 text-center">{item.unit}</td>
                  <td dir="ltr" className="p-2 text-center font-bold">{qty(item.requiredQuantity)}</td>
                  <td dir="ltr" className="p-2 text-center">{item.preparedQuantity != null ? qty(item.preparedQuantity) : "—"}</td>
                  <td dir="ltr" className="p-2 text-center">{item.loadedQuantity != null ? qty(item.loadedQuantity) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {(order.shortage || order.needsReview) && (
          <div className="border-2 border-united-danger/40 rounded-xl p-3 mb-5 text-sm print-break-inside-avoid">
            <div className="font-extrabold text-united-danger mb-1">{t("printdoc.qty-diff")}</div>
            {order.needsReview ? (
              <p className="text-united-danger font-bold">{t("printdoc.needs-approval")}</p>
            ) : approval ? (
              <p>
                {t("printdoc.approved-by")} <span className="font-bold">{approval.userName}</span> —{" "}
                {timeLabel(approval.timestamp.toISOString(), locale)}
                {approval.reason && t("printdoc.reason", { reason: approval.reason })}
              </p>
            ) : (
              <p>{t("printdoc.approved-generic")}</p>
            )}
          </div>
        )}

        {(order.vehicle || order.driverName || order.crateCount != null) && (
          <div className="border-2 border-united-dark/20 rounded-xl p-3 mb-5 text-sm print-break-inside-avoid">
            <div className="font-extrabold mb-1">{t("printdoc.dispatch-data")}</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div>
                <span className="text-united-dark/50">{t("printdoc.driver")}</span>
                <span className="font-bold">{order.driverName ?? "—"}</span>
              </div>
              <div>
                <span className="text-united-dark/50">{t("printdoc.vehicle")}</span>
                <span className="font-bold">{order.vehicle ?? "—"}</span>
              </div>
              <div>
                <span className="text-united-dark/50">{t("printdoc.crates")}</span>
                <span dir="ltr" className="font-bold">{order.crateCount ?? "—"}</span>
              </div>
              {dispatchLog && (
                <div>
                  <span className="text-united-dark/50">{t("printdoc.dispatch-time")}</span>
                  <span className="font-bold" dir="ltr">
                    {timeLabel(dispatchLog.timestamp.toISOString(), locale)}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-6 mt-10 text-sm print-break-inside-avoid">
          <div>
            <div className="border-b border-united-dark h-14" />
            <div className="text-united-dark/60 mt-1">{t("printdoc.receiver-sign")}</div>
            <div className="text-united-dark/40 text-xs">{t("printdoc.name-date")}</div>
          </div>
          <div>
            <div className="border-b border-united-dark h-14" />
            <div className="text-united-dark/60 mt-1">{t("printdoc.driver-sign")}</div>
            <div className="text-united-dark/40 text-xs">{t("printdoc.name-date")}</div>
          </div>
        </div>

        <p className="text-[10px] text-united-dark/30 mt-8">
          {t("printdoc.printed-at", { when: new Date().toLocaleString(printIntl(locale)), id: order.id })}
        </p>
      </div>
    </main>
  );
}
