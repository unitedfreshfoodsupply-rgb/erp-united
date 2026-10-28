import { Prisma, type SupplierBill } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { assertEgpCurrency } from "@/lib/core/currency";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { getSetting } from "@/lib/core/settings-service";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { cancelPendingApproval, findPending, requestApproval } from "@/lib/core/approvals";
import { optText, parse, text, version } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { lineAmounts, sumAmounts, type LineAmounts } from "@/lib/sales/money";
import { effectiveSupplierPrice } from "@/lib/purchasing/suppliers";
import { poLineUnitCost } from "@/lib/purchasing/receiving";
import { isoDate, money, qty } from "@/lib/purchasing/orders";
import { matchBill, type MatchLine } from "@/lib/purchasing/match";
import { postDebitNote, postSupplierBill } from "@/lib/accounting/ledger";
import { isServiceBillAccount } from "@/lib/purchasing/service-accounts";
import { postReturnToSupplierInTx } from "@/lib/inventory/documents";
import { idempotencyKeyField, lockKey, replayRequest, requestFingerprint } from "@/lib/core/idempotency";

/**
 * Supplier bills and debit notes — the payables side of purchasing.
 *
 *  1. A bill is booked from the supplier's invoice, one line per goods receipt not
 *     yet billed. Each line is matched three ways: the AGREED price (the PO line, net
 *     of discount, per base unit — else the cost recorded on the receipt, else the
 *     supplier's dated price), the GOOD quantity received, and what the supplier
 *     BILLED. Lines are judged one by one so an over-charge on one line cannot hide
 *     behind an under-charge on another.
 *  2. Posting a bill whose every line is within the tolerance is immediate. A line
 *     outside it — or with no agreed price to compare against — sends the bill to
 *     approval (purchasing.bills.approve), which posts it or returns it to draft.
 *  3. A posted bill never changes (database-enforced); a receipt on a live bill can no
 *     longer be corrected or voided. Corrections afterwards are debit notes, by
 *     quantity per line, never more than was billed.
 *
 * A supplier's payable = posted bills − debit notes (− payments, Phase 6).
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const r2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
type Actorish = { id: string | null; name: string; role: string; deviceId?: string };

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const auditBill = (tx: Tx, actor: Actorish, entityType: "supplier_bill" | "debit_note", id: string, number: string, action: string, detail: string | null, reason?: string | null) =>
  writeAudit(
    { userId: actor.id, userName: actor.name, role: actor.role, action, entityType, entityId: id, fieldChanged: number, newValue: detail, reason: reason ?? undefined, source: "user", deviceId: actor.deviceId },
    tx
  );
const amountsData = (a: LineAmounts) => ({ gross: a.gross, discount: a.discount, net: a.net, tax: a.tax, total: a.total });
const totalsData = (a: LineAmounts) => ({ gross: a.gross, discountTotal: a.discount, net: a.net, taxTotal: a.tax, total: a.total });

// ---------------------------------------------------------------------------
// What a receipt should cost
// ---------------------------------------------------------------------------

const RECEIPT_INCLUDE = {
  product: { select: { id: true, name: true, nameAr: true, unit: true, salesTaxCode: true, salesTax: { select: { rate: true } } } },
  purchaseOrderLine: { include: { po: { select: { id: true, number: true } } } },
} as const;
type ReceiptRow = Prisma.StockIntakeGetPayload<{ include: typeof RECEIPT_INCLUDE }>;

/** The agreed price per base unit for a receipt, and where it came from. */
async function agreedPrice(db: Tx | typeof prisma, r: ReceiptRow): Promise<{ price: Prisma.Decimal | null; source: "po" | "receipt" | "supplier_price" | null }> {
  if (r.purchaseOrderLine) return { price: poLineUnitCost(r.purchaseOrderLine), source: "po" };
  if (r.unitCost != null) return { price: D(r.unitCost), source: "receipt" };
  const sp = await effectiveSupplierPrice(db, { supplierId: r.supplierId, product: r.product, uom: r.product.unit, date: r.receivedDate });
  return sp ? { price: D(sp.unitPrice), source: "supplier_price" } : { price: null, source: null };
}

function defaultTax(r: ReceiptRow) {
  if (r.purchaseOrderLine) return { code: r.purchaseOrderLine.taxCode, rate: D(r.purchaseOrderLine.taxRate) };
  return { code: r.product.salesTaxCode, rate: D(r.product.salesTax.rate) };
}

/** Receipts of a supplier that are on no live bill, with what they should cost. */
export async function billableReceipts(supplierId: string) {
  const rows = await prisma.stockIntake.findMany({
    where: { supplierId, status: "posted", goodQty: { gt: 0 }, billLines: { none: { released: false } } },
    include: RECEIPT_INCLUDE,
    orderBy: [{ receivedDate: "asc" }, { createdAt: "asc" }],
    take: 500,
  });
  return Promise.all(
    rows.map(async (r) => {
      const agreed = await agreedPrice(prisma, r);
      const tax = defaultTax(r);
      return {
        intakeId: r.id,
        receiptNumber: r.receiptNumber,
        receivedDate: r.receivedDate,
        product: { id: r.product.id, name: r.product.nameAr ?? r.product.name, nameAr: r.product.nameAr, nameEn: r.product.name, unit: r.product.unit },
        poNumber: r.purchaseOrderLine?.po.number ?? null,
        goodQty: r.goodQty.toString(),
        expectedUnitPrice: agreed.price?.toString() ?? null,
        priceSource: agreed.source,
        expectedNet: agreed.price ? r2(r.goodQty.times(agreed.price)).toFixed(2) : null,
        taxCode: tax.code,
        taxRate: tax.rate.toString(),
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Draft bills
// ---------------------------------------------------------------------------

const billLine = z.object({
  intake_id: text("الاستلام"),
  /** Defaults to the receipt's good quantity. */
  quantity: qty("الكمية المفوترة").optional(),
  unit_price: money,
  tax_code: z.string().trim().min(1).optional(),
});
const billInput = z.object({
  supplier_id: text("المورد"),
  supplier_invoice_no: text("رقم فاتورة المورد", 60),
  bill_date: isoDate("تاريخ الفاتورة"),
  due_date: isoDate("تاريخ الاستحقاق").nullable().optional(),
  notes: optText("ملاحظات", 2000).optional(),
  lines: z.array(billLine).min(1, "لازم استلام واحد على الأقل").max(300),
  expected_version: version,
});

/** Locks the receipts (row locks — a correction or void of the same receipt waits), checks them, prices the lines. */
async function buildLines(tx: Tx, supplierId: string, v: z.infer<typeof billInput>, excludeBillId?: string) {
  const ids = v.lines.map((l) => l.intake_id);
  if (new Set(ids).size !== ids.length) throw new ApiError(400, "نفس الاستلام متكرر في الفاتورة");
  await tx.$queryRaw`SELECT "id" FROM "StockIntake" WHERE "id" = ANY(${ids}::text[]) FOR UPDATE`;
  const receipts = await tx.stockIntake.findMany({ where: { id: { in: ids } }, include: RECEIPT_INCLUDE });
  const byId = new Map(receipts.map((r) => [r.id, r]));
  const taxCodes = [...new Set(v.lines.map((l) => l.tax_code).filter((c): c is string => !!c))];
  const taxes = new Map((await tx.taxRate.findMany({ where: { code: { in: taxCodes }, active: true } })).map((t) => [t.code, D(t.rate)]));
  const out: Prisma.SupplierBillLineCreateManyBillInput[] = [];
  const amounts: LineAmounts[] = [];
  const match: MatchLine[] = [];
  for (const [i, l] of v.lines.entries()) {
    const r = byId.get(l.intake_id);
    if (!r) throw new ApiError(404, "استلام مش موجود");
    if (r.supplierId !== supplierId) throw new ApiError(400, `الاستلام ${r.receiptNumber} مش من المورد ده`);
    if (r.status !== "posted") throw new ApiError(409, `الاستلام ${r.receiptNumber} ملغي`);
    if (!r.goodQty.gt(0)) throw new ApiError(400, `الاستلام ${r.receiptNumber} مفيهوش كمية سليمة`);
    const live = await tx.supplierBillLine.findFirst({ where: { intakeId: r.id, released: false, ...(excludeBillId ? { billId: { not: excludeBillId } } : {}) }, include: { bill: { select: { number: true } } } });
    if (live) throw new ApiError(409, `الاستلام ${r.receiptNumber} عليه فاتورة ${live.bill.number} بالفعل`);
    let tax = defaultTax(r);
    if (l.tax_code) {
      const rate = taxes.get(l.tax_code);
      if (!rate) throw new ApiError(400, `كود ضريبة غير معروف: ${l.tax_code}`);
      tax = { code: l.tax_code, rate };
    }
    const quantity = l.quantity ?? D(r.goodQty);
    const agreed = await agreedPrice(tx, r);
    const a = lineAmounts({ quantity, unitPrice: l.unit_price, discountPct: 0, taxRate: tax.rate });
    const expectedNet = agreed.price ? r2(D(r.goodQty).times(agreed.price)) : null;
    amounts.push(a);
    match.push({ net: a.net, expectedNet });
    out.push({
      lineNo: i + 1,
      intakeId: r.id,
      poLineId: r.purchaseOrderLineId,
      productId: r.productId,
      description: `${r.product.nameAr ?? r.product.name} · ${r.receiptNumber}${r.purchaseOrderLine ? ` · ${r.purchaseOrderLine.po.number}` : ""}`,
      uomCode: r.product.unit,
      receivedQty: r.goodQty,
      quantity,
      unitPrice: l.unit_price,
      expectedUnitPrice: agreed.price,
      expectedNet,
      discountPct: 0,
      taxCode: tax.code,
      taxRate: tax.rate,
      ...amountsData(a),
    });
  }
  return { lines: out, totals: sumAmounts(amounts), match };
}

async function headerFields(tx: Tx, v: { supplier_id: string; bill_date: string; due_date?: string | null }) {
  const supplier = await tx.supplier.findUnique({ where: { id: v.supplier_id } });
  if (!supplier) throw new ApiError(404, "المورد مش موجود");
  const dueDate = v.due_date ?? addDays(v.bill_date, supplier.paymentTermsDays);
  if (dueDate < v.bill_date) throw new ApiError(400, "تاريخ الاستحقاق قبل تاريخ الفاتورة");
  return { supplier, dueDate };
}

async function assertInvoiceNoFree(tx: Tx, supplierId: string, invoiceNo: string, exceptBillId?: string) {
  const dup = await tx.$queryRaw<{ number: string }[]>`
    SELECT "number" FROM "SupplierBill"
    WHERE "supplierId" = ${supplierId} AND lower(btrim("supplierInvoiceNo")) = lower(btrim(${invoiceNo})) AND "status" <> 'cancelled'
      AND "id" <> ${exceptBillId ?? ""}`;
  if (dup.length) throw new ApiError(409, `فاتورة المورد رقم ${invoiceNo} متسجلة بالفعل (${dup[0].number})`);
}

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
/** The partial unique indexes back the checks above; a race that slips between them lands here. */
async function guardRace<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err) || (err instanceof Prisma.PrismaClientUnknownRequestError && /SupplierBill(Line_one_live_bill_per_receipt|_supplier_invoice_once)/.test(err.message))) {
      throw new ApiError(409, "الاستلام أو رقم فاتورة المورد اتسجل في فاتورة تانية في نفس اللحظة");
    }
    throw err;
  }
}

export async function createBill(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.bills.manage");
  if (isServiceInput(input)) return createServiceBill(input, actor);
  const v = parse(billInput, input);
  return guardRace(() =>
    inTx(async (tx) => {
      // One supplier's bills are booked one at a time: the duplicate-invoice and
      // receipt-already-billed checks and the insert are one step.
      await advisoryXactLock(tx, `purchasing:bills:${v.supplier_id}`);
      const { supplier, dueDate } = await headerFields(tx, v);
      assertEgpCurrency(supplier.currencyCode, "فاتورة المورد");
      await assertInvoiceNoFree(tx, supplier.id, v.supplier_invoice_no);
      const tolerance = await getSetting("purchasing.bill_match_tolerance_pct");
      const { lines, totals, match } = await buildLines(tx, supplier.id, v);
      const m = matchBill(match, tolerance);
      const bill = await tx.supplierBill.create({
        data: {
          number: await nextDocumentNumber(tx, "purchasing.bill", todayLocalISO()),
          supplierId: supplier.id,
          supplierInvoiceNo: v.supplier_invoice_no,
          billDate: v.bill_date,
          dueDate,
          notes: v.notes ?? null,
          ...totalsData(totals),
          expectedNet: m.expectedNet,
          variance: m.variance,
          matchStatus: m.status,
          createdById: actor.id,
          createdBy: actor.name,
          lines: { createMany: { data: lines } },
        },
      });
      await auditBill(tx, actor, "supplier_bill", bill.id, bill.number, "supplier_bill_created", `${supplier.code} · ${v.supplier_invoice_no} · ${lines.length} سطر · ${bill.total.toFixed(2)} · ${m.status}`);
      return bill;
    })
  );
}

export async function updateBill(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.bills.manage");
  if (isServiceInput(input)) return updateServiceBill(id, input, actor);
  const v = parse(billInput, input);
  return guardRace(() =>
    inTx(async (tx) => {
      await advisoryXactLock(tx, `purchasing:bills:${v.supplier_id}`);
      const bill = await tx.supplierBill.findUnique({ where: { id } });
      if (!bill) throw new ApiError(404, "الفاتورة مش موجودة");
      if (bill.status !== "draft") throw new ApiError(409, bill.status === "pending_approval" ? "الفاتورة مستنية اعتماد — مينفعش تتعدل" : "بس المسودة تتعدل");
      if (v.expected_version !== undefined && v.expected_version !== bill.version) throw new ApiError(409, "الفاتورة اتعدلت من حد تاني — حدّث الصفحة");
      if (v.supplier_id !== bill.supplierId) throw new ApiError(400, "مينفعش تغير مورد الفاتورة — الغيها واعمل واحدة جديدة");
      if (bill.kind !== "goods") throw new ApiError(400, "دي فاتورة خدمة — بتتعدل بسطور حسابات مش استلامات");
      const { supplier, dueDate } = await headerFields(tx, v);
      await assertInvoiceNoFree(tx, supplier.id, v.supplier_invoice_no, bill.id);
      const tolerance = await getSetting("purchasing.bill_match_tolerance_pct");
      const { lines, totals, match } = await buildLines(tx, supplier.id, v, bill.id);
      const m = matchBill(match, tolerance);
      await tx.supplierBillLine.deleteMany({ where: { billId: id } });
      await tx.supplierBillLine.createMany({ data: lines.map((l) => ({ ...l, billId: id })) });
      const updated = await transition(tx, bill, {
        supplierInvoiceNo: v.supplier_invoice_no,
        billDate: v.bill_date,
        dueDate,
        notes: v.notes ?? null,
        ...totalsData(totals),
        expectedNet: m.expectedNet,
        variance: m.variance,
        matchStatus: m.status,
      });
      await auditBill(tx, actor, "supplier_bill", id, bill.number, "supplier_bill_edited", `${lines.length} سطر · ${updated.total.toFixed(2)} · ${m.status}`);
      return updated;
    })
  );
}

// ---------------------------------------------------------------------------
// Service bills — rent, utilities, transport, services, equipment: no goods receipt,
// so no three-way match. Each line names the expense (or asset) account it is charged
// to and its tax; the bill posts Dr those accounts / Dr input VAT / Cr the supplier,
// and is paid, aged and stated exactly like a goods bill. Above the configured total
// it waits for approval (decided by someone other than who booked it).
// ---------------------------------------------------------------------------

const amount2 = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const s = typeof v === "number" ? String(v) : v.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "المبلغ لازم يكون أكبر من صفر بحد أقصى خانتين عشريتين" });
    return z.NEVER;
  }
  return D(s);
});
const serviceInput = z.object({
  kind: z.literal("service"),
  supplier_id: text("المورد"),
  supplier_invoice_no: text("رقم فاتورة المورد", 60),
  bill_date: isoDate("تاريخ الفاتورة"),
  due_date: isoDate("تاريخ الاستحقاق").nullable().optional(),
  notes: optText("ملاحظات", 2000).optional(),
  lines: z
    .array(z.object({ account_id: text("الحساب"), description: text("البيان", 200), amount: amount2, tax_code: text("كود الضريبة", 40) }))
    .min(1, "لازم سطر واحد على الأقل")
    .max(100),
  expected_version: version,
});
const isServiceInput = (input: unknown) => !!input && typeof input === "object" && (input as { kind?: unknown }).kind === "service";

/** The account a service line may be charged to — the shared rule in lib/purchasing/service-accounts.ts. */
async function serviceAccount(tx: Tx, accountId: string) {
  const a = await tx.account.findUnique({ where: { id: accountId } });
  if (!a) throw new ApiError(404, "حساب مش موجود");
  if (!a.active || !a.postable) throw new ApiError(400, `الحساب ${a.code} حساب رئيسي أو موقوف — مينفعش الترحيل عليه`);
  if (a.type !== "expense" && a.type !== "asset") throw new ApiError(400, `الحساب ${a.code} مش حساب مصروفات أو أصول`);
  // Control, input-VAT, stock-cost and cash/bank accounts (lib/purchasing/service-accounts.ts).
  if (!isServiceBillAccount(a, !!(await tx.cashAccount.findFirst({ where: { accountId: a.id } })))) throw new ApiError(400, `الحساب ${a.code} (${a.nameAr}) مينفعش يتحمل على فاتورة خدمة`);
  return a;
}

async function buildServiceLines(tx: Tx, v: z.infer<typeof serviceInput>) {
  const taxes = new Map((await tx.taxRate.findMany({ where: { code: { in: [...new Set(v.lines.map((l) => l.tax_code))] }, active: true } })).map((t) => [t.code, D(t.rate)]));
  const amounts: LineAmounts[] = [];
  const lines: Prisma.SupplierBillServiceLineCreateManyBillInput[] = [];
  for (const [i, l] of v.lines.entries()) {
    const account = await serviceAccount(tx, l.account_id);
    const rate = taxes.get(l.tax_code);
    if (!rate) throw new ApiError(400, `كود ضريبة غير معروف: ${l.tax_code}`);
    const a = lineAmounts({ quantity: 1, unitPrice: l.amount, discountPct: 0, taxRate: rate });
    amounts.push(a);
    lines.push({ lineNo: i + 1, accountId: account.id, description: l.description, taxCode: l.tax_code, taxRate: rate, net: a.net, tax: a.tax, total: a.total });
  }
  return { lines, totals: sumAmounts(amounts) };
}

async function createServiceBill(input: unknown, actor: ServiceActor) {
  const v = parse(serviceInput, input);
  return guardRace(() =>
    inTx(async (tx) => {
      await advisoryXactLock(tx, `purchasing:bills:${v.supplier_id}`);
      const { supplier, dueDate } = await headerFields(tx, v);
      assertEgpCurrency(supplier.currencyCode, "فاتورة المورد");
      await assertInvoiceNoFree(tx, supplier.id, v.supplier_invoice_no);
      const { lines, totals } = await buildServiceLines(tx, v);
      const bill = await tx.supplierBill.create({
        data: {
          number: await nextDocumentNumber(tx, "purchasing.bill", todayLocalISO()),
          kind: "service",
          supplierId: supplier.id,
          supplierInvoiceNo: v.supplier_invoice_no,
          billDate: v.bill_date,
          dueDate,
          notes: v.notes ?? null,
          ...totalsData(totals),
          expectedNet: totals.net,
          variance: 0,
          matchStatus: "matched",
          createdById: actor.id,
          createdBy: actor.name,
          serviceLines: { createMany: { data: lines } },
        },
      });
      await auditBill(tx, actor, "supplier_bill", bill.id, bill.number, "supplier_bill_created", `${supplier.code} · ${v.supplier_invoice_no} · خدمة · ${lines.length} سطر · ${bill.total.toFixed(2)}`);
      return bill;
    })
  );
}

async function updateServiceBill(id: string, input: unknown, actor: ServiceActor) {
  const v = parse(serviceInput, input);
  return guardRace(() =>
    inTx(async (tx) => {
      await advisoryXactLock(tx, `purchasing:bills:${v.supplier_id}`);
      const bill = await tx.supplierBill.findUnique({ where: { id } });
      if (!bill) throw new ApiError(404, "الفاتورة مش موجودة");
      if (bill.kind !== "service") throw new ApiError(400, "دي فاتورة بضاعة — بتتعدل باستلامات");
      if (bill.status !== "draft") throw new ApiError(409, bill.status === "pending_approval" ? "الفاتورة مستنية اعتماد — مينفعش تتعدل" : "بس المسودة تتعدل");
      if (v.expected_version !== undefined && v.expected_version !== bill.version) throw new ApiError(409, "الفاتورة اتعدلت من حد تاني — حدّث الصفحة");
      if (v.supplier_id !== bill.supplierId) throw new ApiError(400, "مينفعش تغير مورد الفاتورة — الغيها واعمل واحدة جديدة");
      const { supplier, dueDate } = await headerFields(tx, v);
      await assertInvoiceNoFree(tx, supplier.id, v.supplier_invoice_no, bill.id);
      const { lines, totals } = await buildServiceLines(tx, v);
      await tx.supplierBillServiceLine.deleteMany({ where: { billId: id } });
      await tx.supplierBillServiceLine.createMany({ data: lines.map((l) => ({ ...l, billId: id })) });
      const updated = await transition(tx, bill, { supplierInvoiceNo: v.supplier_invoice_no, billDate: v.bill_date, dueDate, notes: v.notes ?? null, ...totalsData(totals), expectedNet: totals.net, variance: 0 });
      await auditBill(tx, actor, "supplier_bill", id, bill.number, "supplier_bill_edited", `خدمة · ${lines.length} سطر · ${updated.total.toFixed(2)}`);
      return updated;
    })
  );
}

const serviceDebitInput = z.object({
  reason: text("سبب الإشعار", 500),
  lines: z.array(z.object({ service_line_id: text("سطر الفاتورة"), amount: amount2 })).min(1, "حدد السطور اللي هتتخصم").max(100),
  idempotency_key: idempotencyKeyField,
});

/** An allowance on a posted service bill: per line, never more than what is left of it, at the line's tax rate. */
async function createServiceDebitNote(billId: string, input: unknown, actor: ServiceActor) {
  const v = parse(serviceDebitInput, input);
  const requestHash = requestFingerprint({ billId, request: v });
  return inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.debitNote.findUnique({ where: { idempotencyKey: v.idempotency_key }, include: { serviceLines: true } });
      if (prev) {
        const key = (xs: [string, Prisma.Decimal][]) => xs.map(([k, a]) => `${k}:${a.toFixed(2)}`).sort().join("|");
        return replayRequest(prev, requestHash, prev.billId === billId && prev.reason === v.reason && key(prev.serviceLines.map((l) => [l.serviceLineId, D(l.net)])) === key(v.lines.map((l) => [l.service_line_id, l.amount])));
      }
    }
    await advisoryXactLock(tx, `purchasing:debit-note:${billId}`);
    const bill = await tx.supplierBill.findUnique({ where: { id: billId }, include: { serviceLines: { orderBy: { lineNo: "asc" } } } });
    if (!bill) throw new ApiError(404, "الفاتورة مش موجودة");
    if (bill.status !== "posted") throw new ApiError(409, "الإشعار المدين بيتعمل على فاتورة مترحّلة بس");
    const prior = await tx.debitNoteServiceLine.groupBy({ by: ["serviceLineId"], where: { serviceLineId: { in: bill.serviceLines.map((l) => l.id) } }, _sum: { net: true, tax: true, total: true } });
    const already = new Map(prior.map((p) => [p.serviceLineId, p._sum]));
    const perLine = new Map<string, Prisma.Decimal>();
    for (const l of v.lines) perLine.set(l.service_line_id, (perLine.get(l.service_line_id) ?? D(0)).plus(l.amount));
    const rows: { serviceLineId: string; a: LineAmounts }[] = [];
    for (const [lineId, net] of perLine) {
      const line = bill.serviceLines.find((l) => l.id === lineId);
      if (!line) throw new ApiError(400, "السطر مش تابع للفاتورة");
      const done = already.get(lineId);
      const left = D(line.net).minus(done?.net ?? 0);
      if (net.greaterThan(left)) throw new ApiError(400, `"${line.description}": المتبقي من السطر ${left.toFixed(2)} بس`);
      // The rest of a line comes off exactly — its remaining tax, not a re-rounding.
      const a = net.equals(left)
        ? { gross: left, discount: D(0), net: left, tax: D(line.tax).minus(done?.tax ?? 0), total: D(line.total).minus(done?.total ?? 0) }
        : lineAmounts({ quantity: 1, unitPrice: net, discountPct: 0, taxRate: line.taxRate });
      rows.push({ serviceLineId: lineId, a });
    }
    const totals = sumAmounts(rows.map((r) => r.a));
    const today = todayLocalISO();
    const dn = await tx.debitNote.create({
      data: {
        number: await nextDocumentNumber(tx, "purchasing.debit_note", today),
        billId,
        supplierId: bill.supplierId,
        issueDate: today,
        reason: v.reason,
        idempotencyKey: v.idempotency_key ?? null,
        requestHash,
        currencyCode: bill.currencyCode,
        ...totalsData(totals),
        createdById: actor.id,
        createdBy: actor.name,
        serviceLines: { createMany: { data: rows.map((r) => ({ serviceLineId: r.serviceLineId, net: r.a.net, tax: r.a.tax, total: r.a.total })) } },
      },
    });
    await auditBill(tx, actor, "debit_note", dn.id, dn.number, "debit_note_issued", `على ${bill.number} · خدمة · ${dn.total.toFixed(2)}`, v.reason);
    await postDebitNote(tx, dn.id, actor);
    return dn;
  });
}

async function transition(tx: Tx, bill: SupplierBill, data: Prisma.SupplierBillUpdateInput) {
  try {
    return await tx.supplierBill.update({ where: { id: bill.id, version: bill.version }, data: { ...data, version: { increment: 1 } } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") throw new ApiError(409, "الفاتورة اتعدلت من حد تاني — حدّث الصفحة");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Posting, approval, cancelling
// ---------------------------------------------------------------------------

/** Posts a matched bill; one with a variance (or nothing agreed to match) waits for approval. */
export async function postBill(id: string, actor: ServiceActor) {
  assertPermission(actor, "purchasing.bills.manage");
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `purchasing:bill:${id}`);
    const bill = await tx.supplierBill.findUnique({ where: { id }, include: { lines: true, supplier: true } });
    if (!bill) throw new ApiError(404, "الفاتورة مش موجودة");
    if (bill.status !== "draft") throw new ApiError(409, bill.status === "pending_approval" ? "الفاتورة مستنية اعتماد بالفعل" : "بس المسودة تترحّل");
    if (bill.kind === "service") {
      const threshold = D(await getSetting("purchasing.service_bill_approval_threshold"));
      if (bill.total.greaterThan(threshold)) {
        const updated = await transition(tx, bill, { status: "pending_approval" });
        await requestApproval(tx, {
          type: "purchasing.bill",
          entityId: bill.id,
          title: `فاتورة خدمة ${bill.number} — ${bill.supplier.name} (${bill.supplierInvoiceNo})`,
          summary: `فاتورة خدمة إجماليها ${bill.total.toFixed(2)} — أكبر من حد الاعتماد ${threshold.toFixed(2)}`,
          amount: bill.total,
          requester: actor,
        });
        await auditBill(tx, actor, "supplier_bill", bill.id, bill.number, "supplier_bill_submitted", `خدمة · ${bill.total.toFixed(2)}`);
        return updated;
      }
      const posted = await transition(tx, bill, { status: "posted", postedAt: new Date(), postedById: actor.id, postedBy: actor.name });
      await auditBill(tx, actor, "supplier_bill", bill.id, bill.number, "supplier_bill_posted", `خدمة · ${bill.total.toFixed(2)}`);
      await postSupplierBill(tx, bill.id, actor);
      return posted;
    }
    // Judged with the tolerance in force now, on the stored lines.
    const m = matchBill(bill.lines.map((l) => ({ net: l.net, expectedNet: l.expectedNet })), await getSetting("purchasing.bill_match_tolerance_pct"));
    if (m.needsApproval) {
      const updated = await transition(tx, bill, { status: "pending_approval", matchStatus: m.status, expectedNet: m.expectedNet, variance: m.variance });
      await requestApproval(tx, {
        type: "purchasing.bill",
        entityId: bill.id,
        title: `فاتورة ${bill.number} — ${bill.supplier.name} (${bill.supplierInvoiceNo})`,
        summary:
          m.status === "unpriced"
            ? "فيها استلام مالوش سعر متفق عليه نطابق عليه"
            : `الفاتورة ${bill.net.toFixed(2)} قبل الضريبة، والمتفق عليه ${m.expectedNet.toFixed(2)} — فرق ${m.variance.toFixed(2)}`,
        amount: m.variance,
        requester: actor,
      });
      await auditBill(tx, actor, "supplier_bill", bill.id, bill.number, "supplier_bill_submitted", `${m.status} · فرق ${m.variance.toFixed(2)}`);
      return updated;
    }
    const posted = await transition(tx, bill, { status: "posted", matchStatus: m.status, expectedNet: m.expectedNet, variance: m.variance, postedAt: new Date(), postedById: actor.id, postedBy: actor.name });
    await auditBill(tx, actor, "supplier_bill", bill.id, bill.number, "supplier_bill_posted", `${bill.total.toFixed(2)} · ${m.status}`);
    await postSupplierBill(tx, bill.id, actor);
    return posted;
  });
}

export async function applyBillDecision(tx: Tx, id: string, approved: boolean, decider: Actorish, comment?: string) {
  const bill = await tx.supplierBill.findUnique({ where: { id } });
  if (!bill) throw new ApiError(404, "الفاتورة مش موجودة");
  if (bill.status !== "pending_approval") throw new ApiError(409, "الفاتورة مش مستنية اعتماد");
  if (approved) {
    const now = new Date();
    await transition(tx, bill, { status: "posted", approvedAt: now, approvedById: decider.id, approvedBy: decider.name, postedAt: now, postedById: decider.id, postedBy: decider.name });
    await auditBill(tx, decider, "supplier_bill", id, bill.number, "supplier_bill_approved", `فرق ${bill.variance.toFixed(2)} اتقبل · ${bill.total.toFixed(2)}`, comment);
    await postSupplierBill(tx, id, decider);
  } else {
    await transition(tx, bill, { status: "draft" });
    await auditBill(tx, decider, "supplier_bill", id, bill.number, "supplier_bill_rejected", null, comment);
  }
}

/** A draft (or one waiting for approval) is cancelled; its receipts may be billed again. */
export async function cancelBill(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.bills.manage");
  const v = parse(z.object({ reason: text("سبب الإلغاء", 500) }), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `purchasing:bill:${id}`);
    const bill = await tx.supplierBill.findUnique({ where: { id } });
    if (!bill) throw new ApiError(404, "الفاتورة مش موجودة");
    if (!["draft", "pending_approval"].includes(bill.status)) throw new ApiError(409, bill.status === "posted" ? "الفاتورة مترحّلة — التصحيح بإشعار مدين" : "الفاتورة ملغية بالفعل");
    if (bill.status === "pending_approval") await cancelPendingApproval(tx, { type: "purchasing.bill", entityId: id, reason: v.reason, actor });
    // Lines first, while the bill is still open (its lines freeze with it).
    await tx.supplierBillLine.updateMany({ where: { billId: id }, data: { released: true } });
    const updated = await transition(tx, bill, { status: "cancelled", cancelReason: v.reason });
    await auditBill(tx, actor, "supplier_bill", id, bill.number, "supplier_bill_cancelled", null, v.reason);
    return updated;
  });
}

/**
 * For the receiving side: a receipt on a live bill (any status but cancelled) can no
 * longer change — the bill was matched against it. Call after locking the receipt row.
 */
export async function assertReceiptNotBilled(tx: Tx, intakeId: string) {
  const line = await tx.supplierBillLine.findFirst({ where: { intakeId, released: false }, include: { bill: { select: { number: true, status: true } } } });
  if (line) throw new ApiError(409, `الاستلام ده عليه فاتورة مورد ${line.bill.number} — ${line.bill.status === "posted" ? "التصحيح بإشعار مدين" : "الغي الفاتورة الأول"}`);
}

// ---------------------------------------------------------------------------
// Debit notes
// ---------------------------------------------------------------------------

const debitInput = z.object({
  reason: text("سبب الإشعار", 500),
  return_document_id: z.string().optional(),
  /** The debited goods go back to the supplier now: take them out of stock in the same step. */
  return_goods: z.boolean().optional(),
  full: z.boolean().optional(),
  lines: z.array(z.object({ bill_line_id: text("سطر الفاتورة"), quantity: qty("الكمية") })).max(300).optional(),
  idempotency_key: idempotencyKeyField,
});

/** The same debit note again: same bill, and (unless "the whole bill") the same lines and quantities. */
function sameDebit(prev: { billId: string; reason: string; returnDocumentId: string | null; lines: { billLineId: string; quantity: Prisma.Decimal }[] }, billId: string, v: { reason: string; full?: boolean; return_goods?: boolean; return_document_id?: string; lines?: { bill_line_id: string; quantity: Prisma.Decimal }[] }) {
  if (prev.billId !== billId || prev.reason !== v.reason) return false;
  if (v.return_document_id && prev.returnDocumentId !== v.return_document_id) return false;
  if (v.return_goods && !prev.returnDocumentId) return false;
  if (!v.return_goods && !v.return_document_id && prev.returnDocumentId) return false;
  if (v.full) return true;
  const sum = (xs: [string, Prisma.Decimal][]) => [...xs.reduce((m, [k, q]) => m.set(k, (m.get(k) ?? D(0)).plus(q)), new Map<string, Prisma.Decimal>())].map(([k, q]) => `${k}:${q.toFixed(3)}`).sort().join("|");
  return sum(prev.lines.map((l) => [l.billLineId, D(l.quantity)])) === sum((v.lines ?? []).map((l) => [l.bill_line_id, D(l.quantity)]));
}

export async function createDebitNote(billId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "purchasing.bills.manage");
  if ((await prisma.supplierBill.findUnique({ where: { id: billId }, select: { kind: true } }))?.kind === "service") return createServiceDebitNote(billId, input, actor);
  const v = parse(debitInput, input);
  const requestHash = requestFingerprint({ billId, request: v });
  if (!v.full && !v.lines?.length) throw new ApiError(400, "حدد السطور اللي هتتخصم أو اختار الفاتورة كلها");
  return inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.debitNote.findUnique({ where: { idempotencyKey: v.idempotency_key }, include: { lines: true } });
      if (prev) return replayRequest(prev, requestHash, sameDebit(prev, billId, v));
    }
    // Serialises debit notes of one bill: "never more than billed" and the insert are one step.
    await advisoryXactLock(tx, `purchasing:debit-note:${billId}`);
    const bill = await tx.supplierBill.findUnique({ where: { id: billId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    if (!bill) throw new ApiError(404, "الفاتورة مش موجودة");
    if (bill.status !== "posted") throw new ApiError(409, "الإشعار المدين بيتعمل على فاتورة مترحّلة بس");
    if (v.return_document_id) {
      const doc = await tx.inventoryDocument.findUnique({ where: { id: v.return_document_id } });
      if (!doc || doc.type !== "supplier_return") throw new ApiError(400, "مستند المرتجع مش موجود");
      if (doc.supplierId !== bill.supplierId) throw new ApiError(400, "المرتجع ده لمورد تاني");
    }
    const debited = await tx.debitNoteLine.groupBy({ by: ["billLineId"], where: { billLineId: { in: bill.lines.map((l) => l.id) } }, _sum: { quantity: true } });
    const already = new Map(debited.map((c) => [c.billLineId, D(c._sum.quantity ?? 0)]));
    const wanted = v.full
      ? bill.lines.map((l) => ({ line: l, qty: D(l.quantity).minus(already.get(l.id) ?? 0) })).filter((x) => x.qty.gt(0))
      : v.lines!.map((x) => {
          const line = bill.lines.find((l) => l.id === x.bill_line_id);
          if (!line) throw new ApiError(400, "السطر مش تابع للفاتورة");
          return { line, qty: x.quantity };
        });
    if (wanted.length === 0) throw new ApiError(409, "الفاتورة متخصومة بالكامل بالفعل");
    const perLine = new Map<string, Prisma.Decimal>();
    for (const w of wanted) perLine.set(w.line.id, (perLine.get(w.line.id) ?? D(0)).plus(w.qty));
    const amounts: { lineId: string; qty: Prisma.Decimal; a: LineAmounts }[] = [];
    for (const [lineId, q] of perLine) {
      const line = bill.lines.find((l) => l.id === lineId)!;
      const left = D(line.quantity).minus(already.get(lineId) ?? 0);
      if (q.greaterThan(left)) throw new ApiError(400, `"${line.description}": المتبقي من الفاتورة ${left.toFixed()} ${line.uomCode} بس`);
      let a: LineAmounts;
      if (q.equals(left)) {
        // The rest of a line, exact to the piastre: what remains, not a re-rounding.
        const prior = await tx.debitNoteLine.aggregate({ where: { billLineId: lineId }, _sum: { gross: true, discount: true, net: true, tax: true, total: true } });
        a = {
          gross: D(line.gross).minus(prior._sum.gross ?? 0),
          discount: D(line.discount).minus(prior._sum.discount ?? 0),
          net: D(line.net).minus(prior._sum.net ?? 0),
          tax: D(line.tax).minus(prior._sum.tax ?? 0),
          total: D(line.total).minus(prior._sum.total ?? 0),
        };
      } else {
        a = lineAmounts({ quantity: q, unitPrice: line.unitPrice, discountPct: line.discountPct, taxRate: line.taxRate });
      }
      amounts.push({ lineId, qty: q, a });
    }
    const totals = sumAmounts(amounts.map((x) => x.a));
    if (!totals.total.gt(0)) throw new ApiError(400, "قيمة الإشعار صفر");
    const today = todayLocalISO();
    if (v.return_goods && v.return_document_id) throw new ApiError(400, "يا إما مرتجع موجود يا إما رجّع البضاعة دلوقتي — مش الاتنين");
    let returnDocumentId = v.return_document_id ?? null;
    if (v.return_goods) {
      const intakes = await tx.stockIntake.findMany({ where: { id: { in: bill.lines.map((l) => l.intakeId) } }, select: { id: true, lotId: true } });
      const lotOf = new Map(intakes.map((x) => [x.id, x.lotId]));
      const doc = await postReturnToSupplierInTx(tx, { supplierId: bill.supplierId, reason: `مرتجع على ${bill.number}: ${v.reason}`, date: today, lines: amounts.map((x) => { const line = bill.lines.find((l) => l.id === x.lineId)!; return { productId: line.productId, lotId: lotOf.get(line.intakeId) ?? null, quantity: x.qty }; }) }, actor);
      returnDocumentId = doc.id;
    }
    const dn = await tx.debitNote.create({
      data: {
        number: await nextDocumentNumber(tx, "purchasing.debit_note", today),
        billId,
        supplierId: bill.supplierId,
        issueDate: today,
        reason: v.reason,
        returnDocumentId,
        idempotencyKey: v.idempotency_key ?? null,
        requestHash,
        currencyCode: bill.currencyCode,
        ...totalsData(totals),
        createdById: actor.id,
        createdBy: actor.name,
        lines: { createMany: { data: amounts.map((x) => ({ billLineId: x.lineId, quantity: x.qty, ...amountsData(x.a) })) } },
      },
    });
    await auditBill(tx, actor, "debit_note", dn.id, dn.number, "debit_note_issued", `على ${bill.number} · ${dn.total.toFixed(2)}`, v.reason);
    await postDebitNote(tx, dn.id, actor);
    return dn;
  });
}

// ---------------------------------------------------------------------------
// Reads: bills, payables, statement, aging
// ---------------------------------------------------------------------------

/** What has been taken off each posted bill: debit notes + payments allocated to it. */
async function debitedByBill(db: Pick<Tx, "debitNote" | "paymentAllocation">, billIds: string[]) {
  const [dn, paid] = billIds.length
    ? await Promise.all([
        db.debitNote.groupBy({ by: ["billId"], where: { billId: { in: billIds } }, _sum: { total: true } }),
        db.paymentAllocation.groupBy({ by: ["billId"], where: { billId: { in: billIds }, payment: { reversal: { is: null } } }, _sum: { amount: true } }),
      ])
    : [[], []];
  const out = new Map<string, Prisma.Decimal>();
  for (const r of dn) out.set(r.billId, (out.get(r.billId) ?? D(0)).plus(r._sum.total ?? 0));
  for (const r of paid) if (r.billId) out.set(r.billId, (out.get(r.billId) ?? D(0)).plus(r._sum.amount ?? 0));
  return out;
}

export async function listBills(filters: { status?: string; supplierId?: string }) {
  const rows = await prisma.supplierBill.findMany({
    where: { ...(filters.status ? { status: filters.status } : {}), ...(filters.supplierId ? { supplierId: filters.supplierId } : {}) },
    orderBy: [{ createdAt: "desc" }],
    include: { supplier: { select: { id: true, code: true, name: true, nameAr: true } }, _count: { select: { lines: true, serviceLines: true } } },
    take: 300,
  });
  const debited = await debitedByBill(prisma, rows.filter((b) => b.status === "posted").map((b) => b.id));
  return rows.map((b) => ({
    id: b.id,
    number: b.number,
    status: b.status,
    kind: b.kind,
    supplier: b.supplier,
    supplierInvoiceNo: b.supplierInvoiceNo,
    billDate: b.billDate,
    dueDate: b.dueDate,
    lineCount: b._count.lines + b._count.serviceLines,
    net: b.net.toFixed(2),
    total: b.total.toFixed(2),
    variance: b.variance.toFixed(2),
    matchStatus: b.matchStatus,
    open: b.status === "posted" ? b.total.minus(debited.get(b.id) ?? 0).toFixed(2) : null,
    version: b.version,
  }));
}

export async function getBill(id: string) {
  const b = await prisma.supplierBill.findUnique({
    where: { id },
    include: {
      supplier: { select: { id: true, code: true, name: true, nameAr: true, paymentTermsDays: true } },
      lines: { orderBy: { lineNo: "asc" }, include: { intake: { select: { receiptNumber: true, receivedDate: true } }, poLine: { select: { po: { select: { id: true, number: true } } } } } },
      serviceLines: { orderBy: { lineNo: "asc" }, include: { account: { select: { code: true, name: true, nameAr: true } }, debitLines: { select: { net: true } } } },
      debitNotes: { orderBy: { createdAt: "asc" }, include: { lines: true } },
      paymentAllocations: { where: { payment: { reversal: { is: null } } }, include: { payment: { select: { id: true, number: true, date: true } } } },
    },
  });
  if (!b) throw new ApiError(404, "الفاتورة مش موجودة");
  const paid = b.paymentAllocations.reduce((s, a) => s.plus(a.amount), D(0));
  const debitedQty = new Map<string, Prisma.Decimal>();
  for (const dn of b.debitNotes) for (const l of dn.lines) debitedQty.set(l.billLineId, (debitedQty.get(l.billLineId) ?? D(0)).plus(l.quantity));
  const debitedTotal = b.debitNotes.reduce((a, dn) => a.plus(dn.total), D(0));
  const pending = b.status === "pending_approval" ? await findPending(prisma, "purchasing.bill", b.id) : null;
  return {
    id: b.id,
    number: b.number,
    status: b.status,
    kind: b.kind,
    supplier: b.supplier,
    supplierInvoiceNo: b.supplierInvoiceNo,
    billDate: b.billDate,
    dueDate: b.dueDate,
    currencyCode: b.currencyCode,
    notes: b.notes,
    cancelReason: b.cancelReason,
    matchStatus: b.matchStatus,
    expectedNet: b.expectedNet.toFixed(2),
    variance: b.variance.toFixed(2),
    gross: b.gross.toFixed(2),
    net: b.net.toFixed(2),
    taxTotal: b.taxTotal.toFixed(2),
    total: b.total.toFixed(2),
    debited: debitedTotal.toFixed(2),
    paid: paid.toFixed(2),
    payments: b.paymentAllocations.map((a) => ({ paymentId: a.payment.id, number: a.payment.number, date: a.payment.date, amount: a.amount.toFixed(2) })),
    open: b.status === "posted" ? b.total.minus(debitedTotal).minus(paid).toFixed(2) : null,
    approvalId: pending?.id ?? null,
    createdBy: b.createdBy,
    postedBy: b.postedBy,
    postedAt: b.postedAt,
    approvedBy: b.approvedBy,
    version: b.version,
    lines: b.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      intakeId: l.intakeId,
      receiptNumber: l.intake.receiptNumber,
      receivedDate: l.intake.receivedDate,
      poNumber: l.poLine?.po.number ?? null,
      description: l.description,
      uomCode: l.uomCode,
      receivedQty: l.receivedQty.toString(),
      quantity: l.quantity.toString(),
      unitPrice: l.unitPrice.toString(),
      expectedUnitPrice: l.expectedUnitPrice?.toString() ?? null,
      expectedNet: l.expectedNet?.toFixed(2) ?? null,
      lineVariance: l.expectedNet == null ? null : l.net.minus(l.expectedNet).toFixed(2),
      taxCode: l.taxCode,
      taxRate: l.taxRate.toString(),
      net: l.net.toFixed(2),
      tax: l.tax.toFixed(2),
      total: l.total.toFixed(2),
      debitedQty: (debitedQty.get(l.id) ?? D(0)).toString(),
    })),
    serviceLines: b.serviceLines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      accountId: l.accountId,
      account: l.account,
      description: l.description,
      taxCode: l.taxCode,
      taxRate: l.taxRate.toString(),
      net: l.net.toFixed(2),
      tax: l.tax.toFixed(2),
      total: l.total.toFixed(2),
      debitedNet: l.debitLines.reduce((s, d) => s.plus(d.net), D(0)).toFixed(2),
    })),
    debitNotes: b.debitNotes.map((dn) => ({ id: dn.id, number: dn.number, issueDate: dn.issueDate, reason: dn.reason, total: dn.total.toFixed(2), createdBy: dn.createdBy })),
  };
}

/** Posted bills − debit notes − payments for a supplier (what we owe them now). */
export async function supplierPayable(db: Pick<Tx, "supplierBill" | "debitNote" | "supplierPayment" | "partyOpeningBalance" | "supplierRefund">, supplierId: string) {
  const [bills, dns, pays, ob, back, paidBack] = await Promise.all([
    db.supplierBill.aggregate({ where: { supplierId, status: "posted" }, _sum: { total: true } }),
    db.debitNote.aggregate({ where: { supplierId }, _sum: { total: true } }),
    db.supplierPayment.aggregate({ where: { supplierId }, _sum: { amount: true } }),
    db.partyOpeningBalance.aggregate({ where: { partyType: "supplier", partyId: supplierId }, _sum: { amount: true } }),
    db.supplierPayment.aggregate({ where: { supplierId, reversal: { isNot: null } }, _sum: { amount: true } }),
    db.supplierRefund.aggregate({ where: { supplierId }, _sum: { amount: true } }),
  ]);
  // A reversed payment still counts as paid on its date; its reversal adds it back.
  // Money the supplier paid back uses up credit we held with them: it adds back too.
  return D(bills._sum.total ?? 0).minus(dns._sum.total ?? 0).minus(pays._sum.amount ?? 0).plus(ob._sum.amount ?? 0).plus(back._sum.amount ?? 0).plus(paidBack._sum.amount ?? 0);
}

/** Every posted bill and debit note of a supplier in a period, with a running balance owed. */
export async function supplierStatement(supplierId: string, from: string, to: string) {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "الفترة غير صالحة");
  const s = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!s) throw new ApiError(404, "المورد مش موجود");
  const [refBefore, refs, revBefore, revs, obBefore, obs, billsBefore, dnBefore, payBefore, pays, bills, dns] = await Promise.all([
    prisma.supplierRefund.aggregate({ where: { supplierId, date: { lt: from } }, _sum: { amount: true } }),
    prisma.supplierRefund.findMany({ where: { supplierId, date: { gte: from, lte: to } }, select: { id: true, number: true, date: true, amount: true, reason: true, createdAt: true } }),
    prisma.supplierPayment.aggregate({ where: { supplierId, reversal: { is: { date: { lt: from } } } }, _sum: { amount: true } }),
    prisma.supplierPaymentReversal.findMany({ where: { payment: { supplierId }, date: { gte: from, lte: to } }, include: { payment: { select: { number: true, amount: true } } } }),
    prisma.partyOpeningBalance.aggregate({ where: { partyType: "supplier", partyId: supplierId, date: { lt: from } }, _sum: { amount: true } }),
    prisma.partyOpeningBalance.findMany({ where: { partyType: "supplier", partyId: supplierId, date: { gte: from, lte: to } } }),
    prisma.supplierBill.aggregate({ where: { supplierId, status: "posted", billDate: { lt: from } }, _sum: { total: true } }),
    prisma.debitNote.aggregate({ where: { supplierId, issueDate: { lt: from } }, _sum: { total: true } }),
    prisma.supplierPayment.aggregate({ where: { supplierId, date: { lt: from } }, _sum: { amount: true } }),
    prisma.supplierPayment.findMany({ where: { supplierId, date: { gte: from, lte: to } }, select: { id: true, number: true, date: true, amount: true, reference: true, createdAt: true } }),
    prisma.supplierBill.findMany({ where: { supplierId, status: "posted", billDate: { gte: from, lte: to } }, select: { id: true, number: true, supplierInvoiceNo: true, billDate: true, dueDate: true, total: true, postedAt: true } }),
    prisma.debitNote.findMany({ where: { supplierId, issueDate: { gte: from, lte: to } }, select: { id: true, number: true, issueDate: true, total: true, reason: true, createdAt: true, bill: { select: { number: true } } } }),
  ]);
  const opening = D(billsBefore._sum.total ?? 0).minus(dnBefore._sum.total ?? 0).minus(payBefore._sum.amount ?? 0).plus(obBefore._sum.amount ?? 0).plus(revBefore._sum.amount ?? 0).plus(refBefore._sum.amount ?? 0);
  const entries = [
    ...refs.map((f) => ({ date: f.date, at: f.createdAt.getTime(), kind: "refund" as const, id: f.id, number: f.number, ref: `استرداد · ${f.reason}`, credit: f.amount, debit: D(0) })),
    ...bills.map((b) => ({ date: b.billDate, at: b.postedAt!.getTime(), kind: "bill" as const, id: b.id, number: b.number, ref: `${b.supplierInvoiceNo} · استحقاق ${b.dueDate}`, credit: b.total, debit: D(0) })),
    ...dns.map((n) => ({ date: n.issueDate, at: n.createdAt.getTime(), kind: "debit_note" as const, id: n.id, number: n.number, ref: `${n.bill.number} · ${n.reason}`, credit: D(0), debit: n.total })),
    ...obs.map((o) => ({ date: o.date, at: o.createdAt.getTime(), kind: "opening_balance" as const, id: o.id, number: "رصيد افتتاحي", ref: o.reference ?? "", credit: o.amount.gt(0) ? o.amount : D(0), debit: o.amount.lt(0) ? o.amount.negated() : D(0) })),
    ...pays.map((p) => ({ date: p.date, at: p.createdAt.getTime(), kind: "payment" as const, id: p.id, number: p.number, ref: `سداد${p.reference ? ` · ${p.reference}` : ""}`, credit: D(0), debit: p.amount })),
    ...revs.map((r) => ({ date: r.date, at: r.createdAt.getTime(), kind: "payment_reversal" as const, id: r.id, number: r.payment.number, ref: `عكس سداد · ${r.reason}`, credit: r.payment.amount, debit: D(0) })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.at - b.at);
  let bal = opening;
  const rows = entries.map((e) => {
    bal = bal.plus(e.credit).minus(e.debit);
    return { date: e.date, kind: e.kind, id: e.id, number: e.number, ref: e.ref, credit: e.credit.toFixed(2), debit: e.debit.toFixed(2), balance: bal.toFixed(2) };
  });
  return { supplier: { id: s.id, code: s.code, name: s.name }, from, to, opening: opening.toFixed(2), closing: bal.toFixed(2), rows };
}

/** Open payables by how overdue they are, per supplier, as of a date. */
export async function apAgingReport(asOf = todayLocalISO()) {
  if (!isValidISODate(asOf)) throw new ApiError(400, "التاريخ غير صالح");
  const bills = await prisma.supplierBill.findMany({
    where: { status: "posted", billDate: { lte: asOf } },
    select: { id: true, supplierId: true, dueDate: true, total: true, supplier: { select: { code: true, name: true, nameAr: true } } },
  });
  const debited = await debitedByBill(prisma, bills.map((b) => b.id));
  type Bucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";
  const bySupplier = new Map<string, { supplier: { id: string; code: string; name: string }; total: Prisma.Decimal } & Record<Bucket, Prisma.Decimal>>();
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  // A debit note on a bill that was already paid leaves it below zero: that is credit the
  // supplier holds for us, on account like unapplied money — never dropped from the aging.
  const unapplied = new Map<string, Prisma.Decimal>();
  for (const b of bills) {
    const open = b.total.minus(debited.get(b.id) ?? 0);
    if (open.lt(0)) {
      unapplied.set(b.supplierId, (unapplied.get(b.supplierId) ?? D(0)).plus(open.negated()));
      if (!bySupplier.has(b.supplierId)) bySupplier.set(b.supplierId, { supplier: { id: b.supplierId, code: b.supplier.code, name: b.supplier.name }, total: D(0), current: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), d90_plus: D(0) });
    }
    if (!open.gt(0)) continue;
    const overdue = day(asOf) - day(b.dueDate);
    const k: Bucket = overdue <= 0 ? "current" : overdue <= 30 ? "d1_30" : overdue <= 60 ? "d31_60" : overdue <= 90 ? "d61_90" : "d90_plus";
    const row = bySupplier.get(b.supplierId) ?? { supplier: { id: b.supplierId, code: b.supplier.code, name: b.supplier.name }, total: D(0), current: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), d90_plus: D(0) };
    row[k] = row[k].plus(open);
    row.total = row.total.plus(open);
    bySupplier.set(b.supplierId, row);
  }
  // Balances brought over at go-live age from their own due date. Payments allocated
  // to an opening item reduce it in aging just like a bill allocation.
  const openingBalances = await prisma.partyOpeningBalance.findMany({ where: { partyType: "supplier", date: { lte: asOf } } });
  const openingIds = openingBalances.map((o) => o.id);
  const openingAllocations = openingIds.length ? await prisma.paymentAllocation.groupBy({
    by: ["openingBalanceId"],
    where: { openingBalanceId: { in: openingIds }, payment: { date: { lte: asOf }, reversal: { is: null } } },
    _sum: { amount: true },
  }) : [];
  const openingAllocatedBy = new Map(openingAllocations.map((a) => [a.openingBalanceId!, D(a._sum.amount ?? 0)]));
  for (const o of openingBalances) {
    const sp = await prisma.supplier.findUnique({ where: { id: o.partyId }, select: { code: true, name: true } });
    const open = o.amount.minus(openingAllocatedBy.get(o.id) ?? 0);
    if (!open.isZero()) {
      if (open.lt(0)) {
        unapplied.set(o.partyId, (unapplied.get(o.partyId) ?? D(0)).plus(open.negated()));
        if (!bySupplier.has(o.partyId)) bySupplier.set(o.partyId, { supplier: { id: o.partyId, code: sp?.code ?? "", name: sp?.name ?? "" }, total: D(0), current: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), d90_plus: D(0) });
      } else {
        const overdue = day(asOf) - day(o.dueDate);
        const k: Bucket = overdue <= 0 ? "current" : overdue <= 30 ? "d1_30" : overdue <= 60 ? "d31_60" : overdue <= 90 ? "d61_90" : "d90_plus";
        const row = bySupplier.get(o.partyId) ?? { supplier: { id: o.partyId, code: sp?.code ?? "", name: sp?.name ?? "" }, total: D(0), current: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), d90_plus: D(0) };
        row[k] = row[k].plus(open);
        row.total = row.total.plus(open);
        bySupplier.set(o.partyId, row);
      }
    }
  }
  // Paid but not yet applied to a bill reduces what we owe.
  const pays = await prisma.supplierPayment.findMany({ where: { date: { lte: asOf }, reversal: { is: null } }, select: { supplierId: true, amount: true, allocations: { select: { amount: true } }, supplier: { select: { code: true, name: true, nameAr: true } } } });
  for (const p of pays) {
    const left = p.amount.minus(p.allocations.reduce((s, a) => s.plus(a.amount), D(0)));
    if (!left.gt(0)) continue;
    unapplied.set(p.supplierId, (unapplied.get(p.supplierId) ?? D(0)).plus(left));
    if (!bySupplier.has(p.supplierId)) bySupplier.set(p.supplierId, { supplier: { id: p.supplierId, code: p.supplier.code, name: p.supplier.name }, total: D(0), current: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), d90_plus: D(0) });
  }
  // Money the supplier paid back uses up our credit with them first; anything beyond it is
  // owed to them again from today.
  for (const f of await prisma.supplierRefund.groupBy({ by: ["supplierId"], where: { date: { lte: asOf } }, _sum: { amount: true } })) {
    const amt = D(f._sum.amount ?? 0);
    const held = unapplied.get(f.supplierId) ?? D(0);
    const used = Prisma.Decimal.min(held, amt);
    unapplied.set(f.supplierId, held.minus(used));
    const rest = amt.minus(used);
    if (rest.gt(0)) {
      const sp = await prisma.supplier.findUnique({ where: { id: f.supplierId }, select: { code: true, name: true } });
      const row = bySupplier.get(f.supplierId) ?? { supplier: { id: f.supplierId, code: sp?.code ?? "", name: sp?.name ?? "" }, total: D(0), current: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), d90_plus: D(0) };
      row.current = row.current.plus(rest);
      row.total = row.total.plus(rest);
      bySupplier.set(f.supplierId, row);
    }
  }
  for (const [id, u] of unapplied) bySupplier.get(id)!.total = bySupplier.get(id)!.total.minus(u);
  const rows = [...bySupplier.values()].sort((a, b) => Number(b.total.minus(a.total)));
  const sum = (k: Bucket | "total") => rows.reduce((s, r) => s.plus(r[k]), D(0)).toFixed(2);
  return {
    asOf,
    rows: rows.map((r) => ({ supplier: r.supplier, unapplied: (unapplied.get(r.supplier.id) ?? D(0)).toFixed(2), total: r.total.toFixed(2), current: r.current.toFixed(2), d1_30: r.d1_30.toFixed(2), d31_60: r.d31_60.toFixed(2), d61_90: r.d61_90.toFixed(2), d90_plus: r.d90_plus.toFixed(2) })),
    totals: { total: sum("total"), current: sum("current"), d1_30: sum("d1_30"), d31_60: sum("d31_60"), d61_90: sum("d61_90"), d90_plus: sum("d90_plus") },
  };
}
