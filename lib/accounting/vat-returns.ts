import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
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
import { optText, parse, text } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";
import { ensureOpenPeriod, postJournal } from "@/lib/accounting/ledger";
import { vatSummary } from "@/lib/accounting/vat-summary";

/**
 * VAT returns.
 *
 * Filing a return for a period sets off the input VAT against the output VAT at the
 * period's last day, from the ledger's own balances (so a credit carried forward from the
 * previous return is used automatically):
 *
 *   settlement   Dr VAT output (its whole balance)   Cr VAT input (up to the output)   Cr VAT payable (the rest)
 *   payment      Dr VAT payable                      Cr cash / bank
 *   void         the settlement reversed (an unpaid return, to correct and file again)
 *
 * Excess input VAT stays in the VAT input account as the credit carried forward. A return
 * is filed only when the VAT summary of the period reconciles (documents = ledger), and
 * while it is live nothing else may post VAT into its period (checked here and by the
 * database), so the figures the authority received stay the figures in the books.
 * Returns follow each other: the next one starts the day after the previous one ends.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const dateField = (label: string) => z.string().refine(isValidISODate, `${label} لازم يكون YYYY-MM-DD`);
const audit = (tx: Tx, actor: { id: string | null; name: string; role: string; deviceId?: string }, id: string, action: string, detail: string, reason?: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType: "vat_return", entityId: id, newValue: detail, reason, source: "user", deviceId: actor.deviceId }, tx);

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** VAT input / output balances up to a date (debit-positive input, credit-positive output), settlements included. */
async function vatBalances(db: Tx | typeof prisma, asOf: string) {
  const rows = await db.$queryRaw<{ systemKey: string; bal: Prisma.Decimal | null }[]>`
    SELECT a."systemKey", sum(l."debit" - l."credit") AS bal
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE a."systemKey" IN ('vat_input', 'vat_output') AND e."date" <= ${asOf}
    GROUP BY a."systemKey"`;
  const by = new Map(rows.map((r) => [r.systemKey, D(r.bal)]));
  return { input: by.get("vat_input") ?? D(0), output: (by.get("vat_output") ?? D(0)).negated() };
}

/** What filing a return for [from, to] would post — the screen's preview and the filing's own figures. */
export async function previewVatReturn(from: string, to: string, db: Tx | typeof prisma = prisma) {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "فترة الإقرار غير صالحة");
  const [summary, bal, last] = await Promise.all([
    vatSummary(from, to, db),
    vatBalances(db, to),
    db.vatReturn.findFirst({ where: { status: { not: "voided" } }, orderBy: { periodTo: "desc" }, select: { number: true, periodTo: true } }),
  ]);
  const output = Prisma.Decimal.max(bal.output, 0);
  const input = Prisma.Decimal.max(bal.input, 0);
  const inputUsed = Prisma.Decimal.min(input, output);
  const problems: string[] = [];
  if (!summary.ledger.reconciled) problems.push("summary_not_reconciled");
  if (bal.output.lt(0)) problems.push("output_debit_balance");
  if (bal.input.lt(0)) problems.push("input_credit_balance");
  if (last && from !== nextDay(last.periodTo)) problems.push("not_contiguous");
  // The period must be over (as for a fiscal year): a return filed on its own last day would
  // freeze VAT postings for the rest of that day.
  if (to >= todayLocalISO()) problems.push("period_not_ended");
  return {
    from, to,
    expectedFrom: last ? nextDay(last.periodTo) : null,
    outputTax: output.toFixed(2), inputTax: input.toFixed(2), inputUsed: inputUsed.toFixed(2),
    payable: output.minus(inputUsed).toFixed(2), carryForward: input.minus(inputUsed).toFixed(2),
    documents: { outputTax: summary.totals.outputTax, inputTax: summary.totals.inputTax, netPayable: summary.totals.netPayable },
    reconciled: summary.ledger.reconciled,
    problems,
  };
}

export async function fileVatReturn(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ period_from: dateField("بداية الفترة"), period_to: dateField("نهاية الفترة"), reference: optText("رقم الإقرار عند المصلحة", 100).optional(), notes: optText("ملاحظات", 1000).optional() }), input);
  return inTx(async (tx) => {
    // The settlement is dated on the period's last day while that month is open, else on the
    // filing day (a month is normally closed before its return is filed). Lock order is the
    // same as every VAT posting — the month first, then the VAT lock — so the two never wait
    // on each other in a circle; and since every VAT posting takes the VAT lock, the balances
    // read below (in this transaction, after the lock) are final for the period.
    const lastMonth = await tx.accountingPeriod.findUnique({ where: { code: v.period_to.slice(0, 7) }, select: { status: true } });
    const entryDate = lastMonth?.status === "closed" ? todayLocalISO() : v.period_to;
    await ensureOpenPeriod(tx, entryDate);
    await advisoryXactLock(tx, "accounting:vat-return");
    const p = await previewVatReturn(v.period_from, v.period_to, tx);
    if (p.problems.includes("period_not_ended")) throw new ApiError(400, "نهاية الفترة لسه مجتش — الإقرار بيتقدّم بعد ما الفترة تخلص");
    if (p.problems.includes("not_contiguous")) throw new ApiError(409, `الإقرار اللي بعده لازم يبدأ ${p.expectedFrom}`);
    if (p.problems.includes("summary_not_reconciled")) throw new ApiError(409, "ملخص الضريبة للفترة مش متطابق مع الأستاذ — راجعه من تبويب ضريبة القيمة المضافة قبل الإقرار");
    if (p.problems.includes("output_debit_balance") || p.problems.includes("input_credit_balance")) throw new ApiError(409, "رصيد حساب الضريبة في اتجاه غير متوقع — راجع القيود قبل الإقرار");
    const id = randomUUID();
    const number = await nextDocumentNumber(tx, "accounting.vat_return", v.period_to);
    // A nil return (nothing to set off) posts no entry; the row still locks the period.
    const entry = await postJournal(tx, {
      date: entryDate, description: `إقرار ضريبة القيمة المضافة ${number} (${v.period_from} – ${v.period_to})`, sourceType: "vat_settlement", sourceId: id,
      lines: [{ key: "vat_output", amount: D(p.outputTax) }, { key: "vat_input", amount: D(p.inputUsed).negated() }, { key: "vat_payable", amount: D(p.payable).negated() }],
    }, actor);
    const nothingDue = D(p.payable).isZero();
    const ret = await tx.vatReturn.create({
      data: {
        id, number, periodFrom: v.period_from, periodTo: v.period_to,
        outputTax: p.outputTax, inputTax: p.inputTax, inputUsed: p.inputUsed, payable: p.payable, carryForward: p.carryForward,
        documentsOutputTax: p.documents.outputTax, documentsInputTax: p.documents.inputTax,
        status: nothingDue ? "paid" : "filed", paidAt: nothingDue ? new Date() : null, paidBy: nothingDue ? actor.name : null,
        entryId: entry?.id ?? null, filedById: actor.id, filedBy: actor.name, reference: v.reference ?? null, notes: v.notes ?? null,
      },
    });
    await audit(tx, actor, ret.id, "vat_return_filed", `${ret.number} · ${v.period_from} – ${v.period_to} · مستحق ${p.payable} · مُرحّل ${p.carryForward}`);
    return tx.vatReturn.findUniqueOrThrow({ where: { id: ret.id } });
  });
}

export async function payVatReturn(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ cash_account_id: text("الخزينة / البنك"), date: dateField("تاريخ السداد").optional(), reference: optText("المرجع", 100).optional() }), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `accounting:vat-return:${id}`);
    const r = await tx.vatReturn.findUnique({ where: { id } });
    if (!r) throw new ApiError(404, "الإقرار مش موجود");
    if (r.status !== "filed") throw new ApiError(409, r.status === "paid" ? "الإقرار اتسدد قبل كده" : "الإقرار ده ملغي");
    const cash = await tx.cashAccount.findUnique({ where: { id: v.cash_account_id } });
    if (!cash?.active) throw new ApiError(400, "الخزينة / الحساب البنكي مش موجود أو موقوف");
    const date = v.date ?? todayLocalISO();
    if (date < r.periodTo) throw new ApiError(400, "السداد مينفعش يكون قبل نهاية فترة الإقرار");
    if (cash.type === "cash") {
      await advisoryXactLock(tx, `accounting:cash-account:${cash.id}`);
      const b = await tx.journalLine.aggregate({ where: { accountId: cash.accountId }, _sum: { debit: true, credit: true } });
      const available = D(b._sum.debit).minus(D(b._sum.credit));
      if (available.lessThan(r.payable)) throw new ApiError(409, `رصيد ${cash.nameAr ?? cash.name} ${available.toFixed(2)} — أقل من ${r.payable.toFixed(2)}`);
    }
    const entry = await postJournal(tx, {
      date, description: `سداد ضريبة القيمة المضافة ${r.number}${v.reference ? ` (${v.reference})` : ""}`, sourceType: "vat_payment", sourceId: r.id,
      lines: [{ key: "vat_payable", amount: r.payable }, { accountId: cash.accountId, amount: r.payable.negated() }],
    }, actor);
    const updated = await tx.vatReturn.update({ where: { id: r.id, version: r.version }, data: { status: "paid", paidAt: new Date(), paidBy: actor.name, paymentDate: date, paymentCashAccountId: cash.id, paymentReference: v.reference ?? null, paymentEntryId: entry!.id, version: { increment: 1 } } });
    await audit(tx, actor, r.id, "vat_return_paid", `${r.number} · ${r.payable.toFixed(2)} · ${cash.code}`);
    return updated;
  });
}

/** Void the latest live, unpaid return: its settlement is reversed and its period opens for VAT again. */
export async function voidVatReturn(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ reason: text("سبب الإلغاء", 500) }), input);
  return inTx(async (tx) => {
    const head = await tx.vatReturn.findUnique({ where: { id }, select: { periodTo: true } });
    if (!head) throw new ApiError(404, "الإقرار مش موجود");
    // Reversed on the return's own date when that month is still open, else today; that month
    // is locked before the VAT lock (the order every VAT posting uses).
    const p = await tx.accountingPeriod.findUnique({ where: { code: head.periodTo.slice(0, 7) }, select: { status: true } });
    const date = p?.status === "closed" ? todayLocalISO() : head.periodTo;
    await ensureOpenPeriod(tx, date);
    await advisoryXactLock(tx, "accounting:vat-return");
    const r = await tx.vatReturn.findUnique({ where: { id }, include: { entry: { include: { lines: true } } } });
    if (!r) throw new ApiError(404, "الإقرار مش موجود");
    if (r.status === "voided") throw new ApiError(409, "الإقرار ده ملغي قبل كده");
    if (r.status === "paid" && !r.payable.isZero()) throw new ApiError(409, "الإقرار اتسدد — مينفعش يتلغي (التصحيح بإقرار معدّل عند المصلحة)");
    const later = await tx.vatReturn.findFirst({ where: { status: { not: "voided" }, periodFrom: { gt: r.periodTo } }, select: { number: true } });
    if (later) throw new ApiError(409, `فيه إقرار بعده (${later.number}) — الغيه الأول`);
    let voidEntryId: string | null = null;
    if (r.entry) {
      const e = await postJournal(tx, {
        date, description: `إلغاء الإقرار ${r.number}: ${v.reason}`, sourceType: "vat_settlement", sourceId: `void:${r.id}`,
        lines: r.entry.lines.map((l) => ({ accountId: l.accountId, amount: l.credit.minus(l.debit) })),
      }, actor);
      voidEntryId = e?.id ?? null;
    }
    const updated = await tx.vatReturn.update({ where: { id: r.id, version: r.version }, data: { status: "voided", voidedAt: new Date(), voidedBy: actor.name, voidReason: v.reason, voidEntryId, ...(r.status === "paid" ? { paidAt: null, paidBy: null } : {}), version: { increment: 1 } } });
    await audit(tx, actor, r.id, "vat_return_voided", r.number, v.reason);
    return updated;
  });
}

export async function listVatReturns() {
  const rows = await prisma.vatReturn.findMany({ orderBy: [{ periodTo: "desc" }, { filedAt: "desc" }], take: 60, include: { entry: { select: { id: true, number: true } }, paymentEntry: { select: { id: true, number: true } }, paymentCashAccount: { select: { id: true, code: true, name: true, nameAr: true } } } });
  const [bal] = await Promise.all([vatBalances(prisma, "9999-12-31")]);
  return {
    returns: rows.map((r) => ({ ...r, outputTax: r.outputTax.toFixed(2), inputTax: r.inputTax.toFixed(2), inputUsed: r.inputUsed.toFixed(2), payable: r.payable.toFixed(2), carryForward: r.carryForward.toFixed(2), documentsOutputTax: r.documentsOutputTax.toFixed(2), documentsInputTax: r.documentsInputTax.toFixed(2) })),
    balances: { input: bal.input.toFixed(2), output: bal.output.toFixed(2) },
    nextFrom: rows.find((r) => r.status !== "voided") ? nextDay(rows.find((r) => r.status !== "voided")!.periodTo) : null,
  };
}
