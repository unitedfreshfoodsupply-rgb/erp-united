import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { parse, text } from "@/lib/core/validation";
import { getSetting } from "@/lib/core/settings-service";
import { requestApproval, type Decider } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";
import { ensureOpenPeriod, postJournal, postStockValuation, type PostLine } from "@/lib/accounting/ledger";

/**
 * Fiscal years and the controlled reopening of closed months and years.
 *
 * Year-end close (accounting.periods.close), on the year's last day:
 *   every revenue account     Dr its balance          every expense account   Cr its balance
 *   retained earnings         Cr net profit (or Dr net loss)
 * then the last month and the year are closed. Balance-sheet accounts are not touched: the
 * next year opens with their balances, so no opening entry is needed. Before closing, every
 * other month of the year must be closed and the year must have ended (an earlier year
 * still open is only a warning: each close takes its own year's result). The P&L, cash-flow and finance reports leave the
 * closing entry out, so a closed year still shows its own result.
 *
 * Reopening is never direct: someone with accounting.periods.close asks with a reason, and
 * a different person holding accounting.periods.reopen approves. Reopening a year reverses
 * its closing entry (and reopens its last month); only the latest closed year can reopen.
 * A month reopens only while its year is open. Every step is in the audit log.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);

const pad = (n: number) => String(n).padStart(2, "0");
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

/** A fiscal year's dates and months from its code (the year it starts in) and the start month. */
export async function fiscalYearBounds(code: string) {
  if (!/^\d{4}$/.test(code)) throw new ApiError(400, "السنة المالية لازم تكون YYYY");
  const existing = await prisma.fiscalYear.findUnique({ where: { code } });
  const startMonth = existing ? Number(existing.startDate.slice(5, 7)) : Number(await getSetting("accounting.fiscal_year_start_month"));
  const y = Number(code);
  const months: string[] = [];
  for (let i = 0; i < 12; i++) {
    const m = ((startMonth - 1 + i) % 12) + 1;
    months.push(`${y + Math.floor((startMonth - 1 + i) / 12)}-${pad(m)}`);
  }
  const last = months[11];
  return { code, startDate: `${months[0]}-01`, endDate: monthEnd(Number(last.slice(0, 4)), Number(last.slice(5, 7))), months };
}

/** Revenue/expense balances over a range (closing entries included: what is still to close). */
async function plBalances(db: Tx | typeof prisma, from: string | null, to: string) {
  return db.$queryRaw<{ accountId: string; code: string; name: string; nameAr: string; type: string; balance: Prisma.Decimal }[]>`
    SELECT a."id" AS "accountId", a."code", a."name", a."nameAr", a."type", sum(l."debit" - l."credit") AS balance
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE a."type" IN ('revenue', 'expense') AND e."date" <= ${to} AND (${from}::text IS NULL OR e."date" >= ${from})
    GROUP BY a."id", a."code", a."name", a."nameAr", a."type"
    HAVING sum(l."debit" - l."credit") <> 0
    ORDER BY a."code"`;
}

/** What closing the year would post, and what stands in the way. */
export async function previewYearClose(code: string) {
  const b = await fiscalYearBounds(code);
  const [fy, lines, before, periods, laterClosed] = await Promise.all([
    prisma.fiscalYear.findUnique({ where: { code } }),
    plBalances(prisma, b.startDate, b.endDate),
    plBalances(prisma, null, new Date(Date.parse(`${b.startDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)),
    prisma.accountingPeriod.findMany({ where: { code: { in: b.months } }, select: { code: true, status: true } }),
    prisma.fiscalYear.findFirst({ where: { status: "closed", startDate: { gt: b.startDate } }, select: { code: true } }),
  ]);
  const revenue = lines.filter((l) => l.type === "revenue").reduce((s, l) => s.minus(l.balance), D(0));
  const expenses = lines.filter((l) => l.type === "expense").reduce((s, l) => s.plus(l.balance), D(0));
  const openMonths = periods.filter((p) => p.status === "open" && p.code !== b.months[11]).map((p) => p.code).sort();
  const lastClosed = periods.some((p) => p.code === b.months[11] && p.status === "closed");
  const problems: { code: string; params?: Record<string, string> }[] = [];
  const warnings: { code: string; params?: Record<string, string> }[] = [];
  if (fy?.status === "closed") problems.push({ code: "already_closed" });
  if (b.endDate >= todayLocalISO()) problems.push({ code: "year_not_ended", params: { end: b.endDate } });
  // Closing a year zeroes only that year's own result, so an earlier year left open is not
  // wrong — but it is unusual, and the screen says so.
  if (before.length) warnings.push({ code: "earlier_year_open" });
  if (openMonths.length) problems.push({ code: "months_open", params: { months: openMonths.join("، ") } });
  if (lastClosed && fy?.status !== "closed") problems.push({ code: "last_month_closed", params: { month: b.months[11] } });

  return {
    ...b, status: fy?.status ?? "open", closedAt: fy?.closedAt ?? null, closedBy: fy?.closedBy ?? null,
    revenue: revenue.toFixed(2), expenses: expenses.toFixed(2), netIncome: revenue.minus(expenses).toFixed(2),
    lines: lines.map((l) => ({ accountId: l.accountId, code: l.code, name: l.name, nameAr: l.nameAr, type: l.type, balance: D(l.balance).toFixed(2) })),
    problems,
    warnings,
  };
}

export async function listFiscalYears() {
  const [years, periods] = await Promise.all([prisma.fiscalYear.findMany({ orderBy: { code: "desc" } }), prisma.accountingPeriod.findMany({ select: { code: true } })]);
  const startMonth = Number(await getSetting("accounting.fiscal_year_start_month"));
  const codes = new Set(years.map((y) => y.code));
  for (const p of periods) {
    const y = Number(p.code.slice(0, 4)), m = Number(p.code.slice(5, 7));
    codes.add(String(m >= startMonth ? y : y - 1));
  }
  const out = [];
  for (const code of [...codes].sort().reverse().slice(0, 15)) {
    const fy = years.find((y) => y.code === code);
    const b = fy ? { startDate: fy.startDate, endDate: fy.endDate } : await fiscalYearBounds(code);
    out.push({ code, startDate: b.startDate, endDate: b.endDate, status: fy?.status ?? "open", closedAt: fy?.closedAt ?? null, closedBy: fy?.closedBy ?? null, netIncome: fy?.netIncome?.toFixed(2) ?? null, closeCount: fy?.closeCount ?? 0, reopenedAt: fy?.reopenedAt ?? null, reopenedBy: fy?.reopenedBy ?? null, reopenReason: fy?.reopenReason ?? null, version: fy?.version ?? 0 });
  }
  return out;
}

export async function closeFiscalYear(code: string, actor: ServiceActor) {
  assertPermission(actor, "accounting.periods.close");
  const b = await fiscalYearBounds(code);
  // The stock value of the year reaches the ledger before its result is taken.
  await postStockValuation(actor);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, "accounting:fiscal-year");
    const p = await previewYearClose(code);
    const block = p.problems[0];
    if (block?.code === "already_closed") throw new ApiError(409, `السنة المالية ${code} مقفولة بالفعل`);
    if (block?.code === "year_not_ended") throw new ApiError(409, `السنة المالية لسه مخلصتش (آخرها ${block.params!.end})`);
    if (block?.code === "months_open") throw new ApiError(409, `اقفل الشهور دي الأول: ${block.params!.months}`);
    if (block?.code === "last_month_closed") throw new ApiError(409, `الشهر الأخير ${block.params!.month} مقفول — قيد الإقفال بيترحّل فيه، فاطلب إعادة فتحه الأول`);
    let fy = await tx.fiscalYear.findUnique({ where: { code } });
    if (!fy) fy = await tx.fiscalYear.create({ data: { code, startDate: b.startDate, endDate: b.endDate } });
    const lines: PostLine[] = p.lines.map((l) => ({ accountId: l.accountId, amount: D(l.balance).negated(), description: "إقفال السنة" }));
    const net = D(p.netIncome);
    if (!net.isZero()) lines.push({ key: "retained_earnings", amount: net.negated(), description: net.gt(0) ? "صافي ربح السنة" : "صافي خسارة السنة" });
    const entry = lines.length ? await postJournal(tx, { date: b.endDate, description: `إقفال السنة المالية ${code}: ${net.gt(0) ? "صافي ربح" : net.lt(0) ? "صافي خسارة" : "بدون نتيجة"} ${net.abs().toFixed(2)}`, sourceType: "year_end_close", sourceId: `${fy.id}:${fy.closeCount + 1}`, lines }, actor) : null;
    // The last month closes with the year.
    const last = await ensureOpenPeriod(tx, b.endDate);
    await tx.accountingPeriod.update({ where: { id: last.id, version: last.version }, data: { status: "closed", closedBy: actor.name, closedAt: new Date(), version: { increment: 1 } } });
    const updated = await tx.fiscalYear.update({ where: { id: fy.id, version: fy.version }, data: { status: "closed", closedAt: new Date(), closedBy: actor.name, closingEntryId: entry?.id ?? null, netIncome: net, closeCount: { increment: 1 }, version: { increment: 1 } } });
    await writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action: "fiscal_year_closed", entityType: "fiscal_year", entityId: fy.id, fieldChanged: code, oldValue: "open", newValue: `closed · ${net.toFixed(2)}${entry ? ` · ${entry.number}` : ""}`, source: "user", deviceId: actor.deviceId }, tx);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Reopening — always a request decided by someone else
// ---------------------------------------------------------------------------

const reasonInput = z.object({ reason: text("سبب إعادة الفتح", 1000).refine((v) => v.trim().length >= 10, "اكتب سبب واضح (10 حروف على الأقل)") });

export async function requestPeriodReopen(code: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.periods.close");
  if (!/^\d{4}-\d{2}$/.test(code)) throw new ApiError(400, "الفترة لازم تكون YYYY-MM");
  const v = parse(reasonInput, input);
  return inTx(async (tx) => {
    const p = await tx.accountingPeriod.findUnique({ where: { code } });
    if (!p) throw new ApiError(404, "الفترة مش موجودة");
    if (p.status !== "closed") throw new ApiError(409, "الفترة مفتوحة بالفعل");
    const year = await tx.fiscalYear.findFirst({ where: { startDate: { lte: p.startDate }, endDate: { gte: p.endDate } } });
    if (year?.status === "closed") throw new ApiError(409, `السنة المالية ${year.code} مقفولة — اطلب إعادة فتح السنة`);
    const later = await tx.accountingPeriod.findMany({ where: { code: { gt: code }, status: "closed" }, select: { code: true }, orderBy: { code: "asc" }, take: 5 });
    return requestApproval(tx, { type: "accounting.period_reopen", entityId: p.id, title: `إعادة فتح الشهر ${code}`, summary: later.length ? `شهور بعده مقفولة: ${later.map((x) => x.code).join("، ")}` : undefined, reason: v.reason, payload: { kind: "period", code, reason: v.reason }, requester: actor });
  });
}

export async function requestYearReopen(code: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.periods.close");
  const v = parse(reasonInput, input);
  return inTx(async (tx) => {
    const fy = await tx.fiscalYear.findUnique({ where: { code } });
    if (!fy || fy.status !== "closed") throw new ApiError(409, "السنة المالية دي مش مقفولة");
    const later = await tx.fiscalYear.findFirst({ where: { status: "closed", startDate: { gt: fy.startDate } }, select: { code: true } });
    if (later) throw new ApiError(409, `السنة ${later.code} اللي بعدها مقفولة — افتحها الأول`);
    return requestApproval(tx, { type: "accounting.year_reopen", entityId: fy.id, title: `إعادة فتح السنة المالية ${code}`, reason: v.reason, payload: { kind: "year", code, reason: v.reason }, requester: actor });
  });
}

const payloadReason = (payload: unknown) => String((payload as { reason?: string } | null)?.reason ?? "");

/** Approved reopening of a month: by someone other than the requester, while its year is open. */
export async function applyPeriodReopen(tx: Tx, periodId: string, payload: unknown, decider: Decider, requestedById: string | null) {
  if (requestedById && requestedById === decider.id) throw new ApiError(403, "اللي طلب إعادة الفتح مينفعش يوافق عليها بنفسه");
  const p = await tx.accountingPeriod.findUniqueOrThrow({ where: { id: periodId } });
  await advisoryXactLock(tx, `accounting-period:${p.code}`);
  if (p.status !== "closed") throw new ApiError(409, "الفترة مفتوحة بالفعل");
  const year = await tx.fiscalYear.findFirst({ where: { startDate: { lte: p.startDate }, endDate: { gte: p.endDate } } });
  if (year?.status === "closed") throw new ApiError(409, `السنة المالية ${year.code} مقفولة — اطلب إعادة فتح السنة`);
  const reason = payloadReason(payload);
  await tx.accountingPeriod.update({ where: { id: p.id, version: p.version }, data: { status: "open", closedBy: null, closedAt: null, reopenCount: { increment: 1 }, reopenedAt: new Date(), reopenedBy: decider.name, reopenReason: reason, version: { increment: 1 } } });
  await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "period_reopened", entityType: "accounting_period", entityId: p.id, fieldChanged: p.code, oldValue: "closed", newValue: "open", reason, source: "user", deviceId: decider.deviceId }, tx);
}

/** Approved reopening of a year: its last month opens and the closing entry is reversed on the same day. */
export async function applyYearReopen(tx: Tx, yearId: string, payload: unknown, decider: Decider, requestedById: string | null) {
  if (requestedById && requestedById === decider.id) throw new ApiError(403, "اللي طلب إعادة الفتح مينفعش يوافق عليها بنفسه");
  await advisoryXactLock(tx, "accounting:fiscal-year");
  const fy = await tx.fiscalYear.findUniqueOrThrow({ where: { id: yearId }, include: { closingEntry: { include: { lines: true } } } });
  if (fy.status !== "closed") throw new ApiError(409, "السنة المالية مفتوحة بالفعل");
  const later = await tx.fiscalYear.findFirst({ where: { status: "closed", startDate: { gt: fy.startDate } }, select: { code: true } });
  if (later) throw new ApiError(409, `السنة ${later.code} اللي بعدها مقفولة — افتحها الأول`);
  const reason = payloadReason(payload);
  const lastCode = fy.endDate.slice(0, 7);
  const last = await tx.accountingPeriod.findUnique({ where: { code: lastCode } });
  if (last?.status === "closed") {
    await tx.accountingPeriod.update({ where: { id: last.id, version: last.version }, data: { status: "open", closedBy: null, closedAt: null, reopenCount: { increment: 1 }, reopenedAt: new Date(), reopenedBy: decider.name, reopenReason: reason, version: { increment: 1 } } });
  }
  if (fy.closingEntry) {
    await postJournal(tx, {
      date: fy.endDate, description: `عكس إقفال السنة المالية ${fy.code}: ${reason}`, sourceType: "year_end_reopen", sourceId: `${fy.id}:${fy.closeCount}`,
      lines: fy.closingEntry.lines.map((l) => ({ accountId: l.accountId, amount: l.credit.minus(l.debit) })),
    }, decider);
  }
  await tx.fiscalYear.update({ where: { id: fy.id, version: fy.version }, data: { status: "open", closedAt: null, closedBy: null, closingEntryId: null, reopenedAt: new Date(), reopenedBy: decider.name, reopenReason: reason, version: { increment: 1 } } });
  await writeAudit({ userId: decider.id, userName: decider.name, role: decider.role, action: "fiscal_year_reopened", entityType: "fiscal_year", entityId: fy.id, fieldChanged: fy.code, oldValue: "closed", newValue: "open", reason, source: "user", deviceId: decider.deviceId }, tx);
}
