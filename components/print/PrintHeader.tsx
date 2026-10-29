import Image from "next/image";
import { printDir, printT, type PrintLocale } from "@/lib/locale/print";

export function PrintHeader({
  titleAr,
  titleEn,
  orderNumber,
  customerName,
  externalId,
  deliveryDate,
  deliveryTime,
  qrSvg,
  locale = "ar",
}: {
  /** The sheet's language: its title leads, the other language's title sits under it. */
  locale?: PrintLocale;
  titleAr: string;
  titleEn: string;
  orderNumber: string;
  customerName: string;
  externalId?: string | null;
  deliveryDate: string;
  deliveryTime?: string | null;
  qrSvg: string;
}) {
  const t = printT(locale);
  return (
    <div className="flex items-start justify-between gap-4 border-b-2 border-united-dark pb-4 mb-4 print-break-inside-avoid">
      <div className="flex items-start gap-3">
        <Image src="/brand/united-mark.png" alt="" width={44} height={44} className="shrink-0" />
        <div>
          <div className="font-extrabold text-lg text-united-dark leading-tight">UNITED</div>
          <div className="text-[10px] text-united-dark/50">Fruits &amp; Vegetables</div>
          <div className="mt-1.5 font-extrabold text-base text-united-dark">{locale === "en" ? titleEn : titleAr}</div>
          <div className="text-[10px] text-united-dark/50">{locale === "en" ? titleAr : titleEn}</div>
        </div>
      </div>

      <div className="text-center shrink-0" dir="ltr">
        <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
        <div className="text-[9px] text-united-dark/50 mt-1">{orderNumber}</div>
      </div>

      <div className="text-xs text-united-dark min-w-[180px] space-y-0.5" dir={printDir(locale)}>
        <div className="flex justify-between gap-3">
          <span className="text-united-dark/50">{t("print.order-number")}</span>
          <span className="font-extrabold">{orderNumber}</span>
        </div>
        {externalId && (
          <div className="flex justify-between gap-3">
            <span className="text-united-dark/50">PO</span>
            <span className="font-bold">{externalId}</span>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <span className="text-united-dark/50">{t("print.customer")}</span>
          <span className="font-bold">{customerName}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-united-dark/50">{t("print.delivery")}</span>
          <span className="font-bold" dir="ltr">
            {deliveryDate} {deliveryTime ?? ""}
          </span>
        </div>
      </div>
    </div>
  );
}
