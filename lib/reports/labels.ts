import { DICTIONARY } from "@/lib/locale/dictionary";
import type { ReportColumn } from "@/lib/reports/types";

/** A coded cell (a column with `labels`) in words, or null when the column is not coded or the
 * code has no entry (the code is then shown as stored). Used by the viewer and the exports. */
export function codedText(column: Pick<ReportColumn, "labels">, value: unknown, lang: "ar" | "en"): string | null {
  if (!column.labels || typeof value !== "string" || !value) return null;
  const entry = (DICTIONARY as Record<string, { ar: string; en: string } | undefined>)[`${column.labels}.${value}`];
  return entry ? entry[lang] : null;
}
