import { z } from "zod";
import { ROLES, type Role } from "@/lib/types";

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
      "لو مفعّل، اللي طلب الموافقة (أو اللي سجّل الكمية الناقصة) مينفعش يوافق بنفسه — لازم شخص تاني عنده الصلاحية. مفعّل افتراضيًا (فصل المهام). لو مفيش على النظام غير مدير واحد عنده الصلاحية، يقدر يوافق لنفسه في الطوارئ بسبب مكتوب، والموافقة دي بتتسجل وبيتبلغ بيها.",
    unit: "",
    schema: z.boolean({ invalid_type_error: "القيمة لازم تكون true أو false" }),
    default: true as boolean,
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
  "inventory.adjustment_approval_required": def({
    group: "inventory",
    label: "تسويات المخزون محتاجة موافقة",
    description: "مفعّل افتراضيًا: أي تسوية مخزون كميتها أكبر من الحد (صفر = كل تسوية) بتستنى موافقة شخص تاني عنده صلاحية اعتماد التسويات.",
    unit: "",
    schema: z.boolean({ invalid_type_error: "القيمة لازم تكون true أو false" }),
    default: true as boolean,
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
  "inventory.grading_loss_approval_required": def({
    group: "inventory",
    label: "خسارة الفرز محتاجة موافقة",
    description: "مفعّل افتراضيًا: الفرز اللي خسارته (فرزة + هالك بالجنيه) أكبر من الحد (صفر = أي خسارة) بيستنى موافقة شخص تاني قبل ما يترحّل.",
    unit: "",
    schema: z.boolean({ invalid_type_error: "القيمة لازم تكون true أو false" }),
    default: true as boolean,
  }),
  "inventory.dispatch_issue_policy": def({
    group: "inventory",
    label: "صرف المخزون عند خروج الأوردر",
    description:
      "صارم دايماً: الأوردر مايخرجش إلا لو كل سطوره بتتصرف من الرصيد بالكامل. الوضع المرن اتلغى (تعديلات نوفمبر 2026) — مفيش بيع لبضاعة مش على الدفاتر.",
    unit: "",
    schema: z.enum(["strict"], { errorMap: () => ({ message: "الوضع الوحيد المسموح: strict (صارم)" }) }),
    default: "strict" as const,
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
      "إجباري: كل سطر في أوردر مؤكد بيحجز كميته كاملة من المتاح للبيع لحظة التأكيد، ولو مش متاحة الأوردر مايتأكدش. مينفعش يتقفل.",
    unit: "",
    schema: z.literal(true, { errorMap: () => ({ message: "حجز المخزون للأوردرات إجباري ومينفعش يتقفل" }) }),
    default: true as const,
  }),
  "sales.price_exception_approval": def({
    group: "sales",
    label: "سعر أقل من التكلفة أو خصم كبير محتاج موافقة",
    description: "مفعّل افتراضيًا: سطر سعره أقل من تكلفة المخزون أو خصمه أكبر من الحد بيوقف الأوردر لحد ما حد تاني عنده صلاحية اعتماد الأسعار يوافق.",
    unit: "",
    schema: z.boolean({ invalid_type_error: "القيمة لازم تكون true أو false" }),
    default: true as boolean,
  }),
  "sales.max_discount_pct": def({
    group: "sales",
    label: "أقصى خصم على السطر من غير موافقة",
    description: "الخصم على سطر الأوردر لو عدّى النسبة دي بيحتاج موافقة.",
    unit: "%",
    schema: z.number().min(0, "أقل قيمة 0").max(100, "أكبر قيمة 100"),
    default: 10,
  }),
  "sales.eta_person_id_threshold": def({
    group: "sales",
    label: "حد الرقم القومي في الفاتورة الإلكترونية",
    description: "فاتورة لشخص طبيعي (مش شركة) بالمبلغ ده أو أكتر مايتبعتش لمصلحة الضرائب من غير الرقم القومي للعميل. الافتراضي 25,000 ج.م: المصلحة خفّضت الحد من 50,000 من أغسطس 2024 حسب المنشور في الصحافة (المصدر الرسمي مش منشور في الـ SDK) — يتأكد منها المحاسب من البوابة. الحد الأقل هو الاتجاه الآمن: فاتورة أكتر محتاجة الرقم القومي بدل ما ترتفض.",
    unit: "ج.م",
    schema: z.number().min(0).max(100_000_000),
    // Maturity 2026-11 (TAX-01): 25,000 per ETA's reported reduction effective 1 Aug 2024
    // (secondary sources; the SDK says only "threshold limit defined"). The lower value is
    // the safe direction — see UNITED_AUDIT .../maturity/EGYPT_TAX_RESEARCH.md §2.
    default: 25_000,
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
    description: "مدة سريان جلسة الدخول قبل ما المستخدم يضطر يعيد تسجيل الدخول. أي قيمة أقل من 1 ساعة بتتعامل كساعة واحدة، وأي قيمة أكبر من 24 ساعة بتتعامل كـ 24 ساعة (حد أقصى ثابت للأمان).",
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
  // --- WS6 (security) -------------------------------------------------------
  "auth.mfa_required_roles": def<Role[]>({
    group: "documents",
    label: "الأدوار اللي لازم عليها التحقق بخطوتين",
    description:
      "أي مستخدم في دور من الأدوار دي ومفيش عليه تحقق بخطوتين (تطبيق المصادقة) بيتطلب منه يفعّله أول ما يدخل، وقبل ما يوصل لأي صفحة أو عملية. اكتب الأدوار مفصولة بفاصلة (مثلًا SUPER_ADMIN,ACCOUNTANT). فاضي = مش إجباري على حد.",
    unit: "",
    schema: z
      .array(z.enum(ROLES, { errorMap: () => ({ message: "دور مش معروف" }) }))
      .max(ROLES.length, "أدوار كتير")
      .refine((list) => new Set(list).size === list.length, "دور متكرر"),
    default: ["SUPER_ADMIN", "ACCOUNTANT"],
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
  "accounting.fiscal_year_start_month": def({
    group: "accounting",
    label: "شهر بداية السنة المالية",
    description: "رقم الشهر اللي السنة المالية بتبدأ فيه (1 = يناير، سنة ميلادية). متغيّروش بعد أول إقفال سنة.",
    unit: "",
    schema: z.number().int().min(1).max(12),
    default: 1,
  }),
  "accounting.lock_date": def({
    group: "accounting",
    label: "تاريخ قفل الدفاتر",
    description: "مفيش قيد يترحّل بتاريخ اليوم ده أو قبله (غير قيود إقفال السنة وعكسها). فاضي = مفيش قفل غير الشهور والسنين المقفولة. مثال: اليوم اللي قبل تاريخ بداية التشغيل على النظام.",
    unit: "",
    schema: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/, "التاريخ لازم يكون YYYY-MM-DD أو فاضي"),
    default: "",
  }),
  "accounting.close_requires_waste_writeoff": def({
    group: "accounting",
    label: "قفل الشهر محتاج إعدام الهالك",
    description: "مفعّل افتراضيًا: الشهر مايتقفلش وفيه هالك دخل لحد آخر يوم فيه ولسه متقيّم في المخزون — الهالك خسارة الشهر اللي حصل فيه، بيتعدم بمستند هالك.",
    unit: "",
    schema: z.boolean({ invalid_type_error: "القيمة لازم تكون true أو false" }),
    default: true as boolean,
  }),
  "accounting.direct_opening_entries": def({
    group: "accounting",
    label: "تسجيل الأرصدة الافتتاحية مباشرة",
    description: "مقفول افتراضيًا: الأرصدة الافتتاحية (عملاء، موردين، مخزون) بتتسجل بدفعة افتتاحية واحدة يعتمدها شخص تاني. التسجيل المباشر من غير موافقة مسموح بس لو اتفتح هنا بقرار.",
    unit: "",
    schema: z.boolean({ invalid_type_error: "القيمة لازم تكون true أو false" }),
    default: false as boolean,
  }),
  "accounting.manual_journal_approval": def({
    group: "accounting",
    label: "القيود اليدوية محتاجة اعتماد",
    description: "لو مفعّل، القيد اليدوي اللي مبلغه فوق الحد بيستنى موافقة شخص تاني عنده صلاحية اعتماد القيود قبل ما يترحّل. مفعّل افتراضيًا (فصل المهام).",
    unit: "",
    schema: z.boolean({ invalid_type_error: "القيمة لازم تكون true أو false" }),
    default: true as boolean,
  }),
  "accounting.manual_journal_approval_threshold": def({
    group: "accounting",
    label: "حد اعتماد القيود اليدوية",
    description: "لما الاعتماد مفعّل: القيد اللي إجماليه أكبر من ده بيستنى موافقة. صفر = كل القيود اليدوية.",
    unit: "ج.م",
    schema: z.number().min(0).max(1_000_000_000),
    default: 0,
  }),
  "accounting.transfer_approval": def({
    group: "accounting",
    label: "التحويلات بين الخزائن والبنوك محتاجة اعتماد",
    description: "لو مفعّل، التحويل اللي مبلغه فوق الحد بيستنى موافقة شخص تاني قبل ما يترحّل. مفعّل افتراضيًا (فصل المهام).",
    unit: "",
    schema: z.boolean({ invalid_type_error: "القيمة لازم تكون true أو false" }),
    default: true as boolean,
  }),
  "accounting.transfer_approval_threshold": def({
    group: "accounting",
    label: "حد اعتماد التحويلات",
    description: "لما الاعتماد مفعّل: التحويل اللي مبلغه أكبر من ده بيستنى موافقة. صفر = كل التحويلات.",
    unit: "ج.م",
    schema: z.number().min(0).max(1_000_000_000),
    default: 0,
  }),
  "accounting.payment_approval": def({
    group: "accounting",
    label: "سداد الموردين محتاج اعتماد",
    description: "لو مفعّل، سداد المورد اللي مبلغه فوق الحد بيتسجل كطلب ومايترحّلش غير لما شخص تاني يعتمده. مفعّل افتراضيًا (فصل المهام — زي التحويلات والقيود اليدوية).",
    unit: "",
    schema: z.boolean({ invalid_type_error: "القيمة لازم تكون true أو false" }),
    default: true as boolean,
  }),
  "accounting.payment_approval_threshold": def({
    group: "accounting",
    label: "حد اعتماد سداد الموردين",
    description: "لما الاعتماد مفعّل: السداد اللي مبلغه أكبر من ده بيستنى موافقة. صفر = كل السدادات.",
    unit: "ج.م",
    schema: z.number().min(0).max(1_000_000_000),
    default: 0,
  }),
  "accounting.cost_center_required": def({
    group: "accounting",
    label: "مركز التكلفة إجباري على المصروفات",
    description: "لو مفعّل، أي سطر على حساب مصروفات (مصروف، فاتورة خدمة، قيد يدوي) لازم يتحدد له مركز تكلفة. مقفول افتراضيًا لحد ما هيكل مراكز التكلفة يتعتمد.",
    unit: "",
    schema: z.boolean({ invalid_type_error: "القيمة لازم تكون true أو false" }),
    default: false,
  }),
  // --- WS4 ETA ------------------------------------------------------------------------
  "accounting.eta_api_submission_from": def({
    group: "accounting",
    label: "بداية الإرسال الآلي للفاتورة الإلكترونية",
    description: "تاريخ (YYYY-MM-DD) من أوله الفواتير والإشعارات الدائنة تتبعت لمصلحة الضرائب من البرنامج. فاضي = الإرسال الآلي مقفول. أي مستند تاريخه قبل كده بيتسجل يدويًا برقم البوابة (UUID) ومايتبعتش آلي أبدًا.",
    unit: "",
    schema: z.string().trim().regex(/^(\d{4}-\d{2}-\d{2})?$/, "التاريخ لازم يكون YYYY-MM-DD أو فاضي"),
    default: "" as string,
  }),
  // ------------------------------------------------------------------------------------
  "hr.expense_approval_threshold": def({
    group: "hr",
    label: "حد اعتماد المصروفات",
    description: "المصروف اللي مبلغه أكبر من ده بيستنى اعتماد قبل ما يترحّل للحسابات. صفر = كل المصروفات محتاجة اعتماد.",
    unit: "ج.م",
    schema: z.number().min(0).max(10_000_000),
    default: 500,
  }),
  // ── WS5 HR & payroll remediation (November 2026) ──
  "hr.advance_recovery_max_pct": def({
    group: "hr",
    label: "أقصى نسبة لاسترداد السلف من صافي المرتب",
    description: "أقصى نسبة من صافي استحقاق الشهر تتخصم لسداد سلفة (القسط التلقائي بيتقلل لحدها، والإدخال اليدوي اللي يعديها بيوقف المسير إلا بخطة سداد معتمدة تسمح بكده). القيمة المبدئية 10% من مصدر ثانوي واحد عن قانون العمل 14/2025 — محتاجة تأكيد قانوني. الصرف تحت الحساب مش داخل فيها.",
    unit: "%",
    schema: z.number().min(0, "أقل قيمة 0").max(100, "أكبر قيمة 100"),
    default: 10,
  }),
  "hr.payroll_absent_policy": def({
    group: "hr",
    label: "خصم أيام الغياب العادي",
    description: "deduct = يوم الغياب (مش المتسجل بدون أجر) بيتخصم زي اليوم بدون أجر وبيظهر تنبيه على القسيمة؛ warn = مبيتخصمش وبيظهر تنبيه بس.",
    unit: "",
    schema: z.enum(["deduct", "warn"], { errorMap: () => ({ message: "القيمة لازم تكون deduct أو warn" }) }),
    default: "deduct",
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
  "inventory.dispatch_issue_policy": { strict: { ar: "صارم", en: "Strict" } },
  "sales.credit_check_mode": { off: { ar: "إيقاف", en: "Off" }, warn: { ar: "تنبيه", en: "Warn" }, block: { ar: "منع", en: "Block" } },
};

export const SETTING_EN: Record<SettingKey, { label: string; description: string }> = {
  "orders.shortage_review_threshold_pct": { label: "Variance needing approval", description: "If the prepared or loaded quantity differs from the ordered one by more than this percentage (over or under), the order stops until a supervisor approves it." },
  "orders.waiting_to_start_minutes": { label: "Time to start preparation", description: "A new order nobody has started after this long shows as waiting on the supervisor board." },
  "orders.stalled_minutes": { label: "Stalled after", description: "An order in progress that nobody touched for this long is marked stalled." },
  "orders.delivery_soon_minutes": { label: "Delivery-soon alert", description: "The order is marked \u201cdue soon\u201d when less than this much time is left before delivery." },
  "approvals.require_different_approver": { label: "Approval by someone other than the requester", description: "On by default (segregation of duties). When only one administrator holds the approving permission, they may approve their own request in an emergency with a written reason; that approval is audited and broadcast." },
  "inventory.adjustment_approval_required": { label: "Stock adjustments need approval", description: "On by default: any stock adjustment above the threshold (0 = every adjustment) waits for approval by another person holding the adjustment-approval permission." },
  "inventory.grading_loss_approval_required": { label: "Grading losses need approval", description: "On by default: a grading whose loss (grade B + waste, EGP) is above the threshold (0 = any loss) waits for approval by another person before it posts." },
  "sales.price_exception_approval": { label: "Below-cost prices and large discounts need approval", description: "On by default: a line priced below its stock cost, or discounted above the limit, holds the order until another person with price-approval permission approves." },
  "sales.max_discount_pct": { label: "Maximum line discount without approval", description: "A line discount above this percentage needs approval." },
  "accounting.direct_opening_entries": { label: "Direct opening entries", description: "Off by default: opening balances (customers, suppliers, stock) go through one opening batch approved by a second person. Direct entry without approval is allowed only if switched on here by decision." },
  "accounting.payment_approval": { label: "Supplier payments need approval", description: "When on, a supplier payment above the threshold is recorded as a request and posts only when another person approves it. On by default (segregation of duties — like transfers and manual journals)." },
  "accounting.payment_approval_threshold": { label: "Supplier payment approval threshold", description: "When approval is on: a payment above this amount waits for approval. Zero = every payment." },
  "accounting.lock_date": { label: "Books lock date", description: "No entry posts dated on or before this day (except the year-end close and its reversal). Empty = no lock beyond closed months and years. For example: the day before go-live on the system." },
  "accounting.close_requires_waste_writeoff": { label: "Month close requires waste write-off", description: "On by default: a month does not close while waste that entered by its last day is still valued in inventory — waste is a loss of the month it happened in, written off with a scrap document." },
  "documents.max_upload_mb": { label: "Largest file upload", description: "Any larger file is refused before it is uploaded." },
  "inventory.default_warehouse_code": { label: "Default warehouse", description: "The warehouse code receipts and adjustments go to when the screen does not name one." },
  "inventory.adjustment_approval_threshold": { label: "Adjustment needing approval", description: "Any stock adjustment (up or down) larger than this quantity, in the product's base unit, waits for approval before it is recorded. Zero = no approval." },
  "inventory.expiry_warning_days": { label: "Expiry warning", description: "Lots expiring within this many days appear in the near-expiry report." },
  "inventory.grading_cost_policy": { label: "Grading cost policy", description: "Proportional: every output takes the input's unit cost (current behaviour). By market value: cost is spread by the relative market value of the saleable outputs." },
  "inventory.grading_waste_loss": { label: "Grading waste treatment", description: "At grading: the waste loss is recorded at grading. Over the outputs: the waste cost is spread over the saleable outputs." },
  "inventory.grading_price_missing": { label: "When grading has no price", description: "Spread proportionally: grading goes on, cost is spread proportionally and the reason recorded. Refuse: grading is refused until the price is entered." },
  "inventory.grading_loss_approval_threshold": { label: "Grading loss needing approval", description: "If the grading loss (EGP) is above this value, it waits for approval before it is recorded. Zero = no approval." },
  "inventory.dispatch_issue_policy": { label: "Stock issue at dispatch", description: "Always strict: an order leaves only if every line is issued in full from the books. The lenient mode was retired (November 2026 remediation) — goods not on the books are never sold." },
  "sales.credit_check_mode": { label: "Credit control", description: "Off: no control. Warn: the order goes on and accounting is alerted if a credit customer is over their limit or on hold. Block: the order cannot start preparation without accounting approval." },
  "sales.auto_reserve": { label: "Reserve stock for orders", description: "Mandatory: every line of a confirmed order reserves its full quantity from sellable stock when it is confirmed; if it is not available the order is not confirmed. Cannot be switched off." },
"sales.eta_person_id_threshold": { label: "National ID threshold on e-invoices", description: "An invoice to a person (not a company) at or above this amount is not sent to the Tax Authority without the customer's national ID. Default 25,000 EGP: ETA lowered it from 50,000 from August 2024 as reported in the press (the SDK does not publish the figure) — to be confirmed by the accountant on the portal. The lower value is the safe direction: more invoices need the ID instead of being rejected." },
  "sales.quotation_validity_days": { label: "Quotation validity", description: "Days a quotation stays valid when no date is given." },
  "auth.session_ttl_hours": { label: "Session lifetime (hours)", description: "How long a sign-in lasts before the user must sign in again. Anything under 1 hour counts as one hour; anything over 24 hours counts as 24 (a fixed security cap)." },
  "auth.login_ip_lockout_threshold": { label: "Failed sign-ins from one address", description: "If sign-in fails this many times from the same IP within 15 minutes, that address is locked for 15 minutes \u2014 whatever the user name. Zero = no IP lock." },
  "auth.mfa_required_roles": { label: "Roles that must use two-step sign-in", description: "Any user in one of these roles without two-step sign-in (an authenticator app) must enrol at their next sign-in, before reaching any page or action. Comma-separated roles (e.g. SUPER_ADMIN,ACCOUNTANT). Empty = not required for anyone." },
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
  "accounting.fiscal_year_start_month": { label: "Fiscal year start month", description: "The month the fiscal year starts in (1 = January, calendar year). Do not change it after the first year-end close." },
  "accounting.manual_journal_approval": { label: "Manual journals need approval", description: "On by default (segregation of duties): a manual journal above the threshold waits for someone else with journal-approval permission before it posts." },
  "accounting.manual_journal_approval_threshold": { label: "Manual journal approval threshold", description: "When approval is on: a journal whose total is above this waits for approval. Zero = every manual journal." },
  "accounting.transfer_approval": { label: "Cash and bank transfers need approval", description: "On by default (segregation of duties): a transfer above the threshold waits for someone else's approval before it posts." },
  "accounting.transfer_approval_threshold": { label: "Transfer approval threshold", description: "When approval is on: a transfer above this amount waits for approval. Zero = every transfer." },
  "accounting.eta_api_submission_from": { label: "E-invoice API submission start date", description: "Date (YYYY-MM-DD) from which invoices and credit notes are sent to the Tax Authority by the system. Empty = API submission is off. Any document dated earlier is recorded by hand with its portal UUID and is never sent by the API." },
  "accounting.cost_center_required": { label: "Cost center required on expenses", description: "When on, every line on an expense account (expense, service bill, manual journal) must name a cost center. Off by default until the cost-center structure is approved." },
  "hr.expense_approval_threshold": { label: "Expense approval threshold", description: "An expense above this amount waits for approval before it posts to the accounts. Zero = every expense needs approval." },
  // WS5 HR & payroll remediation (November 2026)
  "hr.advance_recovery_max_pct": { label: "Largest advance recovery, % of net pay", description: "The most of a month's net entitlement deducted to repay an advance (an automatic instalment is reduced to it; a manual entry above it blocks the run unless an approved repayment plan allows it). The default 10% comes from a single secondary source on Labour Law 14/2025 — needs legal confirmation. Salary paid on account is not counted." },
  "hr.payroll_absent_policy": { label: "Deduct plain absences", description: "deduct = an absence day (not marked unpaid) is deducted like an unpaid day and flagged on the payslip; warn = not deducted, only flagged." },
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
