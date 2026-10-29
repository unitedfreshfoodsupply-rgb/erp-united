import { Prisma, type Customer, type CustomerLegalEntity } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit, writeAuditMany, type AuditInput } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { normalizeProductName as normalizeName } from "@/lib/productIdentity";
import { active, optDecimal, optText, parse, text, version } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { applyListPrices } from "@/lib/sales/pricing";

/**
 * The customer master.
 *
 * Identity works exactly like the product master: a customer name arriving on an
 * order (WhatsApp, n8n, a supervisor typing) resolves to ONE account by an exact,
 * normalized match on its name, Arabic name or a recorded alias — or by the
 * integration's own customer id — and otherwise stays unmapped until a person decides.
 * There is no fuzzy matching: billing the wrong hotel is worse than asking.
 *
 * Credit terms (limit, payment days, hold) are a finance decision with their own
 * permission; everything else is the sales team's.
 */

export const CUSTOMER_TYPES = ["hotel", "restaurant", "cafe", "retail", "wholesale", "institution", "other"] as const;

/** One lock for the whole alias namespace: its invariant (one name → one customer)
 * is global, so writers are serialised against each other. */
const ALIAS_LOCK = "sales:customer-alias-namespace";

const taxId = z
  .string({ invalid_type_error: "رقم التسجيل الضريبي لازم يكون نص" })
  .trim()
  .nullable()
  .transform((v) => (v ? v.replace(/[\s-]/g, "") : null))
  .refine((v) => v === null || /^[0-9]{9}$/.test(v), "رقم التسجيل الضريبي 9 أرقام");

const customerFields = {
  name: text("اسم العميل"),
  name_ar: optText("الاسم بالعربي").optional(),
  legal_name: optText("الاسم القانوني للفوترة", 300).optional(),
  legal_name_ar: optText("الاسم القانوني للفوترة بالعربي", 300).optional(),
  type: z.enum(CUSTOMER_TYPES, { errorMap: () => ({ message: "نوع العميل غير معروف" }) }).optional(),
  tax_registration_no: taxId.optional(),
  commercial_reg_no: optText("السجل التجاري", 40).optional(),
  phone: optText("التليفون", 40).optional(),
  email: optText("الإيميل").optional(),
  city: optText("المدينة", 80).optional(),
  area: optText("المنطقة", 120).optional(),
  address: optText("العنوان", 500).optional(),
  delivery_notes: optText("ملاحظات التوصيل", 1000).optional(),
  external_ref: optText("كود العميل في نظام الطلبات", 120).optional(),
  notes: optText("ملاحظات", 2000).optional(),
  /// Optional legacy link; the card's own legal name and tax number are authoritative.
  legal_entity_id: z.string().trim().nullable().optional(),
  /// Commercial group ids this customer belongs to (M:N).
  group_ids: z.array(z.string().trim().min(1)).optional(),
};
/** A code supplied on creation (an import from the business's existing records) is kept as
 * the customer's code; without one the next CUS- number is assigned. Letters are upper-cased
 * like generated codes so search and opening-balance imports match them. */
export const partyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/, "الكود حروف إنجليزي وأرقام و . _ - / بحد أقصى 40")
  .transform((s) => s.toUpperCase());
const customerCreateWithCommercialTerms = z.object(customerFields).extend({
  code: partyCode.optional(),
  payment_terms_days: z.number({ invalid_type_error: "مدة السداد لازم تكون رقم" }).int().min(0).max(365).optional(),
  credit_limit: optDecimal("حد الائتمان").optional(),
  credit_hold: z.boolean().optional(),
  credit_hold_reason: optText("سبب إيقاف التعامل الآجل", 500).optional(),
  credit_reason: text("سبب إعداد الائتمان", 500).optional(),
  price_list_id: z.string().nullable().optional(),
  price_list_reason: text("سبب ربط قائمة الأسعار", 500).optional(),
});
const customerUpdate = z.object(customerFields).partial().extend({ active: active().optional(), expected_version: version });

const creditUpdate = z.object({
  payment_terms_days: z.number({ invalid_type_error: "مدة السداد لازم تكون رقم" }).int("مدة السداد أيام صحيحة").min(0).max(365).optional(),
  credit_limit: optDecimal("حد الائتمان").optional(),
  credit_hold: z.boolean().optional(),
  credit_hold_reason: optText("سبب الإيقاف", 500).optional(),
  reason: text("سبب التغيير", 500),
  expected_version: version,
});

const contactInput = z.object({
  name: text("اسم جهة الاتصال"),
  role: optText("الوظيفة", 80).optional(),
  phone: optText("التليفون", 40).optional(),
  email: optText("الإيميل").optional(),
  is_primary: z.boolean().optional(),
  active: active().optional(),
  expected_version: version,
});

const audit = (actor: ServiceActor, a: Omit<AuditInput, "userId" | "userName" | "role" | "source" | "deviceId">): AuditInput => ({
  userId: actor.id,
  userName: actor.name,
  role: actor.role,
  source: "user",
  deviceId: actor.deviceId,
  ...a,
});

function uniqueViolation(err: unknown, field: string): never | void {
  const e = err as { code?: string; meta?: { target?: string[] | string } };
  if (e?.code !== "P2002") return;
  const target = String(e.meta?.target ?? "");
  if (target.includes("externalRef")) throw new ApiError(409, "كود العميل في نظام الطلبات مستخدم لعميل تاني");
  throw new ApiError(409, `${field} مستخدم بالفعل`);
}

// ---------------------------------------------------------------------------
// Aliases (identity)
// ---------------------------------------------------------------------------

/** Claims a name for a customer inside the caller's transaction (alias lock held). A
 * name already pointing at this customer is fine; at another customer it is refused. */
async function claimName(tx: Tx, customerId: string, raw: string, kind: "canonical" | "canonical_ar" | "manual", actor: ServiceActor) {
  const normalized = normalizeName(raw);
  if (!normalized) throw new ApiError(400, "الاسم فاضي بعد التنظيف");
  const existing = await tx.customerAlias.findUnique({ where: { normalized }, include: { customer: { select: { code: true, name: true } } } });
  if (existing) {
    if (existing.customerId === customerId) return existing;
    throw new ApiError(409, `الاسم "${raw}" مستخدم للعميل ${existing.customer.code} · ${existing.customer.name}`);
  }
  return tx.customerAlias.create({ data: { customerId, alias: raw.trim(), normalized, kind, createdById: actor.id, createdBy: actor.name } });
}

/** Drops a canonical alias that no longer matches the customer's name. */
async function releaseCanonical(tx: Tx, customerId: string, kind: "canonical" | "canonical_ar") {
  await tx.customerAlias.deleteMany({ where: { customerId, kind } });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listCustomers(opts: { q?: string; includeInactive?: boolean } = {}) {
  const q = opts.q?.trim();
  const normalized = q ? normalizeName(q) : "";
  const rows = await prisma.customer.findMany({
    where: {
      ...(opts.includeInactive ? {} : { active: true }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { nameAr: { contains: q } },
              { legalName: { contains: q, mode: "insensitive" } },
              { legalNameAr: { contains: q } },
              { taxRegistrationNo: { contains: q } },
              { code: { contains: q.toUpperCase() } },
              { phone: { contains: q } },
              ...(normalized ? [{ aliases: { some: { normalized: { contains: normalized } } } }] : []),
              { groupMembers: { some: { group: { OR: [{ code: { contains: q.toUpperCase() } }, { name: { contains: q, mode: "insensitive" } }, { nameAr: { contains: q } }] } } } },
              { legalEntity: { OR: [{ code: { contains: q.toUpperCase() } }, { name: { contains: q, mode: "insensitive" } }, { nameAr: { contains: q } }] } },
            ],
          }
        : {}),
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    take: 300,
    include: {
      _count: { select: { orders: true } },
      groupMembers: { include: { group: { select: { id: true, code: true, name: true, nameAr: true } } } },
      legalEntity: { select: { id: true, code: true, name: true, nameAr: true, taxRegistrationNo: true } },
    },
  });
  return rows.map(({ groupMembers, ...rest }) => ({
    ...rest,
    groups: groupMembers.map((m) => m.group),
  }));
}

export async function getCustomer(id: string) {
  const c = await prisma.customer.findUnique({
    where: { id },
    include: {
      aliases: { orderBy: { createdAt: "asc" } },
      contacts: { orderBy: [{ isPrimary: "desc" }, { name: "asc" }] },
      _count: { select: { orders: true } },
      groupMembers: { include: { group: { select: { id: true, code: true, name: true, nameAr: true } } } },
      legalEntity: true,
    },
  });
  if (!c) throw new ApiError(404, "العميل مش موجود");
  const recentOrders = await prisma.order.findMany({
    where: { customerAccountId: id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, orderNumber: true, deliveryDate: true, status: true },
  });
  const { groupMembers, ...rest } = c;
  return { ...rest, groups: groupMembers.map((m) => m.group), recentOrders };
}

/** Everything recorded about one customer: its own edits and credit changes, its
 * aliases and contacts (logged against its code), and order-name mappings. */
export async function customerHistory(id: string) {
  const c = await prisma.customer.findUnique({ where: { id }, select: { code: true } });
  if (!c) throw new ApiError(404, "العميل مش موجود");
  return prisma.auditLog.findMany({
    where: {
      OR: [
        { entityType: "customer", entityId: id },
        { entityType: { in: ["customer_alias", "customer_contact"] }, fieldChanged: c.code },
      ],
    },
    orderBy: { timestamp: "desc" },
    take: 200,
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createCustomer(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.customers.manage");
  const v = parse(customerCreateWithCommercialTerms, input);
  const hasCreditTerms = v.payment_terms_days !== undefined || v.credit_limit !== undefined || v.credit_hold !== undefined || v.credit_hold_reason !== undefined;
  if (hasCreditTerms) {
    assertPermission(actor, "sales.credit.manage");
    if (!v.credit_reason) throw new ApiError(400, "سبب إعداد الائتمان مطلوب");
  }
  if (v.price_list_id !== undefined) {
    assertPermission(actor, "sales.pricing.manage");
    if (!v.price_list_reason) throw new ApiError(400, "سبب ربط قائمة الأسعار مطلوب");
  }
  if ((v.credit_hold ?? false) && !v.credit_hold_reason) throw new ApiError(400, "اكتب سبب إيقاف التعامل الآجل");
  if (!(v.credit_hold ?? false) && v.credit_hold_reason) throw new ApiError(400, "سبب الإيقاف يستخدم فقط عند إيقاف التعامل الآجل");
  try {
    return await inTx(async (tx) => {
      await advisoryXactLock(tx, ALIAS_LOCK);
      const priceList = v.price_list_id ? await tx.priceList.findUnique({ where: { id: v.price_list_id } }) : null;
      if (v.price_list_id && (!priceList || !priceList.active || priceList.currencyCode !== "EGP")) throw new ApiError(400, "قائمة الأسعار غير موجودة أو موقوفة أو ليست بالجنيه المصري");
      const legalEntity = v.legal_entity_id ? await tx.customerLegalEntity.findUnique({ where: { id: v.legal_entity_id } }) : null;
      if (v.legal_entity_id && (!legalEntity || !legalEntity.active)) throw new ApiError(400, "الكيان القانوني غير موجود أو موقوف");
      const groups = v.group_ids?.length ? await tx.customerGroup.findMany({ where: { id: { in: v.group_ids }, active: true }, select: { id: true, code: true } }) : [];
      if (v.group_ids?.length && groups.length !== v.group_ids.length) throw new ApiError(400, "مجموعة من المجموعات المختارة غير موجودة أو موقوفة");
      if (v.code && /^(CUS|SUP)-\d+$/.test(v.code)) throw new ApiError(400, "أكواد CUS-/SUP- برقم محجوزة للترقيم التلقائي — استخدم كودكم أو سيب العمود فاضي");
      if (v.code && (await tx.customer.findUnique({ where: { code: v.code }, select: { id: true } }))) throw new ApiError(409, `كود العميل ${v.code} مستخدم لعميل تاني`);
      const code = v.code ?? (await nextDocumentNumber(tx, "sales.customer", todayLocalISO()));
      const c = await tx.customer.create({
        data: {
          code,
          name: v.name,
          nameAr: v.name_ar ?? null,
          legalName: v.legal_name ?? null,
          legalNameAr: v.legal_name_ar ?? null,
          type: v.type ?? "other",
          taxRegistrationNo: v.tax_registration_no ?? null,
          commercialRegNo: v.commercial_reg_no ?? null,
          phone: v.phone ?? null,
          email: v.email ?? null,
          city: v.city ?? null,
          area: v.area ?? null,
          address: v.address ?? null,
          deliveryNotes: v.delivery_notes ?? null,
          paymentTermsDays: v.payment_terms_days ?? 0,
          creditLimit: v.credit_limit ?? null,
          creditHold: v.credit_hold ?? false,
          creditHoldReason: (v.credit_hold ?? false) ? (v.credit_hold_reason ?? null) : null,
          priceListId: priceList?.id ?? null,
          externalRef: v.external_ref ?? null,
          notes: v.notes ?? null,
          legalEntityId: legalEntity?.id ?? null,
          createdById: actor.id,
          createdBy: actor.name,
        },
      });
      if (groups.length) {
        await tx.customerGroupMember.createMany({
          data: groups.map((g) => ({ groupId: g.id, customerId: c.id, createdById: actor.id, createdBy: actor.name })),
        });
      }
      await claimName(tx, c.id, c.name, "canonical", actor);
      if (c.nameAr && normalizeName(c.nameAr) !== normalizeName(c.name)) await claimName(tx, c.id, c.nameAr, "canonical_ar", actor);
      await writeAudit(audit(actor, { action: "customer_created", entityType: "customer", entityId: c.id, newValue: `${c.code} · ${c.name}` }), tx);
      if (legalEntity) await writeAudit(audit(actor, { action: "customer_edited", entityType: "customer", entityId: c.id, fieldChanged: "legalEntityId", newValue: `${legalEntity.code} · ${legalEntity.name}` }), tx);
      for (const g of groups) await writeAudit(audit(actor, { action: "customer_edited", entityType: "customer", entityId: c.id, fieldChanged: "groupId", newValue: `${g.code}` }), tx);
      if (hasCreditTerms) {
        await writeAuditMany([
          ...(v.payment_terms_days !== undefined ? [audit(actor, { action: "customer_credit_initialized", entityType: "customer", entityId: c.id, fieldChanged: "paymentTermsDays", newValue: String(c.paymentTermsDays), reason: v.credit_reason })] : []),
          ...(v.credit_limit !== undefined ? [audit(actor, { action: "customer_credit_initialized", entityType: "customer", entityId: c.id, fieldChanged: "creditLimit", newValue: c.creditLimit?.toString() ?? null, reason: v.credit_reason })] : []),
          ...(v.credit_hold !== undefined ? [audit(actor, { action: "customer_credit_initialized", entityType: "customer", entityId: c.id, fieldChanged: "creditHold", newValue: String(c.creditHold), reason: v.credit_reason })] : []),
        ], tx);
      }
      if (priceList) await writeAudit(audit(actor, { action: "customer_price_list_assigned", entityType: "customer", entityId: c.id, fieldChanged: "priceListId", newValue: priceList.code, reason: v.price_list_reason }), tx);
      return c;
    });
  } catch (err) {
    uniqueViolation(err, "العميل");
    throw err;
  }
}

const TRACKED: [keyof z.infer<typeof customerUpdate>, keyof Customer][] = [
  ["name", "name"],
  ["name_ar", "nameAr"],
  ["legal_name", "legalName"],
  ["legal_name_ar", "legalNameAr"],
  ["type", "type"],
  ["tax_registration_no", "taxRegistrationNo"],
  ["commercial_reg_no", "commercialRegNo"],
  ["phone", "phone"],
  ["email", "email"],
  ["city", "city"],
  ["area", "area"],
  ["address", "address"],
  ["delivery_notes", "deliveryNotes"],
  ["external_ref", "externalRef"],
  ["notes", "notes"],
  ["active", "active"],
];

export async function updateCustomer(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.customers.manage");
  const v = parse(customerUpdate, input);
  try {
    return await inTx(async (tx) => {
      await advisoryXactLock(tx, ALIAS_LOCK);
      const cur = await tx.customer.findUnique({ where: { id } });
      if (!cur) throw new ApiError(404, "العميل مش موجود");
      if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "بيانات العميل اتغيرت من واحد تاني، حدّث الشاشة");
      const data: Record<string, unknown> = {};
      const audits: AuditInput[] = [];
      for (const [inKey, col] of TRACKED) {
        if (v[inKey] === undefined) continue;
        const next = v[inKey] as unknown;
        const prev = cur[col] as unknown;
        if (next === prev) continue;
        data[col] = next;
        audits.push(audit(actor, { action: "customer_edited", entityType: "customer", entityId: id, fieldChanged: col, oldValue: prev == null ? null : String(prev), newValue: next == null ? null : String(next) }));
      }
      // Legal entity link: a linked entity owns the tax number; a hotel's own tax
      // row then must be cleared (its billing identity is the entity, not the hotel).
      if (v.legal_entity_id !== undefined && (v.legal_entity_id ?? null) !== cur.legalEntityId) {
        const nextId = v.legal_entity_id ?? null;
        if (nextId) {
          const legalEntity = await tx.customerLegalEntity.findUnique({ where: { id: nextId } });
          if (!legalEntity || !legalEntity.active) throw new ApiError(400, "الكيان القانوني غير موجود أو موقوف");
        }
        data.legalEntityId = nextId;
        audits.push(audit(actor, { action: "customer_edited", entityType: "customer", entityId: id, fieldChanged: "legalEntityId", oldValue: cur.legalEntityId ?? null, newValue: nextId }));
        // The card's own legal name and tax are always authoritative; linking or
        // unlinking an entity never alters them. (Legacy compat only.)
      }
      if (audits.length === 0) return cur;
      let updated: Customer;
      try {
        updated = await tx.customer.update({ where: { id, version: cur.version }, data: { ...data, version: { increment: 1 } } });
      } catch (err) {
        if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "بيانات العميل اتغيرت من واحد تاني، حدّث الشاشة");
        throw err;
      }
      // Group membership: replace the whole set when group_ids is provided.
      if (v.group_ids !== undefined) {
        const current = await tx.customerGroupMember.findMany({ where: { customerId: id }, select: { groupId: true, group: { select: { code: true } } } });
        const currentIds = new Set(current.map((m) => m.groupId));
        const wanted = new Set(v.group_ids);
        const remove: string[] = [];
        for (const m of current) if (!wanted.has(m.groupId)) remove.push(m.groupId);
        const keepAudit = current.filter((m) => wanted.has(m.groupId)).map((m) => m.group.code);
        if (remove.length) await tx.customerGroupMember.deleteMany({ where: { customerId: id, groupId: { in: remove } } });
        const add = wanted.size ? await tx.customerGroup.findMany({ where: { id: { in: [...wanted] }, active: true }, select: { id: true, code: true } }) : [];
        if (add.length !== wanted.size) throw new ApiError(400, "مجموعة من المجموعات المختارة غير موجودة أو موقوفة");
        const addAudit: string[] = [];
        for (const g of add) {
          if (currentIds.has(g.id)) continue;
          await tx.customerGroupMember.create({ data: { groupId: g.id, customerId: id, createdById: actor.id, createdBy: actor.name } });
          addAudit.push(g.code);
        }
        const before = current.map((m) => m.group.code).sort().join("، ");
        const afterSet = new Set([...keepAudit, ...addAudit]);
        if (remove.length || addAudit.length) {
          audits.push(audit(actor, { action: "customer_edited", entityType: "customer", entityId: id, fieldChanged: "groupId", oldValue: before || null, newValue: [...afterSet].sort().join("، ") || null }));
        }
      }
      // Canonical aliases follow the names; a manual alias is never touched here.
      if ("name" in data) {
        await releaseCanonical(tx, id, "canonical");
        await claimName(tx, id, updated.name, "canonical", actor);
      }
      if ("nameAr" in data || "name" in data) {
        await releaseCanonical(tx, id, "canonical_ar");
        if (updated.nameAr && normalizeName(updated.nameAr) !== normalizeName(updated.name)) await claimName(tx, id, updated.nameAr, "canonical_ar", actor);
      }
      await writeAuditMany(audits, tx);
      return updated;
    });
  } catch (err) {
    uniqueViolation(err, "العميل");
    throw err;
  }
}

/** Payment terms, credit limit and credit hold — finance's call, always with a reason. */
export async function updateCustomerCredit(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.credit.manage");
  const v = parse(creditUpdate, input);
  return inTx(async (tx) => {
    const cur = await tx.customer.findUnique({ where: { id } });
    if (!cur) throw new ApiError(404, "العميل مش موجود");
    if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "بيانات العميل اتغيرت من واحد تاني، حدّث الشاشة");
    const hold = v.credit_hold ?? cur.creditHold;
    const holdReason = v.credit_hold_reason !== undefined ? v.credit_hold_reason : cur.creditHoldReason;
    if (hold && !holdReason) throw new ApiError(400, "اكتب سبب إيقاف التعامل الآجل");
    const changes: [string, string | null, string | null][] = [];
    const data: Prisma.CustomerUpdateInput = {};
    if (v.payment_terms_days !== undefined && v.payment_terms_days !== cur.paymentTermsDays) {
      changes.push(["paymentTermsDays", String(cur.paymentTermsDays), String(v.payment_terms_days)]);
      data.paymentTermsDays = v.payment_terms_days;
    }
    if (v.credit_limit !== undefined) {
      const prev = cur.creditLimit?.toString() ?? null;
      const next = v.credit_limit?.toString() ?? null;
      if (prev !== next) {
        changes.push(["creditLimit", prev, next]);
        data.creditLimit = v.credit_limit;
      }
    }
    if (hold !== cur.creditHold) {
      changes.push(["creditHold", String(cur.creditHold), String(hold)]);
      data.creditHold = hold;
    }
    const nextReason = hold ? holdReason : null;
    if (nextReason !== cur.creditHoldReason) data.creditHoldReason = nextReason;
    if (changes.length === 0 && data.creditHoldReason === undefined) return cur;
    let updated: Customer;
    try {
      updated = await tx.customer.update({ where: { id, version: cur.version }, data: { ...data, version: { increment: 1 } } });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "بيانات العميل اتغيرت من واحد تاني، حدّث الشاشة");
      throw err;
    }
    await writeAuditMany(
      changes.map(([f, o, n]) => audit(actor, { action: "customer_credit_changed", entityType: "customer", entityId: id, fieldChanged: f, oldValue: o, newValue: n, reason: v.reason })),
      tx
    );
    return updated;
  });
}

export async function addCustomerAlias(customerId: string, rawAlias: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.customers.manage");
  const alias = parse(text("الاسم البديل"), rawAlias);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, ALIAS_LOCK);
    const c = await tx.customer.findUnique({ where: { id: customerId } });
    if (!c) throw new ApiError(404, "العميل مش موجود");
    const row = await claimName(tx, customerId, alias, "manual", actor);
    await writeAudit(audit(actor, { action: "customer_alias_added", entityType: "customer_alias", entityId: row.id, fieldChanged: c.code, newValue: alias }), tx);
    return row;
  });
}

export async function removeCustomerAlias(aliasId: string, actor: ServiceActor) {
  assertPermission(actor, "sales.customers.manage");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, ALIAS_LOCK);
    const a = await tx.customerAlias.findUnique({ where: { id: aliasId } });
    if (!a) throw new ApiError(404, "الاسم البديل مش موجود");
    if (a.kind !== "manual") throw new ApiError(400, "الاسم الأساسي بيتغير من بيانات العميل نفسها");
    await tx.customerAlias.delete({ where: { id: aliasId } });
    await writeAudit(audit(actor, { action: "customer_alias_removed", entityType: "customer_alias", entityId: aliasId, oldValue: a.alias }), tx);
    return { removed: true };
  });
}

export async function saveContact(customerId: string, contactId: string | null, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.customers.manage");
  const v = parse(contactInput, input);
  return inTx(async (tx) => {
    const c = await tx.customer.findUnique({ where: { id: customerId } });
    if (!c) throw new ApiError(404, "العميل مش موجود");
    // Making this one primary demotes the current primary, in the same transaction
    // (the partial unique index would otherwise refuse the second primary).
    if (v.is_primary) await tx.customerContact.updateMany({ where: { customerId, isPrimary: true, ...(contactId ? { id: { not: contactId } } : {}) }, data: { isPrimary: false, version: { increment: 1 } } });
    const data = { name: v.name, role: v.role ?? null, phone: v.phone ?? null, email: v.email ?? null, isPrimary: v.is_primary ?? false, active: v.active ?? true };
    let row;
    if (contactId) {
      const cur = await tx.customerContact.findUnique({ where: { id: contactId } });
      if (!cur || cur.customerId !== customerId) throw new ApiError(404, "جهة الاتصال مش موجودة");
      if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "جهة الاتصال اتغيرت، حدّث الشاشة");
      row = await tx.customerContact.update({ where: { id: contactId }, data: { ...data, version: { increment: 1 } } });
    } else {
      row = await tx.customerContact.create({ data: { customerId, ...data } });
    }
    await writeAudit(audit(actor, { action: contactId ? "customer_contact_edited" : "customer_contact_added", entityType: "customer_contact", entityId: row.id, fieldChanged: c.code, newValue: `${row.name}${row.phone ? ` · ${row.phone}` : ""}` }), tx);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Resolution — how an order finds its customer
// ---------------------------------------------------------------------------

export type CustomerResolution =
  | { status: "matched"; customerId: string; matchedOn: "external_ref" | "alias" | "explicit" }
  | { status: "unmapped"; reason: "blank" | "no_match" | "inactive" };

/**
 * Exact resolution, in order: an explicit account chosen on screen; the integration's
 * customer id; the normalized name against every recorded name and alias. An inactive
 * customer does not match (a closed account must not silently collect new orders).
 */
export async function resolveCustomer(
  db: Pick<Tx, "customer" | "customerAlias">,
  input: { accountId?: string | null; externalRef?: string | null; name?: string | null }
): Promise<CustomerResolution> {
  if (input.accountId) {
    const c = await db.customer.findUnique({ where: { id: input.accountId } });
    if (!c) throw new ApiError(400, "العميل المختار مش موجود");
    if (!c.active) throw new ApiError(400, `العميل ${c.code} موقوف`);
    return { status: "matched", customerId: c.id, matchedOn: "explicit" };
  }
  if (input.externalRef) {
    const c = await db.customer.findUnique({ where: { externalRef: input.externalRef } });
    if (c) return c.active ? { status: "matched", customerId: c.id, matchedOn: "external_ref" } : { status: "unmapped", reason: "inactive" };
  }
  const normalized = normalizeName(input.name ?? "");
  if (!normalized) return { status: "unmapped", reason: "blank" };
  const hits = await db.customerAlias.findMany({ where: { normalized }, include: { customer: { select: { id: true, active: true } } } });
  if (hits.length !== 1) return { status: "unmapped", reason: "no_match" };
  return hits[0].customer.active ? { status: "matched", customerId: hits[0].customer.id, matchedOn: "alias" } : { status: "unmapped", reason: "inactive" };
}

/** Customer names on orders that no account claims yet, most frequent first. */
export async function unmappedOrderCustomers() {
  const rows = await prisma.order.groupBy({
    by: ["customerName"],
    where: { customerAccountId: null },
    _count: { _all: true },
    _max: { deliveryDate: true },
  });
  return rows
    .map((r) => ({ customerName: r.customerName, orders: r._count._all, lastDeliveryDate: r._max.deliveryDate }))
    .sort((a, b) => b.orders - a.orders || a.customerName.localeCompare(b.customerName));
}

/**
 * A person decides that a customer name on orders means this account: the name is
 * recorded as an alias (so future orders resolve by themselves) and every order still
 * carrying that name unmapped is linked — one audited decision, one transaction.
 */
export async function mapOrderCustomerName(rawName: unknown, customerId: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.customers.manage");
  const name = parse(text("اسم العميل في الأوردر"), rawName);
  if (typeof customerId !== "string" || !customerId) throw new ApiError(400, "اختار العميل");
  const normalized = normalizeName(name);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, ALIAS_LOCK);
    const c = await tx.customer.findUnique({ where: { id: customerId } });
    if (!c) throw new ApiError(404, "العميل مش موجود");
    if (!c.active) throw new ApiError(400, `العميل ${c.code} موقوف`);
    const alias = await claimName(tx, c.id, name, "manual", actor);
    // Normalization happens in code, so candidate orders are narrowed in SQL by the
    // unmapped flag and compared here.
    const candidates = await tx.order.findMany({ where: { customerAccountId: null }, select: { id: true, customerName: true } });
    const ids = candidates.filter((o) => normalizeName(o.customerName) === normalized).map((o) => o.id);
    if (ids.length) await tx.order.updateMany({ where: { id: { in: ids }, customerAccountId: null }, data: { customerAccountId: c.id } });
    // The customer may have its own price list: list prices are refreshed for it.
    for (const orderId of ids) await applyListPrices(tx, orderId, actor, { refresh: true });
    await writeAudit(
      audit(actor, { action: "order_customer_mapped", entityType: "customer", entityId: c.id, fieldChanged: "customerAccountId", oldValue: name, newValue: `${c.code} · ${ids.length} أوردر` }),
      tx
    );
    return { alias, ordersLinked: ids.length };
  });
}

// ---------------------------------------------------------------------------
// Commercial groups (brands) and legal billing entities
// ---------------------------------------------------------------------------

const codeField = (label: string) =>
  z
    .string({ invalid_type_error: `${label} لازم يكون نص` })
    .trim()
    .min(1, `${label} مطلوب`)
    .max(20, `${label} طويل أوي`)
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z0-9_-]+$/.test(v), `${label} لازم حروف/أرقام/شرطة فقط`);

const groupCreate = z.object({
  code: codeField("كود المجموعة"),
  name: text("اسم المجموعة"),
  name_ar: optText("اسم المجموعة بالعربي").optional(),
});

const legalEntityCreate = z.object({
  code: codeField("كود الكيان القانوني"),
  name: text("الاسم القانوني"),
  name_ar: optText("الاسم القانوني بالعربي").optional(),
  tax_registration_no: taxId.optional(),
  commercial_reg_no: optText("السجل التجاري", 40).optional(),
  phone: optText("التليفون", 40).optional(),
  email: optText("الإيميل").optional(),
  address: optText("العنوان", 500).optional(),
  area: optText("المنطقة", 120).optional(),
  city: optText("المدينة", 80).optional(),
  country: optText("الدولة", 60).optional(),
  governate: optText("المحافظة", 60).optional(),
  region_city: optText("المنطقة/المدينة", 60).optional(),
  street: optText("الشارع", 120).optional(),
  building_number: optText("رقم المبنى", 40).optional(),
  postal_code: optText("الرقم البريدي", 20).optional(),
  floor: optText("الدور", 40).optional(),
  room: optText("الغرفة", 40).optional(),
  landmark: optText("علامة مميزة", 120).optional(),
  additional_information: optText("معلومات إضافية", 200).optional(),
  receiver_type: z.enum(["B", "P", "F"], { errorMap: () => ({ message: "receiver_type لازم B أو P أو F" }) }).nullable().optional(),
  receiver_id: optText("رقم هوية المستلم", 60).optional(),
  notes: optText("ملاحظات", 2000).optional(),
});

const legalEntityUpdate = legalEntityCreate.partial().extend({ active: active().optional(), expected_version: version });

/** Creates a commercial group/brand (JAZ, Four Seasons, ...). Purely commercial. */
export async function createCustomerGroup(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.customers.manage");
  const v = parse(groupCreate, input);
  try {
    return await inTx(async (tx) => {
      const g = await tx.customerGroup.create({
        data: { code: v.code, name: v.name, nameAr: v.name_ar ?? null, createdById: actor.id, createdBy: actor.name },
      });
      await writeAudit(audit(actor, { action: "customer_group_created", entityType: "customer_group", entityId: g.id, newValue: `${g.code} · ${g.name}` }), tx);
      return g;
    });
  } catch (err) {
    const e = err as { code?: string; meta?: { target?: string[] | string } };
    if (e?.code === "P2002" && String(e.meta?.target ?? "").includes("code")) throw new ApiError(409, "كود المجموعة مستخدم قبل كده");
    throw err;
  }
}

/** All active groups with their current hotel counts. */
export async function listCustomerGroups() {
  const groups = await prisma.customerGroup.findMany({
    where: { active: true },
    orderBy: [{ code: "asc" }],
    include: { _count: { select: { members: true } } },
  });
  return groups.map(({ _count, ...g }) => ({ ...g, hotels: _count.members }));
}

/** Creates a legal billing entity that owns a tax number; hotels link to it. */
export async function createCustomerLegalEntity(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.customers.manage");
  const v = parse(legalEntityCreate, input);
  try {
    return await inTx(async (tx) => {
      const le = await tx.customerLegalEntity.create({
        data: {
          code: v.code,
          name: v.name,
          nameAr: v.name_ar ?? null,
          taxRegistrationNo: v.tax_registration_no ?? null,
          commercialRegNo: v.commercial_reg_no ?? null,
          phone: v.phone ?? null,
          email: v.email ?? null,
          address: v.address ?? null,
          area: v.area ?? null,
          city: v.city ?? null,
          country: v.country ?? null,
          governate: v.governate ?? null,
          regionCity: v.region_city ?? null,
          street: v.street ?? null,
          buildingNumber: v.building_number ?? null,
          postalCode: v.postal_code ?? null,
          floor: v.floor ?? null,
          room: v.room ?? null,
          landmark: v.landmark ?? null,
          additionalInformation: v.additional_information ?? null,
          receiverType: v.receiver_type ?? null,
          receiverId: v.receiver_id ?? null,
          notes: v.notes ?? null,
          createdById: actor.id,
          createdBy: actor.name,
        },
      });
      await writeAudit(audit(actor, { action: "customer_legal_entity_created", entityType: "customer_legal_entity", entityId: le.id, newValue: `${le.code} · ${le.name}` }), tx);
      return le;
    });
  } catch (err) {
    const e = err as { code?: string; meta?: { target?: string[] | string } };
    if (e?.code === "P2002") {
      const target = String(e.meta?.target ?? "");
      if (target.includes("taxRegistrationNo")) throw new ApiError(409, "الرقم الضريبي مسجل لكيان قانوني آخر");
      if (target.includes("code")) throw new ApiError(409, "كود الكيان القانوني مستخدم قبل كده");
    }
    throw err;
  }
}

/** All active legal entities with their linked hotel counts. */
export async function listCustomerLegalEntities() {
  const entities = await prisma.customerLegalEntity.findMany({
    where: { active: true },
    orderBy: [{ code: "asc" }],
    include: { _count: { select: { customers: true } } },
  });
  return entities.map(({ _count, ...le }) => ({ ...le, hotels: _count.customers }));
}

/** Updates a legal entity (name, tax data, billing/e-invoice details). */
export async function updateCustomerLegalEntity(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "sales.customers.manage");
  const v = parse(legalEntityUpdate, input);
  try {
    return await inTx(async (tx) => {
      const cur = await tx.customerLegalEntity.findUnique({ where: { id } });
      if (!cur) throw new ApiError(404, "الكيان القانوني مش موجود");
      if (v.expected_version !== undefined && v.expected_version !== cur.version) throw new ApiError(409, "بيانات الكيان القانوني اتغيرت، حدّث الشاشة");
      const data: Prisma.CustomerLegalEntityUpdateInput = {};
      const audits: AuditInput[] = [];
      const pairs: [keyof z.infer<typeof legalEntityCreate>, keyof CustomerLegalEntity][] = [
        ["name", "name"], ["name_ar", "nameAr"], ["tax_registration_no", "taxRegistrationNo"], ["commercial_reg_no", "commercialRegNo"],
        ["phone", "phone"], ["email", "email"], ["address", "address"], ["area", "area"], ["city", "city"],
        ["country", "country"], ["governate", "governate"], ["region_city", "regionCity"], ["street", "street"], ["building_number", "buildingNumber"],
        ["postal_code", "postalCode"], ["floor", "floor"], ["room", "room"], ["landmark", "landmark"], ["additional_information", "additionalInformation"],
        ["receiver_type", "receiverType"], ["receiver_id", "receiverId"], ["notes", "notes"],
      ];
      for (const [inKey, col] of pairs) {
        if (v[inKey] === undefined) continue;
        const next = v[inKey] as unknown;
        const prev = col === "taxRegistrationNo" ? (cur.taxRegistrationNo ?? null) : (cur[col] as unknown);
        if (next === prev) continue;
        (data as Record<string, unknown>)[col] = next;
        audits.push(audit(actor, { action: "customer_legal_entity_edited", entityType: "customer_legal_entity", entityId: id, fieldChanged: col, oldValue: prev == null ? null : String(prev), newValue: next == null ? null : String(next) }));
      }
      if (v.active !== undefined && v.active !== cur.active) {
        data.active = v.active;
        audits.push(audit(actor, { action: "customer_legal_entity_edited", entityType: "customer_legal_entity", entityId: id, fieldChanged: "active", oldValue: String(cur.active), newValue: String(v.active) }));
      }
      if (audits.length === 0) return cur;
      let updated: CustomerLegalEntity;
      try {
        updated = await tx.customerLegalEntity.update({ where: { id, version: cur.version }, data: { ...data, version: { increment: 1 } } });
      } catch (err) {
        if ((err as { code?: string })?.code === "P2025") throw new ApiError(409, "بيانات الكيان القانوني اتغيرت، حدّث الشاشة");
        throw err;
      }
      await writeAuditMany(audits, tx);
      return updated;
    });
  } catch (err) {
    const e = err as { code?: string; meta?: { target?: string[] | string } };
    if (e?.code === "P2002") {
      const target = String(e.meta?.target ?? "");
      if (target.includes("taxRegistrationNo")) throw new ApiError(409, "الرقم الضريبي مسجل لكيان قانوني آخر");
      if (target.includes("code")) throw new ApiError(409, "كود الكيان القانوني مستخدم قبل كده");
    }
    throw err;
  }
}
