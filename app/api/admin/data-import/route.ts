import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/rbac";
import { requireServiceActor } from "@/lib/core/actor";
import { readJsonLimited, readLimitedBody } from "@/lib/http";
import { parseCsv, type CsvRecord } from "@/lib/data-import/csv";
import { createCustomer, createCustomerGroup, createCustomerLegalEntity } from "@/lib/sales/customers";
import { createSupplierFull } from "@/lib/purchasing/suppliers";
import { createProduct, type ProductInput } from "@/lib/product-master-service";
import { createOpeningBalance } from "@/lib/accounting/integrity";
import { postOpeningStock } from "@/lib/inventory/documents";
import { requestFingerprint } from "@/lib/core/idempotency";
import { setPrices } from "@/lib/sales/pricing";
import { setSupplierPrices } from "@/lib/purchasing/suppliers";
import { updateInventorySettings, savePackaging } from "@/lib/inventory/products";
import { assertPermission } from "@/lib/authz-core";
import type { Permission } from "@/lib/permissions";
import { isValidISODate } from "@/lib/dates";
import { validateImportRow } from "@/lib/data-import/validation";
import { normalizeProductName } from "@/lib/productIdentity";
import { xlsxToCsv } from "@/lib/data-import/xlsx";

const templates = {
  customers: { headers: "name,name_ar,legal_name,legal_name_ar,type,tax_registration_no,commercial_reg_no,phone,email,city,area,address,delivery_notes,external_ref,notes,payment_terms_days,credit_limit,credit_hold,credit_hold_reason,credit_reason,price_list_code,price_list_reason,group_code,legal_entity_code", required: ["name"] },
  customer_groups: { headers: "code,name,name_ar", required: ["code", "name"] },
  customer_legal_entities: { headers: "code,name,name_ar,tax_registration_no,commercial_reg_no,phone,email,address,area,city,country,governate,region_city,street,building_number,postal_code,floor,room,landmark,additional_information,receiver_type,receiver_id,notes", required: ["code", "name"] },
  suppliers: { headers: "name,name_ar,phone,notes,type,tax_registration_no,commercial_reg_no,email,city,address,payment_terms_days,lead_time_days,currency_code", required: ["name"] },
  products: { headers: "name,name_ar,sku,category,unit,stock_tracked,sales_tax_code", required: ["name", "unit"] },
  product_settings: { headers: "sku,shelf_life_days,removal_strategy,min_stock_qty,reorder_point_qty,max_stock_qty,cold_chain,costing_method,standard_cost", required: ["sku"] },
  product_packaging: { headers: "sku,uom,qty_in_base_unit,barcode,active", required: ["sku", "uom", "qty_in_base_unit"] },
  opening_stock: { headers: "sku,quantity,unit,unit_cost,expiry_date,location_code", required: ["sku", "quantity", "unit", "unit_cost"] },
  opening_balances: { headers: "party_type,party_code,date,due_date,amount,reference", required: ["party_type", "party_code", "date", "amount"] },
  sales_prices: { headers: "price_list_code,sku,uom,unit_price,valid_from,valid_to", required: ["price_list_code", "sku", "unit_price", "valid_from"] },
  supplier_prices: { headers: "supplier_code,sku,uom,unit_price,valid_from,valid_to,lead_time_days,notes", required: ["supplier_code", "sku", "unit_price", "valid_from"] },
} as const;
export type ImportKind = keyof typeof templates;

/** Bilingual name columns: `name` is the English name (the schema's `name`) and may be
 * titled `name_en`; `name_ar` is the Arabic name. A product's identifying code is its
 * SKU, so `code` is accepted for it. Customer and supplier codes are system-assigned. */
const NAME_ALIASES = { name_en: "name" } as const;
const headerAliases: Record<ImportKind, Record<string, string>> = {
  customers: { ...NAME_ALIASES, legal_name_en: "legal_name" },
  customer_groups: NAME_ALIASES,
  customer_legal_entities: NAME_ALIASES,
  suppliers: NAME_ALIASES,
  products: { ...NAME_ALIASES, code: "sku" },
  product_settings: { code: "sku" },
  product_packaging: { code: "sku" },
  opening_stock: { code: "sku" },
  opening_balances: {},
  sales_prices: { code: "sku" },
  supplier_prices: { code: "sku" },
};
const permissionByKind: Record<ImportKind, Permission> = {
  customers: "sales.customers.manage", customer_groups: "sales.customers.manage", customer_legal_entities: "sales.customers.manage", suppliers: "purchasing.suppliers.manage", products: "stock.manage_products", product_settings: "stock.manage_products", product_packaging: "stock.manage_products",
  opening_stock: "accounting.manage", opening_balances: "accounting.manage", sales_prices: "sales.pricing.manage", supplier_prices: "purchasing.prices.manage",
};

function kindOf(raw: unknown): ImportKind {
  if (typeof raw === "string" && raw in templates) return raw as ImportKind;
  throw new ApiError(400, "نوع ملف الاستيراد غير معروف");
}

function inputFor(kind: ImportKind, row: CsvRecord) {
  const v = row.values;
  if (kind === "customers") return { name: v.name, name_ar: v.name_ar || null, legal_name: v.legal_name || null, legal_name_ar: v.legal_name_ar || null, type: v.type || undefined, tax_registration_no: v.tax_registration_no || null, commercial_reg_no: v.commercial_reg_no || null, phone: v.phone || null, email: v.email || null, city: v.city || null, area: v.area || null, address: v.address || null, delivery_notes: v.delivery_notes || null, external_ref: v.external_ref || null, notes: v.notes || null, payment_terms_days: v.payment_terms_days ? Number(v.payment_terms_days) : undefined, credit_limit: v.credit_limit || undefined, credit_hold: v.credit_hold ? ["true", "1", "نعم"].includes(v.credit_hold.toLowerCase()) : undefined, credit_hold_reason: v.credit_hold_reason || undefined, credit_reason: v.credit_reason || undefined, price_list_reason: v.price_list_reason || undefined };
  if (kind === "customer_groups") return { code: v.code, name: v.name, name_ar: v.name_ar || null };
  if (kind === "customer_legal_entities") return { code: v.code, name: v.name, name_ar: v.name_ar || null, tax_registration_no: v.tax_registration_no || null, commercial_reg_no: v.commercial_reg_no || null, phone: v.phone || null, email: v.email || null, address: v.address || null, area: v.area || null, city: v.city || null, country: v.country || null, governate: v.governate || null, region_city: v.region_city || null, street: v.street || null, building_number: v.building_number || null, postal_code: v.postal_code || null, floor: v.floor || null, room: v.room || null, landmark: v.landmark || null, additional_information: v.additional_information || null, receiver_type: v.receiver_type || null, receiver_id: v.receiver_id || null, notes: v.notes || null };
  if (kind === "suppliers") return { name: v.name, name_ar: v.name_ar || null, phone: v.phone || null, notes: v.notes || null, type: v.type || undefined, tax_registration_no: v.tax_registration_no || null, commercial_reg_no: v.commercial_reg_no || null, email: v.email || null, city: v.city || null, address: v.address || null, payment_terms_days: v.payment_terms_days ? Number(v.payment_terms_days) : undefined, lead_time_days: v.lead_time_days ? Number(v.lead_time_days) : null, currency_code: v.currency_code || "EGP" };
  if (kind === "products") return { name: v.name, name_ar: v.name_ar || null, sku: v.sku || null, category: v.category || null, unit: v.unit, stock_tracked: v.stock_tracked ? ["true", "1", "نعم"].includes(v.stock_tracked.toLowerCase()) : true, sales_tax_code: v.sales_tax_code || undefined };
  if (kind === "opening_stock") return { ...v };
  return { ...v };
}

async function previewRows(kind: ImportKind, rows: CsvRecord[], body: Record<string, unknown>) {
  if (kind === "opening_stock" && rows.length > 200) throw new ApiError(400, "رصيد الافتتاح يقبل 200 سطر كحد أقصى في المستند الواحد");
  if (kind === "opening_stock" && (typeof body.business_date !== "string" || !isValidISODate(body.business_date))) throw new ApiError(400, "حدد تاريخ الرصيد الافتتاحي بصيغة YYYY-MM-DD");
  const results = rows.map((row) => ({ rowNumber: row.rowNumber, errors: validateImportRow(kind, row, templates[kind].required), label: row.values.name || row.values.sku || row.values.party_code || "—", ...(row.values.name_ar ? { labelAr: row.values.name_ar } : {}), ...(row.values.code || row.values.sku ? { code: row.values.code || row.values.sku } : {}) }));
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const v = r.values;
    const unique = kind === "products" ? (v.sku || v.name).toLowerCase() : kind === "customers" || kind === "suppliers" ? v.name.toLowerCase() : kind === "customer_groups" || kind === "customer_legal_entities" ? v.code.toUpperCase() : kind === "opening_balances" ? [v.party_type, v.party_code, v.date, v.due_date, v.amount, v.reference].join("|") : kind === "product_settings" ? v.sku.toLowerCase() : kind === "product_packaging" ? [v.sku, v.uom].join("|").toLowerCase() : kind === "sales_prices" ? [v.price_list_code, v.sku, v.uom, v.valid_from].join("|").toLowerCase() : kind === "supplier_prices" ? [v.supplier_code, v.sku, v.uom, v.valid_from].join("|").toLowerCase() : "";
    if (unique && seen.has(unique)) results[i].errors.push(`مكرر داخل الملف (صف ${seen.get(unique)})`);
    else if (unique) seen.set(unique, r.rowNumber);
  });
  const aliasesInFile = new Map<string, number>();
  const identifiersInFile = new Map<string, number>();
  rows.forEach((r, i) => {
    const v = r.values;
    if (kind === "customers" || kind === "products") {
      for (const name of [v.name, v.name_ar].filter(Boolean)) {
        const normalized = normalizeProductName(name);
        if (!normalized) continue;
        const key = `${kind}|name|${normalized}`;
        const prior = aliasesInFile.get(key);
        if (prior !== undefined && prior !== r.rowNumber) results[i].errors.push(`اسم أساسي أو بديل مكرر داخل الملف (صف ${prior})`);
        else aliasesInFile.set(key, r.rowNumber);
      }
    }
    const identifier = kind === "customers" ? (v.external_ref ? `customer|external|${v.external_ref.toLowerCase()}` : "")
      : kind === "suppliers" && v.tax_registration_no ? `supplier|tax|${v.tax_registration_no.replace(/[\s-]/g, "")}` : "";
    if (identifier) {
      const prior = identifiersInFile.get(identifier);
      if (prior !== undefined) results[i].errors.push(`معرّف مكرر داخل الملف (صف ${prior})`);
      else identifiersInFile.set(identifier, r.rowNumber);
    }
  });
  if (kind === "product_packaging") {
    const barcodes = new Map<string, number>();
    rows.forEach((r, i) => {
      const code = r.values.barcode;
      if (!code) return;
      const prior = barcodes.get(code);
      if (prior !== undefined) results[i].errors.push(`barcode مكرر داخل الملف (صف ${prior})`);
      else barcodes.set(code, r.rowNumber);
    });
  }
  if (kind === "sales_prices" || kind === "supplier_prices") {
    const groupCounts = new Map<string, number>();
    rows.forEach((r, i) => {
      const v = r.values;
      const owner = kind === "sales_prices" ? v.price_list_code.toUpperCase() : v.supplier_code;
      const key = [owner, v.valid_from, v.valid_to].join("|");
      const count = (groupCounts.get(key) ?? 0) + 1;
      groupCounts.set(key, count);
      const limit = kind === "sales_prices" ? 1000 : 500;
      if (count > limit) results[i].errors.push(`الحد الأقصى ${limit} سعرًا لنفس الطرف والفترة`);
    });
  }

  if (kind === "opening_stock") {
    const skus = [...new Set(rows.map((r) => r.values.sku).filter(Boolean))];
    const products = await prisma.stockProduct.findMany({ where: { sku: { in: skus } }, select: { sku: true, active: true, stockTracked: true } });
    const bySku = new Map(products.map((p) => [p.sku, p]));
    rows.forEach((r, i) => {
      const p = bySku.get(r.values.sku);
      if (!p) results[i].errors.push("SKU غير موجود في دليل الأصناف"); else if (!p.active || !p.stockTracked) results[i].errors.push("الصنف موقوف أو غير متتبع للمخزون");
      if (r.values.expiry_date && typeof body.business_date === "string" && r.values.expiry_date < body.business_date) results[i].errors.push("الصنف منتهي قبل تاريخ الرصيد الافتتاحي");
    });
    const warehouse = await prisma.warehouse.findFirst({ where: { active: true }, orderBy: { code: "asc" }, include: { locations: { where: { active: true }, select: { code: true } } } });
    const locationCodes = new Set(warehouse?.locations.map((l) => l.code) ?? []);
    rows.forEach((r, i) => { if (r.values.location_code && !locationCodes.has(r.values.location_code)) results[i].errors.push("location_code غير موجود في المخزن النشط"); });
  }
  if (kind === "product_settings" || kind === "product_packaging") {
    const skus = [...new Set(rows.map((r) => r.values.sku).filter(Boolean))];
    const products = await prisma.stockProduct.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true, unit: true, active: true, stockTracked: true } });
    const bySku = new Map(products.map((p) => [p.sku, p]));
    rows.forEach((r, i) => {
      const product = bySku.get(r.values.sku);
      if (!product) results[i].errors.push("SKU غير موجود في دليل الأصناف");
      else if (!product.active) results[i].errors.push("الصنف موقوف");
      else if (!product.stockTracked) results[i].errors.push("الصنف غير متتبع للمخزون");
      else if (kind === "product_packaging" && product.unit === r.values.uom) results[i].errors.push("uom لا يمكن أن تكون هي الوحدة الأساسية للصنف");
    });
    if (kind === "product_packaging") {
      const codes = [...new Set(rows.map((r) => r.values.uom).filter(Boolean))];
      const uoms = await prisma.unitOfMeasure.findMany({ where: { code: { in: codes }, active: true }, select: { code: true } });
      const validUoms = new Set(uoms.map((u) => u.code));
      rows.forEach((r, i) => { if (r.values.uom && !validUoms.has(r.values.uom)) results[i].errors.push("uom غير موجودة أو موقوفة في وحدات القياس"); });
      const barcodes = [...new Set(rows.map((r) => r.values.barcode).filter(Boolean))];
      const existing = await prisma.productPackaging.findMany({ where: { barcode: { in: barcodes } }, select: { barcode: true, productId: true, uomCode: true } });
      const existingByBarcode = new Map(existing.map((p) => [p.barcode, p]));
      rows.forEach((r, i) => {
        const current = r.values.barcode ? existingByBarcode.get(r.values.barcode) : null;
        const product = bySku.get(r.values.sku);
        if (current && (current.productId !== product?.id || current.uomCode !== r.values.uom)) results[i].errors.push("barcode مستخدم لتعبئة أخرى");
      });
    }
  }
  if (kind === "opening_balances") {
    const customers = await prisma.customer.findMany({ where: { code: { in: rows.filter((r) => r.values.party_type === "customer").map((r) => r.values.party_code) } }, select: { code: true } });
    const suppliers = await prisma.supplier.findMany({ where: { code: { in: rows.filter((r) => r.values.party_type === "supplier").map((r) => r.values.party_code) } }, select: { code: true } });
    const valid = new Set([...customers.map((x) => x.code), ...suppliers.map((x) => x.code)]);
    rows.forEach((r, i) => { if (r.values.party_code && !valid.has(r.values.party_code)) results[i].errors.push("party_code غير موجود؛ استخدم كود العميل أو المورد من المتحدة"); });
  }
  if (kind === "customers") {
    const names = rows.flatMap((r) => [r.values.name, r.values.name_ar].filter(Boolean).map(normalizeProductName));
    const refs = rows.map((r) => r.values.external_ref).filter(Boolean);
    const groupCodes = [...new Set(rows.flatMap((r) => r.values.group_code?.split("|").map((x) => x.trim().toUpperCase()).filter(Boolean) ?? []))];
    const legalCodes = [...new Set(rows.map((r) => r.values.legal_entity_code?.trim().toUpperCase()).filter((x): x is string => !!x))];
    const [aliases, existingByRef, groups, legalEntities] = await Promise.all([
      prisma.customerAlias.findMany({ where: { normalized: { in: names } }, select: { normalized: true, customerId: true, customer: { select: { code: true, externalRef: true } } } }),
      refs.length ? prisma.customer.findMany({ where: { externalRef: { in: refs } }, select: { id: true, code: true, externalRef: true, name: true } }) : [],
      groupCodes.length ? prisma.customerGroup.findMany({ where: { code: { in: groupCodes }, active: true }, select: { code: true } }) : [],
      legalCodes.length ? prisma.customerLegalEntity.findMany({ where: { code: { in: legalCodes }, active: true }, select: { code: true } }) : [],
    ]);
    // Build a map of normalized name → first owning customer (id/code/externalRef).
    const nameOwner = new Map<string, { id: string; code: string; externalRef: string | null }>();
    for (const a of aliases) {
      if (!nameOwner.has(a.normalized)) nameOwner.set(a.normalized, { id: a.customerId, code: a.customer.code, externalRef: a.customer.externalRef });
    }
    const knownGroups = new Set(groups.map((g) => g.code));
    const knownLegal = new Set(legalEntities.map((l) => l.code));
    // Map of external_ref → existing customer for reconciliation.
    const refToCustomer = new Map(existingByRef.map((c) => [c.externalRef, c]));
    rows.forEach((r, i) => {
      // --- Name reconciliation ------------------------------------------------------
      const rowNorm = [r.values.name, r.values.name_ar].filter(Boolean).map(normalizeProductName);
      const existing = rowNorm.find((n) => nameOwner.has(n));
      if (existing) {
        const owner = nameOwner.get(existing)!;
        const rowRef = r.values.external_ref?.trim() ?? null;
        if (rowRef && owner.externalRef === rowRef) {
          // Same external_ref + same name → it is the existing record being
          // re-imported. Not an error — commit will skip this row.
        } else {
          const hint = owner.code ? ` (${owner.code})` : "";
          results[i].errors.push(`اسم العميل موجود في دليل العملاء${hint} — أضف external_ref مطابق أو اربط يدوياً`);
        }
      }
      // --- external_ref already used by a DIFFERENT customer ------------------------
      if (r.values.external_ref) {
        const ref = r.values.external_ref.trim();
        const refCustomer = refToCustomer.get(ref);
        if (refCustomer) {
          const refNorm = normalizeProductName(refCustomer.name);
          if (!existing || nameOwner.get(existing)?.id !== refCustomer.id) {
            results[i].errors.push(`external_ref "${ref}" مستخدم لعميل آخر (${refCustomer.code})`);
          }
        }
      }
      // --- Group / legal entity existence (unchanged) --------------------------------
      for (const code of (r.values.group_code ?? "").split("|").map((x) => x.trim().toUpperCase()).filter(Boolean)) {
        if (!knownGroups.has(code)) results[i].errors.push(`group_code "${code}" غير موجود — استورد المجموعات الأول`);
      }
      if (r.values.legal_entity_code) {
        const code = r.values.legal_entity_code.trim().toUpperCase();
        if (!knownLegal.has(code)) results[i].errors.push(`legal_entity_code "${code}" غير موجود — استورد الكيانات القانونية الأول`);
      }
    });
    const listCodes = [...new Set(rows.map((r) => r.values.price_list_code).filter(Boolean).map((x) => x.toUpperCase()))];
    if (listCodes.length) {
      const lists = await prisma.priceList.findMany({ where: { code: { in: listCodes } }, select: { code: true, active: true, currencyCode: true } });
      const byCode = new Map(lists.map((l) => [l.code, l]));
      rows.forEach((r, i) => {
        if (!r.values.price_list_code) return;
        const list = byCode.get(r.values.price_list_code.toUpperCase());
        if (!list) results[i].errors.push("price_list_code غير معروف");
        else if (!list.active || list.currencyCode !== "EGP") results[i].errors.push("قائمة الأسعار موقوفة أو ليست بالجنيه المصري");
      });
    }
  }
  if (kind === "customer_groups") {
    const codes = rows.map((r) => r.values.code).filter(Boolean).map((x) => x.toUpperCase());
    const existing = await prisma.customerGroup.findMany({ where: { code: { in: codes } }, select: { code: true } });
    const used = new Set(existing.map((g) => g.code));
    rows.forEach((r, i) => {
      if (r.values.code && used.has(r.values.code.toUpperCase())) results[i].errors.push(`كود المجموعة "${r.values.code}" مستخدم قبل كده`);
    });
  }
  if (kind === "customer_legal_entities") {
    const codes = rows.map((r) => r.values.code).filter(Boolean).map((x) => x.toUpperCase());
    const taxes = rows.map((r) => r.values.tax_registration_no?.replace(/[\s-]/g, "")).filter(Boolean);
    const [existing, customerTaxes] = await Promise.all([
      prisma.customerLegalEntity.findMany({ where: { OR: [{ code: { in: codes } }, ...(taxes.length ? [{ taxRegistrationNo: { in: taxes } }] : [])] }, select: { code: true, taxRegistrationNo: true } }),
      prisma.customer.findMany({ where: { taxRegistrationNo: { in: taxes } }, select: { taxRegistrationNo: true } }),
    ]);
    const usedCodes = new Set(existing.map((l) => l.code));
    const usedTaxes = new Set(existing.map((l) => l.taxRegistrationNo).filter(Boolean));
    const customerOwned = new Set(customerTaxes.map((c) => c.taxRegistrationNo).filter((x): x is string => !!x));
    rows.forEach((r, i) => {
      if (r.values.code && usedCodes.has(r.values.code.toUpperCase())) results[i].errors.push(`كود الكيان القانوني "${r.values.code}" مستخدم قبل كده`);
      // One tax number = one legal entity. A number already on another entity or on
      // a standalone hotel card may not be re-assigned here.
      const t = r.values.tax_registration_no?.replace(/[\s-]/g, "");
      if (t && usedTaxes.has(t)) results[i].errors.push("الرقم الضريبي مسجل لكيان قانوني آخر");
      if (t && customerOwned.has(t)) results[i].errors.push("الرقم الضريبي مستخدم على كارت عميل مستقل — اربط العميل بالكيان بدل ما تكرر الرقم");
    });
  }
  if (kind === "products") {
    const names = rows.flatMap((r) => [r.values.name, r.values.name_ar].filter(Boolean).map(normalizeProductName));
    const skus = rows.map((r) => r.values.sku).filter(Boolean);
    const [aliases, existing] = await Promise.all([
      prisma.productAlias.findMany({ where: { normalized: { in: names } }, select: { normalized: true } }),
      prisma.stockProduct.findMany({ where: { sku: { in: skus } }, select: { sku: true } }),
    ]);
    const usedNames = new Set(aliases.map((a) => a.normalized));
    const usedSkus = new Set(existing.map((x) => x.sku).filter(Boolean));
    rows.forEach((r, i) => {
      if ([r.values.name, r.values.name_ar].filter(Boolean).some((n) => usedNames.has(normalizeProductName(n)))) results[i].errors.push("اسم الصنف موجود في دليل الأصناف");
      if (r.values.sku && usedSkus.has(r.values.sku)) results[i].errors.push("SKU مستخدم لصنف آخر");
    });
    const taxCodes = [...new Set(rows.map((r) => r.values.sales_tax_code).filter(Boolean))];
    if (taxCodes.length) {
      const taxes = await prisma.taxRate.findMany({ where: { code: { in: taxCodes }, active: true }, select: { code: true } });
      const validTaxes = new Set(taxes.map((t) => t.code));
      rows.forEach((r, i) => { if (r.values.sales_tax_code && !validTaxes.has(r.values.sales_tax_code)) results[i].errors.push("sales_tax_code غير معروف أو موقوف"); });
    }
  }
  if (kind === "suppliers") {
    const names = rows.map((r) => r.values.name).filter(Boolean);
    const taxes = rows.map((r) => r.values.tax_registration_no?.replace(/[\s-]/g, "")).filter(Boolean);
    const existing = await prisma.supplier.findMany({ where: { OR: [{ name: { in: names } }, { taxRegistrationNo: { in: taxes } }] }, select: { name: true, taxRegistrationNo: true } });
    const usedNames = new Set(existing.map((x) => x.name.toLowerCase()));
    const usedTaxes = new Set(existing.map((x) => x.taxRegistrationNo).filter(Boolean));
    rows.forEach((r, i) => {
      if (usedNames.has(r.values.name.toLowerCase())) results[i].errors.push("اسم المورد موجود");
      if (r.values.tax_registration_no && usedTaxes.has(r.values.tax_registration_no.replace(/[\s-]/g, ""))) results[i].errors.push("الرقم الضريبي مسجل لمورد آخر");
    });
  }
  if (kind === "sales_prices" || kind === "supplier_prices") {
    const skus = [...new Set(rows.map((r) => r.values.sku).filter(Boolean))];
    const products = await prisma.stockProduct.findMany({ where: { sku: { in: skus } }, select: { sku: true, active: true } });
    const bySku = new Map(products.map((p) => [p.sku, p]));
    rows.forEach((r, i) => {
      const product = bySku.get(r.values.sku);
      if (!product) results[i].errors.push("SKU غير موجود في دليل الأصناف");
      else if (!product.active) results[i].errors.push("الصنف موقوف");
    });
    if (kind === "sales_prices") {
      const codes = [...new Set(rows.map((r) => r.values.price_list_code).filter(Boolean).map((x) => x.toUpperCase()))];
      const lists = await prisma.priceList.findMany({ where: { code: { in: codes } }, select: { code: true, active: true } });
      const byCode = new Map(lists.map((p) => [p.code, p]));
      rows.forEach((r, i) => { const list = byCode.get(r.values.price_list_code.toUpperCase()); if (!list) results[i].errors.push("قائمة الأسعار غير موجودة بكودها"); else if (!list.active) results[i].errors.push("قائمة الأسعار موقوفة"); });
    } else {
      const codes = [...new Set(rows.map((r) => r.values.supplier_code).filter(Boolean))];
      const suppliers = await prisma.supplier.findMany({ where: { code: { in: codes } }, select: { code: true, active: true } });
      const byCode = new Map(suppliers.map((p) => [p.code, p]));
      rows.forEach((r, i) => { const supplier = byCode.get(r.values.supplier_code); if (!supplier) results[i].errors.push("كود المورد غير موجود"); else if (!supplier.active) results[i].errors.push("المورد موقوف"); });
    }
  }
  return results;
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireServiceActor(req, "users.view");
    const kind = kindOf(new URL(req.url).searchParams.get("template"));
    assertPermission(actor, permissionByKind[kind]);
    return new NextResponse(`${templates[kind].headers}\r\n`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="united-${kind}.csv"` } });
  } catch (err) { return handleApiError(err, req); }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireServiceActor(req, "users.view");
    let body: Record<string, unknown>;
    let kind: ImportKind;
    if (req.headers.get("content-type")?.toLowerCase().includes("multipart/form-data")) {
      const contentLength = Number(req.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 2_100_000) throw new ApiError(413, "حجم ملف الاستيراد أكبر من 2 ميجابايت");
      const bytes = await readLimitedBody(req, 2_100_000, "حجم ملف الاستيراد أكبر من 2 ميجابايت");
      const formBody = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(formBody).set(bytes);
      let form: FormData;
      try { form = await new Request("http://localhost", { method: "POST", headers: { "content-type": req.headers.get("content-type") ?? "" }, body: formBody }).formData(); }
      catch { throw new ApiError(400, "نموذج رفع الملف غير صالح"); }
      kind = kindOf(form.get("kind"));
      assertPermission(actor, permissionByKind[kind]);
      const file = form.get("file");
      if (!file || typeof file === "string") throw new ApiError(400, "اختار ملف CSV أو XLSX");
      if (file.size > 2_000_000) throw new ApiError(413, "حجم ملف الاستيراد أكبر من 2 ميجابايت");
      const filename = file.name.toLowerCase();
      let csv: string;
      if (filename.endsWith(".xlsx")) csv = xlsxToCsv(new Uint8Array(await file.arrayBuffer()));
      else if (filename.endsWith(".csv")) {
        try { csv = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
        catch { throw new ApiError(400, "ملف CSV لازم يكون محفوظًا بصيغة UTF-8"); }
      }
      else throw new ApiError(400, "صيغة الملف لازم تكون CSV أو Excel XLSX");
      body = { action: form.get("action"), kind, csv, business_date: form.get("business_date") };
    } else {
      body = await readJsonLimited(req, 2_100_000);
      kind = kindOf(body.kind);
      assertPermission(actor, permissionByKind[kind]);
    }
    if (body.action !== "preview" && body.action !== "commit") throw new ApiError(400, "نوع العملية لازم معاينة أو حفظ");
    if (typeof body.csv !== "string") throw new ApiError(400, "محتوى ملف CSV مطلوب");
    const rows = parseCsv(body.csv, templates[kind].required, headerAliases[kind]);
    if (kind === "products" && rows.some((r) => r.values.sales_tax_code)) assertPermission(actor, "sales.tax.manage");
    if (kind === "customers" && rows.some((r) => [r.values.payment_terms_days, r.values.credit_limit, r.values.credit_hold, r.values.credit_hold_reason].some(Boolean))) assertPermission(actor, "sales.credit.manage");
    if (kind === "customers" && rows.some((r) => r.values.price_list_code)) assertPermission(actor, "sales.pricing.manage");
    if (kind === "product_settings" && rows.some((r) => r.values.standard_cost || r.values.costing_method)) assertPermission(actor, "accounting.manage");
    const validation = await previewRows(kind, rows, body);
    const errors = validation.filter((r) => r.errors.length);
    if (body.action !== "commit") return NextResponse.json({ rows: validation, rowCount: rows.length, errorCount: errors.length });
    if (errors.length) throw new ApiError(400, `فيه ${errors.length} صف محتاج تصحيح — مفيش بيانات اتسجلت`);

    if (kind === "opening_stock") {
      const warehouse = await prisma.warehouse.findFirst({ where: { active: true }, include: { locations: { where: { active: true } } }, orderBy: { code: "asc" } });
      if (!warehouse) throw new ApiError(400, "مفيش مخزن نشط");
      const products = await prisma.stockProduct.findMany({ where: { sku: { in: rows.map((r) => r.values.sku) } }, select: { id: true, sku: true } });
      const productBySku = new Map(products.map((p) => [p.sku, p.id]));
      const locations = new Map(warehouse.locations.map((l) => [l.code, l.id]));
      const lines = rows.map((r) => {
        const v = r.values;
        const locationId = v.location_code ? locations.get(v.location_code) : undefined;
        if (v.location_code && !locationId) throw new ApiError(400, `موقع ${v.location_code} مش موجود في المخزن ${warehouse.code}`);
        return { product_id: productBySku.get(v.sku), quantity: v.quantity, uom: v.unit, unit_cost: v.unit_cost, expiry_date: v.expiry_date || null, location_id: locationId };
      });
      const fingerprint = requestFingerprint({ business_date: body.business_date, lines: lines.slice().sort((a, b) => `${a.product_id}|${a.quantity}|${a.uom}|${a.unit_cost}|${a.expiry_date}|${a.location_id}`.localeCompare(`${b.product_id}|${b.quantity}|${b.uom}|${b.unit_cost}|${b.expiry_date}|${b.location_id}`)) });
      const document = await postOpeningStock({ business_date: body.business_date, warehouse_id: warehouse.id, lines, idempotency_key: `csv-opening-${fingerprint.slice(0, 40)}` }, actor);
      return NextResponse.json({ created: 1, failed: 0, results: [{ rowNumber: null, status: "تم تسجيل مستند الرصيد الافتتاحي", document: document.number }] });
    }

    if (kind === "product_settings" || kind === "product_packaging") {
      const products = await prisma.stockProduct.findMany({ where: { sku: { in: rows.map((r) => r.values.sku) } }, select: { id: true, sku: true } });
      const productBySku = new Map(products.map((p) => [p.sku, p.id]));
      const results: { rowNumber: number; status: string; error?: string }[] = [];
      for (const row of rows) {
        try {
          const productId = productBySku.get(row.values.sku);
          if (!productId) throw new ApiError(404, "الصنف غير موجود بكود SKU");
          const v = row.values;
          if (kind === "product_settings") {
            const input: Record<string, unknown> = {
              ...(v.shelf_life_days ? { shelf_life_days: Number(v.shelf_life_days) } : {}),
              ...(v.removal_strategy ? { removal_strategy: v.removal_strategy } : {}),
              ...(v.min_stock_qty ? { min_stock_qty: v.min_stock_qty } : {}),
              ...(v.reorder_point_qty ? { reorder_point_qty: v.reorder_point_qty } : {}),
              ...(v.max_stock_qty ? { max_stock_qty: v.max_stock_qty } : {}),
              ...(v.cold_chain ? { cold_chain: ["true", "1", "نعم"].includes(v.cold_chain.toLowerCase()) } : {}),
              ...(v.costing_method ? { costing_method: v.costing_method } : {}),
              ...(v.standard_cost ? { standard_cost: v.standard_cost } : {}),
            };
            await updateInventorySettings(productId, input, actor);
          } else {
            await savePackaging(productId, { uom: v.uom, qty_in_base_unit: v.qty_in_base_unit, barcode: v.barcode || null, active: v.active ? ["true", "1", "نعم"].includes(v.active.toLowerCase()) : true }, actor);
          }
          results.push({ rowNumber: row.rowNumber, status: "تم" });
        } catch (err) {
          results.push({ rowNumber: row.rowNumber, status: "فشل", error: err instanceof Error ? err.message : "تعذر الحفظ" });
        }
      }
      return NextResponse.json({ created: results.filter((r) => r.status === "تم").length, failed: results.filter((r) => r.status === "فشل").length, results });
    }

    if (kind === "sales_prices" || kind === "supplier_prices") {
      const skus = [...new Set(rows.map((r) => r.values.sku))];
      const products = await prisma.stockProduct.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true } });
      const productBySku = new Map(products.map((p) => [p.sku, p.id]));
      const groups = new Map<string, CsvRecord[]>();
      for (const row of rows) {
        const v = row.values;
        const owner = kind === "sales_prices" ? v.price_list_code.toUpperCase() : v.supplier_code;
        const key = [owner, v.valid_from, v.valid_to].join("|");
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      const results: { rowNumber: number; status: string; error?: string }[] = [];
      for (const group of groups.values()) {
        try {
          const first = group[0].values;
          const prices = group.map((r) => ({ product_id: productBySku.get(r.values.sku), uom: r.values.uom || undefined, unit_price: r.values.unit_price, ...(kind === "supplier_prices" ? { lead_time_days: r.values.lead_time_days ? Number(r.values.lead_time_days) : undefined, notes: r.values.notes || undefined } : {}) }));
          if (kind === "sales_prices") {
            const list = await prisma.priceList.findUnique({ where: { code: first.price_list_code.toUpperCase() }, select: { id: true } });
            if (!list) throw new ApiError(404, "قائمة الأسعار غير موجودة");
            await setPrices(list.id, { valid_from: first.valid_from, valid_to: first.valid_to || null, prices }, actor);
          } else {
            const supplier = await prisma.supplier.findUnique({ where: { code: first.supplier_code }, select: { id: true } });
            if (!supplier) throw new ApiError(404, "المورد غير موجود");
            await setSupplierPrices(supplier.id, { valid_from: first.valid_from, valid_to: first.valid_to || null, prices }, actor);
          }
          group.forEach((r) => results.push({ rowNumber: r.rowNumber, status: "تم" }));
        } catch (err) {
          group.forEach((r) => results.push({ rowNumber: r.rowNumber, status: "فشل", error: err instanceof Error ? err.message : "تعذر الحفظ" }));
        }
      }
      results.sort((a, b) => a.rowNumber - b.rowNumber);
      return NextResponse.json({ created: results.filter((r) => r.status === "تم").length, failed: results.filter((r) => r.status === "فشل").length, results });
    }

    const results: { rowNumber: number; status: string; code?: string; error?: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        let code: string | undefined;
        if (kind === "customers") {
          const input = inputFor(kind, row) as Record<string, unknown>;
          if (row.values.price_list_code) {
            const list = await prisma.priceList.findUnique({ where: { code: row.values.price_list_code.toUpperCase() }, select: { id: true } });
            if (!list) throw new ApiError(404, "قائمة الأسعار غير موجودة");
            input.price_list_id = list.id;
          }
          // Reconciliation: if external_ref already exists on a customer with the
          // same normalized name, skip creation — it is the same record.
          if (row.values.external_ref) {
            const existing = await prisma.customer.findUnique({ where: { externalRef: row.values.external_ref.trim() }, select: { id: true, code: true } });
            if (existing) {
              // Same rule as the preview: the row is the existing card when EITHER of
              // its names is one of the card's names/aliases (the preview checks the
              // alias table, so a match on name_ar alone must not 409 here). Nothing on
              // the card is changed — a re-import never overwrites or blanks a name.
              const rowNames = [row.values.name, row.values.name_ar].filter(Boolean).map(normalizeProductName);
              const sameCard = await prisma.customerAlias.count({ where: { customerId: existing.id, normalized: { in: rowNames } } });
              if (sameCard > 0) {
                results.push({ rowNumber: row.rowNumber, status: "موجود — لم يتكرر", code: existing.code });
                continue;
              }
              throw new ApiError(409, `external_ref "${row.values.external_ref}" مستخدم لعميل آخر (${existing.code})`);
            }
          }
          // Resolve stable reference codes to row ids (groups, legal entity).
          if (row.values.legal_entity_code) {
            const le = await prisma.customerLegalEntity.findUnique({ where: { code: row.values.legal_entity_code.trim().toUpperCase() }, select: { id: true } });
            if (!le) throw new ApiError(404, "الكيان القانوني غير موجود بالكود");
            input.legal_entity_id = le.id;
          }
          const groupCodes = (row.values.group_code ?? "").split("|").map((x) => x.trim().toUpperCase()).filter(Boolean);
          if (groupCodes.length) {
            const groups = await prisma.customerGroup.findMany({ where: { code: { in: groupCodes }, active: true }, select: { id: true, code: true } });
            if (groups.length !== groupCodes.length) throw new ApiError(404, "مجموعة من المجموعات غير موجودة");
            input.group_ids = groups.map((g) => g.id);
          }
          code = (await createCustomer(input, actor)).code;
        }
        else if (kind === "customer_groups") await createCustomerGroup(inputFor(kind, row), actor);
        else if (kind === "customer_legal_entities") await createCustomerLegalEntity(inputFor(kind, row), actor);
        else if (kind === "suppliers") code = (await createSupplierFull(inputFor(kind, row), actor)).code;
        else if (kind === "products") await createProduct(inputFor(kind, row) as ProductInput, actor);
        else {
          const v = row.values;
          const party = v.party_type === "customer"
            ? await prisma.customer.findUnique({ where: { code: v.party_code }, select: { id: true } })
            : await prisma.supplier.findUnique({ where: { code: v.party_code }, select: { id: true } });
          if (!party) throw new ApiError(404, "الطرف مش موجود بكوده");
          const request: Record<string, unknown> = { party_type: v.party_type, party_id: party.id, date: v.date, due_date: v.due_date || v.date, amount: v.amount, reference: v.reference || null };
          request.idempotency_key = `csv-balance-${requestFingerprint(request).slice(0, 40)}`;
          await createOpeningBalance(request, actor);
        }
        results.push({ rowNumber: row.rowNumber, status: "تم", code });
      } catch (err) {
        results.push({ rowNumber: row.rowNumber, status: "فشل", error: err instanceof Error ? err.message : "تعذر الحفظ" });
      }
    }
    return NextResponse.json({ created: results.filter((r) => r.status === "تم").length, failed: results.filter((r) => r.status === "فشل").length, results });
  } catch (err) { return handleApiError(err, req); }
}
