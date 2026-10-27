import { z } from "zod";

/**
 * The catalogue of system settings — every operational policy number the business
 * can tune without a code change.
 *
 * Code is the source of truth for WHICH settings exist, their type, their bounds and
 * their default. The database only stores values someone has deliberately changed
 * (see SystemSetting); a key with no row resolves to the default below. That makes
 * adding a setting a code change with no data migration, and makes "reset to default"
 * the same as "delete the override".
 *
 * Pure and dependency-light on purpose: it is imported by the client (to label and
 * validate the admin form) as well as the server.
 */

export const SETTING_GROUPS = ["orders", "approvals", "documents", "inventory", "sales", "purchasing", "accounting", "hr"] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export const SETTING_GROUP_LABEL: Record<SettingGroup, string> = {
  orders: "تشغيل الأوردرات",
  approvals: "الموافقات",
  documents: "المستندات والمرفقات",
  inventory: "المخزون",
  sales: "المبيعات والائتمان",
  purchasing: "المشتريات",
  accounting: "الحسابات",
  hr: "المصروفات والموظفين",
};

type Def<T> = {
  group: SettingGroup;
  label: string;
  description: string;
  /** Shown next to the value — "%", "دقيقة". */
  unit: string;
  schema: z.ZodType<T>;
  default: T;
};

function def<T>(d: Def<T>): Def<T> {
  return d;
}

/** An account code, or empty for "not set up" — the feature that needs it stays off. */
const accountCode = z.string().trim().max(20, "كود الحساب طويل").regex(/^[0-9A-Za-z._-]*$/, "كود حساب غير صالح");

const minutes = (max: number) => z.number().int("لازم يكون رقم صحيح").min(1, "أقل قيمة 1").max(max, `أكبر قيمة ${max}`);

export const SETTING_DEFS = {
  "orders.shortage_review_threshold_pct": def({
    group: "orders",
    label: "حد الفرق اللي محتاج اعتماد",
    description:
      "لو الكمية المتجهزة أو المتحملة فرقت عن المطلوب بأكتر من النسبة دي (زيادة أو نقص)، الأوردر بيقف لحد ما المشرف يعتمده.",
    unit: "%",
    schema: z.number().min(0, "أقل قيمة 0").max(100, "أكبر قيمة 100"),
    default: 5,
  }),
  "orders.waiting_to_start_minutes": def({
    group: "orders",
    label: "مهلة بدء التجهيز",
    description: "أوردر جديد محدش بدأ فيه بعد المدة دي بيظهر للمشرف إنه مستني.",
    unit: "دقيقة",
    schema: minutes(24 * 60),
    default: 20,
  }),
  "orders.stalled_minutes": def({
    group: "orders",
    label: "مهلة التوقف",
    description: "أوردر شغال محدش لمسه المدة دي بيتعلّم إنه متوقف.",
    unit: "دقيقة",
    schema: minutes(24 * 60),
    default: 45,
  }),
  "orders.delivery_soon_minutes": def({
    group: "orders",
    label: "تنبيه قرب ميعاد التسليم",
    description: "الأوردر بيتعلّم «قريب من الميعاد» لما يفضل على التسليم أقل من المدة دي.",
    unit: "دقيقة",
    schema: minutes(24 * 60),
    default: 60,
  }),
  "approvals.require_different_approver": def({
    group: "approvals",
    label: "الموافقة لازم تكون من شخص غير الطالب",
    description:
      "لو مفعّل، اللي طلب الموافقة (أو اللي سجّل الكمية الناقصة) مينفعش يوافق بنفسه — لازم شخص تاني عنده الصلاحية. مقفول افتراضيًا علشان المشرف يقدر يكمل الشغل لوحده لو مفيش غيره.",
    unit: "",
    schema: z.boolean({ invalid_type_error: "القيمة لازم تكون true أو false" }),
    default: false,
  }),
  "documents.max_upload_mb": def({
    group: "documents",
    label: "أقصى حجم للملف المرفوع",
    description: "أي ملف أكبر من كده بيترفض قبل ما يترفع.",
    unit: "ميجا",
    schema: z.number().int("لازم يكون رقم صحيح").min(1, "أقل قيمة 1").max(50, "أكبر قيمة 50"),
    default: 10,
  }),
  "inventory.default_warehouse_code": def({
    group: "inventory",
    label: "المخزن الافتراضي",
    description: "كود المخزن اللي الاستلام والتسويات بتروحله لما الشاشة متحددش مخزن.",
    unit: "",
    schema: z.string().trim().min(1, "الكود مطلوب").max(40).regex(/^[A-Z0-9][A-Z0-9_-]*$/, "كود مخزن غير صالح"),
    default: "WH-MAIN",
  }),
  "inventory.adjustment_approval_threshold": def({
    group: "inventory",
    label: "حد التسوية اللي محتاجة موافقة",
    description:
      "أي تسوية مخزون (زيادة أو نقص) أكبر من الكمية دي بوحدة الصنف الأساسية بتستنى موافقة قبل ما تتسجل. صفر = من غير موافقة.",
    unit: "بوحدة الصنف",
    schema: z.number().min(0, "أقل قيمة 0").max(1_000_000),
    default: 0,
  }),
  "inventory.expiry_warning_days": def({
    group: "inventory",
    label: "تنبيه قرب انتهاء الصلاحية",
    description: "الدفعات اللي هتنتهي صلاحيتها خلال الأيام دي بتظهر في تقرير قرب الانتهاء.",
    unit: "يوم",
    schema: z.number().int().min(0).max(365),
    default: 2,
  }),
  "inventory.grading_cost_policy": def({
    group: "inventory",
    label: "سياسة تكلفة الفرز",
    description:
      "proportional: كل مخرج بياخد نفس تكلفة الوحدة المدخلة (السلوك الحالي). nrv: توزيع التكلفة حسب القيمة السوقية النسبية للمخرجات القابلة للبيع.",
    unit: "",
    schema: z.enum(["proportional", "nrv"], { errorMap: () => ({ message: "القيمة لازم تكون proportional أو nrv" }) }),
    default: "proportional" as "proportional" | "nrv",
  }),
  "inventory.grading_waste_loss": def({
    group: "inventory",
    label: "معالجة هالك الفرز",
    description:
      "expense_at_grading: خسارة الهالك بتتسجل في الفرز. zero_basis: تكلفة الهالك بتتوزع على المخرجات القابلة للبيع.",
    unit: "",
    schema: z.enum(["expense_at_grading", "zero_basis"], { errorMap: () => ({ message: "القيمة لازم تكون expense_at_grading أو zero_basis" }) }),
    default: "expense_at_grading" as "expense_at_grading" | "zero_basis",
  }),
  "inventory.grading_price_missing": def({
    group: "inventory",
    label: "لو السعر مش موجود في الفرز",
    description:
      "fallback: يوزع بالتناسب (proportional) ويسجل السبب. refuse: يرفض الفرز.",
    unit: "",
    schema: z.enum(["fallback", "refuse"], { errorMap: () => ({ message: "القيمة لازم تكون fallback أو refuse" }) }),
    default: "fallback" as "fallback" | "refuse",
  }),
  "inventory.grading_loss_approval_threshold": def({
    group: "inventory",
    label: "حد خسارة الفرز اللي محتاجة موافقة",
    description:
      "لو خسارة الفرز (الجنية) أكبر من القيمة دي، بتستنى موافقة قبل ما تتسجل. صفر = من غير موافقة.",
    unit: "ج.م",
    schema: z.number().min(0, "أقل قيمة 0").max(1_000_000_000),
    default: 0,
  }),
  "inventory.dispatch_issue_policy": def({
    group: "inventory",
    label: "صرف المخزون عند خروج الأوردر",
    description:
      "lenient: الأوردر بيخرج دايماً، واللي ملوش رصيد كفاية أو صنفه مش معروف بيتسجل كاستثناء لأمين المخزن يراجعه. strict: الأوردر مايخرجش لو رصيد صنف متتبع مش كفاية.",
    unit: "",
    schema: z.enum(["lenient", "strict"], { errorMap: () => ({ message: "القيمة لازم تكون lenient أو strict" }) }),
    default: "lenient" as "lenient" | "strict",
  }),
  "sales.credit_check_mode": def({
    group: "sales",
    label: "رقابة الائتمان",
    description:
      "off: من غير رقابة. warn: الأوردر بيكمل، والحسابات بيوصلها تنبيه لو العميل الآجل عدّى حده أو موقوف. block: الأوردر مايبدأش تجهيز غير بموافقة الحسابات.",
    unit: "",
    schema: z.enum(["off", "warn", "block"], { errorMap: () => ({ message: "القيمة لازم تكون off أو warn أو block" }) }),
    default: "warn" as "off" | "warn" | "block",
  }),
  "sales.auto_reserve": def({
    group: "sales",
    label: "حجز المخزون تلقائياً للأوردرات",
    description:
      "لما يتفعّل: كل أوردر لصنف متتبع بيحجز من المتاح (على قد الموجود) لحد ما يخرج. يُفضّل يتفعّل بعد ما تسجيل الاستلامات يبقى كامل، لأن المحجوز مايتعملوش هالك أو تسوية.",
    unit: "",
    schema: z.boolean(),
    default: false as boolean,
  }),
  "sales.eta_person_id_threshold": def({
    group: "sales",
    label: "حد الرقم القومي في الفاتورة الإلكترونية",
    description: "فاتورة لشخص طبيعي (مش شركة) بالمبلغ ده أو أكتر مايتبعتش لمصلحة الضرائب من غير الرقم القومي للعميل. القيمة حسب قواعد المنظومة المنشورة — يتأكد منها المحاسب.",
    unit: "ج.م",
    schema: z.number().min(0).max(100_000_000),
    default: 50_000,
  }),
  "sales.quotation_validity_days": def({
    group: "sales",
    label: "صلاحية عرض السعر",
    description: "عدد الأيام اللي عرض السعر بيفضل ساري فيها لو مااتحددش تاريخ.",
    unit: "يوم",
    schema: z.number().int().min(1).max(90),
    default: 3,
  }),
  "auth.session_ttl_hours": def({
    group: "documents",
    label: "صلاحية الجلسة (ساعة)",
    description: "مدة سريان جلسة الدخول قبل ما المستخدم يضطر يعيد تسجيل الدخول. أي قيمة أقل من 1 ساعة بتتعامل كساعة واحدة.",
    unit: "ساعة",
    schema: z.number().min(1, "أقل قيمة 1").max(720, "أكبر قيمة 720 (شهر)"),
    default: 12,
  }),
  "auth.login_ip_lockout_threshold": def({
    group: "documents",
    label: "حد محاولات الدخول الغلط من نفس العنوان",
    description: "لو فشل تسجيل الدخول من نفس الـ IP بالعدد ده خلال 15 دقيقة، العنوان بيتقفل 15 دقيقة — حتى لو اليوزر مختلف. صفر = إيقاف القفل بالـ IP.",
    unit: "محاولة",
    schema: z.number().int().min(0).max(1000),
    default: 20,
  }),
  "purchasing.po_approval_threshold": def({
    group: "purchasing",
    label: "حد اعتماد أمر الشراء",
    description: "أمر الشراء اللي إجماليه أكبر من المبلغ ده بيستنى اعتماد الحسابات قبل ما يتبعت للمورد. صفر = كل أوامر الشراء محتاجة اعتماد.",
    unit: "ج.م",
    schema: z.number().min(0).max(100_000_000),
    default: 10000,
  }),
  "purchasing.over_receipt_tolerance_pct": def({
    group: "purchasing",
    label: "سماحية الاستلام الزيادة",
    description: "أقصى زيادة مسموح بيها في الاستلام فوق الكمية المطلوبة في أمر الشراء (الأوزان في الخضار والفاكهة مش بالظبط).",
    unit: "%",
    schema: z.number().min(0).max(100),
    default: 10,
  }),
  "purchasing.bill_match_tolerance_pct": def({
    group: "purchasing",
    label: "سماحية مطابقة فاتورة المورد",
    description: "لو قيمة فاتورة المورد (قبل الضريبة) مختلفة عن قيمة الاستلام بالسعر المتفق عليه بأكتر من النسبة دي، الفاتورة بتستنى اعتماد قبل الترحيل.",
    unit: "%",
    schema: z.number().min(0).max(100),
    default: 1,
  }),
  "purchasing.service_bill_approval_threshold": def({
    group: "purchasing",
    label: "حد اعتماد فواتير الخدمات",
    description: "فاتورة الخدمة (إيجار، كهرباء، نقل، صيانة، معدات…) اللي إجماليها أكبر من ده بتستنى اعتماد قبل الترحيل. صفر = كل فواتير الخدمات محتاجة اعتماد.",
    unit: "ج.م",
    schema: z.number().min(0).max(100_000_000),
    default: 0,
  }),
  "accounting.withholding_receivable_account": def({
    group: "accounting",
    label: "حساب الضريبة المخصومة من العملاء",
    description: "كود الحساب (أصول) اللي بيتسجل فيه مبلغ الخصم من المنبع اللي العميل خصمه من التحصيل. فاضي = الخصم ده مش متاح في التحصيل.",
    unit: "",
    schema: accountCode,
    default: "",
  }),
  "accounting.withholding_payable_account": def({
    group: "accounting",
    label: "حساب الضريبة المخصومة من الموردين",
    description: "كود الحساب (خصوم) اللي بيتسجل فيه مبلغ الخصم من المنبع اللي احنا خصمناه من سداد المورد. فاضي = الخصم ده مش متاح في السداد.",
    unit: "",
    schema: accountCode,
    default: "",
  }),
  "accounting.bank_charges_account": def({
    group: "accounting",
    label: "حساب مصاريف البنك",
    description: "كود حساب المصروفات اللي بتتسجل فيه عمولة البنك المخصومة من تحويل العميل. فاضي = مش متاح.",
    unit: "",
    schema: accountCode,
    default: "",
  }),
  "accounting.write_off_account": def({
    group: "accounting",
    label: "حساب فروق التحصيل",
    description: "كود حساب المصروفات اللي بيتسجل فيه الفرق الصغير اللي اتسامح فيه عند التحصيل. فاضي = مش متاح.",
    unit: "",
    schema: accountCode,
    default: "",
  }),
  "accounting.write_off_limit": def({
    group: "accounting",
    label: "حد فرق التحصيل المسموح",
    description: "أقصى فرق يتسامح فيه في التحصيل الواحد، وبصلاحية إدارة الحسابات بس. صفر = ممنوع.",
    unit: "ج.م",
    schema: z.number().min(0).max(1_000_000),
    default: 0,
  }),
  "hr.expense_approval_threshold": def({
    group: "hr",
    label: "حد اعتماد المصروفات",
    description: "المصروف اللي مبلغه أكبر من ده بيستنى اعتماد قبل ما يترحّل للحسابات. صفر = كل المصروفات محتاجة اعتماد.",
    unit: "ج.م",
    schema: z.number().min(0).max(10_000_000),
    default: 500,
  }),
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFS)[K]["default"];

export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SETTING_DEFS, value);
}

/** Validates a candidate value. Returns the parsed value or the first error message. */
export function parseSettingValue<K extends SettingKey>(
  key: K,
  raw: unknown
): { ok: true; value: SettingValue<K> } | { ok: false; error: string } {
  const result = (SETTING_DEFS[key].schema as z.ZodType<SettingValue<K>>).safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.issues[0]?.message ?? "قيمة غير صالحة" };
}

/** The thresholds the order boards and the command center classify against. Served to
 * the client too, so a card and the server can never disagree on "stalled". */
export type OperationalSettings = {
  shortageReviewThresholdPct: number;
  waitingToStartMinutes: number;
  stalledMinutes: number;
  deliverySoonMinutes: number;
};

export const DEFAULT_OPERATIONAL_SETTINGS: OperationalSettings = {
  shortageReviewThresholdPct: SETTING_DEFS["orders.shortage_review_threshold_pct"].default,
  waitingToStartMinutes: SETTING_DEFS["orders.waiting_to_start_minutes"].default,
  stalledMinutes: SETTING_DEFS["orders.stalled_minutes"].default,
  deliverySoonMinutes: SETTING_DEFS["orders.delivery_soon_minutes"].default,
};
export const SETTING_GROUP_LABEL_EN: Record<string, string> = {
  "orders": "Order Operations",
  "approvals": "Approvals",
  "documents": "Documents & Attachments",
  "inventory": "Inventory",
  "sales": "Sales & Credit",
  "purchasing": "Purchasing",
  "hr": "Expenses & Employees",
};

export const SETTING_LABEL_EN: Record<string, string> = {
  "approvals.hr_expense": "Expense Approval",
  "approvals.order_shortage": "Order Shortage Approval",
  "approvals.purchasing_bill": "Supplier Bill Approval",
  "approvals.purchasing_order": "Purchase Order Approval",
  "approvals.sales_credit": "Sales Credit Approval",
  "approvals.stock_adjustment": "Stock Adjustment Approval",
  "auth.login_ip_lockout_threshold": "IP Lockout Threshold",
  "auth.session_ttl_hours": "Session TTL (hours)",
  "documents.allowed_file_types": "Allowed File Types",
  "documents.max_attachment_size_mb": "Max Attachment Size (MB)",
  "inventory.adjustment_approval_threshold": "Adjustment Approval Threshold",
  "inventory.default_warehouse": "Default Warehouse",
  "inventory.dispatch_issue_policy": "Dispatch Issue Policy",
  "inventory.expiry_warning_days": "Expiry Warning Days",
  "inventory.grading_cost_policy": "Grading Cost Policy",
  "inventory.grading_loss_approval_threshold": "Grading Loss Approval Threshold",
  "inventory.grading_price_missing": "Missing Price in Grading",
  "inventory.grading_waste_loss": "Waste Loss Treatment",
  "orders.default_uom": "Default Unit of Measure",
  "orders.load_time_minutes": "Load Time Goal (minutes)",
  "orders.prep_time_minutes": "Prep Time Goal (minutes)",
  "orders.price_list_validity_days": "Price List Validity (days)",
  "purchasing.auto_receive": "Auto Receive on Bill",
  "purchasing.bill_matching_tolerance": "Bill Matching Tolerance",
  "purchasing.receiving_tolerance": "Receiving Tolerance",
  "sales.auto_reserve": "Auto Reserve Stock",
  "sales.credit_check_mode": "Credit Check Mode",
};

export const SETTING_DESC_EN: Record<string, string> = {
  "approvals.hr_expense": "Require approval for expense claims above the configured threshold.",
  "approvals.order_shortage": "Require approval when an order line shortage exceeds the threshold.",
  "approvals.purchasing_bill": "Require approval for supplier bills above the configured threshold.",
  "approvals.purchasing_order": "Require approval for purchase orders above the configured threshold.",
  "approvals.sales_credit": "Require approval for orders that exceed the customer's credit limit.",
  "approvals.stock_adjustment": "Require approval for stock adjustments above the configured threshold.",
  "auth.login_ip_lockout_threshold": "Number of failed attempts from the same IP before temporary lockout. 0 = disabled.",
  "auth.session_ttl_hours": "Duration in hours before a user session expires and requires re-login.",
  "documents.allowed_file_types": "Comma-separated list of allowed MIME types for file uploads.",
  "documents.max_attachment_size_mb": "Maximum file size in MB for uploaded attachments.",
  "inventory.adjustment_approval_threshold": "Any stock adjustment (increase or decrease) larger than this quantity in the product's base unit requires approval before posting. Zero = no approval needed.",
  "inventory.default_warehouse": "The warehouse code that receipts and adjustments go to when no warehouse is specified on the screen.",
  "inventory.dispatch_issue_policy": "lenient: the order always dispatches; items without sufficient stock or unknown products are logged as exceptions. strict: the order will not dispatch if a tracked product has insufficient stock.",
  "inventory.expiry_warning_days": "Lots expiring within this many days appear in the expiry report.",
  "inventory.grading_cost_policy": "proportional: each output gets the same unit cost as the input (current behavior). nrv: cost is distributed by relative market value of saleable outputs.",
  "inventory.grading_loss_approval_threshold": "If the grading loss (EGP) exceeds this value, it waits for approval before posting. Zero = no approval needed.",
  "inventory.grading_price_missing": "fallback: distributes proportionally and logs the reason. refuse: rejects the grading.",
  "inventory.grading_waste_loss": "expense_at_grading: waste loss is recorded at sorting time. zero_basis: waste cost is distributed to saleable outputs.",
  "orders.default_uom": "Default unit of measure for new products.",
  "orders.load_time_minutes": "Target loading time per order. Used for performance tracking.",
  "orders.prep_time_minutes": "Target preparation time per order. Used for performance tracking on the supervisor board.",
  "orders.price_list_validity_days": "How many days into the future a new price list is valid.",
  "purchasing.auto_receive": "Automatically record receipt when a supplier bill is posted.",
  "purchasing.bill_matching_tolerance": "Tolerance percentage for 3-way matching (PO x Receipt x Bill).",
  "purchasing.receiving_tolerance": "Tolerance percentage for over/under receipt against purchase order lines.",
  "sales.auto_reserve": "Automatically reserve stock against orders when they enter preparation.",
  "sales.credit_check_mode": "off: no credit check. warn: the order proceeds; accounting gets an alert if the customer exceeds their limit or is on hold. block: the order cannot start preparation without accounting approval.",
};
