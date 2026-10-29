import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { getOrder } from "@/lib/orders-service";
import { getBaseUrl } from "@/lib/absoluteUrl";
import { orderQrSvg } from "@/lib/orderQr";
import { PrintBar } from "@/components/print/PrintBar";
import { PrintHeader } from "@/components/print/PrintHeader";
import { qty, unitLabel } from "@/lib/format";
import { printDir, printIntl, printLocale, printT } from "@/lib/locale/print";

/** What a loader needs: how much to load per item, and the manifest (driver /
 * vehicle / crates) — filled in already if the order has actually been
 * dispatched, otherwise left blank to write on paper during loading. Never
 * prints a driver/vehicle/crate value that isn't really on the order. */
export default async function DispatchSheetPage({ params, searchParams }: { params: { orderId: string }; searchParams?: { lang?: string } }) {
  const locale = printLocale(searchParams);
  const t = printT(locale);
  const gate = await requirePagePermission("orders.load");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  const order = await getOrder(params.orderId).catch(() => null);
  if (!order) notFound();

  const qrSvg = await orderQrSvg(`${getBaseUrl()}/orders/${order.id}`);
  const isDispatched = order.status === "dispatched";

  return (
    <main className="min-h-screen bg-white" dir={printDir(locale)} lang={locale}>
      <PrintBar backHref={`/orders/${order.id}`} />
      <div className="print-sheet max-w-3xl mx-auto p-6 text-united-dark">
        <PrintHeader
          locale={locale}
          titleAr="شيت التحميل / التسليم"
          titleEn="Loading and dispatch sheet"
          orderNumber={order.orderNumber}
          customerName={order.customerName}
          deliveryDate={order.deliveryDate}
          deliveryTime={order.deliveryTime}
          qrSvg={qrSvg}
        />

        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-united-dark text-white">
              <th className="p-2 text-start">#</th>
              <th className="p-2 text-start">{t("printdoc.col.product")}</th>
              <th className="p-2 text-center">{t("printdoc.col.unit")}</th>
              <th className="p-2 text-center">{t("printdoc.col.prepared-to-load")}</th>
              <th className="p-2 text-center">{t("printdoc.col.actually-loaded")}</th>
              <th className="p-2 text-center">✓</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item, idx) => (
              <tr key={item.id} className="border-b border-united-border print-break-inside-avoid">
                <td className="p-2 text-start text-united-dark/50">{idx + 1}</td>
                <td className="p-2 text-start font-bold text-base">{item.productName}</td>
                <td className="p-2 text-center">{unitLabel(item.unit, locale)}</td>
                <td dir="ltr" className="p-2 text-center font-extrabold text-base">
                  {qty(item.preparedQuantity ?? item.requiredQuantity)}
                </td>
                <td className="p-2 text-center">
                  {item.loadedQuantity != null ? (
                    <span dir="ltr" className="font-bold">{qty(item.loadedQuantity)}</span>
                  ) : (
                    <div className="border-b border-united-dark/50 h-8 w-24 mx-auto" />
                  )}
                </td>
                <td className="p-2 text-center">
                  <div className="border-2 border-united-dark/40 rounded w-7 h-7 mx-auto" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="border-2 border-united-dark/20 rounded-xl p-4 mt-6 text-sm print-break-inside-avoid">
          <div className="font-extrabold mb-2">{t("printdoc.dispatch-data")} {isDispatched ? "" : t("printdoc.fill-at-dispatch")}</div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-united-dark/50 text-xs mb-1">{t("printdoc.driver-name")}</div>
              {order.driverName ? (
                <div className="font-bold">{order.driverName}</div>
              ) : (
                <div className="border-b border-united-dark/50 h-8" />
              )}
            </div>
            <div>
              <div className="text-united-dark/50 text-xs mb-1">{t("printdoc.vehicle-name")}</div>
              {order.vehicle ? (
                <div className="font-bold">{order.vehicle}</div>
              ) : (
                <div className="border-b border-united-dark/50 h-8" />
              )}
            </div>
            <div>
              <div className="text-united-dark/50 text-xs mb-1">{t("printdoc.crate-count")}</div>
              {order.crateCount != null ? (
                <div dir="ltr" className="font-bold">{order.crateCount}</div>
              ) : (
                <div className="border-b border-united-dark/50 h-8" />
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6 mt-10 text-sm print-break-inside-avoid">
          <div>
            <div className="border-b border-united-dark h-14" />
            <div className="text-united-dark/60 mt-1">{t("printdoc.driver-sign-goods")}</div>
          </div>
          <div>
            <div className="border-b border-united-dark h-14" />
            <div className="text-united-dark/60 mt-1">{t("printdoc.supervisor-sign")}</div>
          </div>
        </div>

        <p className="text-[10px] text-united-dark/30 mt-8">
          {t("printdoc.printed-at", { when: new Date().toLocaleString(printIntl(locale)), id: order.id })}
        </p>
      </div>
    </main>
  );
}
