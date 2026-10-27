import {
  MOVEMENT_ICON,
  MOVEMENT_LABEL,
  fmtSignedKg,
  shortDate,
  timeLabel,
} from "@/lib/stockPresentation";
import type { MovementDTO } from "@/lib/stock-client-types";
import { localName } from "@/lib/locale/names";
import { useLocale } from "@/lib/locale";

/** One ledger line. Shows the signed quantity, because the sign is the whole point of
 * a ledger — a correction that removed 5kg has to look different from one that added it. */
export function MovementRow({ movement }: { movement: MovementDTO }) {
  const { locale, t } = useLocale();
  const positive = movement.quantityKg > 0;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="text-lg leading-none mt-0.5">{MOVEMENT_ICON[movement.kind]}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold text-united-dark truncate">{movement.product.name}</span>
          <span dir="ltr" className={`font-extrabold shrink-0 ${positive ? "text-united-green" : "text-united-danger"}`}>
            {fmtSignedKg(movement.quantityKg)} {movement.product.unit}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs font-bold text-united-muted">
          <span>{MOVEMENT_LABEL[movement.kind]}</span>
          {movement.intake && <span>· {movement.intake.receiptNumber}</span>}
          {movement.intake?.supplier?.name && <span>· {localName(movement.intake.supplier, locale)}</span>}
          <span dir="ltr">· {shortDate(movement.effectiveDate)} {timeLabel(movement.occurredAt)}</span>
          <span>· {movement.actorName}</span>
        </div>
        {movement.reason && (
          <p className="text-xs font-bold text-united-dark/70 mt-0.5">{t("audit.reason-prefix")} {movement.reason}</p>
        )}
      </div>
    </li>
  );
}
