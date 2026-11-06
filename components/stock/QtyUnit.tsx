import { Fragment } from "react";
import { unitLabel } from "@/lib/format";

/**
 * A quantity with its unit that reads in the right order in both languages (FLOOR-2):
 * "21 كجم" in Arabic, "21 kg" in English. Only the number is isolated left-to-right, so a sign,
 * a decimal point or a thousands comma stays with its digits; the unit word follows it in the
 * reading direction. Wrapping the number and an Arabic unit together in dir="ltr" put the unit
 * first for an Arabic reader ("كجم 21").
 *
 * `value` is already formatted (qty(), fmtKg(), fmtSignedKg()); "—" (no figure) shows no unit.
 */
export function QtyUnit({ value, unit, className }: { value: string; unit?: string | null; className?: string }) {
  return (
    <span className={`whitespace-nowrap${className ? ` ${className}` : ""}`}>
      <span dir="ltr">{value}</span>
      {unit && value !== "—" ? ` ${unitLabel(unit)}` : null}
    </span>
  );
}

/** "300 كجم · 200 قطعة": one figure per unit, each in reading order. */
export function PerUnitQty({ rows }: { rows: readonly { value: string; unit: string }[] }) {
  return (
    <>
      {rows.map((r, i) => (
        <Fragment key={r.unit}>
          {i > 0 && " · "}
          <QtyUnit value={r.value} unit={r.unit} />
        </Fragment>
      ))}
    </>
  );
}
