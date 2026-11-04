import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAuditMany, type AuditInput } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { inTx, type Tx } from "@/lib/tx";
import { advisoryXactLock } from "@/lib/dbLock";
import type { ServiceActor } from "@/lib/core/actor";
import { STORAGE_LOCATION_TYPES, UOM_CATEGORIES } from "@/lib/core/reference-data";
import { active, optDecimal, optText, parse, text, version } from "@/lib/core/validation";
import { egpCurrencyCode } from "@/lib/core/currency";

/**
 * Organisation master data: currencies, company → branch → warehouse → storage
 * location, and units of measure.
 *
 * Rules held here (the database backs the structural ones with CHECKs):
 *  - Codes are set once. They will be printed on documents and referenced by stock
 *    and accounting rows; a renamed code silently changes what old paperwork meant.
 *  - Nothing is deleted. Records are deactivated; a parent cannot be deactivated while
 *    it has active children, and a child cannot be created under (or reactivated
 *    beneath) an inactive parent — so the active structure is always a connected tree.
 *  - A unit's category and conversion ratio are fixed once created. Changing "1 TON =
 *    1000 KG" after quantities exist in tons would rewrite history; a correction is a
 *    new unit.
 *  - Every write is versioned (409 on a stale edit) and audited field by field, in the
 *    same transaction as the change.
 */

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]*$/;
const UOM_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

const code = (label: string, re = CODE_RE) =>
  z
    .string({ invalid_type_error: `${label} لازم يكون نص` })
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => re.test(v), `${label} لازم يكون حروف إنجليزي كبيرة وأرقام و - أو _ بس`);

const companyCreate = z.object({
  code: code("كود الشركة"),
  legal_name: text("الاسم القانوني"),
  trade_name: optText("الاسم التجاري").optional(),
  name_ar: optText("الاسم بالعربي").optional(),
  tax_registration_number: optText("رقم التسجيل الضريبي", 40).optional(),
  commercial_registration: optText("رقم السجل التجاري", 40).optional(),
  address: optText("العنوان", 500).optional(),
  phone: optText("التليفون", 40).optional(),
  email: optText("الإيميل", 200).optional(),
  base_currency_code: egpCurrencyCode.optional(),
  // Printed on invoices only when set (commercial invoices, Nov 2026).
  legal_form: optText("الشكل القانوني", 120).optional(),
  issued_capital: optText("رأس المال المصدر", 60).optional(),
  bank_name: optText("اسم البنك", 120).optional(),
  bank_account_name: optText("اسم الحساب البنكي", 160).optional(),
  bank_account_number: optText("رقم الحساب البنكي", 40).optional().refine((v) => !v || /^[0-9A-Za-z -]{4,40}$/.test(v), "رقم الحساب البنكي: أرقام وحروف إنجليزي بس (4 لـ 40)"),
  iban: optText("الـ IBAN", 34).optional().transform((v) => (v ? v.replace(/\s+/g, "").toUpperCase() : v)).refine((v) => !v || /^EG\d{27}$/.test(v), "الـ IBAN المصري: EG وبعدها 27 رقم"),
  invoice_terms: optText("شروط الفاتورة", 1500).optional(),
});
const companyUpdate = companyCreate.omit({ code: true }).partial().extend({ active: active().optional(), expected_version: version });

const branchCreate = z.object({
  company_id: text("الشركة"),
  code: code("كود الفرع"),
  name: text("اسم الفرع"),
  name_ar: optText("الاسم بالعربي").optional(),
  address: optText("العنوان", 500).optional(),
  phone: optText("التليفون", 40).optional(),
});
const branchUpdate = branchCreate.omit({ code: true, company_id: true }).partial().extend({ active: active().optional(), expected_version: version });

const warehouseCreate = z.object({
  branch_id: text("الفرع"),
  code: code("كود المخزن"),
  name: text("اسم المخزن"),
  name_ar: optText("الاسم بالعربي").optional(),
  address: optText("العنوان", 500).optional(),
  area_m2: optDecimal("المساحة").optional(),
  daily_capacity_kg: optDecimal("الطاقة اليومية").optional(),
});
const warehouseUpdate = warehouseCreate.omit({ code: true, branch_id: true }).partial().extend({ active: active().optional(), expected_version: version });

const locationCreate = z.object({
  warehouse_id: text("المخزن"),
  parent_id: optText("المكان الأب").optional(),
  code: code("كود المكان"),
  name: text("اسم المكان"),
  name_ar: optText("الاسم بالعربي").optional(),
  type: z.enum(STORAGE_LOCATION_TYPES, { errorMap: () => ({ message: "نوع المكان غير معروف" }) }),
  capacity_kg: optDecimal("السعة").optional(),
  temp_min_c: optDecimal("أقل درجة حرارة", { min: -60, max: 60 }).optional(),
  temp_max_c: optDecimal("أعلى درجة حرارة", { min: -60, max: 60 }).optional(),
});
const locationUpdate = locationCreate
  .omit({ code: true, warehouse_id: true })
  .partial()
  .extend({ active: active().optional(), expected_version: version });

const uomCreate = z.object({
  code: code("كود الوحدة", UOM_CODE_RE),
  name: text("اسم الوحدة"),
  name_ar: optText("الاسم بالعربي").optional(),
  category: z.enum(UOM_CATEGORIES as [string, ...string[]], { errorMap: () => ({ message: "نوع الوحدة غير معروف" }) }),
  ratio_to_reference: optDecimal("معامل التحويل", { min: null }).optional(),
  precision: z.number().int("عدد الخانات العشرية لازم يكون رقم صحيح").min(0).max(6).optional(),
});
const uomUpdate = z.object({
  name: text("اسم الوحدة").optional(),
  name_ar: optText("الاسم بالعربي").optional(),
  precision: z.number().int("عدد الخانات العشرية لازم يكون رقم صحيح").min(0).max(6).optional(),
  active: active().optional(),
  expected_version: version,
});

const currencyCreate = z.object({
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z]{3}$/.test(v), "كود العملة لازم يكون 3 حروف (ISO 4217) زي EGP"),
  name: text("اسم العملة"),
  name_ar: optText("الاسم بالعربي").optional(),
  symbol: optText("الرمز", 10).optional(),
  decimal_places: z.number().int().min(0).max(4).optional(),
});
const currencyUpdate = currencyCreate.omit({ code: true }).partial().extend({ active: active().optional(), expected_version: version });

// ---------------------------------------------------------------------------
// Shared write plumbing
// ---------------------------------------------------------------------------

type EntityType = "company" | "branch" | "warehouse" | "storage_location" | "unit_of_measure" | "currency";

function show(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Prisma.Decimal) return v.toString();
  return String(v);
}

/** Builds the Prisma update payload and the per-field change list from the fields the
 * caller actually sent. Unchanged values are dropped, so a no-op save writes nothing. */
function diff(existing: Record<string, unknown>, next: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  const changes: [string, string | null, string | null][] = [];
  for (const [field, value] of Object.entries(next)) {
    if (value === undefined) continue;
    const before = show(existing[field]);
    const after = show(value);
    if (before === after) continue;
    data[field] = value;
    changes.push([field, before, after]);
  }
  return { data, changes };
}

function auditRows(
  actor: ServiceActor,
  entityType: EntityType,
  entityId: string,
  action: string,
  changes: [string, string | null, string | null][]
): AuditInput[] {
  return changes.map(([fieldChanged, oldValue, newValue]) => ({
    userId: actor.id,
    userName: actor.name,
    role: actor.role,
    action: fieldChanged === "active" ? (newValue === "true" ? `${entityType}_activated` : `${entityType}_deactivated`) : action,
    entityType,
    entityId,
    fieldChanged,
    oldValue,
    newValue,
    source: "user" as const,
    deviceId: actor.deviceId,
  }));
}

function createdAudit(actor: ServiceActor, entityType: EntityType, entityId: string, summary: string): AuditInput {
  return {
    userId: actor.id,
    userName: actor.name,
    role: actor.role,
    action: `${entityType}_created`,
    entityType,
    entityId,
    newValue: summary,
    source: "user",
    deviceId: actor.deviceId,
  };
}

function uniqueConflict(err: unknown, message: string): never {
  if ((err as { code?: string })?.code === "P2002") throw new ApiError(409, message);
  throw err;
}

function staleVersion(what: string, current: number): never {
  throw new ApiError(409, `${what} اتغيّر من واحد تاني، حدّث الشاشة وحاول تاني (النسخة الحالية: ${current})`);
}

function checkVersion(what: string, current: number, expected: number | undefined) {
  if (expected !== undefined && expected !== current) staleVersion(what, current);
}

/**
 * Serialises structural changes around one node of the tree. Creating a child and
 * deactivating its parent both take the PARENT's lock and re-check inside the
 * transaction — otherwise the two can interleave and leave an active child under an
 * inactive parent, each having checked a state the other was about to change.
 */
function lockNode(tx: Tx, id: string) {
  return advisoryXactLock(tx, `org-node:${id}`);
}

/** Runs a versioned UPDATE (compare-and-swap on version) plus its audit rows. `guard`
 * runs first inside the same transaction, for checks that must not go stale. */
async function casUpdate<T>(
  what: string,
  currentVersion: number,
  changes: [string, string | null, string | null][],
  audit: AuditInput[],
  write: (tx: Tx) => Promise<T>,
  guard?: (tx: Tx) => Promise<void>
): Promise<T | null> {
  if (changes.length === 0) return null;
  return inTx(async (tx) => {
    if (guard) await guard(tx);
    let row: T;
    try {
      row = await write(tx);
    } catch (err) {
      if ((err as { code?: string })?.code === "P2025") staleVersion(what, currentVersion);
      throw err;
    }
    await writeAuditMany(audit, tx);
    return row;
  });
}

function manage(actor: ServiceActor) {
  assertPermission(actor, "core.masterdata.manage");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The whole structure, for the admin centre (inactive rows included). */
export async function getMasterData() {
  const [currencies, companies, uoms] = await Promise.all([
    prisma.currency.findMany({ orderBy: [{ active: "desc" }, { code: "asc" }] }),
    prisma.company.findMany({
      orderBy: { code: "asc" },
      include: {
        branches: {
          orderBy: { code: "asc" },
          include: {
            warehouses: {
              orderBy: { code: "asc" },
              include: { locations: { orderBy: { code: "asc" } } },
            },
          },
        },
      },
    }),
    prisma.unitOfMeasure.findMany({ orderBy: [{ category: "asc" }, { isReference: "desc" }, { code: "asc" }] }),
  ]);
  return { currencies, companies, uoms };
}

/** Active reference lists that operational modules pick from (units, warehouses and
 * their locations, currencies). */
export async function getReferenceData() {
  const [uoms, currencies, warehouses] = await Promise.all([
    prisma.unitOfMeasure.findMany({
      where: { active: true },
      orderBy: [{ category: "asc" }, { isReference: "desc" }, { code: "asc" }],
    }),
    prisma.currency.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.warehouse.findMany({
      where: { active: true, branch: { active: true, company: { active: true } } },
      orderBy: { code: "asc" },
      include: { locations: { where: { active: true }, orderBy: { code: "asc" } } },
    }),
  ]);
  return { uoms, currencies, warehouses };
}

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------

export async function createCurrency(input: unknown, actor: ServiceActor) {
  manage(actor);
  const v = parse(currencyCreate, input);
  if (v.code !== "EGP") throw new ApiError(400, "دفاتر UNITED بالجنيه المصري فقط؛ لا يمكن إضافة عملة أخرى");
  return inTx(async (tx) => {
    const row = await tx.currency
      .create({
        data: {
          code: v.code,
          name: v.name,
          nameAr: v.name_ar ?? null,
          symbol: v.symbol ?? null,
          decimalPlaces: v.decimal_places ?? 2,
        },
      })
      .catch((e) => uniqueConflict(e, `العملة ${v.code} موجودة بالفعل`));
    await writeAuditMany([createdAudit(actor, "currency", row.code, `${row.code} · ${row.name}`)], tx);
    return row;
  });
}

export async function updateCurrency(codeParam: string, input: unknown, actor: ServiceActor) {
  manage(actor);
  const v = parse(currencyUpdate, input);
  const code = codeParam.toUpperCase();
  if (code !== "EGP" && (v.active === true || v.name !== undefined || v.name_ar !== undefined || v.symbol !== undefined || v.decimal_places !== undefined)) {
    throw new ApiError(400, "دفاتر UNITED بالجنيه المصري فقط؛ بيانات العملات الأخرى للقراءة فقط");
  }
  const existing = await prisma.currency.findUnique({ where: { code } });
  if (!existing) throw new ApiError(404, "العملة مش موجودة");
  checkVersion("العملة", existing.version, v.expected_version);
  const { data, changes } = diff(existing, {
    name: v.name,
    nameAr: v.name_ar,
    symbol: v.symbol,
    decimalPlaces: v.decimal_places,
    active: v.active,
  });
  const row = await casUpdate(
    "العملة",
    existing.version,
    changes,
    auditRows(actor, "currency", existing.code, "currency_updated", changes),
    (tx) => tx.currency.update({ where: { code: existing.code, version: existing.version }, data: { ...data, version: { increment: 1 } } }),
    async (tx) => {
      await lockNode(tx, `currency:${existing.code}`);
      if (v.active === false && existing.active) {
        const users = await tx.company.count({ where: { baseCurrencyCode: existing.code, active: true } });
        if (users > 0) throw new ApiError(409, `مينفعش توقف ${existing.code} — دي العملة الأساسية لشركة نشطة`);
      }
    }
  );
  return row ?? existing;
}

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

async function assertActiveCurrency(tx: Tx, codeValue: string) {
  await lockNode(tx, `currency:${codeValue}`);
  const c = await tx.currency.findUnique({ where: { code: codeValue } });
  if (!c) throw new ApiError(400, `العملة ${codeValue} مش موجودة`);
  if (!c.active) throw new ApiError(400, `العملة ${codeValue} موقوفة`);
}

export async function createCompany(input: unknown, actor: ServiceActor) {
  manage(actor);
  const v = parse(companyCreate, input);
  const currency = v.base_currency_code ?? "EGP";
  return inTx(async (tx) => {
    await assertActiveCurrency(tx, currency);
    const row = await tx.company
      .create({
        data: {
          code: v.code,
          legalName: v.legal_name,
          tradeName: v.trade_name ?? null,
          nameAr: v.name_ar ?? null,
          taxRegistrationNumber: v.tax_registration_number ?? null,
          commercialRegistration: v.commercial_registration ?? null,
          address: v.address ?? null,
          phone: v.phone ?? null,
          email: v.email ?? null,
          legalForm: v.legal_form ?? null,
          issuedCapital: v.issued_capital ?? null,
          bankName: v.bank_name ?? null,
          bankAccountName: v.bank_account_name ?? null,
          bankAccountNumber: v.bank_account_number ?? null,
          iban: v.iban ?? null,
          invoiceTerms: v.invoice_terms ?? null,
          baseCurrencyCode: currency,
        },
      })
      .catch((e) => uniqueConflict(e, `فيه شركة بالكود ${v.code}`));
    await writeAuditMany([createdAudit(actor, "company", row.id, `${row.code} · ${row.legalName}`)], tx);
    return row;
  });
}

export async function updateCompany(id: string, input: unknown, actor: ServiceActor) {
  manage(actor);
  const v = parse(companyUpdate, input);
  const existing = await prisma.company.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "الشركة مش موجودة");
  checkVersion("الشركة", existing.version, v.expected_version);
  const { data, changes } = diff(existing, {
    legalName: v.legal_name,
    tradeName: v.trade_name,
    nameAr: v.name_ar,
    taxRegistrationNumber: v.tax_registration_number,
    commercialRegistration: v.commercial_registration,
    address: v.address,
    phone: v.phone,
    email: v.email,
    legalForm: v.legal_form,
    issuedCapital: v.issued_capital,
    bankName: v.bank_name,
    bankAccountName: v.bank_account_name,
    bankAccountNumber: v.bank_account_number,
    iban: v.iban,
    invoiceTerms: v.invoice_terms,
    baseCurrencyCode: v.base_currency_code,
    active: v.active,
  });
  const row = await casUpdate(
    "الشركة",
    existing.version,
    changes,
    auditRows(actor, "company", id, "company_updated", changes),
    (tx) => tx.company.update({ where: { id, version: existing.version }, data: { ...data, version: { increment: 1 } } }),
    async (tx) => {
      if (v.base_currency_code && v.base_currency_code !== existing.baseCurrencyCode) {
        await assertActiveCurrency(tx, v.base_currency_code);
      }
      await lockNode(tx, id);
      if (v.active === false && existing.active) {
        const children = await tx.branch.count({ where: { companyId: id, active: true } });
        if (children > 0) throw new ApiError(409, `أوقف الفروع النشطة الأول (${children})`);
      }
    }
  );
  return row ?? existing;
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

export async function createBranch(input: unknown, actor: ServiceActor) {
  manage(actor);
  const v = parse(branchCreate, input);
  return inTx(async (tx) => {
    await lockNode(tx, v.company_id);
    const company = await tx.company.findUnique({ where: { id: v.company_id } });
    if (!company) throw new ApiError(404, "الشركة مش موجودة");
    if (!company.active) throw new ApiError(400, "الشركة موقوفة — فعّلها الأول");
    const row = await tx.branch
      .create({
        data: { companyId: company.id, code: v.code, name: v.name, nameAr: v.name_ar ?? null, address: v.address ?? null, phone: v.phone ?? null },
      })
      .catch((e) => uniqueConflict(e, `فيه فرع بالكود ${v.code} في الشركة دي`));
    await writeAuditMany([createdAudit(actor, "branch", row.id, `${company.code}/${row.code} · ${row.name}`)], tx);
    return row;
  });
}

export async function updateBranch(id: string, input: unknown, actor: ServiceActor) {
  manage(actor);
  const v = parse(branchUpdate, input);
  const existing = await prisma.branch.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "الفرع مش موجود");
  checkVersion("الفرع", existing.version, v.expected_version);
  const { data, changes } = diff(existing, { name: v.name, nameAr: v.name_ar, address: v.address, phone: v.phone, active: v.active });
  const row = await casUpdate(
    "الفرع",
    existing.version,
    changes,
    auditRows(actor, "branch", id, "branch_updated", changes),
    (tx) => tx.branch.update({ where: { id, version: existing.version }, data: { ...data, version: { increment: 1 } } }),
    async (tx) => {
      if (v.active === true && !existing.active) {
        await lockNode(tx, existing.companyId);
        const company = await tx.company.findUnique({ where: { id: existing.companyId } });
        if (!company?.active) throw new ApiError(409, "الشركة موقوفة — فعّلها الأول");
      }
      await lockNode(tx, id);
      if (v.active === false && existing.active) {
        const children = await tx.warehouse.count({ where: { branchId: id, active: true } });
        if (children > 0) throw new ApiError(409, `أوقف المخازن النشطة الأول (${children})`);
      }
    }
  );
  return row ?? existing;
}

// ---------------------------------------------------------------------------
// Warehouse
// ---------------------------------------------------------------------------

export async function createWarehouse(input: unknown, actor: ServiceActor) {
  manage(actor);
  const v = parse(warehouseCreate, input);
  return inTx(async (tx) => {
    await lockNode(tx, v.branch_id);
    const branch = await tx.branch.findUnique({ where: { id: v.branch_id } });
    if (!branch) throw new ApiError(404, "الفرع مش موجود");
    if (!branch.active) throw new ApiError(400, "الفرع موقوف — فعّله الأول");
    const row = await tx.warehouse
      .create({
        data: {
          branchId: branch.id,
          code: v.code,
          name: v.name,
          nameAr: v.name_ar ?? null,
          address: v.address ?? null,
          areaM2: v.area_m2 ?? null,
          dailyCapacityKg: v.daily_capacity_kg ?? null,
        },
      })
      .catch((e) => uniqueConflict(e, `فيه مخزن بالكود ${v.code}`));
    await writeAuditMany([createdAudit(actor, "warehouse", row.id, `${row.code} · ${row.name}`)], tx);
    return row;
  });
}

export async function updateWarehouse(id: string, input: unknown, actor: ServiceActor) {
  manage(actor);
  const v = parse(warehouseUpdate, input);
  const existing = await prisma.warehouse.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "المخزن مش موجود");
  checkVersion("المخزن", existing.version, v.expected_version);
  const { data, changes } = diff(existing, {
    name: v.name,
    nameAr: v.name_ar,
    address: v.address,
    areaM2: v.area_m2,
    dailyCapacityKg: v.daily_capacity_kg,
    active: v.active,
  });
  const row = await casUpdate(
    "المخزن",
    existing.version,
    changes,
    auditRows(actor, "warehouse", id, "warehouse_updated", changes),
    (tx) => tx.warehouse.update({ where: { id, version: existing.version }, data: { ...data, version: { increment: 1 } } }),
    async (tx) => {
      if (v.active === true && !existing.active) {
        await lockNode(tx, existing.branchId);
        const branch = await tx.branch.findUnique({ where: { id: existing.branchId } });
        if (!branch?.active) throw new ApiError(409, "الفرع موقوف — فعّله الأول");
      }
      await lockNode(tx, id);
      if (v.active === false && existing.active) {
        const children = await tx.storageLocation.count({ where: { warehouseId: id, active: true } });
        if (children > 0) throw new ApiError(409, `أوقف أماكن التخزين النشطة الأول (${children})`);
      }
    }
  );
  return row ?? existing;
}

// ---------------------------------------------------------------------------
// Storage location
// ---------------------------------------------------------------------------

function assertTempBand(min: Prisma.Decimal | null | undefined, max: Prisma.Decimal | null | undefined) {
  if (min != null && max != null && min.greaterThan(max)) {
    throw new ApiError(400, "أقل درجة حرارة لازم تكون أصغر من أو تساوي أعلى درجة");
  }
}

/** The proposed parent must be an active location in the same warehouse, and must not
 * sit underneath the location being moved (that would close a loop). */
async function assertValidParent(db: Pick<Tx, "storageLocation">, warehouseId: string, parentId: string, selfId?: string) {
  const parent = await db.storageLocation.findUnique({ where: { id: parentId } });
  if (!parent) throw new ApiError(404, "المكان الأب مش موجود");
  if (parent.warehouseId !== warehouseId) throw new ApiError(400, "المكان الأب لازم يكون في نفس المخزن");
  if (!parent.active) throw new ApiError(400, "المكان الأب موقوف");
  if (!selfId) return;
  let cursor: string | null = parent.id;
  for (let depth = 0; cursor && depth < 50; depth++) {
    if (cursor === selfId) throw new ApiError(400, "مينفعش المكان يبقى جوه نفسه");
    const next: { parentId: string | null } | null = await db.storageLocation.findUnique({ where: { id: cursor }, select: { parentId: true } });
    cursor = next?.parentId ?? null;
  }
}

export async function createLocation(input: unknown, actor: ServiceActor) {
  manage(actor);
  const v = parse(locationCreate, input);
  assertTempBand(v.temp_min_c, v.temp_max_c);
  return inTx(async (tx) => {
    await lockNode(tx, v.warehouse_id);
    const warehouse = await tx.warehouse.findUnique({ where: { id: v.warehouse_id } });
    if (!warehouse) throw new ApiError(404, "المخزن مش موجود");
    if (!warehouse.active) throw new ApiError(400, "المخزن موقوف — فعّله الأول");
    if (v.parent_id) {
      await lockNode(tx, v.parent_id);
      await assertValidParent(tx, warehouse.id, v.parent_id);
    }
    const row = await tx.storageLocation
      .create({
        data: {
          warehouseId: warehouse.id,
          parentId: v.parent_id ?? null,
          code: v.code,
          name: v.name,
          nameAr: v.name_ar ?? null,
          type: v.type,
          capacityKg: v.capacity_kg ?? null,
          tempMinC: v.temp_min_c ?? null,
          tempMaxC: v.temp_max_c ?? null,
        },
      })
      .catch((e) => uniqueConflict(e, `فيه مكان بالكود ${v.code} في المخزن ده`));
    await writeAuditMany([createdAudit(actor, "storage_location", row.id, `${warehouse.code}/${row.code} · ${row.name}`)], tx);
    return row;
  });
}

export async function updateLocation(id: string, input: unknown, actor: ServiceActor) {
  manage(actor);
  const v = parse(locationUpdate, input);
  const existing = await prisma.storageLocation.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "المكان مش موجود");
  checkVersion("المكان", existing.version, v.expected_version);
  assertTempBand(
    v.temp_min_c === undefined ? existing.tempMinC : v.temp_min_c,
    v.temp_max_c === undefined ? existing.tempMaxC : v.temp_max_c
  );
  const { data, changes } = diff(existing, {
    parentId: v.parent_id,
    name: v.name,
    nameAr: v.name_ar,
    type: v.type,
    capacityKg: v.capacity_kg,
    tempMinC: v.temp_min_c,
    tempMaxC: v.temp_max_c,
    active: v.active,
  });
  const row = await casUpdate(
    "المكان",
    existing.version,
    changes,
    auditRows(actor, "storage_location", id, "storage_location_updated", changes),
    (tx) => tx.storageLocation.update({ where: { id, version: existing.version }, data: { ...data, version: { increment: 1 } } }),
    async (tx) => {
      const parentId = v.parent_id === undefined ? existing.parentId : v.parent_id;
      if (v.active === true && !existing.active) {
        await lockNode(tx, existing.warehouseId);
        const warehouse = await tx.warehouse.findUnique({ where: { id: existing.warehouseId } });
        if (!warehouse?.active) throw new ApiError(409, "المخزن موقوف — فعّله الأول");
      }
      if (parentId && (v.parent_id !== undefined || v.active === true)) {
        await lockNode(tx, parentId);
        await assertValidParent(tx, existing.warehouseId, parentId, id);
      }
      await lockNode(tx, id);
      if (v.active === false && existing.active) {
        const children = await tx.storageLocation.count({ where: { parentId: id, active: true } });
        if (children > 0) throw new ApiError(409, `أوقف الأماكن اللي جواه الأول (${children})`);
      }
    }
  );
  return row ?? existing;
}

// ---------------------------------------------------------------------------
// Units of measure
// ---------------------------------------------------------------------------

export async function createUom(input: unknown, actor: ServiceActor) {
  manage(actor);
  const v = parse(uomCreate, input);
  const isPackage = v.category === "package";
  if (isPackage && v.ratio_to_reference != null) {
    throw new ApiError(400, "وحدات التعبئة (برنيكة، كرتونة…) ملهاش معامل تحويل ثابت — التحويل بيتحدد لكل صنف");
  }
  if (!isPackage && (v.ratio_to_reference == null || !v.ratio_to_reference.greaterThan(0))) {
    throw new ApiError(400, "معامل التحويل للوحدة المرجعية مطلوب ولازم يكون أكبر من صفر");
  }
  return inTx(async (tx) => {
    const row = await tx.unitOfMeasure
      .create({
        data: {
          code: v.code,
          name: v.name,
          nameAr: v.name_ar ?? null,
          category: v.category,
          ratioToReference: isPackage ? null : v.ratio_to_reference,
          isReference: false, // the reference unit of each category ships with the system
          precision: v.precision ?? (isPackage ? 0 : 3),
        },
      })
      .catch((e) => uniqueConflict(e, `فيه وحدة بالكود ${v.code}`));
    await writeAuditMany(
      [createdAudit(actor, "unit_of_measure", row.id, `${row.code} · ${row.category}${row.ratioToReference ? ` · ×${row.ratioToReference}` : ""}`)],
      tx
    );
    return row;
  });
}

export async function updateUom(id: string, input: unknown, actor: ServiceActor) {
  manage(actor);
  if (input && typeof input === "object" && ("category" in input || "ratio_to_reference" in input || "code" in input)) {
    throw new ApiError(400, "الكود والنوع ومعامل التحويل مينفعش يتغيروا بعد إنشاء الوحدة — اعمل وحدة جديدة");
  }
  const v = parse(uomUpdate, input);
  const existing = await prisma.unitOfMeasure.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "الوحدة مش موجودة");
  checkVersion("الوحدة", existing.version, v.expected_version);
  if (v.active === false && existing.isReference) {
    throw new ApiError(409, `${existing.code} هي الوحدة المرجعية للنوع ده — مينفعش تتوقف`);
  }
  const { data, changes } = diff(existing, { name: v.name, nameAr: v.name_ar, precision: v.precision, active: v.active });
  const row = await casUpdate("الوحدة", existing.version, changes, auditRows(actor, "unit_of_measure", id, "unit_of_measure_updated", changes), (tx) =>
    tx.unitOfMeasure.update({ where: { id, version: existing.version }, data: { ...data, version: { increment: 1 } } })
  );
  return row ?? existing;
}
