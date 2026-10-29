import { isValidISODate } from "@/lib/dates";

export type ImportRow = { rowNumber: number; values: Record<string, string> };

const ARABIC_LETTER = /[\u0621-\u064A\u0671-\u06D3\u06FA-\u06FF]/;
const LATIN_LETTER = /[A-Za-z]/;
const BILINGUAL_KINDS = new Set(["customers", "customer_groups", "customer_legal_entities", "suppliers", "products"]);

/**
 * Arabic/English name columns must not be swapped: `name_ar` (and `legal_name_ar`) has
 * to contain Arabic script. Nothing is guessed or auto-corrected — the row is refused
 * so the person importing fixes the file, and the error says which way it looks swapped.
 */
function bilingualNameErrors(v: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [ar, en] of [["name_ar", "name"], ["legal_name_ar", "legal_name"]] as const) {
    const arValue = v[ar]?.trim();
    if (!arValue || ARABIC_LETTER.test(arValue)) continue;
    const enValue = v[en]?.trim() ?? "";
    errors.push(ARABIC_LETTER.test(enValue) && !LATIN_LETTER.test(enValue)
      ? `يبدو إن ${ar} و ${en} متبدلين (${ar} مفيهوش حروف عربية و${en} عربي) — صحح الأعمدة`
      : `${ar} لازم يكون الاسم بالعربي — سيبه فاضي لو مفيش اسم عربي`);
  }
  return errors;
}

/** Pure row-level validation so templates can be checked without loading a DB or API runtime. */
export function validateImportRow(kind: string, row: ImportRow, required: readonly string[]): string[] {
  const v = row.values;
  const errors: string[] = [];
  for (const name of required) if (!v[name]?.trim()) errors.push(`حقل ${name} مطلوب`);
  if (BILINGUAL_KINDS.has(kind)) errors.push(...bilingualNameErrors(v));
  // Customer/supplier codes come from the numbering service and are immutable; a code
  // in the file would otherwise be dropped silently while the card gets another one.
  // A code from the business's own records is kept as the system code; empty = generated.
  if ((kind === "customers" || kind === "suppliers") && v.code?.trim()) {
    const code = v.code.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/.test(code)) errors.push("الكود حروف إنجليزي وأرقام و . _ - / بحد أقصى 40");
    // CUS-/SUP- + digits is the generator's own series; a supplied one could collide later.
    else if (/^(CUS|SUP)-\d+$/i.test(code)) errors.push("أكواد CUS-/SUP- برقم محجوزة للترقيم التلقائي — استخدم كودكم أو سيب العمود فاضي");
  }
  if (kind === "customers" && v.type && !["hotel", "restaurant", "cafe", "retail", "wholesale", "institution", "other"].includes(v.type)) errors.push("type غير معروف");
  if (kind === "customers") {
    if (v.payment_terms_days && (!/^\d+$/.test(v.payment_terms_days) || Number(v.payment_terms_days) > 365)) errors.push("payment_terms_days لازم يكون من 0 إلى 365");
    if (v.credit_limit && (!/^\d+(\.\d{1,2})?$/.test(v.credit_limit) || Number(v.credit_limit) > 1_000_000_000_000)) errors.push("credit_limit لازم يكون مبلغًا صالحًا بخانتين عشريتين كحد أقصى");
    if (v.credit_hold && !["true", "false", "1", "0", "نعم", "لا"].includes(v.credit_hold.toLowerCase())) errors.push("credit_hold لازم يكون true أو false");
    const hasCredit = Boolean(v.payment_terms_days || v.credit_limit || v.credit_hold || v.credit_hold_reason);
    if (hasCredit && !v.credit_reason) errors.push("credit_reason مطلوب عند إدخال شروط ائتمان");
    const holdEnabled = ["true", "1", "نعم"].includes((v.credit_hold ?? "").toLowerCase());
    if (holdEnabled && !v.credit_hold_reason) errors.push("credit_hold_reason مطلوب عند إيقاف التعامل الآجل");
    if (!holdEnabled && v.credit_hold_reason) errors.push("credit_hold_reason لا يستخدم إلا مع credit_hold=true");
    if (v.price_list_code && !v.price_list_reason) errors.push("price_list_reason مطلوب عند ربط قائمة الأسعار");
    // Tax number format is validated below for any kind that carries it. The number
    // may repeat across cards — uniqueness is intentionally removed.
    if (v.tax_registration_no) {
      const normalized = v.tax_registration_no.replace(/[\s-]/g, "");
      if (!/^\d{9}$/.test(normalized)) errors.push("رقم التسجيل الضريبي لازم 9 أرقام — إذا كان الرقم مش 9 أرقام اترك الحقل فاضي وبلّغ عن المصدر");
    }
    if (v.group_code) {
      for (const code of v.group_code.split("|").map((x) => x.trim()).filter(Boolean)) {
        if (!/^[A-Za-z0-9_-]{1,20}$/.test(code)) errors.push(`group_code "${code}" غير صالح — حروف/أرقام/شرطة فقط`);
      }
    }
    if (v.legal_entity_code && !/^[A-Za-z0-9_-]{1,20}$/.test(v.legal_entity_code.trim())) errors.push("legal_entity_code غير صالح — حروف/أرقام/شرطة فقط");
  }
  if (kind === "customer_groups") {
    if (v.code && !/^[A-Za-z0-9_-]{1,20}$/.test(v.code.trim())) errors.push("code غير صالح — حروف/أرقام/شرطة فقط");
  }
  if (kind === "customer_legal_entities") {
    if (v.code && !/^[A-Za-z0-9_-]{1,20}$/.test(v.code.trim())) errors.push("code غير صالح — حروف/أرقام/شرطة فقط");
    if (v.tax_registration_no) {
      const normalized = v.tax_registration_no.replace(/[\s-]/g, "");
      if (!/^\d{9}$/.test(normalized)) errors.push("رقم التسجيل الضريبي لازم 9 أرقام");
    }
    if (v.receiver_type && !["B", "P", "F"].includes(v.receiver_type)) errors.push("receiver_type لازم B أو P أو F");
  }
  if (kind === "suppliers") {
    if (v.type && !["farm", "grower", "wholesaler", "market_trader", "importer", "packaging", "services", "other"].includes(v.type)) errors.push("type غير معروف");
    for (const key of ["payment_terms_days", "lead_time_days"]) if (v[key] && (!/^\d+$/.test(v[key]) || Number(v[key]) > 365)) errors.push(`${key} لازم يكون أيام صحيحة من 0 إلى 365`);
    if (v.currency_code && v.currency_code.toUpperCase() !== "EGP") errors.push("العملة الوحيدة المدعومة EGP");
  }
  if (kind === "products" && v.stock_tracked && !["true", "false", "1", "0", "نعم", "لا"].includes(v.stock_tracked.toLowerCase())) errors.push("stock_tracked لازم يكون true أو false");
  if (kind === "product_settings") {
    const fields = ["shelf_life_days", "removal_strategy", "min_stock_qty", "reorder_point_qty", "max_stock_qty", "cold_chain", "costing_method", "standard_cost"];
    if (!fields.some((key) => v[key])) errors.push("أدخل إعدادًا واحدًا على الأقل للصنف");
    if (v.shelf_life_days && (!/^\d+$/.test(v.shelf_life_days) || Number(v.shelf_life_days) < 1 || Number(v.shelf_life_days) > 3650)) errors.push("shelf_life_days لازم يكون من 1 إلى 3650 يومًا");
    if (v.removal_strategy && !["fefo", "fifo"].includes(v.removal_strategy)) errors.push("removal_strategy لازم fefo أو fifo");
    for (const key of ["min_stock_qty", "reorder_point_qty", "max_stock_qty"]) if (v[key] && (!/^\d+(\.\d{1,3})?$/.test(v[key]) || Number(v[key]) > 1_000_000_000_000)) errors.push(`${key} لازم يكون كمية موجبة أو صفر حتى 3 خانات عشرية`);
    if (v.cold_chain && !["true", "false", "1", "0", "نعم", "لا"].includes(v.cold_chain.toLowerCase())) errors.push("cold_chain لازم يكون true أو false");
    if (v.costing_method && !["avco", "fifo", "standard"].includes(v.costing_method)) errors.push("costing_method لازم avco أو fifo أو standard");
    if (v.standard_cost && (!/^\d+(\.\d{1,4})?$/.test(v.standard_cost) || Number(v.standard_cost) > 1_000_000_000_000)) errors.push("standard_cost لازم يكون مبلغًا صالحًا حتى 4 خانات عشرية");
    if (v.costing_method === "standard" && !v.standard_cost) errors.push("standard_cost مطلوب عند costing_method=standard");
    if (v.max_stock_qty && v.min_stock_qty && Number(v.min_stock_qty) > Number(v.max_stock_qty)) errors.push("min_stock_qty أكبر من max_stock_qty");
    if (v.max_stock_qty && v.reorder_point_qty && Number(v.reorder_point_qty) > Number(v.max_stock_qty)) errors.push("reorder_point_qty أكبر من max_stock_qty");
  }
  if (kind === "product_packaging") {
    if (v.qty_in_base_unit && (!/^\d+(\.\d{1,6})?$/.test(v.qty_in_base_unit) || Number(v.qty_in_base_unit) <= 0 || Number(v.qty_in_base_unit) > 1_000_000_000_000)) errors.push("qty_in_base_unit لازم يكون أكبر من صفر وحتى 6 خانات عشرية");
    if (v.active && !["true", "false", "1", "0", "نعم", "لا"].includes(v.active.toLowerCase())) errors.push("active لازم يكون true أو false");
  }
  if (kind === "opening_stock") {
    if (v.quantity && (!/^\d+(\.\d{1,3})?$/.test(v.quantity) || Number(v.quantity) <= 0)) errors.push("quantity لازم يكون أكبر من صفر وبحد أقصى 3 خانات عشرية");
    if (v.unit_cost && !/^\d+(\.\d{1,4})?$/.test(v.unit_cost)) errors.push("unit_cost لازم يكون رقم لحد 4 خانات عشرية");
    if (v.expiry_date && !isValidISODate(v.expiry_date)) errors.push("expiry_date لازم يكون YYYY-MM-DD");
  }
  if (kind === "opening_balances") {
    if (v.party_type && !["customer", "supplier"].includes(v.party_type)) errors.push("party_type لازم customer أو supplier");
    if (v.date && !isValidISODate(v.date)) errors.push("date لازم يكون YYYY-MM-DD");
    if (v.due_date && !isValidISODate(v.due_date)) errors.push("due_date لازم يكون YYYY-MM-DD");
    if (v.amount && (!/^-?\d+(\.\d{1,2})?$/.test(v.amount) || Number(v.amount) === 0)) errors.push("amount لازم يكون غير صفر وبحد أقصى خانتين عشريتين");
  }
  if (kind === "sales_prices" || kind === "supplier_prices") {
    if (v.unit_price && !/^\d+(\.\d{1,4})?$/.test(v.unit_price)) errors.push("unit_price لازم يكون رقم لحد 4 خانات عشرية");
    if (v.valid_from && !isValidISODate(v.valid_from)) errors.push("valid_from لازم يكون YYYY-MM-DD");
    if (v.valid_to && !isValidISODate(v.valid_to)) errors.push("valid_to لازم يكون YYYY-MM-DD");
    if (v.valid_from && v.valid_to && v.valid_to < v.valid_from) errors.push("valid_to مينفعش قبل valid_from");
    if (kind === "supplier_prices" && v.lead_time_days && (!/^\d+$/.test(v.lead_time_days) || Number(v.lead_time_days) > 365)) errors.push("lead_time_days لازم يكون من 0 إلى 365");
  }
  return errors;
}
