import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { actorCan, assertPermission } from "@/lib/authz-core";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { optText, parse, text } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import type { Permission } from "@/lib/permissions";

/**
 * Statutory and policy rule sets (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.10, §7).
 *
 * This file fixes only the SHAPE of each kind of rule — which numbers a rule needs — never a
 * value. Rates, caps, brackets, exemptions, multipliers and divisors are typed in by the
 * accountant or HR from the official source, and a second person verifies them before payroll
 * may use them. Nothing here is seeded, and nothing in the payroll engine has a default rate.
 */

const rate = z.number().min(0, "النسبة مينفعش تكون سالبة").max(100, "النسبة مينفعش تزيد عن 100");
const money = z.number().min(0, "المبلغ مينفعش يكون سالب").max(1e10);
const rounding = z.object({ step: z.number().positive().max(100), mode: z.enum(["nearest", "down", "up"]) }).optional();
const bracket = z.object({ up_to: money.nullable(), rate });
const brackets = z
  .array(bracket)
  .min(1, "اكتب شريحة واحدة على الأقل")
  .refine((b) => b[b.length - 1].up_to === null && b.slice(0, -1).every((x, i, a) => x.up_to !== null && (i === 0 || x.up_to! > a[i - 1].up_to!)), "الشرائح لازم تكون تصاعدية وآخر شريحة من غير حد أعلى");

export const RULE_SCHEMAS = {
  /** Social insurance: employee and employer shares of the insurable wage, within its monthly limits (§7 S6, S7). */
  eg_social_insurance: z.object({
    employee_rate: rate,
    employer_rate: rate,
    min_insurable_wage: money,
    max_insurable_wage: money,
    rounding,
  }).refine((p) => p.max_insurable_wage >= p.min_insurable_wage, "الحد الأقصى أقل من الحد الأدنى"),
  /**
   * Salary income tax (§7 S10–S12). The annual taxable income is the month's taxable base × 12
   * minus the exemption; the default brackets apply unless the income is above a threshold that
   * has its own bracket table (how sources describe the high-earner rule differs — the accountant
   * enters the tables they confirm). The month's tax is the annual tax ÷ 12.
   */
  eg_salary_income_tax: z.object({
    taxable_base: z.enum(["taxable_gross_minus_employee_insurance", "taxable_gross"]),
    period_method: z.enum(["annualised_monthly"]),
    annual_exemption: money,
    brackets,
    high_income_tables: z.array(z.object({ above: money, brackets })).max(20).optional(),
    rounding,
  }),
  /** Other levies, each a rate on a base, paid by the employee or the employer (§7 S9). */
  eg_other_levies: z.object({
    levies: z.array(z.object({
      code: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
      name_ar: z.string().min(1).max(100),
      base: z.enum(["gross", "taxable_gross", "insurable_wage", "net_entitlement"]),
      rate,
      payer: z.enum(["employee", "employer"]),
    })).min(1).max(20),
    rounding,
  }),
  /** Overtime pay (§7 S5, decision P7): multipliers per class, the hourly-rate basis, and which minutes count. */
  eg_overtime: z.object({
    day_multiplier: z.number().min(1).max(10),
    night_multiplier: z.number().min(1).max(10),
    rest_day_multiplier: z.number().min(1).max(10),
    holiday_multiplier: z.number().min(1).max(10),
    monthly_divisor_days: z.number().min(1).max(31),
    hours_per_day: z.number().min(1).max(24),
    /** Which pay components make up the hourly rate base (by code). */
    base_components: z.array(z.string().min(1)).min(1),
    /** Minutes below this on a day are not paid as overtime. */
    minimum_minutes_per_day: z.number().int().min(0).max(600),
    rounding,
  }),
  /** How a month's fixed pay is split into days — for joiners, leavers and unpaid days (§7 S14). */
  pay_proration: z.object({
    method: z.enum(["fixed_divisor", "calendar_days"]),
    divisor_days: z.number().min(1).max(31).optional(),
    base_components: z.array(z.string().min(1)).min(1),
    rounding,
  }).refine((p) => p.method !== "fixed_divisor" || p.divisor_days != null, "اكتب عدد أيام القسمة"),
} as const;

export type RuleCode = keyof typeof RULE_SCHEMAS;
export const RULE_CODES = Object.keys(RULE_SCHEMAS) as RuleCode[];
export type RuleParams<C extends RuleCode> = z.infer<(typeof RULE_SCHEMAS)[C]>;

const READ: Permission[] = ["hr.statutory.manage", "hr.payroll.prepare", "hr.payroll.approve", "hr.payroll.view"];
function assertCanRead(actor: ServiceActor) {
  if (!READ.some((p) => actorCan(actor, p))) assertPermission(actor, "hr.statutory.manage");
}

const day = z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD");
const input = z.object({
  code: z.enum(RULE_CODES as [RuleCode, ...RuleCode[]], { errorMap: () => ({ message: "نوع القاعدة غير معروف" }) }),
  effective_from: day,
  effective_to: day.nullable().optional(),
  parameters: z.record(z.unknown()),
  source_reference: text("المرجع", 500),
  notes: optText("ملاحظات", 1000).optional(),
});

function validated(code: RuleCode, params: unknown) {
  const r = RULE_SCHEMAS[code].safeParse(params);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ApiError(400, `قيم القاعدة غير صالحة: ${i.path.join(".") || code} — ${i.message}`);
  }
  return r.data;
}

export async function listRuleSets(actor: ServiceActor) {
  assertCanRead(actor);
  return prisma.statutoryRuleSet.findMany({ orderBy: [{ code: "asc" }, { effectiveFrom: "desc" }] });
}

/** A draft (POST) or a change to a draft (PATCH). The editor becomes the author. */
export async function saveRuleSet(id: string | null, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.statutory.manage");
  const v = parse(input, body);
  if (v.effective_to && v.effective_to < v.effective_from) throw new ApiError(400, "تاريخ النهاية قبل البداية");
  const parameters = validated(v.code, v.parameters);
  return inTx(async (tx) => {
    const data = { code: v.code, effectiveFrom: v.effective_from, effectiveTo: v.effective_to ?? null, parameters, sourceReference: v.source_reference, notes: v.notes ?? null, createdById: actor.id, createdBy: actor.name };
    let row;
    if (!id) row = await tx.statutoryRuleSet.create({ data });
    else {
      const cur = await tx.statutoryRuleSet.findUnique({ where: { id } });
      if (!cur) throw new ApiError(404, "القاعدة مش موجودة");
      if (cur.status !== "draft") throw new ApiError(409, "القاعدة اتراجعت — مينفعش تتعدل؛ أوقفها واعمل واحدة جديدة");
      row = await tx.statutoryRuleSet.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
    }
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: id ? "rule_set_updated" : "rule_set_created", entityType: "statutory_rule_set", entityId: row.id, fieldChanged: v.code, newValue: `${v.effective_from}..${v.effective_to ?? ""} · ${JSON.stringify(parameters).slice(0, 400)}`, reason: v.source_reference, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

/** A second person checks the values against the source; from then on payroll may use them. */
export async function verifyRuleSet(id: string, actor: ServiceActor) {
  assertPermission(actor, "hr.statutory.manage");
  try {
    return await inTx(async (tx) => {
      const r = await tx.statutoryRuleSet.findUnique({ where: { id } });
      if (!r) throw new ApiError(404, "القاعدة مش موجودة");
      if (r.status !== "draft") throw new ApiError(409, "القاعدة دي مش مسودة");
      if (r.createdById && r.createdById === actor.id) throw new ApiError(403, "المراجعة لازم تكون من شخص غير اللي كتب القاعدة");
      validated(r.code as RuleCode, r.parameters);
      const row = await tx.statutoryRuleSet.update({ where: { id, version: r.version }, data: { status: "verified", verifiedById: actor.id, verifiedBy: actor.name, verifiedAt: new Date(), version: { increment: 1 } } });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "rule_set_verified", entityType: "statutory_rule_set", entityId: id, fieldChanged: r.code, oldValue: "draft", newValue: "verified", reason: r.sourceReference, source: "user", deviceId: actor.deviceId }, tx);
      return row;
    });
  } catch (err) {
    if (err instanceof Error && /overlaps another verified rule set/.test(err.message)) throw new ApiError(409, "فيه قاعدة معتمدة تانية لنفس النوع في نفس الفترة — أوقفها الأول");
    throw err;
  }
}

/** Ends a verified rule set (or discards a draft). Payslips that used it keep its id and version. */
export async function retireRuleSet(id: string, body: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.statutory.manage");
  const v = parse(z.object({ effective_to: day.optional(), reason: text("السبب", 300) }), body);
  return inTx(async (tx) => {
    const r = await tx.statutoryRuleSet.findUnique({ where: { id } });
    if (!r) throw new ApiError(404, "القاعدة مش موجودة");
    if (r.status === "draft") {
      await tx.statutoryRuleSet.delete({ where: { id } });
      await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "rule_set_discarded", entityType: "statutory_rule_set", entityId: id, fieldChanged: r.code, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
      return { deleted: true };
    }
    if (r.status !== "verified") throw new ApiError(409, "القاعدة دي متوقفة بالفعل");
    const to = v.effective_to ?? r.effectiveTo ?? todayLocalISO();
    if (to < r.effectiveFrom) throw new ApiError(400, "تاريخ النهاية قبل البداية");
    if (r.effectiveTo && to !== r.effectiveTo) throw new ApiError(409, "القاعدة ليها تاريخ نهاية بالفعل");
    const row = await tx.statutoryRuleSet.update({ where: { id }, data: { status: "retired", effectiveTo: to, version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "rule_set_retired", entityType: "statutory_rule_set", entityId: id, fieldChanged: r.code, oldValue: "verified", newValue: `retired · ${to}`, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

/**
 * The verified rule set of a code covering a whole period, or null. Payroll refuses to
 * calculate when a rule it needs returns null (§3.10 hard rule).
 */
export async function verifiedRuleFor<C extends RuleCode>(db: Pick<Tx, "statutoryRuleSet">, code: C, from: string, to: string) {
  const r = await db.statutoryRuleSet.findFirst({
    where: { code, status: "verified", effectiveFrom: { lte: from }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: to } }] },
  });
  if (!r) return null;
  return { id: r.id, version: r.version, code, sourceReference: r.sourceReference, params: RULE_SCHEMAS[code].parse(r.parameters) as RuleParams<C> };
}
