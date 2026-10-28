import { Prisma } from "@prisma/client";
import { idempotencyKeyField, lockKey, replayRequest, requestFingerprint } from "@/lib/core/idempotency";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { inTx } from "@/lib/tx";
import { isValidISODate } from "@/lib/dates";
import { optText, parse, text } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { postJournal } from "@/lib/accounting/ledger";

/**
 * Two things that make the ledger trustworthy enough to replace Odoo:
 *
 *  1. Opening balances at go-live — a customer's or supplier's balance brought over
 *     becomes a document of their account (statement, aging) AND a journal entry
 *     (AR/AP ↔ opening-balance equity), in one transaction, so the two never differ.
 *     (Opening stock goes through the stock ledger: see postOpeningStock.)
 *
 *  2. The integrity check — every subledger against its GL account, party by party,
 *     plus anything that should have posted and did not. All zeros is the claim
 *     "every department reads the same truth", checked rather than assumed.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);

// ---------------------------------------------------------------------------
// Opening balances
// ---------------------------------------------------------------------------

const openingInput = z.object({
  party_type: z.enum(["customer", "supplier"]),
  party_id: text("الطرف"),
  date: z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD"),
  due_date: z.string().refine(isValidISODate, "تاريخ الاستحقاق لازم يكون YYYY-MM-DD").optional(),
  amount: z.union([z.number(), z.string()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(s) || Number(s) === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "المبلغ لازم يكون رقم غير الصفر بحد أقصى خانتين عشريتين" });
      return z.NEVER;
    }
    return D(s);
  }),
  reference: optText("المرجع", 100).optional(),
  idempotency_key: idempotencyKeyField,
});

export async function createOpeningBalance(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(openingInput, input);
  const requestHash = requestFingerprint({ party_type: v.party_type, party_id: v.party_id, date: v.date, due_date: v.due_date ?? v.date, amount: v.amount, reference: v.reference ?? null });
  return inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.partyOpeningBalance.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) return replayRequest(prev, requestHash, prev.partyType === v.party_type && prev.partyId === v.party_id && D(prev.amount).equals(v.amount) && prev.date === v.date && prev.dueDate === (v.due_date ?? v.date) && prev.reference === (v.reference ?? null));
    }
    const party = v.party_type === "customer" ? await tx.customer.findUnique({ where: { id: v.party_id }, select: { id: true, name: true } }) : await tx.supplier.findUnique({ where: { id: v.party_id }, select: { id: true, name: true } });
    if (!party) throw new ApiError(404, v.party_type === "customer" ? "العميل مش موجود" : "المورد مش موجود");
    const row = await tx.partyOpeningBalance.create({ data: { partyType: v.party_type, partyId: party.id, date: v.date, dueDate: v.due_date ?? v.date, amount: v.amount, reference: v.reference ?? null, idempotencyKey: v.idempotency_key ?? null, requestHash, createdById: actor.id, createdBy: actor.name } });
    // Customer: Dr AR / Cr opening equity. Supplier: Cr AP / Dr opening equity. (Negative amounts reverse.)
    const partyLine = v.party_type === "customer" ? { key: "ar" as const, amount: v.amount } : { key: "ap" as const, amount: v.amount.negated() };
    await postJournal(tx, {
      date: v.date, description: `رصيد افتتاحي — ${party.name}${v.reference ? ` (${v.reference})` : ""}`, sourceType: "opening_balance", sourceId: row.id,
      lines: [{ ...partyLine, party: { type: v.party_type, id: party.id } }, { key: "opening_equity", amount: partyLine.amount.negated() }],
    }, actor);
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "opening_balance_recorded", entityType: "journal_entry", entityId: row.id, fieldChanged: v.party_type, newValue: `${party.name} · ${v.amount.toFixed(2)}`, source: "user", deviceId: actor.deviceId }, tx);
    return row;
  });
}

export async function listOpeningBalances() {
  const rows = await prisma.partyOpeningBalance.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
  const [customers, suppliers] = await Promise.all([
    prisma.customer.findMany({ where: { id: { in: rows.filter((r) => r.partyType === "customer").map((r) => r.partyId) } }, select: { id: true, code: true, name: true } }),
    prisma.supplier.findMany({ where: { id: { in: rows.filter((r) => r.partyType === "supplier").map((r) => r.partyId) } }, select: { id: true, code: true, name: true } }),
  ]);
  const names = new Map([...customers, ...suppliers].map((p) => [p.id, p]));
  return rows.map((r) => ({ ...r, amount: r.amount.toFixed(2), party: names.get(r.partyId) ?? null }));
}

// ---------------------------------------------------------------------------
// Integrity check
// ---------------------------------------------------------------------------

type Check = { key: string; label: string; ok: boolean; subledger?: string; ledger?: string; difference?: string; count?: number; detail?: unknown };

async function glBalance(systemKey: string) {
  const [r] = await prisma.$queryRaw<{ bal: Prisma.Decimal | null }[]>`
    SELECT sum(l."debit" - l."credit") AS bal FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = ${systemKey}`;
  return D(r?.bal);
}

/** Per-party subledger vs GL for AR (customers) or AP (suppliers). Returns the parties that differ. */
async function partyMismatches(kind: "customer" | "supplier") {
  const rows =
    kind === "customer"
      ? await prisma.$queryRaw<{ id: string; sub: Prisma.Decimal; gl: Prisma.Decimal }[]>`
        WITH sub AS (
          SELECT "customerId" AS id, sum("total") AS amt FROM "SalesInvoice" WHERE "status" = 'issued' GROUP BY 1
          UNION ALL SELECT "customerId", -sum("total") FROM "CreditNote" GROUP BY 1
          UNION ALL SELECT "customerId", -sum("amount") FROM "CustomerReceipt" GROUP BY 1
          UNION ALL SELECT r."customerId", sum(r."amount") FROM "CustomerReceiptReversal" x JOIN "CustomerReceipt" r ON r."id" = x."receiptId" GROUP BY 1
          UNION ALL SELECT "customerId", sum("amount") FROM "CustomerRefund" GROUP BY 1
          UNION ALL SELECT "partyId", sum("amount") FROM "PartyOpeningBalance" WHERE "partyType" = 'customer' GROUP BY 1
        ), s AS (SELECT id, sum(amt) AS sub FROM sub GROUP BY id),
        g AS (SELECT l."partyId" AS id, sum(l."debit" - l."credit") AS gl FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = 'ar' AND l."partyType" = 'customer' GROUP BY 1)
        SELECT coalesce(s.id, g.id) AS id, coalesce(s.sub, 0) AS sub, coalesce(g.gl, 0) AS gl FROM s FULL JOIN g ON g.id = s.id WHERE coalesce(s.sub, 0) <> coalesce(g.gl, 0)`
      : await prisma.$queryRaw<{ id: string; sub: Prisma.Decimal; gl: Prisma.Decimal }[]>`
        WITH sub AS (
          SELECT "supplierId" AS id, sum("total") AS amt FROM "SupplierBill" WHERE "status" = 'posted' GROUP BY 1
          UNION ALL SELECT "supplierId", -sum("total") FROM "DebitNote" GROUP BY 1
          UNION ALL SELECT "supplierId", -sum("amount") FROM "SupplierPayment" GROUP BY 1
          UNION ALL SELECT p."supplierId", sum(p."amount") FROM "SupplierPaymentReversal" x JOIN "SupplierPayment" p ON p."id" = x."paymentId" GROUP BY 1
          UNION ALL SELECT "supplierId", sum("amount") FROM "SupplierRefund" GROUP BY 1
          UNION ALL SELECT "partyId", sum("amount") FROM "PartyOpeningBalance" WHERE "partyType" = 'supplier' GROUP BY 1
        ), s AS (SELECT id, sum(amt) AS sub FROM sub GROUP BY id),
        g AS (SELECT l."partyId" AS id, sum(l."credit" - l."debit") AS gl FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = 'ap' AND l."partyType" = 'supplier' GROUP BY 1)
        SELECT coalesce(s.id, g.id) AS id, coalesce(s.sub, 0) AS sub, coalesce(g.gl, 0) AS gl FROM s FULL JOIN g ON g.id = s.id WHERE coalesce(s.sub, 0) <> coalesce(g.gl, 0)`;
  return rows.map((r) => ({ id: r.id, subledger: D(r.sub).toFixed(2), ledger: D(r.gl).toFixed(2) }));
}

export async function integrityReport() {
  const checks: Check[] = [];

  // The journal itself.
  const [tb] = await prisma.$queryRaw<{ dr: Prisma.Decimal | null; cr: Prisma.Decimal | null }[]>`SELECT sum("debit") AS dr, sum("credit") AS cr FROM "JournalLine"`;
  checks.push({ key: "trial_balance", label: "ميزان المراجعة متوازن", ok: D(tb?.dr).equals(D(tb?.cr)), subledger: D(tb?.dr).toFixed(2), ledger: D(tb?.cr).toFixed(2) });

  // Documents that should have posted.
  const unposted = await prisma.$queryRaw<{ kind: string; n: bigint }[]>`
    SELECT 'sales_invoice' AS kind, count(*) AS n FROM "SalesInvoice" d WHERE d."status" = 'issued' AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'sales_invoice' AND e."sourceId" = d."id")
    UNION ALL SELECT 'credit_note', count(*) FROM "CreditNote" d WHERE NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'credit_note' AND e."sourceId" = d."id")
    UNION ALL SELECT 'supplier_bill', count(*) FROM "SupplierBill" d WHERE d."status" = 'posted' AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'supplier_bill' AND e."sourceId" = d."id")
    UNION ALL SELECT 'debit_note', count(*) FROM "DebitNote" d WHERE NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'debit_note' AND e."sourceId" = d."id")
    UNION ALL SELECT 'customer_receipt', count(*) FROM "CustomerReceipt" d WHERE NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'customer_receipt' AND e."sourceId" = d."id")
    UNION ALL SELECT 'supplier_payment', count(*) FROM "SupplierPayment" d WHERE NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'supplier_payment' AND e."sourceId" = d."id")
    UNION ALL SELECT 'receipt_reversal', count(*) FROM "CustomerReceiptReversal" d WHERE NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'receipt_reversal' AND e."sourceId" = d."id")
    UNION ALL SELECT 'payment_reversal', count(*) FROM "SupplierPaymentReversal" d WHERE NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'payment_reversal' AND e."sourceId" = d."id")
    UNION ALL SELECT 'customer_refund', count(*) FROM "CustomerRefund" d WHERE NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'customer_refund' AND e."sourceId" = d."id")
    UNION ALL SELECT 'supplier_refund', count(*) FROM "SupplierRefund" d WHERE NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'supplier_refund' AND e."sourceId" = d."id")
    UNION ALL SELECT 'expense', count(*) FROM "Expense" d WHERE d."status" = 'approved' AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'expense' AND e."sourceId" = d."id")
    UNION ALL SELECT 'stock_movement', count(*) FROM "StockMovement" m WHERE NOT EXISTS (SELECT 1 FROM "StockValuationPosting" p WHERE p."movementId" = m."id")
    UNION ALL SELECT 'payroll_run', count(*) FROM "PayrollRun" d WHERE d."status" IN ('posted', 'reversed') AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'payroll_run' AND e."sourceId" = d."id")
    UNION ALL SELECT 'payroll_payment', count(*) FROM "PayrollPayment" d WHERE NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceType" = 'payroll_payment' AND e."sourceId" = d."id")`;
  const missing = unposted.filter((u) => Number(u.n) > 0).map((u) => ({ kind: u.kind, count: Number(u.n) }));
  checks.push({ key: "unposted", label: "كل المستندات وحركات المخزون مترحّلة للحسابات", ok: missing.length === 0, count: missing.reduce((s, m) => s + m.count, 0), detail: missing });

  // Journal entries with no source document behind them (only manual entries and reversals may stand alone).
  const [orphans] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "JournalEntry" e WHERE
      (e."sourceType" = 'sales_invoice' AND NOT EXISTS (SELECT 1 FROM "SalesInvoice" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'credit_note' AND NOT EXISTS (SELECT 1 FROM "CreditNote" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'supplier_bill' AND NOT EXISTS (SELECT 1 FROM "SupplierBill" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'debit_note' AND NOT EXISTS (SELECT 1 FROM "DebitNote" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'customer_receipt' AND NOT EXISTS (SELECT 1 FROM "CustomerReceipt" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'supplier_payment' AND NOT EXISTS (SELECT 1 FROM "SupplierPayment" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'receipt_reversal' AND NOT EXISTS (SELECT 1 FROM "CustomerReceiptReversal" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'payment_reversal' AND NOT EXISTS (SELECT 1 FROM "SupplierPaymentReversal" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'customer_refund' AND NOT EXISTS (SELECT 1 FROM "CustomerRefund" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'supplier_refund' AND NOT EXISTS (SELECT 1 FROM "SupplierRefund" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'expense' AND NOT EXISTS (SELECT 1 FROM "Expense" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'employee_transaction' AND NOT EXISTS (SELECT 1 FROM "EmployeeTransaction" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'opening_balance' AND NOT EXISTS (SELECT 1 FROM "PartyOpeningBalance" d WHERE d."id" = e."sourceId"))
      OR (e."sourceType" = 'payroll_run' AND NOT EXISTS (SELECT 1 FROM "PayrollRun" d WHERE d."id" = e."sourceId" AND d."journalEntryId" = e."id"))
      OR (e."sourceType" = 'payroll_payment' AND NOT EXISTS (SELECT 1 FROM "PayrollPayment" d WHERE d."id" = e."sourceId" AND d."journalEntryId" = e."id"))
      OR (e."sourceType" = 'stock_valuation' AND NOT EXISTS (SELECT 1 FROM "StockValuationPosting" p WHERE p."entryId" = e."id") AND e."sourceId" NOT LIKE '%|%')`;
  checks.push({ key: "traceable", label: "كل قيد له مستند مصدر", ok: Number(orphans?.n ?? 0) === 0, count: Number(orphans?.n ?? 0) });

  // Receivables: customer documents vs the AR account, in total and per customer.
  const arSub = await prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT (SELECT coalesce(sum("total"), 0) FROM "SalesInvoice" WHERE "status" = 'issued') - (SELECT coalesce(sum("total"), 0) FROM "CreditNote")
         - (SELECT coalesce(sum("amount"), 0) FROM "CustomerReceipt") + (SELECT coalesce(sum("amount"), 0) FROM "PartyOpeningBalance" WHERE "partyType" = 'customer')
         + (SELECT coalesce(sum(r."amount"), 0) FROM "CustomerReceiptReversal" x JOIN "CustomerReceipt" r ON r."id" = x."receiptId")
         + (SELECT coalesce(sum("amount"), 0) FROM "CustomerRefund") AS v`;
  const arGl = await glBalance("ar");
  const arParties = await partyMismatches("customer");
  checks.push({ key: "ar", label: "أرصدة العملاء = حساب العملاء في الأستاذ", ok: D(arSub[0]?.v).equals(arGl) && arParties.length === 0, subledger: D(arSub[0]?.v).toFixed(2), ledger: arGl.toFixed(2), difference: D(arSub[0]?.v).minus(arGl).toFixed(2), detail: arParties.slice(0, 20) });

  // Payables.
  const apSub = await prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT (SELECT coalesce(sum("total"), 0) FROM "SupplierBill" WHERE "status" = 'posted') - (SELECT coalesce(sum("total"), 0) FROM "DebitNote")
         - (SELECT coalesce(sum("amount"), 0) FROM "SupplierPayment") + (SELECT coalesce(sum("amount"), 0) FROM "PartyOpeningBalance" WHERE "partyType" = 'supplier')
         + (SELECT coalesce(sum(p."amount"), 0) FROM "SupplierPaymentReversal" x JOIN "SupplierPayment" p ON p."id" = x."paymentId")
         + (SELECT coalesce(sum("amount"), 0) FROM "SupplierRefund") AS v`;
  const apGl = (await glBalance("ap")).negated();
  const apParties = await partyMismatches("supplier");
  checks.push({ key: "ap", label: "أرصدة الموردين = حساب الموردين في الأستاذ", ok: D(apSub[0]?.v).equals(apGl) && apParties.length === 0, subledger: D(apSub[0]?.v).toFixed(2), ledger: apGl.toFixed(2), difference: D(apSub[0]?.v).minus(apGl).toFixed(2), detail: apParties.slice(0, 20) });

  // Inventory: the stock ledger's value vs the inventory account. Each posting rounds to
  // the piastre, so a difference of a few piastres over thousands of movements is rounding.
  const [inv] = await prisma.$queryRaw<{ v: Prisma.Decimal | null; n: bigint }[]>`SELECT sum("value") AS v, count(*) AS n FROM "StockValuationLayer"`;
  const invGl = await glBalance("inventory");
  const invDiff = D(inv?.v).minus(invGl);
  const tolerance = D(Number(inv?.n ?? 0)).times("0.005");
  checks.push({ key: "inventory", label: "قيمة المخزون = حساب المخزون في الأستاذ", ok: invDiff.abs().lessThanOrEqualTo(Prisma.Decimal.max(tolerance, D("0.01"))), subledger: D(inv?.v).toFixed(2), ledger: invGl.toFixed(2), difference: invDiff.toFixed(2) });

  // Received but not yet billed (informational: it is normal to carry some).
  const grni = (await glBalance("grni")).negated();
  checks.push({ key: "grni", label: "بضاعة مستلمة لسه فواتيرها مجتش (معلومة)", ok: true, ledger: grni.toFixed(2) });

  // Payroll: what posted runs still owe their employees (net payable less payments, reversed
  // runs and payments left out) against the net-salaries account(s) the runs posted to.
  const [pay] = await prisma.$queryRaw<{ sub: Prisma.Decimal | null; runs: bigint }[]>`
    SELECT (SELECT coalesce(sum(r."netPayable"), 0) FROM "PayrollRun" r WHERE r."status" = 'posted')
         - (SELECT coalesce(sum(p."amount"), 0) FROM "PayrollPayment" p JOIN "PayrollRun" r ON r."id" = p."runId" WHERE r."status" = 'posted' AND p."reversedAt" IS NULL) AS sub,
           (SELECT count(*) FROM "PayrollRun" r WHERE r."status" IN ('posted', 'reversed')) AS runs`;
  const [payGl] = await prisma.$queryRaw<{ gl: Prisma.Decimal | null }[]>`
    SELECT coalesce(sum(l."credit" - l."debit"), 0) AS gl FROM "JournalLine" l
    WHERE l."accountId" IN (SELECT DISTINCT "netPayAccountId" FROM "PayrollRun" WHERE "netPayAccountId" IS NOT NULL)`;
  const paySub = D(pay?.sub);
  const payLedger = D(payGl?.gl);
  checks.push({ key: "payroll", label: "صافي المرتبات المستحقة = حسابها في الأستاذ", ok: paySub.equals(payLedger), subledger: paySub.toFixed(2), ledger: payLedger.toFixed(2), difference: paySub.minus(payLedger).toFixed(2), count: Number(pay?.runs ?? 0) });

  // Waste still on the books (informational): grading sends waste to the waste location at
  // cost and it stays in inventory until a scrap document writes it off. Whether and when to
  // write it off is the accountant's policy; this shows what is waiting.
  const waste = await prisma.$queryRaw<{ productId: string; name: string; nameAr: string | null; unit: string; qty: Prisma.Decimal; value: Prisma.Decimal }[]>`
    SELECT m."productId", p."name", p."nameAr", p."unit", sum(m."quantity") AS qty, coalesce(sum(v."value"), 0) AS value
    FROM "StockMovement" m
    JOIN "StorageLocation" l ON l."id" = m."locationId"
    JOIN "StockProduct" p ON p."id" = m."productId"
    LEFT JOIN "StockValuationLayer" v ON v."movementId" = m."id"
    WHERE l."type" = 'waste'
    GROUP BY m."productId", p."name", p."nameAr", p."unit"
    HAVING sum(m."quantity") <> 0 OR coalesce(sum(v."value"), 0) <> 0
    ORDER BY value DESC`;
  const wasteValue = waste.reduce((sum, w) => sum.plus(w.value), D(0));
  checks.push({
    key: "waste_pending", label: "هالك لسه في المخزون مستني الإعدام (معلومة)", ok: true, ledger: wasteValue.toFixed(2), count: waste.length,
    detail: waste.slice(0, 20).map((w) => ({ productId: w.productId, name: w.name, nameAr: w.nameAr, unit: w.unit, quantity: D(w.qty).toString(), value: D(w.value).toFixed(2) })),
  });

  return { ok: checks.every((c) => c.ok), checkedAt: new Date().toISOString(), checks };
}
