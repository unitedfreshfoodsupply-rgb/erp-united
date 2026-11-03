import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { valuationReport } from "@/lib/inventory/reports";
import { csvResponse, exportLang, toCsv, toCsvColumns, tr } from "@/lib/core/csv-export";

/** Excel-safe CSV export of the inventory valuation report. */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "stock.valuation.view");
    const r = await valuationReport();
    // No ?lang: the original output (machine-key header). ?lang=ar|en: titled, translated.
    const lang = exportLang(new URL(req.url).searchParams);
    const rows: Record<string, unknown>[] = [
      { product: tr(lang ?? "ar", "قيمة المخزون", "Inventory value"), unit: r.currency, quantity: "", value: r.totalValue.toString(), averageCost: "" },
      ...r.rows.map((x) => ({
        product: lang === "en" ? x.productName : x.productNameAr ?? x.productName,
        unit: x.unit,
        quantity: x.quantity.toString(),
        value: x.value.toString(),
        averageCost: x.averageCost?.toString() ?? "",
      })),
    ];
    const columns = [{ key: "product", ar: "الصنف", en: "Product" }, { key: "unit", ar: "الوحدة", en: "Unit" }, { key: "quantity", ar: "الكمية", en: "Quantity" }, { key: "value", ar: "القيمة", en: "Value" }, { key: "averageCost", ar: "متوسط التكلفة", en: "Average cost" }];
    return csvResponse(lang ? toCsvColumns(rows, columns, lang) : toCsv(rows), `inventory-valuation-${new Date().toISOString().slice(0, 10)}`);
  } catch (err) {
    return handleApiError(err, req);
  }
}