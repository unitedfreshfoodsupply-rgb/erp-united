import type { Permission } from "@/lib/permissions";

/**
 * The report engine (maturity 2026-11). A report is a definition: what it is, who may
 * see it, which filters it takes, its columns, where each row drills to, and a function
 * that reads the authoritative source (the ledger for money, the stock ledger for stock,
 * the documents for operations). One viewer renders every report with the same filters,
 * totals, drill-down, print and bilingual CSV / Excel export.
 */
export type Bilingual = { ar: string; en: string };
export type ReportCategory = "financial" | "sales" | "purchasing" | "inventory" | "operations";
export type ColumnType = "text" | "code" | "date" | "money" | "qty" | "number" | "percent";
/** `cost`: a cost or a figure derived from cost (stock value, unit cost, cost of sales, margin). It is
 *  shown only to viewers who may see what stock is worth (stock.valuation.view), as everywhere else
 *  (lib/security/redact.ts): the report stays open to its other viewers without those columns. */
export type ReportColumn = { key: string; label: Bilingual; type: ColumnType; total?: boolean; cost?: boolean };
export type FilterKey = "period" | "customer" | "supplier" | "product" | "category" | "account" | "cashAccount" | "groupBy" | "days";

export type ReportParams = {
  from: string;
  to: string;
  customerId?: string;
  supplierId?: string;
  productId?: string;
  category?: string;
  accountId?: string;
  cashAccountId?: string;
  groupBy: "day" | "week" | "month" | "year";
  days: number;
};

export type ReportRow = Record<string, string | number | null> & { _href?: string | null; _tone?: "warn" | "danger" | null };
export type ReportResult = {
  rows: ReportRow[];
  /** Overrides the column sums (e.g. a balance that is not a sum). */
  totals?: Record<string, string | number | null>;
  /** Shown above the table: why a figure cannot be taken as complete. */
  warnings?: Bilingual[];
  /** Whose figures these are when a filter decides it (e.g. the cash account): under the period, and in the Excel title. */
  scope?: Bilingual;
};

export type ReportDef = {
  key: string;
  category: ReportCategory;
  title: Bilingual;
  description: Bilingual;
  /** Where the figures come from, and what they do not include. */
  notes?: Bilingual;
  /** Any one of these lets a user run the report. */
  permissions: Permission[];
  filters: FilterKey[];
  columns: ReportColumn[] | ((p: ReportParams) => ReportColumn[]);
  run?: (p: ReportParams) => Promise<ReportResult>;
  /** A report that already has its own screen: the catalogue links there (listed only to viewers who can open it). */
  href?: string;
};
