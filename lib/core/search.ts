import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isValidISODate } from "@/lib/dates";
import { ApiError } from "@/lib/rbac";

/**
 * Server-side search for every module list (maturity 2026-11). One rule everywhere: a
 * record matches when the search text appears in ANY of its identifying texts — code,
 * number, Arabic name, English name, phone, tax number, the party or product it belongs
 * to — compared through united_norm() (database function: Arabic letter variants,
 * diacritics, case and digit scripts folded). The query returns ids only; the caller's
 * own Prisma query (with its own permission rules) loads the rows, so search can never
 * widen what a list shows.
 *
 * The SQL below is built from these constants only; the user's text is always a bound
 * parameter.
 */
const SOURCES = {
  customer: `SELECT c."id" FROM "Customer" c WHERE united_norm(concat_ws(' ', c."code", c."name", c."nameAr", c."legalName", c."legalNameAr", c."taxRegistrationNo", c."phone", c."email", c."externalRef")) LIKE $1`,
  supplier: `SELECT s."id" FROM "Supplier" s WHERE united_norm(concat_ws(' ', s."code", s."name", s."nameAr", s."phone", s."email", s."taxRegistrationNo")) LIKE $1`,
  product: `SELECT p."id" FROM "StockProduct" p WHERE united_norm(concat_ws(' ', p."sku", p."name", p."nameAr", p."category",
              (SELECT string_agg(a."alias", ' ') FROM "ProductAlias" a WHERE a."productId" = p."id"))) LIKE $1`,
  order: `SELECT o."id" FROM "Order" o LEFT JOIN "Customer" c ON c."id" = o."customerAccountId"
          WHERE united_norm(concat_ws(' ', o."orderNumber", o."externalId", o."customerName", c."code", c."name", c."nameAr", c."phone")) LIKE $1`,
  salesInvoice: `SELECT i."id" FROM "SalesInvoice" i JOIN "Customer" c ON c."id" = i."customerId"
          WHERE united_norm(concat_ws(' ', i."number", i."buyerName", i."buyerTaxId", c."code", c."name", c."nameAr", c."taxRegistrationNo")) LIKE $1`,
  supplierBill: `SELECT b."id" FROM "SupplierBill" b JOIN "Supplier" s ON s."id" = b."supplierId"
          WHERE united_norm(concat_ws(' ', b."number", b."supplierInvoiceNo", s."code", s."name", s."nameAr")) LIKE $1`,
  supplierPayment: `SELECT x."id" FROM "SupplierPayment" x JOIN "Supplier" s ON s."id" = x."supplierId"
          WHERE united_norm(concat_ws(' ', x."number", x."reference", s."code", s."name", s."nameAr")) LIKE $1`,
  customerReceipt: `SELECT x."id" FROM "CustomerReceipt" x JOIN "Customer" c ON c."id" = x."customerId"
          WHERE united_norm(concat_ws(' ', x."number", x."reference", c."code", c."name", c."nameAr")) LIKE $1`,
  purchaseRequest: `SELECT r."id" FROM "PurchaseRequest" r LEFT JOIN "StockProduct" p ON p."id" = r."productId" LEFT JOIN "Customer" c ON c."id" = r."customerId"
          WHERE united_norm(concat_ws(' ', r."number", r."customerReference", p."name", p."nameAr", p."sku", c."name", c."nameAr")) LIKE $1`,
  purchaseOrder: `SELECT o."id" FROM "PurchaseOrder" o JOIN "Supplier" s ON s."id" = o."supplierId"
          WHERE united_norm(concat_ws(' ', o."number", s."code", s."name", s."nameAr")) LIKE $1`,
  intake: `SELECT i."id" FROM "StockIntake" i LEFT JOIN "Supplier" s ON s."id" = i."supplierId" LEFT JOIN "StockProduct" p ON p."id" = i."productId" LEFT JOIN "StockLot" l ON l."id" = i."lotId"
          WHERE united_norm(concat_ws(' ', i."receiptNumber", s."code", s."name", s."nameAr", p."name", p."nameAr", p."sku", l."lotNumber")) LIKE $1`,
  journal: `SELECT e."id" FROM "JournalEntry" e WHERE united_norm(concat_ws(' ', e."number", e."description")) LIKE $1`,
  document: `SELECT d."id" FROM "InventoryDocument" d LEFT JOIN "Supplier" s ON s."id" = d."supplierId"
          WHERE united_norm(concat_ws(' ', d."number", d."reason", s."name", s."nameAr",
            (SELECT string_agg(concat_ws(' ', p."name", p."nameAr", p."sku", l."lotNumber"), ' ') FROM "StockMovement" m
               JOIN "StockProduct" p ON p."id" = m."productId" LEFT JOIN "StockLot" l ON l."id" = m."lotId" WHERE m."documentId" = d."id"))) LIKE $1`,
  trip: `SELECT t."id" FROM "Trip" t JOIN "Vehicle" v ON v."id" = t."vehicleId" JOIN "Driver" r ON r."id" = t."driverId"
          WHERE united_norm(concat_ws(' ', t."number", v."code", v."plate", r."name", r."phone",
            (SELECT string_agg(concat_ws(' ', o."orderNumber", o."customerName"), ' ') FROM "TripStop" s JOIN "Order" o ON o."id" = s."orderId" WHERE s."tripId" = t."id"))) LIKE $1`,
  lot: `SELECT l."id" FROM "StockLot" l JOIN "StockProduct" p ON p."id" = l."productId"
          WHERE united_norm(concat_ws(' ', l."lotNumber", p."name", p."nameAr", p."sku")) LIKE $1`,
} as const;
export type SearchEntity = keyof typeof SOURCES;

/** A search text, trimmed; at most 100 characters; "" when absent. */
export function searchText(raw: string | null | undefined): string {
  return (raw ?? "").trim().slice(0, 100);
}

/**
 * Ids of `entity` records whose identifying text contains `q` (normalised). At most
 * `cap` ids — a list shows a page of them; a search wide enough to exceed the cap is
 * narrowed by its other filters or a longer text.
 */
export async function searchIds(entity: SearchEntity, q: string, cap = 1000, db: Pick<Prisma.TransactionClient, "$queryRawUnsafe"> = prisma): Promise<string[]> {
  const text = searchText(q);
  if (!text) return [];
  // LIKE wildcards in the user's text are literal characters (united_norm leaves \ % _ as they are).
  const escaped = text.replace(/[\\%_]/g, (c) => `\\${c}`);
  const sql = SOURCES[entity].replace("LIKE $1", "LIKE '%' || united_norm($1) || '%' ESCAPE '\\'");
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM (${sql}) x LIMIT ${Math.max(1, Math.min(cap, 5000))}`, escaped);
  return rows.map((r) => r.id);
}

/** Prisma `where` fragment for a searched list: no text → nothing; text → those ids. */
export async function searchWhere(entity: SearchEntity, q: string | null | undefined): Promise<{ id?: { in: string[] } }> {
  const text = searchText(q);
  return text ? { id: { in: await searchIds(entity, text) } } : {};
}

/** Shared list parameters from a URL: paging, date range, sort — validated, never trusted. */
export function listParams(sp: URLSearchParams, opts: { sorts?: readonly string[]; defaultLimit?: number; maxLimit?: number } = {}) {
  const limit = Math.min(Math.max(Number(sp.get("limit")) || opts.defaultLimit || 50, 1), opts.maxLimit ?? 200);
  const offset = Math.max(Number(sp.get("offset")) || 0, 0);
  const from = sp.get("from") || undefined;
  const to = sp.get("to") || undefined;
  if ((from && !isValidISODate(from)) || (to && !isValidISODate(to))) throw new ApiError(400, "التاريخ لازم يكون YYYY-MM-DD");
  const sortRaw = sp.get("sort") ?? "";
  const sort = opts.sorts?.includes(sortRaw) ? sortRaw : undefined;
  const dir: "asc" | "desc" = sp.get("dir") === "asc" ? "asc" : "desc";
  return { q: searchText(sp.get("q")), limit, offset, from, to, sort, dir };
}

/** Just the search part of a list URL: { q, from, to } (validated). */
export function searchOf(sp: URLSearchParams) {
  const { q, from, to } = listParams(sp);
  return { q, from, to };
}
