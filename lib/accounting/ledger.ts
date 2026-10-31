import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { idempotencyKeyField, lockKey, replayRequest, requestFingerprint } from "@/lib/core/idempotency";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { isValidISODate } from "@/lib/dates";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { parse, text } from "@/lib/core/validation";
import { assertEgpCurrency } from "@/lib/core/currency";
import { getSetting } from "@/lib/core/settings-service";
import { cancelPendingApproval, requestApproval } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";

/**
 * The general ledger.
 *
 * Every business document posts its own journal entry, once (unique on its source),
 * inside the transaction that issues/posts the document — so a document and its
 * accounting either both exist or neither does:
 *
 *   sales invoice   Dr AR (customer)        Cr Sales (net)       Cr VAT output (tax)
 *   credit note     Dr Sales returns (net)  Dr VAT output (tax)  Cr AR (customer)
 *   supplier bill   Dr GRNI (agreed value)  Dr/Cr PPV (difference)  Dr VAT input  Cr AP (supplier)
 *   debit note      Dr AP (supplier)        Cr GRNI (goods returned) or PPV (allowance)  Cr VAT input
 *   receipt         Dr Cash/Bank            Cr AR (customer)
 *   payment         Dr AP (supplier)        Cr Cash/Bank
 *   stock valuation (from the stock ledger's valuation layers, per day):
 *     receipts in ±  Inventory ↔ GRNI;  issues / customer returns ±  Inventory ↔ COGS;
 *     adjustments, counts, scrap, transfers ±  Inventory ↔ Inventory adjustments;
 *     supplier returns ±  Inventory ↔ GRNI
 *
 * The database enforces the rest: entries balance (checked at commit), lines are
 * append-only, nothing posts into a closed period or to a header account. A mistake
 * is corrected by a reversing entry, never by an edit.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const r2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
type Actorish = { id: string | null; name: string; role: string; deviceId?: string };

export type SystemKey =
  | "cash" | "bank" | "ar" | "inventory" | "vat_input" | "employee_advances" | "ap" | "grni" | "vat_output" | "employee_payable"
  | "capital" | "retained_earnings" | "opening_equity" | "sales" | "sales_returns" | "cogs" | "inventory_adjustment" | "ppv" | "general_expenses" | "transport_expenses" | "salaries"
  | "vat_payable" | "fa_disposal_gain" | "fa_depreciation" | "fa_disposal_loss";

export type PostLine = {
  key?: SystemKey;
  accountId?: string;
  /** Signed: positive debits, negative credits. Zero lines are dropped. */
  amount: Prisma.Decimal;
  party?: { type: "customer" | "supplier" | "employee"; id: string };
  description?: string;
};

export type SourceType = "manual" | "sales_invoice" | "credit_note" | "supplier_bill" | "debit_note" | "customer_receipt" | "supplier_payment" | "stock_valuation" | "reversal" | "expense" | "employee_transaction" | "opening_balance" | "receipt_reversal" | "payment_reversal" | "customer_refund" | "supplier_refund" | "payroll_run" | "payroll_payment"
  | "cash_transfer" | "cash_transfer_reversal" | "vat_settlement" | "vat_payment" | "year_end_close" | "year_end_reopen"
  | "asset_acquisition" | "asset_improvement" | "asset_depreciation" | "asset_disposal" | "opening_batch";

async function accountIds(tx: Tx, keys: SystemKey[]) {
  const rows = await tx.account.findMany({ where: { systemKey: { in: keys } }, select: { id: true, systemKey: true } });
  const map = new Map(rows.map((r) => [r.systemKey as SystemKey, r.id]));
  for (const k of keys) if (!map.has(k)) throw new ApiError(500, `حساب النظام "${k}" مش موجود في دليل الحسابات`);
  return map;
}

/** The period a date falls in, created open on first use; a closed one refuses. */
export async function ensureOpenPeriod(tx: Tx, date: string) {
  const code = date.slice(0, 7);
  // A close and a posting for the same month must serialize. The database trigger uses
  // this same key, so raw SQL writers cannot race the application close path either.
  await advisoryXactLock(tx, `accounting-period:${code}`);
  let p = await tx.accountingPeriod.findUnique({ where: { code } });
  if (!p) {
    const [y, m] = code.split("-").map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    p = await tx.accountingPeriod.upsert({ where: { code }, update: {}, create: { code, startDate: `${code}-01`, endDate: end } });
  }
  if (p.status === "closed") throw new ApiError(409, `الفترة المحاسبية ${code} مقفولة — مينفعش تترحّل فيها قيود`);
  return p;
}

/**
 * Posts one balanced entry in the caller's transaction. Returns null when every line
 * is zero (nothing to account for). Throws if the lines do not balance — that is a
 * bug in a posting rule, never a user error.
 */
export async function postJournal(
  tx: Tx,
  e: { date: string; description: string; sourceType: SourceType; sourceId: string; lines: PostLine[]; reversalOfId?: string; requestHash?: string },
  actor: Actorish
) {
  const lines = e.lines.map((l) => ({ ...l, amount: r2(l.amount) })).filter((l) => !l.amount.isZero());
  if (lines.length === 0) return null;
  const debit = lines.filter((l) => l.amount.gt(0)).reduce((a, l) => a.plus(l.amount), D(0));
  const credit = lines.filter((l) => l.amount.lt(0)).reduce((a, l) => a.plus(l.amount.negated()), D(0));
  if (!debit.equals(credit)) throw new Error(`unbalanced posting ${e.sourceType}/${e.sourceId}: ${debit} ≠ ${credit}`);
  await ensureOpenPeriod(tx, e.date);
  const keys = [...new Set(lines.map((l) => l.key).filter((k): k is SystemKey => !!k))];
  // A filed VAT return freezes the VAT of its period (the database refuses it too); say why.
  if (e.sourceType !== "vat_settlement" && (keys.includes("vat_input") || keys.includes("vat_output"))) {
    const filed = await tx.vatReturn.findFirst({ where: { status: { not: "voided" }, periodFrom: { lte: e.date }, periodTo: { gte: e.date } }, select: { number: true, periodFrom: true, periodTo: true } });
    if (filed) throw new ApiError(409, `فترة الضريبة ${filed.periodFrom} – ${filed.periodTo} اتقدّم عنها الإقرار ${filed.number} — سجّل المستند بتاريخ في فترة ضريبية مفتوحة`);
  }
  const ids = keys.length ? await accountIds(tx, keys) : new Map<SystemKey, string>();
  const entry = await tx.journalEntry.create({
    data: {
      number: await nextDocumentNumber(tx, "accounting.journal", e.date),
      date: e.date,
      description: e.description,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      requestHash: e.requestHash ?? null,
      reversalOfId: e.reversalOfId ?? null,
      total: debit,
      createdById: actor.id,
      createdBy: actor.name,
      lines: {
        createMany: {
          data: lines.map((l) => ({
            accountId: l.accountId ?? ids.get(l.key!)!,
            debit: l.amount.gt(0) ? l.amount : 0,
            credit: l.amount.lt(0) ? l.amount.negated() : 0,
            partyType: l.party?.type ?? null,
            partyId: l.party?.id ?? null,
            description: l.description ?? null,
          })),
        },
      },
    },
  });
  await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "journal_posted", entityType: "journal_entry", entityId: entry.id, fieldChanged: entry.number, newValue: `${e.sourceType} · ${debit.toFixed(2)} · ${e.description}`, source: "user", deviceId: actor.deviceId }, tx);
  return entry;
}

/** Already posted? (Documents post once; a re-run of a sync skips them.) */
const posted = (tx: Tx, sourceType: SourceType, sourceId: string) => tx.journalEntry.findFirst({ where: { sourceType, sourceId }, select: { id: true } });

// ---------------------------------------------------------------------------
// Posting rules — one per business document
// ---------------------------------------------------------------------------

export async function postSalesInvoice(tx: Tx, invoiceId: string, actor: Actorish) {
  if (await posted(tx, "sales_invoice", invoiceId)) return null;
  const inv = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (inv.status !== "issued") return null;
  assertEgpCurrency(inv.currencyCode, `فاتورة المبيعات ${inv.number ?? inv.id}`);
  const party = { type: "customer" as const, id: inv.customerId };
  return postJournal(tx, {
    date: inv.issueDate!, description: `فاتورة مبيعات ${inv.number}`, sourceType: "sales_invoice", sourceId: inv.id,
    lines: [{ key: "ar", amount: inv.total, party }, { key: "sales", amount: inv.net.negated() }, { key: "vat_output", amount: inv.taxTotal.negated() }],
  }, actor);
}

export async function postCreditNote(tx: Tx, creditNoteId: string, actor: Actorish) {
  if (await posted(tx, "credit_note", creditNoteId)) return null;
  const cn = await tx.creditNote.findUniqueOrThrow({ where: { id: creditNoteId }, include: { invoice: { select: { number: true } } } });
  assertEgpCurrency(cn.currencyCode, `الإشعار الدائن ${cn.number}`);
  return postJournal(tx, {
    date: cn.issueDate, description: `إشعار دائن ${cn.number} على ${cn.invoice.number}`, sourceType: "credit_note", sourceId: cn.id,
    lines: [{ key: "sales_returns", amount: cn.net }, { key: "vat_output", amount: cn.taxTotal }, { key: "ar", amount: cn.total.negated(), party: { type: "customer", id: cn.customerId } }],
  }, actor);
}

export async function postSupplierBill(tx: Tx, billId: string, actor: Actorish) {
  if (await posted(tx, "supplier_bill", billId)) return null;
  const bill = await tx.supplierBill.findUniqueOrThrow({ where: { id: billId }, include: { lines: true, serviceLines: true } });
  if (bill.status !== "posted") return null;
  assertEgpCurrency(bill.currencyCode, `فاتورة المورد ${bill.number}`);
  if (bill.kind === "service") {
    // No receipt behind it: each line goes straight to its expense (or asset) account.
    if (!bill.serviceLines.length) throw new ApiError(409, `فاتورة الخدمة ${bill.number} مفيهاش سطور`);
    const byAccount = new Map<string, Prisma.Decimal>();
    for (const l of bill.serviceLines) byAccount.set(l.accountId, (byAccount.get(l.accountId) ?? D(0)).plus(l.net));
    return postJournal(tx, {
      date: bill.billDate, description: `فاتورة خدمة ${bill.number} (${bill.supplierInvoiceNo})`, sourceType: "supplier_bill", sourceId: bill.id,
      lines: [
        ...[...byAccount].map(([accountId, amount]) => ({ accountId, amount })),
        { key: "vat_input", amount: bill.taxTotal },
        { key: "ap", amount: bill.total.negated(), party: { type: "supplier", id: bill.supplierId } },
      ],
    }, actor);
  }
  // GRNI carries what the receipts were valued at in stock (the agreed price); anything
  // else the supplier charged is a purchase price variance.
  const agreed = bill.lines.reduce((a, l) => a.plus(l.expectedNet ?? 0), D(0));
  return postJournal(tx, {
    date: bill.billDate, description: `فاتورة مورد ${bill.number} (${bill.supplierInvoiceNo})`, sourceType: "supplier_bill", sourceId: bill.id,
    lines: [
      { key: "grni", amount: agreed },
      { key: "ppv", amount: bill.net.minus(agreed) },
      { key: "vat_input", amount: bill.taxTotal },
      { key: "ap", amount: bill.total.negated(), party: { type: "supplier", id: bill.supplierId } },
    ],
  }, actor);
}

export async function postDebitNote(tx: Tx, debitNoteId: string, actor: Actorish) {
  if (await posted(tx, "debit_note", debitNoteId)) return null;
  const dn = await tx.debitNote.findUniqueOrThrow({ where: { id: debitNoteId }, include: { bill: { select: { number: true } }, serviceLines: { include: { serviceLine: { select: { accountId: true } } } } } });
  assertEgpCurrency(dn.currencyCode, `الإشعار المدين ${dn.number}`);
  if (dn.serviceLines.length) {
    // An allowance on a service bill takes back from the accounts the bill charged.
    const byAccount = new Map<string, Prisma.Decimal>();
    for (const l of dn.serviceLines) byAccount.set(l.serviceLine.accountId, (byAccount.get(l.serviceLine.accountId) ?? D(0)).plus(l.net));
    return postJournal(tx, {
      date: dn.issueDate, description: `إشعار مدين ${dn.number} على ${dn.bill.number}`, sourceType: "debit_note", sourceId: dn.id,
      lines: [
        { key: "ap", amount: dn.total, party: { type: "supplier", id: dn.supplierId } },
        ...[...byAccount].map(([accountId, amount]) => ({ accountId, amount: amount.negated() })),
        { key: "vat_input", amount: dn.taxTotal.negated() },
      ],
    }, actor);
  }
  // Goods returned left stock against GRNI at what they were carried at; anything the
  // supplier credits beyond that (or a pure allowance) is a purchase price variance.
  let grni = D(0);
  if (dn.returnDocumentId) {
    const v = await tx.stockValuationLayer.aggregate({ where: { movement: { documentId: dn.returnDocumentId } }, _sum: { value: true } });
    grni = D(v._sum.value ?? 0).negated();
  }
  return postJournal(tx, {
    date: dn.issueDate, description: `إشعار مدين ${dn.number} على ${dn.bill.number}`, sourceType: "debit_note", sourceId: dn.id,
    lines: [
      { key: "ap", amount: dn.total, party: { type: "supplier", id: dn.supplierId } },
      { key: "grni", amount: grni.negated() },
      { key: "ppv", amount: grni.minus(dn.net) },
      { key: "vat_input", amount: dn.taxTotal.negated() },
    ],
  }, actor);
}

// ---------------------------------------------------------------------------
// Inventory valuation → GL, from the stock ledger
// ---------------------------------------------------------------------------

const VALUATION_COUNTER: Record<string, SystemKey> = {
  intake: "grni", intake_correction: "grni", intake_void: "grni", supplier_return: "grni",
  issue: "cogs", customer_return: "cogs",
  adjustment: "inventory_adjustment", scrap: "inventory_adjustment", transfer_out: "inventory_adjustment", transfer_in: "inventory_adjustment",
};
const KIND_LABEL: Record<string, string> = { grni: "استلامات ومرتجعات موردين", cogs: "صرف ومرتجعات عملاء", inventory_adjustment: "تسويات وهالك وتحويلات", opening_equity: "رصيد مخزون افتتاحي" };

/** A date to post on: the business date, unless its period is already closed — then today. */
async function postingDate(tx: Tx, date: string): Promise<{ date: string; redated: boolean }> {
  const p = await tx.accountingPeriod.findUnique({ where: { code: date.slice(0, 7) }, select: { status: true } });
  if (p?.status === "closed") return { date: todayLocalISO(), redated: true };
  return { date, redated: false };
}

/** Lines Inventory ↔ counter account, one pair per counter, from movements' values. */
async function valuationLines(tx: Tx, moves: { kind: string; documentId: string | null; value: Prisma.Decimal.Value }[]) {
  // Stock brought over at go-live is equity, not an adjustment expense.
  const docIds = [...new Set(moves.map((m) => m.documentId).filter((x): x is string => !!x))];
  const opening = new Set(docIds.length ? (await tx.inventoryDocument.findMany({ where: { id: { in: docIds }, sourceType: "opening_balance" }, select: { id: true } })).map((d) => d.id) : []);
  const groups = new Map<SystemKey, Prisma.Decimal>();
  for (const m of moves) {
    const counter: SystemKey = m.documentId && opening.has(m.documentId) ? "opening_equity" : VALUATION_COUNTER[m.kind] ?? "inventory_adjustment";
    groups.set(counter, (groups.get(counter) ?? D(0)).plus(m.value));
  }
  const lines: PostLine[] = [];
  for (const [counter, value] of groups) {
    const v = r2(value);
    if (v.isZero()) continue;
    lines.push({ key: "inventory", amount: v, description: KIND_LABEL[counter] }, { key: counter, amount: v.negated(), description: KIND_LABEL[counter] });
  }
  return lines;
}

const MOVE_LABEL: Record<string, string> = { intake: "استلام", intake_correction: "تصحيح استلام", intake_void: "إلغاء استلام", adjustment: "تسوية", transfer_out: "تحويل", transfer_in: "تحويل", issue: "صرف لعميل", customer_return: "مرتجع عميل", supplier_return: "مرتجع مورد", sorting_out: "فرز — خارج", sorting_in: "فرز — داخل", release_out: "إفراج محجوز — خارج", release_in: "إفراج محجوز — داخل" };

/** "قيمة مخزون — استلام RC-…" — the kind in words and the document it came from. */
async function valuationDescription(tx: Tx, moves: { kind: string; documentId: string | null; intakeId?: string | null }[]) {
  const kinds = [...new Set(moves.map((m) => MOVE_LABEL[m.kind] ?? m.kind))].join("، ");
  const docIds = [...new Set(moves.map((m) => m.documentId).filter((x): x is string => !!x))];
  const intakeIds = [...new Set(moves.map((m) => m.intakeId).filter((x): x is string => !!x))];
  const refs = [
    ...(docIds.length ? (await tx.inventoryDocument.findMany({ where: { id: { in: docIds } }, select: { number: true } })).map((d) => d.number) : []),
    ...(intakeIds.length ? (await tx.stockIntake.findMany({ where: { id: { in: intakeIds } }, select: { receiptNumber: true } })).map((r) => r.receiptNumber) : []),
  ];
  return `قيمة مخزون — ${kinds}${refs.length ? ` ${refs.slice(0, 3).join("، ")}` : ""}`;
}

/**
 * Called by the stock ledger for every batch of movements, inside the movements' own
 * transaction: their value is posted at once (Inventory ↔ GRNI / COGS / adjustments /
 * opening equity), and each movement is marked as carried — so receiving stock,
 * dispatching it, returning or writing it off moves the GL in the same step.
 */
export async function postMovementValuation(tx: Tx, moves: { movementId: string; kind: string; documentId: string | null; intakeId?: string | null; value: Prisma.Decimal.Value }[], ctx: { id: string | null; name: string; effectiveDate: string }) {
  if (moves.length === 0) return null;
  const lines = await valuationLines(tx, moves);
  const pd = await postingDate(tx, ctx.effectiveDate);
  const entry = lines.length
    ? await postJournal(tx, { date: pd.date, description: await valuationDescription(tx, moves), sourceType: "stock_valuation", sourceId: `mv:${moves[0].movementId}`, lines }, { id: ctx.id, name: ctx.name, role: "SYSTEM" })
    : null;
  await tx.stockValuationPosting.createMany({ data: moves.map((m) => ({ movementId: m.movementId, entryId: entry?.id ?? null })) });
  // A posting pushed into an already-closed period moves to today's date silently —
  // make that shift auditable so a closing can be explained later.
  if (pd.redated && entry) {
    await writeAudit(
      {
        userId: ctx.id,
        userName: ctx.name,
        role: "SYSTEM",
        action: "stock_valuation_redated",
        entityType: "journal_entry",
        entityId: entry.id,
        fieldChanged: "date",
        oldValue: ctx.effectiveDate,
        newValue: pd.date,
        reason: "الفترة المحاسبية مقفولة — اترحّل القيد بتاريخ النهاردة",
        source: "system",
      },
      tx
    );
  }
  return entry;
}

/**
 * Catch-up: posts any stock movement whose value never reached the GL (movements from
 * before the ledger existed), one entry per business day. Idempotent — every movement
 * is posted exactly once. Runs before a period closes and from the sync.
 */
export async function postStockValuation(actor: Actorish) {
  return inTx(async (tx) => {
    await advisoryXactLock(tx, "accounting:stock-valuation");
    const rows = await tx.$queryRaw<{ movementId: string; kind: string; documentId: string | null; intakeId: string | null; effectiveDate: string; value: Prisma.Decimal }[]>`
      SELECT m."id" AS "movementId", m."kind", m."documentId", m."intakeId", m."effectiveDate", v."value"
      FROM "StockMovement" m JOIN "StockValuationLayer" v ON v."movementId" = m."id"
      LEFT JOIN "StockValuationPosting" p ON p."movementId" = m."id"
      WHERE p."movementId" IS NULL
      ORDER BY m."effectiveDate"`;
    const byDay = new Map<string, typeof rows>();
    for (const r of rows) byDay.set(r.effectiveDate, [...(byDay.get(r.effectiveDate) ?? []), r]);
    const entries = [];
    for (const [day, moves] of [...byDay.entries()].sort()) {
      const e = await postMovementValuation(tx, moves, { id: actor.id, name: actor.name, effectiveDate: day });
      if (e) entries.push(e);
    }
    return { layers: rows.length, entries: entries.map((e) => ({ id: e.id, number: e.number, date: e.date, total: e.total.toFixed(2) })) };
  });
}

/** Documents issued/posted before the ledger existed (or by any path that missed it), posted now. */
export async function syncUnposted(actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const counts = { invoices: 0, creditNotes: 0, bills: 0, debitNotes: 0 };
  const missing = <T extends { id: string }>(rows: T[], type: SourceType) =>
    prisma.journalEntry.findMany({ where: { sourceType: type, sourceId: { in: rows.map((r) => r.id) } }, select: { sourceId: true } }).then((p) => {
      const done = new Set(p.map((x) => x.sourceId));
      return rows.filter((r) => !done.has(r.id));
    });
  for (const i of await missing(await prisma.salesInvoice.findMany({ where: { status: "issued" }, select: { id: true }, orderBy: { issuedAt: "asc" } }), "sales_invoice")) {
    if (await inTx((tx) => postSalesInvoice(tx, i.id, actor))) counts.invoices++;
  }
  for (const c of await missing(await prisma.creditNote.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } }), "credit_note")) {
    if (await inTx((tx) => postCreditNote(tx, c.id, actor))) counts.creditNotes++;
  }
  for (const b of await missing(await prisma.supplierBill.findMany({ where: { status: "posted" }, select: { id: true }, orderBy: { postedAt: "asc" } }), "supplier_bill")) {
    if (await inTx((tx) => postSupplierBill(tx, b.id, actor))) counts.bills++;
  }
  for (const d of await missing(await prisma.debitNote.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } }), "debit_note")) {
    if (await inTx((tx) => postDebitNote(tx, d.id, actor))) counts.debitNotes++;
  }
  const stock = await postStockValuation(actor);
  return { ...counts, stockEntries: stock.entries.length };
}

// ---------------------------------------------------------------------------
// Manual journals and reversals
// ---------------------------------------------------------------------------

const money = z.union([z.number(), z.string()]).optional().transform((v, ctx) => {
  if (v === undefined || v === "" || v === 0) return D(0);
  const s = typeof v === "number" ? String(v) : v.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "المبلغ لازم يكون رقم موجب بحد أقصى خانتين عشريتين" });
    return z.NEVER;
  }
  return D(s);
});
const manualInput = z.object({
  date: z.string().refine(isValidISODate, "التاريخ لازم يكون YYYY-MM-DD"),
  description: text("البيان", 500),
  lines: z.array(z.object({ account_id: text("الحساب"), debit: money, credit: money, party_type: z.enum(["customer", "supplier"]).optional(), party_id: z.string().optional(), description: z.string().max(500).optional() })).min(2, "القيد محتاج سطرين على الأقل").max(100),
  idempotency_key: idempotencyKeyField,
});

export { controlAccountMovedBy } from "@/lib/accounting/control-accounts";
import { controlAccountMovedBy } from "@/lib/accounting/control-accounts";

export async function createManualJournal(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(manualInput, input);
  for (const l of v.lines) {
    if (l.debit.gt(0) === l.credit.gt(0)) throw new ApiError(400, "كل سطر يا مدين يا دائن (مش الاتنين ولا صفر)");
    if (!!l.party_type !== !!l.party_id) throw new ApiError(400, "حدد نوع الطرف ورقمه مع بعض");
  }
  return inTx(async (tx) => {
    // A keyed manual journal is identified by its key (its source id), so a retried
    // submit finds the entry the first attempt posted instead of posting it again.
    await lockKey(tx, v.idempotency_key);
    const sourceId = v.idempotency_key ? `manual-${v.idempotency_key}` : `manual-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const requestHash = requestFingerprint({
      date: v.date,
      description: v.description,
      lines: v.lines.map((l) => ({ accountId: l.account_id, debit: l.debit.toString(), credit: l.credit.toString(), partyType: l.party_type ?? null, partyId: l.party_id ?? null, description: l.description ?? null })),
    });
    if (v.idempotency_key) {
      const prev = await tx.journalEntry.findFirst({ where: { sourceType: "manual", sourceId }, include: { lines: true } });
      const total = v.lines.reduce((a, l) => a.plus(l.debit), D(0));
      const legacySame = prev ? prev.date === v.date && prev.description === v.description && D(prev.total).equals(total) &&
        prev.lines.length === v.lines.length && prev.lines.every((line) => v.lines.some((wanted) => line.accountId === wanted.account_id && D(line.debit).equals(wanted.debit) && D(line.credit).equals(wanted.credit) && line.partyType === (wanted.party_type ?? null) && line.partyId === (wanted.party_id ?? null) && line.description === (wanted.description ?? null))) : false;
      if (prev) return replayRequest(prev, requestHash, legacySame);
    }
    const accounts = await tx.account.findMany({ where: { id: { in: v.lines.map((l) => l.account_id) } } });
    for (const l of v.lines) {
      const a = accounts.find((x) => x.id === l.account_id);
      if (!a) throw new ApiError(404, "حساب مش موجود");
      if (!a.postable || !a.active) throw new ApiError(400, `الحساب ${a.code} حساب رئيسي أو موقوف — مينفعش الترحيل عليه`);
      const via = controlAccountMovedBy(a.systemKey, a.controlledBy);
      if (via) throw new ApiError(400, `الحساب ${a.code} (${a.nameAr}) حساب مراقبة — بيتحرك بس من ${via}، عشان كشف الحساب والأستاذ يفضلوا متطابقين`);
    }
    const lines: PostLine[] = v.lines.map((l) => ({ accountId: l.account_id, amount: l.debit.gt(0) ? l.debit : l.credit.negated(), party: l.party_type ? { type: l.party_type, id: l.party_id! } : undefined, description: l.description }));
    const dr = lines.filter((l) => l.amount.gt(0)).reduce((a, l) => a.plus(l.amount), D(0));
    const cr = lines.filter((l) => l.amount.lt(0)).reduce((a, l) => a.minus(l.amount), D(0));
    if (!dr.equals(cr)) throw new ApiError(400, `القيد مش متوازن: مدين ${dr.toFixed(2)} ودائن ${cr.toFixed(2)}`);
    const entry = await postJournal(tx, { date: v.date, description: v.description, sourceType: "manual", sourceId, requestHash: v.idempotency_key ? requestHash : undefined, lines }, actor);
    return entry!;
  });
}

type ManualInput = z.infer<typeof manualInput>;

/** Every line names an active postable account that is not a control account. */
async function checkManualAccounts(tx: Tx, lines: { account_id: string }[]) {
  const accounts = await tx.account.findMany({ where: { id: { in: lines.map((l) => l.account_id) } } });
  for (const l of lines) {
    const a = accounts.find((x) => x.id === l.account_id);
    if (!a) throw new ApiError(404, "حساب مش موجود");
    if (!a.postable || !a.active) throw new ApiError(400, `الحساب ${a.code} حساب رئيسي أو موقوف — مينفعش الترحيل عليه`);
    const via = controlAccountMovedBy(a.systemKey, a.controlledBy);
    if (via) throw new ApiError(400, `الحساب ${a.code} (${a.nameAr}) حساب مراقبة — بيتحرك بس من ${via}، عشان كشف الحساب والأستاذ يفضلوا متطابقين`);
  }
}

function manualPostLines(v: Pick<ManualInput, "lines">): PostLine[] {
  const lines: PostLine[] = v.lines.map((l) => ({ accountId: l.account_id, amount: l.debit.gt(0) ? l.debit : l.credit.negated(), party: l.party_type ? { type: l.party_type, id: l.party_id! } : undefined, description: l.description }));
  const dr = lines.filter((l) => l.amount.gt(0)).reduce((a, l) => a.plus(l.amount), D(0));
  const cr = lines.filter((l) => l.amount.lt(0)).reduce((a, l) => a.minus(l.amount), D(0));
  if (!dr.equals(cr)) throw new ApiError(400, `القيد مش متوازن: مدين ${dr.toFixed(2)} ودائن ${cr.toFixed(2)}`);
  return lines;
}

const REQUEST_LINES = z.array(z.object({ account_id: z.string(), debit: z.string(), credit: z.string(), party_type: z.enum(["customer", "supplier"]).nullable().optional(), party_id: z.string().nullable().optional(), description: z.string().nullable().optional() }));

/**
 * A manual journal from the screen: posted at once, or — when approval is switched on and
 * the total is above the threshold — held as a request until someone other than the
 * requester with accounting.journals.approve approves it (it posts then, after the same
 * checks again). The answer says which: { journal } or { request }.
 */
export async function submitManualJournal(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(manualInput, input);
  const total = v.lines.reduce((a, l) => a.plus(l.debit), D(0));
  const [on, threshold] = await Promise.all([getSetting("accounting.manual_journal_approval"), getSetting("accounting.manual_journal_approval_threshold")]);
  if (!on || !total.greaterThan(D(threshold))) return { journal: await createManualJournal(input, actor), request: null };
  for (const l of v.lines) {
    if (l.debit.gt(0) === l.credit.gt(0)) throw new ApiError(400, "كل سطر يا مدين يا دائن (مش الاتنين ولا صفر)");
    if (!!l.party_type !== !!l.party_id) throw new ApiError(400, "حدد نوع الطرف ورقمه مع بعض");
  }
  const lines = v.lines.map((l) => ({ account_id: l.account_id, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2), party_type: l.party_type ?? null, party_id: l.party_id ?? null, description: l.description ?? null }));
  const requestHash = requestFingerprint({ date: v.date, description: v.description, lines });
  const request = await inTx(async (tx) => {
    await lockKey(tx, v.idempotency_key);
    if (v.idempotency_key) {
      const prev = await tx.journalRequest.findUnique({ where: { idempotencyKey: v.idempotency_key } });
      if (prev) return replayRequest(prev, requestHash, false);
    }
    manualPostLines(v);
    await checkManualAccounts(tx, v.lines);
    const period = await tx.accountingPeriod.findUnique({ where: { code: v.date.slice(0, 7) }, select: { status: true } });
    if (period?.status === "closed") throw new ApiError(409, `الفترة المحاسبية ${v.date.slice(0, 7)} مقفولة — مينفعش تترحّل فيها قيود`);
    const r = await tx.journalRequest.create({
      data: { number: await nextDocumentNumber(tx, "accounting.journal_request", v.date), date: v.date, description: v.description, lines, total, status: "pending_approval", idempotencyKey: v.idempotency_key ?? null, requestHash: v.idempotency_key ? requestHash : null, requestedById: actor.id, requestedBy: actor.name },
    });
    await requestApproval(tx, { type: "accounting.manual_journal", entityId: r.id, title: `قيد يدوي ${r.number}: ${v.description}`, amount: total, requester: actor });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "journal_request_submitted", entityType: "journal_request", entityId: r.id, fieldChanged: r.number, newValue: `${total.toFixed(2)} · ${v.description}`, source: "user", deviceId: actor.deviceId }, tx);
    return r;
  });
  return { journal: null, request };
}

/** Approval handler: approved → posted by the approver's decision (never the requester's); rejected → nothing posts. */
export async function applyJournalRequestDecision(tx: Tx, id: string, approved: boolean, decider: { id: string | null; name: string; role: string; deviceId?: string }, comment?: string) {
  const r = await tx.journalRequest.findUniqueOrThrow({ where: { id } });
  if (r.status !== "pending_approval") throw new ApiError(409, "الطلب ده اتقرر قبل كده");
  if (r.requestedById && r.requestedById === decider.id) throw new ApiError(403, "اللي طلب القيد مينفعش يعتمده بنفسه");
  if (!approved) {
    await tx.journalRequest.update({ where: { id, version: r.version }, data: { status: "rejected", decidedBy: decider.name, decidedAt: new Date(), decisionNote: comment ?? null, version: { increment: 1 } } });
    await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "journal_request_rejected", entityType: "journal_request", entityId: id, fieldChanged: r.number, reason: comment, source: "user", deviceId: decider.deviceId }, tx);
    return null;
  }
  const lines = REQUEST_LINES.parse(r.lines).map((l) => ({ account_id: l.account_id, debit: D(l.debit), credit: D(l.credit), party_type: l.party_type ?? undefined, party_id: l.party_id ?? undefined, description: l.description ?? undefined }));
  await checkManualAccounts(tx, lines);
  const entry = await postJournal(tx, { date: r.date, description: r.description, sourceType: "manual", sourceId: `manual-req-${r.id}`, lines: manualPostLines({ lines }) }, { id: r.requestedById, name: r.requestedBy, role: "ACCOUNTANT", deviceId: decider.deviceId });
  await tx.journalRequest.update({ where: { id, version: r.version }, data: { status: "posted", entryId: entry!.id, decidedBy: decider.name, decidedAt: new Date(), decisionNote: comment ?? null, version: { increment: 1 } } });
  await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "journal_request_approved", entityType: "journal_request", entityId: id, fieldChanged: r.number, newValue: entry!.number, source: "user", deviceId: decider.deviceId }, tx);
  return entry;
}

/** The requester (or any accounting manager) withdraws a request still waiting. */
export async function cancelJournalRequest(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ reason: text("السبب", 500) }), input);
  return inTx(async (tx) => {
    const r = await tx.journalRequest.findUnique({ where: { id } });
    if (!r) throw new ApiError(404, "الطلب مش موجود");
    if (r.status !== "pending_approval") throw new ApiError(409, "الطلب ده اتقرر قبل كده");
    await cancelPendingApproval(tx, { type: "accounting.manual_journal", entityId: id, reason: v.reason, actor });
    const updated = await tx.journalRequest.update({ where: { id, version: r.version }, data: { status: "cancelled", decidedBy: actor.name, decidedAt: new Date(), decisionNote: v.reason, version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "journal_request_cancelled", entityType: "journal_request", entityId: id, fieldChanged: r.number, reason: v.reason, source: "user", deviceId: actor.deviceId }, tx);
    return updated;
  });
}

export async function listJournalRequests(filters: { status?: string }) {
  const rows = await prisma.journalRequest.findMany({ where: filters.status ? { status: filters.status } : {}, orderBy: { createdAt: "desc" }, take: 100, include: { entry: { select: { id: true, number: true } } } });
  return rows.map((r) => ({ ...r, total: r.total.toFixed(2) }));
}

export async function reverseJournal(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ reason: text("سبب العكس", 500), date: z.string().refine(isValidISODate).optional() }), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `accounting:reverse:${id}`);
    const e = await tx.journalEntry.findUnique({ where: { id }, include: { lines: true, reversedBy: true } });
    if (!e) throw new ApiError(404, "القيد مش موجود");
    if (e.reversedBy) throw new ApiError(409, `القيد اتعكس بالفعل (${e.reversedBy.number})`);
    if (e.sourceType === "reversal") throw new ApiError(409, "ده قيد عكسي — اعمل قيد جديد بدل ما تعكسه");
    if (e.sourceType !== "manual") throw new ApiError(409, "قيود المستندات بتتصحح بمستند (إشعار دائن/مدين)، مش بعكس القيد");
    return (await postJournal(tx, {
      date: v.date ?? todayLocalISO(), description: `عكس ${e.number}: ${v.reason}`, sourceType: "reversal", sourceId: e.id, reversalOfId: e.id,
      lines: e.lines.map((l) => ({ accountId: l.accountId, amount: l.credit.minus(l.debit), party: l.partyType ? { type: l.partyType as "customer" | "supplier" | "employee", id: l.partyId! } : undefined, description: l.description ?? undefined })),
    }, actor))!;
  });
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export async function listPeriods() {
  return prisma.accountingPeriod.findMany({ orderBy: { code: "desc" }, take: 36 });
}

/** Closing posts the stock valuation up to now first, so the period is complete, then locks it. */
export async function closePeriod(code: string, actor: ServiceActor) {
  assertPermission(actor, "accounting.periods.close");
  if (!/^\d{4}-\d{2}$/.test(code)) throw new ApiError(400, "الفترة لازم تكون YYYY-MM");
  await postStockValuation(actor);
  return inTx(async (tx) => {
    const p = await ensureOpenPeriod(tx, `${code}-01`);
    const later = await tx.accountingPeriod.findFirst({ where: { code: { lt: code }, status: "open" }, select: { code: true } });
    if (later) throw new ApiError(409, `اقفل الفترة ${later.code} الأول`);
    const updated = await tx.accountingPeriod.update({ where: { id: p.id, version: p.version }, data: { status: "closed", closedBy: actor.name, closedAt: new Date(), version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "period_closed", entityType: "accounting_period", entityId: p.id, fieldChanged: code, oldValue: "open", newValue: "closed", source: "user", deviceId: actor.deviceId }, tx);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Reads: chart, trial balance, account ledger, party balances
// ---------------------------------------------------------------------------

/**
 * P&L — revenue and expense lines over a period, with totals and net income.
 */
export async function profitLoss(from: string, to: string) {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "الفترة غير صالحة");
  const rows = await prisma.$queryRaw<{ type: string; code: string; nameAr: string; amount: Prisma.Decimal }[]>`
    SELECT a."type", a."code", a."nameAr",
      sum(CASE WHEN a."type" IN ('revenue') THEN l."credit" - l."debit" ELSE l."debit" - l."credit" END) AS amount
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE a."type" IN ('revenue', 'expense') AND e."date" BETWEEN ${from} AND ${to} AND e."sourceType" NOT IN ('year_end_close', 'year_end_reopen')
    GROUP BY a."type", a."code", a."nameAr" ORDER BY a."type", a."code"`;
  const plLines = rows.map((r) => ({ type: r.type, code: r.code, name: r.nameAr, amount: D(r.amount).toFixed(2) }));
  const rev = plLines.filter((l) => l.type === "revenue").reduce((s, l) => s.plus(D(l.amount)), D(0));
  const exp = plLines.filter((l) => l.type === "expense").reduce((s, l) => s.plus(D(l.amount)), D(0));
  return { from, to, lines: plLines, revenue: rev.toFixed(2), expenses: exp.toFixed(2), netIncome: rev.minus(exp).toFixed(2) };
}

/**
 * Balance Sheet as at a date — assets, liabilities, equity, closing.
 * Shows absolute values so each section is readable on its own.
 */
export async function balanceSheet(asOf: string, openingFrom?: string) {
  if (!isValidISODate(asOf)) throw new ApiError(400, "التاريخ غير صالح");
  const from = openingFrom ?? `${asOf.slice(0, 4)}-01-01`;
  if (!isValidISODate(from) || from > asOf) throw new ApiError(400, "الفترة غير صالحة");

  // Per-account closing position over [from, asOf] — signed (debit − credit).
  const rows = await prisma.$queryRaw<{ accountId: string; closing: Prisma.Decimal }[]>`
    SELECT l."accountId",
      coalesce(sum(CASE WHEN e."date" < ${from} THEN l."debit" - l."credit" END), 0) +
      coalesce(sum(CASE WHEN e."date" >= ${from} AND e."date" <= ${asOf} THEN l."debit" - l."credit" END), 0) AS closing
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE e."date" <= ${asOf}
    GROUP BY l."accountId"`;
  const accounts = new Map((await prisma.account.findMany()).map((a) => [a.id, a]));
  type StatementLine = { code: string; name: string; nameAr: string; nameEn?: string; type: string; amount: string };
  const groups: Record<string, StatementLine[]> = { asset: [], liability: [], equity: [], revenue: [], expense: [] };
  const signedSums = { asset: D(0), liability: D(0), equity: D(0), revenue: D(0), expense: D(0) };

  for (const r of rows) {
    const a = accounts.get(r.accountId);
    if (!a) continue;
    const signed = D(r.closing);
    const line: StatementLine = { code: a.code, name: a.nameAr, nameAr: a.nameAr, nameEn: a.name, type: a.type, amount: signed.abs().toFixed(2) };
    if (groups[a.type]) {
      groups[a.type].push(line);
      signedSums[a.type as "asset" | "liability" | "equity" | "revenue" | "expense"] = signedSums[a.type as "asset" | "liability" | "equity" | "revenue" | "expense"].plus(signed);
    }
  }
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.code.localeCompare(b.code));
  }

  // Balance sheet totals from signed sums (not from group amounts, which are abs).
  //   Assets = what the company holds = signedAsset (positive = actual asset)
  //   Liabilities = what the company owes = -signedLiability
  //   Net income = -signedRevenue - signedExpense (P&L → retained earnings)
  const totalAssets = signedSums.asset.abs();
  const totalLiabilities = signedSums.liability.negated().abs();
  const netIncome = signedSums.revenue.negated().minus(signedSums.expense);
  const openingEquity = signedSums.equity.negated();
  const totalEquity = openingEquity.plus(netIncome);

  // Build the equity section: existing equity lines + net income
  const allEquity = [...groups.equity];
  if (!netIncome.isZero()) {
    allEquity.push({
      code: "3200", name: "صافي الدخل (الأرباح المحتجزة)", nameAr: "صافي الدخل",
      type: "equity", amount: netIncome.abs().toFixed(2),
    });
  }

  return {
    asOf,
    openingFrom: from,
    sections: {
      assets: { lines: groups.asset, total: totalAssets.toFixed(2) },
      liabilities: { lines: groups.liability, total: totalLiabilities.toFixed(2) },
      equity: { lines: allEquity, total: totalEquity.toFixed(2) },
    },
    totalAssets: totalAssets.toFixed(2),
    totalLiabilitiesAndEquity: totalLiabilities.plus(totalEquity).toFixed(2),
    _balanced: totalAssets.equals(totalLiabilities.plus(totalEquity)),
  };
}

export async function chartOfAccounts() {
  return prisma.account.findMany({ orderBy: { code: "asc" } });
}

export async function trialBalance(from: string, to: string) {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "الفترة غير صالحة");
  const rows = await prisma.$queryRaw<{ accountId: string; opening: Prisma.Decimal; debit: Prisma.Decimal; credit: Prisma.Decimal }[]>`
    SELECT l."accountId",
      coalesce(sum(CASE WHEN e."date" < ${from} THEN l."debit" - l."credit" END), 0) AS opening,
      coalesce(sum(CASE WHEN e."date" >= ${from} THEN l."debit" END), 0) AS debit,
      coalesce(sum(CASE WHEN e."date" >= ${from} THEN l."credit" END), 0) AS credit
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE e."date" <= ${to}
    GROUP BY l."accountId"`;
  const accounts = new Map((await prisma.account.findMany()).map((a) => [a.id, a]));
  const lines = rows
    .map((r) => {
      const a = accounts.get(r.accountId)!;
      const closing = D(r.opening).plus(r.debit).minus(r.credit);
      // `name` stays the Arabic name (existing contract); nameAr/nameEn let screens pick by locale.
      return { account: { id: a.id, code: a.code, name: a.nameAr, nameAr: a.nameAr, nameEn: a.name, type: a.type }, opening: D(r.opening).toFixed(2), debit: D(r.debit).toFixed(2), credit: D(r.credit).toFixed(2), closing: closing.toFixed(2) };
    })
    .sort((a, b) => a.account.code.localeCompare(b.account.code));
  const sum = (k: "debit" | "credit") => lines.reduce((s, l) => s.plus(l[k]), D(0)).toFixed(2);
  const closingSum = lines.reduce((s, l) => s.plus(l.closing), D(0));
  return { from, to, lines, totals: { debit: sum("debit"), credit: sum("credit") }, balanced: closingSum.isZero() };
}

export async function accountLedger(accountId: string, from: string, to: string, opts?: { limit?: number; offset?: number }) {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "الفترة غير صالحة");
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new ApiError(404, "الحساب مش موجود");
  const take = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  const skip = Math.max(opts?.offset ?? 0, 0);
  const before = await prisma.journalLine.aggregate({ where: { accountId, entry: { date: { lt: from } } }, _sum: { debit: true, credit: true } });
  const [total, lines] = await Promise.all([
    prisma.journalLine.count({ where: { accountId, entry: { date: { gte: from, lte: to } } } }),
    prisma.journalLine.findMany({ where: { accountId, entry: { date: { gte: from, lte: to } } }, include: { entry: { select: { number: true, date: true, description: true, sourceType: true, createdAt: true } } }, orderBy: [{ entry: { date: "asc" } }, { entry: { createdAt: "asc" } }], skip, take }),
  ]);
  let bal = D(before._sum.debit ?? 0).minus(before._sum.credit ?? 0);
  const opening = bal.toFixed(2);
  return {
    account: { id: account.id, code: account.code, name: account.nameAr, nameAr: account.nameAr, nameEn: account.name, type: account.type },
    opening,
    rows: lines.map((l) => {
      bal = bal.plus(l.debit).minus(l.credit);
      return { id: l.id, date: l.entry.date, number: l.entry.number, description: l.description ?? l.entry.description, sourceType: l.entry.sourceType, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2), balance: bal.toFixed(2), reconciled: !!l.reconciliationId };
    }),
    closing: bal.toFixed(2),
    pagination: { total, limit: take, offset: skip },
  };
}

/** The GL balance of a party on AR or AP (the subledger total). */
export async function partyGlBalance(partyType: "customer" | "supplier", partyId: string) {
  const a = await prisma.journalLine.aggregate({ where: { partyType, partyId }, _sum: { debit: true, credit: true } });
  return D(a._sum.debit ?? 0).minus(a._sum.credit ?? 0);
}

export async function getJournal(id: string) {
  const e = await prisma.journalEntry.findUnique({ where: { id }, include: { lines: { include: { account: { select: { code: true, name: true, nameAr: true } } } }, reversedBy: { select: { id: true, number: true } } } });
  if (!e) throw new ApiError(404, "القيد مش موجود");
  return { ...e, total: e.total.toFixed(2), lines: e.lines.map((l) => ({ ...l, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2) })) };
}

const MAX_LIST_PAGE = 200;

export async function listJournals(filters: { from?: string; to?: string; sourceType?: string; limit?: number; offset?: number }) {
  const take = Math.min(Math.max(filters.limit ?? 50, 1), MAX_LIST_PAGE);
  const skip = Math.max(filters.offset ?? 0, 0);
  const where = { ...(filters.sourceType ? { sourceType: filters.sourceType } : {}), date: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } };
  const [total, rows] = await Promise.all([
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], skip, take }),
  ]);
  return {
    journals: rows.map((e) => ({ id: e.id, number: e.number, date: e.date, description: e.description, sourceType: e.sourceType, total: e.total.toFixed(2), createdBy: e.createdBy })),
    pagination: { total, limit: take, offset: skip },
  };
}

export const CASH_FLOW_CATEGORIES = ["operating", "investing", "financing"] as const;
export type CashFlowCategory = (typeof CASH_FLOW_CATEGORIES)[number];
const cashFlowField = z.enum(CASH_FLOW_CATEGORIES, { errorMap: () => ({ message: "تصنيف التدفق النقدي: تشغيلي أو استثماري أو تمويلي" }) });

/**
 * The cash-flow section of a new balance-sheet account: what the accountant chose, else
 * what its header carries (a header under "Fixed assets" is investing), else operating for
 * assets and liabilities (working capital is by far the commonest new account) and
 * financing for equity. P&L accounts carry none — they reach the statement as net income.
 */
export function defaultCashFlowCategory(type: string, chosen?: CashFlowCategory | null, parentCategory?: string | null): CashFlowCategory | null {
  if (type === "revenue" || type === "expense") return null;
  if (chosen) return chosen;
  if (parentCategory && (CASH_FLOW_CATEGORIES as readonly string[]).includes(parentCategory)) return parentCategory as CashFlowCategory;
  return type === "equity" ? "financing" : "operating";
}

/** A new postable sub-account under a header (e.g. a second bank, an expense line). */
export async function createAccount(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ code: z.string().regex(/^[0-9]{3,8}$/, "الكود أرقام بس (3–8)"), name: text("الاسم", 100), name_ar: text("الاسم بالعربي", 100), parent_id: text("الحساب الرئيسي"), cash_flow_category: cashFlowField.optional() }), input);
  return inTx(async (tx) => {
    const parent = await tx.account.findUnique({ where: { id: v.parent_id } });
    if (!parent) throw new ApiError(404, "الحساب الرئيسي مش موجود");
    if (parent.postable) throw new ApiError(400, "الحساب الرئيسي لازم يكون حساب تجميعي");
    if (parent.id === "acc_1700") throw new ApiError(400, "حسابات الأصول الثابتة بتتعمل من فئات الأصول (شاشة الأصول الثابتة)، مش يدوي");
    if ((parent.type === "revenue" || parent.type === "expense") && v.cash_flow_category) throw new ApiError(400, "حسابات الإيرادات والمصروفات مالهاش تصنيف تدفق نقدي — بتدخل في صافي الدخل");
    let a;
    try {
      a = await tx.account.create({ data: { code: v.code, name: v.name, nameAr: v.name_ar, type: parent.type, parentId: parent.id, cashFlowCategory: defaultCashFlowCategory(parent.type, v.cash_flow_category, parent.cashFlowCategory) } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ApiError(409, "الكود مستخدم");
      throw err;
    }
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "account_created", entityType: "account", entityId: a.id, fieldChanged: a.code, newValue: `${a.code} · ${a.nameAr}`, source: "user", deviceId: actor.deviceId }, tx);
    return a;
  });
}

/**
 * Rename an account, classify it for the cash-flow statement, or retire it. Retiring needs
 * a zero balance and is refused for system accounts, cash/bank accounts (retired from
 * their own screen) and subledger-owned accounts; the type and parent never change.
 */
export async function updateAccount(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ name: text("الاسم", 100).optional(), name_ar: text("الاسم بالعربي", 100).optional(), cash_flow_category: cashFlowField.nullable().optional(), active: z.boolean().optional(), version: z.number().int().optional() }), input);
  return inTx(async (tx) => {
    const a = await tx.account.findUnique({ where: { id } });
    if (!a) throw new ApiError(404, "الحساب مش موجود");
    if (v.version !== undefined && v.version !== a.version) throw new ApiError(409, "الحساب اتعدّل من واحد تاني — حدّث الشاشة");
    if (v.cash_flow_category !== undefined) {
      if (a.type === "revenue" || a.type === "expense") throw new ApiError(400, "حسابات الإيرادات والمصروفات مالهاش تصنيف تدفق نقدي — بتدخل في صافي الدخل");
      if (await tx.cashAccount.findFirst({ where: { accountId: a.id } })) throw new ApiError(400, "حساب خزينة أو بنك — هو نفسه النقدية اللي القائمة بتقيس تغيّرها");
      if (a.systemKey && v.cash_flow_category === null) throw new ApiError(400, "حسابات النظام لازم يكون لها تصنيف");
    }
    if (v.active === false && a.active) {
      if (a.systemKey || a.controlledBy) throw new ApiError(400, "حساب نظام أو حساب سجل فرعي — مينفعش يتوقف");
      if (await tx.cashAccount.findFirst({ where: { accountId: a.id } })) throw new ApiError(400, "حساب خزينة أو بنك — اوقفه من شاشة الخزائن والبنوك");
      if (!a.postable && (await tx.account.count({ where: { parentId: a.id, active: true } }))) throw new ApiError(409, "الحساب الرئيسي ده تحته حسابات شغالة");
      const bal = await tx.journalLine.aggregate({ where: { accountId: a.id }, _sum: { debit: true, credit: true } });
      if (!D(bal._sum.debit ?? 0).equals(D(bal._sum.credit ?? 0))) throw new ApiError(409, "رصيد الحساب مش صفر — حوّل رصيده الأول");
    }
    const data: Prisma.AccountUpdateInput = { version: { increment: 1 } };
    if (v.name !== undefined) data.name = v.name;
    if (v.name_ar !== undefined) data.nameAr = v.name_ar;
    if (v.cash_flow_category !== undefined) data.cashFlowCategory = v.cash_flow_category;
    if (v.active !== undefined) data.active = v.active;
    const updated = await tx.account.update({ where: { id, version: a.version }, data });
    const changes = [
      v.name !== undefined && v.name !== a.name ? `name: ${a.name} → ${v.name}` : null,
      v.name_ar !== undefined && v.name_ar !== a.nameAr ? `nameAr: ${a.nameAr} → ${v.name_ar}` : null,
      v.cash_flow_category !== undefined && v.cash_flow_category !== a.cashFlowCategory ? `cashFlow: ${a.cashFlowCategory ?? "—"} → ${v.cash_flow_category ?? "—"}` : null,
      v.active !== undefined && v.active !== a.active ? `active: ${a.active} → ${v.active}` : null,
    ].filter(Boolean).join(" · ");
    if (changes) await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "account_updated", entityType: "account", entityId: a.id, fieldChanged: a.code, newValue: changes, source: "user", deviceId: actor.deviceId }, tx);
    return updated;
  });
}
