import { unitLabel } from "@/lib/format";
import {
  MOVEMENT_ICON,
  movementLabel,
  fmtSignedKg,
  shortDate,
  timeLabel,
} from "@/lib/stockPresentation";
import type { MovementDTO } from "@/lib/stock-client-types";
import { localName } from "@/lib/locale/names";
import { useLocale } from "@/lib/locale";
import { EventIcon } from "@/components/ui/EventIcon";

/** One ledger line. Shows the signed quantity, because the sign is the whole point of
 * a ledger — a correction that removed 5kg has to look different from one that added it. */
export function MovementRow({ movement }: { movement: MovementDTO }) {
  const { locale, t } = useLocale();
  const positive = movement.quantityKg > 0;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${positive ? "bg-united-green/10 text-united-green" : "bg-[#FDECEA] text-united-danger"}`}>
        <EventIcon symbol={MOVEMENT_ICON[movement.kind]} size={14} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium text-united-dark">{localName(movement.product, locale)}</span>
          <span dir="ltr" className={`shrink-0 font-semibold ${positive ? "text-united-green" : "text-united-danger"}`}>
            {fmtSignedKg(movement.quantityKg)} {unitLabel(movement.product.unit)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-united-muted">
          <span>{movementLabel(movement.kind, locale)}</span>
          {movement.intake && <span>· <span dir="ltr">{movement.intake.receiptNumber}</span></span>}
          {movement.intake?.supplier?.name && <span>· {localName(movement.intake.supplier, locale)}</span>}
          <span dir="ltr">· {shortDate(movement.effectiveDate)} {timeLabel(movement.occurredAt, locale)}</span>
          <span>· {movement.actorName}</span>
        </div>
        {movement.reason && (
          <p className="mt-0.5 text-xs text-united-dark/80">{t("audit.reason-prefix")} {movement.reason}</p>
        )}
      </div>
    </li>
  );
}
