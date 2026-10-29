/**
 * Baseline reference and organisation data.
 *
 * Production receives these rows once, from migration
 * `…_add_org_master_data` (a frozen copy — migrations never change after they ship).
 * The test/demo seed loads them from here. After that they are ordinary master data:
 * an administrator corrects names, capacities and temperatures in the admin centre.
 *
 * The physical figures below are the approximate ones the business gave (a ~1200 m²
 * site, ~60 t/day, two ~10 t cold rooms). They are starting values to be confirmed,
 * not constants anything depends on.
 *
 * Stable ids let a later migration (Phase 2: stock movements gain a warehouse and a
 * location) backfill existing rows to the main warehouse without a lookup by name.
 */

export const BASE_CURRENCY_CODE = "EGP";

export const CURRENCIES = [
  { code: "EGP", name: "Egyptian Pound", nameAr: "جنيه مصري", symbol: "ج.م", decimalPlaces: 2 },
  { code: "USD", name: "US Dollar", nameAr: "دولار أمريكي", symbol: "$", decimalPlaces: 2 },
  { code: "EUR", name: "Euro", nameAr: "يورو", symbol: "€", decimalPlaces: 2 },
] as const;

/** Tax classes — the same rows migration `…_sales_pricing` inserts. */
export const TAX_RATES = [
  { code: "EXEMPT", name: "VAT exempt", nameAr: "معفى من ضريبة القيمة المضافة", rate: "0", etaType: "T1", etaSubtype: "V003" },
  { code: "VAT14", name: "VAT 14%", nameAr: "ضريبة قيمة مضافة 14%", rate: "14", etaType: "T1", etaSubtype: "V009" },
  { code: "VAT0", name: "VAT 0% (export)", nameAr: "ضريبة صفرية (تصدير)", rate: "0", etaType: "T1", etaSubtype: "V001" },
] as const;

export type UomCategory = "weight" | "volume" | "count" | "package";

export const UOM_CATEGORIES: UomCategory[] = ["weight", "volume", "count", "package"];

export const UOM_CATEGORY_LABEL: Record<UomCategory, string> = {
  weight: "وزن",
  volume: "حجم",
  count: "عدد",
  package: "تعبئة",
};

export const UOM_CATEGORY_LABEL_EN: Record<UomCategory, string> = {
  weight: "Weight",
  volume: "Volume",
  count: "Count",
  package: "Package",
};

export const UNITS_OF_MEASURE: {
  id: string;
  code: string;
  name: string;
  nameAr: string;
  category: UomCategory;
  ratioToReference: string | null;
  isReference: boolean;
  precision: number;
}[] = [
  { id: "uom_kg", code: "KG", name: "Kilogram", nameAr: "كيلو", category: "weight", ratioToReference: "1", isReference: true, precision: 3 },
  { id: "uom_g", code: "G", name: "Gram", nameAr: "جرام", category: "weight", ratioToReference: "0.001", isReference: false, precision: 0 },
  { id: "uom_ton", code: "TON", name: "Tonne", nameAr: "طن", category: "weight", ratioToReference: "1000", isReference: false, precision: 3 },
  { id: "uom_l", code: "L", name: "Litre", nameAr: "لتر", category: "volume", ratioToReference: "1", isReference: true, precision: 3 },
  { id: "uom_ml", code: "ML", name: "Millilitre", nameAr: "مللي", category: "volume", ratioToReference: "0.001", isReference: false, precision: 0 },
  { id: "uom_piece", code: "PIECE", name: "Piece", nameAr: "قطعة", category: "count", ratioToReference: "1", isReference: true, precision: 0 },
  { id: "uom_dozen", code: "DOZEN", name: "Dozen", nameAr: "دستة", category: "count", ratioToReference: "12", isReference: false, precision: 0 },
  { id: "uom_crate", code: "CRATE", name: "Crate", nameAr: "برنيكة", category: "package", ratioToReference: null, isReference: false, precision: 0 },
  { id: "uom_box", code: "BOX", name: "Box", nameAr: "صندوق", category: "package", ratioToReference: null, isReference: false, precision: 0 },
  { id: "uom_carton", code: "CARTON", name: "Carton", nameAr: "كرتونة", category: "package", ratioToReference: null, isReference: false, precision: 0 },
  { id: "uom_pallet", code: "PALLET", name: "Pallet", nameAr: "باليتة", category: "package", ratioToReference: null, isReference: false, precision: 0 },
  { id: "uom_bunch", code: "BUNCH", name: "Bunch", nameAr: "ربطة", category: "package", ratioToReference: null, isReference: false, precision: 0 },
];

export const STORAGE_LOCATION_TYPES = [
  "cold_room",
  "chiller",
  "freezer",
  "dry",
  "receiving",
  "staging",
  "dispatch",
  "quarantine",
  "other",
  "waste",
] as const;
export type StorageLocationType = (typeof STORAGE_LOCATION_TYPES)[number];

export const STORAGE_LOCATION_TYPE_LABEL: Record<StorageLocationType, string> = {
  cold_room: "غرفة تبريد",
  chiller: "ثلاجة",
  freezer: "فريزر",
  dry: "تخزين جاف",
  receiving: "استلام",
  staging: "تجهيز",
  dispatch: "تحميل",
  quarantine: "حجز/فحص",
  other: "أخرى",
  waste: "هالك",
};

export const STORAGE_LOCATION_TYPE_LABEL_EN: Record<StorageLocationType, string> = {
  cold_room: "Cold room",
  chiller: "Chiller",
  freezer: "Freezer",
  dry: "Dry storage",
  receiving: "Receiving",
  staging: "Staging",
  dispatch: "Dispatch",
  quarantine: "Quarantine",
  other: "Other",
  waste: "Waste",
};

/** A location type's label in `locale`; an unknown type shows its raw code. */
export function storageLocationTypeLabel(type: string, locale: "ar" | "en"): string {
  const labels: Record<string, string> = locale === "en" ? STORAGE_LOCATION_TYPE_LABEL_EN : STORAGE_LOCATION_TYPE_LABEL;
  return labels[type] ?? type;
}

export const DEFAULT_ORG = {
  company: {
    id: "cmp_united",
    code: "UNITED",
    legalName: "UNITED Fresh Food Supply",
    baseCurrencyCode: BASE_CURRENCY_CODE,
  },
  branch: { id: "brn_main", companyId: "cmp_united", code: "MAIN", name: "Main branch", nameAr: "الفرع الرئيسي" },
  warehouse: {
    id: "wh_main",
    branchId: "brn_main",
    code: "WH-MAIN",
    name: "Main warehouse",
    nameAr: "المخزن الرئيسي",
    areaM2: "1200",
    dailyCapacityKg: "60000",
  },
  locations: [
    { id: "loc_cold_1", warehouseId: "wh_main", code: "COLD-1", name: "Cold room 1", nameAr: "غرفة تبريد 1", type: "cold_room", capacityKg: "10000" },
    { id: "loc_cold_2", warehouseId: "wh_main", code: "COLD-2", name: "Cold room 2", nameAr: "غرفة تبريد 2", type: "cold_room", capacityKg: "10000" },
    { id: "loc_recv", warehouseId: "wh_main", code: "RECV", name: "Receiving bay", nameAr: "منطقة الاستلام", type: "receiving", capacityKg: null },
    { id: "loc_disp", warehouseId: "wh_main", code: "DISP", name: "Dispatch dock", nameAr: "منطقة التحميل", type: "dispatch", capacityKg: null },
    { id: "loc_grade_b", warehouseId: "wh_main", code: "GRADE-B", name: "Second grade / فرزة", nameAr: "فرزة", type: "cold_room", capacityKg: null },
    { id: "loc_waste", warehouseId: "wh_main", code: "WASTE", name: "Spoilage / waste", nameAr: "هالك وتوالف", type: "waste", capacityKg: null },
    { id: "loc_quarantine", warehouseId: "wh_main", code: "QUAR", name: "Quarantine (returns)", nameAr: "حجر صحي (مرتجعات)", type: "quarantine", capacityKg: null },
  ],
} as const;

/** The default chart of accounts — the same rows the accounting_core migration inserts.
 * Parents come before children. */
export const CHART_OF_ACCOUNTS: { id: string; code: string; name: string; nameAr: string; type: string; parentId: string | null; postable: boolean; systemKey: string | null }[] = [
  { id: "acc_1000", code: "1000", name: "Assets", nameAr: "الأصول", type: "asset", parentId: null, postable: false, systemKey: null },
  { id: "acc_1100", code: "1100", name: "Cash on hand", nameAr: "النقدية بالخزينة", type: "asset", parentId: "acc_1000", postable: true, systemKey: "cash" },
  { id: "acc_1200", code: "1200", name: "Bank", nameAr: "البنك", type: "asset", parentId: "acc_1000", postable: true, systemKey: "bank" },
  { id: "acc_1300", code: "1300", name: "Accounts receivable", nameAr: "العملاء (ذمم مدينة)", type: "asset", parentId: "acc_1000", postable: true, systemKey: "ar" },
  { id: "acc_1400", code: "1400", name: "Inventory", nameAr: "المخزون", type: "asset", parentId: "acc_1000", postable: true, systemKey: "inventory" },
  { id: "acc_1500", code: "1500", name: "VAT input", nameAr: "ضريبة القيمة المضافة — مشتريات", type: "asset", parentId: "acc_1000", postable: true, systemKey: "vat_input" },
  { id: "acc_1600", code: "1600", name: "Employee advances", nameAr: "سلف العاملين", type: "asset", parentId: "acc_1000", postable: true, systemKey: "employee_advances" },
  { id: "acc_2000", code: "2000", name: "Liabilities", nameAr: "الخصوم", type: "liability", parentId: null, postable: false, systemKey: null },
  { id: "acc_2100", code: "2100", name: "Accounts payable", nameAr: "الموردين (ذمم دائنة)", type: "liability", parentId: "acc_2000", postable: true, systemKey: "ap" },
  { id: "acc_2150", code: "2150", name: "Goods received not invoiced", nameAr: "بضاعة مستلمة لم تصل فواتيرها", type: "liability", parentId: "acc_2000", postable: true, systemKey: "grni" },
  { id: "acc_2200", code: "2200", name: "VAT output", nameAr: "ضريبة القيمة المضافة — مبيعات", type: "liability", parentId: "acc_2000", postable: true, systemKey: "vat_output" },
  { id: "acc_2300", code: "2300", name: "Employee reimbursements payable", nameAr: "مستحقات العاملين", type: "liability", parentId: "acc_2000", postable: true, systemKey: "employee_payable" },
  { id: "acc_3000", code: "3000", name: "Equity", nameAr: "حقوق الملكية", type: "equity", parentId: null, postable: false, systemKey: null },
  { id: "acc_3100", code: "3100", name: "Capital", nameAr: "رأس المال", type: "equity", parentId: "acc_3000", postable: true, systemKey: "capital" },
  { id: "acc_3300", code: "3300", name: "Opening balance equity", nameAr: "أرصدة افتتاحية", type: "equity", parentId: "acc_3000", postable: true, systemKey: "opening_equity" },
  { id: "acc_3200", code: "3200", name: "Retained earnings", nameAr: "الأرباح المحتجزة", type: "equity", parentId: "acc_3000", postable: true, systemKey: "retained_earnings" },
  { id: "acc_4000", code: "4000", name: "Revenue", nameAr: "الإيرادات", type: "revenue", parentId: null, postable: false, systemKey: null },
  { id: "acc_4100", code: "4100", name: "Sales", nameAr: "المبيعات", type: "revenue", parentId: "acc_4000", postable: true, systemKey: "sales" },
  { id: "acc_4200", code: "4200", name: "Sales returns and allowances", nameAr: "مردودات ومسموحات المبيعات", type: "revenue", parentId: "acc_4000", postable: true, systemKey: "sales_returns" },
  { id: "acc_5000", code: "5000", name: "Cost of sales", nameAr: "تكلفة المبيعات", type: "expense", parentId: null, postable: false, systemKey: null },
  { id: "acc_5100", code: "5100", name: "Cost of goods sold", nameAr: "تكلفة البضاعة المباعة", type: "expense", parentId: "acc_5000", postable: true, systemKey: "cogs" },
  { id: "acc_5200", code: "5200", name: "Inventory adjustments and write-offs", nameAr: "تسويات وهالك المخزون", type: "expense", parentId: "acc_5000", postable: true, systemKey: "inventory_adjustment" },
  { id: "acc_5300", code: "5300", name: "Purchase price variance", nameAr: "فروق أسعار المشتريات", type: "expense", parentId: "acc_5000", postable: true, systemKey: "ppv" },
  { id: "acc_6000", code: "6000", name: "Operating expenses", nameAr: "المصروفات", type: "expense", parentId: null, postable: false, systemKey: null },
  { id: "acc_6100", code: "6100", name: "General expenses", nameAr: "مصروفات عمومية", type: "expense", parentId: "acc_6000", postable: true, systemKey: "general_expenses" },
  { id: "acc_6200", code: "6200", name: "Transport and fuel", nameAr: "نقل ووقود", type: "expense", parentId: "acc_6000", postable: true, systemKey: "transport_expenses" },
  { id: "acc_6300", code: "6300", name: "Salaries and wages", nameAr: "مرتبات وأجور", type: "expense", parentId: "acc_6000", postable: true, systemKey: "salaries" },
];

export const CASH_ACCOUNTS = [
  { id: "cash_main", code: "CASH", name: "Main cash", nameAr: "الخزينة الرئيسية", type: "cash", accountId: "acc_1100" },
  { id: "bank_main", code: "BANK", name: "Bank account", nameAr: "الحساب البنكي", type: "bank", accountId: "acc_1200" },
];
