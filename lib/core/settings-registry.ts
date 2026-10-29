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
      "بالتناسب: كل مخرج بياخد نفس تكلفة الوحدة المدخلة (السلوك الحالي). حسب القيمة السوقية: التكلفة بتتوزع حسب القيمة السوقية النسبية للمخرجات القابلة للبيع.",
    unit: "",
    schema: z.enum(["proportional", "nrv"], { errorMap: () => ({ message: "القيمة لازم تكون proportional أو nrv" }) }),
    default: "proportional" as "proportional" | "nrv",
  }),
  "inventory.grading_waste_loss": def({
    group: "inventory",
    label: "معالجة هالك الفرز",
    description:
      "وقت الفرز: خسارة الهالك بتتسجل في الفرز نفسه. على المخرجات: تكلفة الهالك بتتوزع على المخرجات القابلة للبيع.",
    unit: "",
    schema: z.enum(["expense_at_grading", "zero_basis"], { errorMap: () => ({ message: "القيمة لازم تكون expense_at_grading أو zero_basis" }) }),
    default: "expense_at_grading" as "expense_at_grading" | "zero_basis",
  }),
  "inventory.grading_price_missing": def({
    group: "inventory",
    label: "لو السعر مش موجود في الفرز",
    description:
      "توزيع بالتناسب: يكمل الفرز ويوزع التكلفة بالتناسب ويسجل السبب. رفض: يرفض الفرز لحد ما السعر يتسجل.",
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
      "مرن: الأوردر بيخرج دايماً، واللي ملوش رصيد كفاية أو صنفه مش معروف بيتسجل كاستثناء لأمين المخزن يراجعه. صارم: الأوردر مايخرجش لو رصيد صنف متتبع مش كفاية.",
    unit: "",
    schema: z.enum(["lenient", "strict"], { errorMap: () => ({ message: "القيمة لازم تكون lenient أو strict" }) }),
    default: "lenient" as "lenient" | "strict",
  }),
  "sales.credit_check_mode": def({
    group: "sales",
    label: "رقابة الائتمان",
    description:
      "إيقاف: من غير رقابة. تنبيه: الأوردر بيكمل، والحسابات بيوصلها تنبيه لو العميل الآجل عدّى حده أو موقوف. منع: الأوردر مايبدأش تجهيز غير بموافقة الحسابات.",
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
  "hr.payroll_net_pay_account": def({
    group: "hr",
    label: "حساب صافي المرتبات المستحقة",
    description: "كود حساب الخصوم اللي بيتسجل فيه صافي المرتبات عند ترحيل المسير، وبيتقفل منه عند الصرف. فاضي = ترحيل المرتبات مقفول لحد ما المحاسب يحدده.",
    unit: "",
    schema: accountCode,
    default: "",
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
export const SETTING_GROUP_LABEL_EN: Record<SettingGroup, string> = {
  orders: "Order operations",
  approvals: "Approvals",
  documents: "Documents and attachments",
  inventory: "Inventory",
  sales: "Sales and credit",
  purchasing: "Purchasing",
  accounting: "Accounting",
  hr: "Expenses and employees",
};

/** English for each setting's label and description (unit test: every setting has both). */
/** Settings whose value is one of a few choices: the words for each stored value. The
 * admin screen shows these and offers them in a list instead of a free-text box. */
export const SETTING_CHOICES: Partial<Record<SettingKey, Record<string, { ar: string; en: string }>>> = {
  "inventory.grading_cost_policy": { proportional: { ar: "بالتناسب", en: "Proportional" }, nrv: { ar: "حسب القيمة السوقية", en: "By market value" } },
  "inventory.grading_waste_loss": { expense_at_grading: { ar: "وقت الفرز", en: "At grading" }, zero_basis: { ar: "على المخرجات", en: "Over the outputs" } },
  "inventory.grading_price_missing": { fallback: { ar: "توزيع بالتناسب", en: "Spread proportionally" }, refuse: { ar: "رفض", en: "Refuse" } },
  "inventory.dispatch_issue_policy": { lenient: { ar: "مرن", en: "Lenient" }, strict: { ar: "صارم", en: "Strict" } },
  "sales.credit_check_mode": { off: { ar: "إيقاف", en: "Off" }, warn: { ar: "تنبيه", en: "Warn" }, block: { ar: "منع", en: "Block" } },
};

export const SETTING_EN: Record<SettingKey, { label: string; description: string }> = {
  "orders.shortage_review_threshold_pct": { label: "Variance needing approval", description: "If the prepared or loaded quantity differs from the ordered one by more than this percentage (over or under), the order stops until a supervisor approves it." },
  "orders.waiting_to_start_minutes": { label: "Time to start preparation", description: "A new order nobody has started after this long shows as waiting on the supervisor board." },
  "orders.stalled_minutes": { label: "Stalled after", description: "An order in progress that nobody touched for this long is marked stalled." },
  "orders.delivery_soon_minutes": { label: "Delivery-soon alert", description: "The order is marked \u201cdue soon\u201d when less than this much time is left before delivery." },
  "approvals.require_different_approver": { label: "Approval by someone other than the requester", description: "When on, whoever requested an approval (or recorded the shortage) cannot approve it themselves \u2014 another person with the permission must. Off by default so a supervisor working alone can finish the work." },
  "documents.max_upload_mb": { label: "Largest file upload", description: "Any larger file is refused before it is uploaded." },
  "inventory.default_warehouse_code": { label: "Default warehouse", description: "The warehouse code receipts and adjustments go to when the screen does not name one." },
  "inventory.adjustment_approval_threshold": { label: "Adjustment needing approval", description: "Any stock adjustment (up or down) larger than this quantity, in the product's base unit, waits for approval before it is recorded. Zero = no approval." },
  "inventory.expiry_warning_days": { label: "Expiry warning", description: "Lots expiring within this many days appear in the near-expiry report." },
  "inventory.grading_cost_policy": { label: "Grading cost policy", description: "Proportional: every output takes the input's unit cost (current behaviour). By market value: cost is spread by the relative market value of the saleable outputs." },
  "inventory.grading_waste_loss": { label: "Grading waste treatment", description: "At grading: the waste loss is recorded at grading. Over the outputs: the waste cost is spread over the saleable outputs." },
  "inventory.grading_price_missing": { label: "When grading has no price", description: "Spread proportionally: grading goes on, cost is spread proportionally and the reason recorded. Refuse: grading is refused until the price is entered." },
  "inventory.grading_loss_approval_threshold": { label: "Grading loss needing approval", description: "If the grading loss (EGP) is above this value, it waits for approval before it is recorded. Zero = no approval." },
  "inventory.dispatch_issue_policy": { label: "Stock issue at dispatch", description: "Lenient: the order always leaves; a line without enough stock or with an unknown product is recorded as an exception for the storekeeper. Strict: the order does not leave if a tracked product lacks stock." },
  "sales.credit_check_mode": { label: "Credit control", description: "Off: no control. Warn: the order goes on and accounting is alerted if a credit customer is over their limit or on hold. Block: the order cannot start preparation without accounting approval." },
  "sales.auto_reserve": { label: "Reserve stock for orders automatically", description: "When on, every order for a tracked product reserves what is available until it leaves. Best turned on once receipts are fully recorded, because reserved stock cannot be scrapped or adjusted." },
  "sales.eta_person_id_threshold": { label: "National ID threshold on e-invoices", description: "An invoice to a person (not a company) at or above this amount is not sent to the Tax Authority without the customer's national ID. The value follows the published system rules \u2014 to be confirmed by the accountant." },
  "sales.quotation_validity_days": { label: "Quotation validity", description: "Days a quotation stays valid when no date is given." },
  "auth.session_ttl_hours": { label: "Session lifetime (hours)", description: "How long a sign-in lasts before the user must sign in again. Anything under 1 hour counts as one hour." },
  "auth.login_ip_lockout_threshold": { label: "Failed sign-ins from one address", description: "If sign-in fails this many times from the same IP within 15 minutes, that address is locked for 15 minutes \u2014 whatever the user name. Zero = no IP lock." },
  "purchasing.po_approval_threshold": { label: "Purchase order approval threshold", description: "A purchase order above this total waits for accounting approval before it goes to the supplier. Zero = every purchase order needs approval." },
  "purchasing.over_receipt_tolerance_pct": { label: "Over-receipt tolerance", description: "The most a receipt may exceed the ordered quantity (produce weights are never exact)." },
  "purchasing.bill_match_tolerance_pct": { label: "Supplier bill match tolerance", description: "If a supplier bill (before tax) differs from the received value at the agreed price by more than this percentage, the bill waits for approval before posting." },
  "purchasing.service_bill_approval_threshold": { label: "Service bill approval threshold", description: "A service bill (rent, electricity, transport, maintenance, equipment\u2026) above this total waits for approval before posting. Zero = every service bill needs approval." },
  "accounting.withholding_receivable_account": { label: "Tax withheld by customers account", description: "Code of the asset account for tax a customer withheld from a payment to us. Empty = this deduction is not offered on receipts." },
  "accounting.withholding_payable_account": { label: "Tax withheld from suppliers account", description: "Code of the liability account for tax we withheld from a supplier payment. Empty = this deduction is not offered on payments." },
  "accounting.bank_charges_account": { label: "Bank charges account", description: "Code of the expense account for the bank fee deducted from a customer's transfer. Empty = not offered." },
  "accounting.write_off_account": { label: "Receipt differences account", description: "Code of the expense account for a small difference forgiven on a receipt. Empty = not offered." },
  "accounting.write_off_limit": { label: "Largest receipt difference", description: "The most that may be forgiven on one receipt, and only with accounting management permission. Zero = not allowed." },
  "hr.payroll_net_pay_account": { label: "Net salaries payable account", description: "Code of the liability account net salaries are credited to when a run is posted, and cleared from when paid. Empty = payroll posting stays blocked until the accountant sets it." },
  "hr.expense_approval_threshold": { label: "Expense approval threshold", description: "An expense above this amount waits for approval before it posts to the accounts. Zero = every expense needs approval." },
};

/** English for the units shown next to values. */
export const SETTING_UNIT_EN: Record<string, string> = { "%": "%", "دقيقة": "minutes", "ميجا": "MB", "بوحدة الصنف": "in the product's unit", "يوم": "days", "ج.م": "EGP", "ساعة": "hours", "محاولة": "attempts", "": "" };

/** A setting's name in the reader's language (audit rows store the key). */
export function settingLabel(key: string, locale: "ar" | "en"): string | null {
  if (!isSettingKey(key)) return null;
  return locale === "en" ? SETTING_EN[key].label : SETTING_DEFS[key].label;
}

/** A setting value as audit rows store it (JSON: `"strict"`, `true`, `12`, `null`) in words:
 * a choice by its label, a switch as on/off, null as the default. */
export function settingValueText(key: string, raw: string | null, locale: "ar" | "en"): string {
  if (raw === null || raw === undefined) return "—";
  let v: unknown = raw;
  try { v = JSON.parse(raw); } catch { return raw; }
  if (v === null) return locale === "en" ? "Default" : "الافتراضي";
  if (typeof v === "boolean") return v ? (locale === "en" ? "Enabled" : "مفعّل") : (locale === "en" ? "Disabled" : "مقفول");
  const choice = isSettingKey(key) ? SETTING_CHOICES[key]?.[String(v)] : undefined;
  if (choice) return locale === "en" ? choice.en : choice.ar;
  return String(v);
}
