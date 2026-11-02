import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { todayLocalISO } from "@/lib/localDate";
import { agingReport, openAmounts } from "@/lib/sales/invoicing";

/**
 * WS3 (remediation 2026-11) G2 — the collection follow-up list. Read-only, built from the
 * same AR documents as the aging report (invoices, credit notes, receipt allocations,
 * opening balances, customer charges, money on account): every customer with something
 * overdue, the overdue documents with their days overdue, the last money received and the
 * credit status — so the collector knows whom to call first. Nothing is sent to anyone.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const dayNo = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

type Item = { kind: "invoice" | "opening_balance" | "charge"; id: string; number: string; date: string; dueDate: string; daysOverdue: number; open: string };

export async function collectionFollowUp(asOf = todayLocalISO()) {
  const aging = await agingReport(asOf);
  const overdueRows = aging.rows.filter((r) => D(r.d1_30).plus(r.d31_60).plus(r.d61_90).plus(r.d90_plus).gt(0));
  const ids = overdueRows.map((r) => r.customer.id);
  if (!ids.length) return { asOf, rows: [], totals: { customers: 0, overdue: "0.00" } };

  const [invoices, openings, receipts, customers] = await Promise.all([
    prisma.salesInvoice.findMany({ where: { customerId: { in: ids }, status: "issued", issueDate: { lte: asOf }, dueDate: { lt: asOf } }, select: { id: true, number: true, customerId: true, issueDate: true, dueDate: true, total: true }, orderBy: { dueDate: "asc" } }),
    prisma.partyOpeningBalance.findMany({ where: { partyType: "customer", partyId: { in: ids }, date: { lte: asOf }, dueDate: { lt: asOf }, amount: { gt: 0 } }, orderBy: { dueDate: "asc" } }),
    prisma.customerReceipt.findMany({ where: { customerId: { in: ids }, date: { lte: asOf }, reversal: { is: null } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], select: { customerId: true, number: true, date: true, amount: true } }),
    prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, phone: true, creditLimit: true, creditHold: true, creditHoldReason: true, paymentTermsDays: true } }),
  ]);
  const [invPaid, openingPaid] = await Promise.all([
    openAmounts(prisma, invoices.map((i) => i.id)),
    openings.length
      ? prisma.receiptAllocation.groupBy({ by: ["openingBalanceId"], where: { openingBalanceId: { in: openings.map((o) => o.id) }, receipt: { date: { lte: asOf }, reversal: { is: null } } }, _sum: { amount: true } })
      : Promise.resolve([]),
  ]);
  const openingPaidBy = new Map(openingPaid.map((a) => [a.openingBalanceId!, D(a._sum.amount)]));
  const lastReceipt = new Map<string, (typeof receipts)[number]>();
  for (const r of receipts) if (!lastReceipt.has(r.customerId)) lastReceipt.set(r.customerId, r);
  const custById = new Map(customers.map((c) => [c.id, c]));

  const items = new Map<string, Item[]>();
  const push = (cid: string, it: Item) => items.set(cid, [...(items.get(cid) ?? []), it]);
  for (const i of invoices) {
    const open = i.total.minus(invPaid.get(i.id) ?? 0);
    if (open.gt(0)) push(i.customerId, { kind: "invoice", id: i.id, number: i.number!, date: i.issueDate!, dueDate: i.dueDate!, daysOverdue: dayNo(asOf) - dayNo(i.dueDate!), open: open.toFixed(2) });
  }
  for (const o of openings) {
    const open = o.amount.minus(openingPaidBy.get(o.id) ?? 0);
    if (open.gt(0)) push(o.partyId, { kind: "opening_balance", id: o.id, number: o.reference ?? "رصيد افتتاحي", date: o.date, dueDate: o.dueDate, daysOverdue: dayNo(asOf) - dayNo(o.dueDate), open: open.toFixed(2) });
  }
  // Charges have no allocation of their own: the aging report applies money on account to
  // them oldest due first; what it leaves open of an overdue one is listed.
  for (const ch of aging.openCharges) {
    if (ch.dueDate < asOf) push(ch.customerId, { kind: "charge", id: ch.id, number: ch.reference, date: ch.date, dueDate: ch.dueDate, daysOverdue: dayNo(asOf) - dayNo(ch.dueDate), open: ch.open });
  }

  const rows = overdueRows.map((r) => {
    const c = custById.get(r.customer.id);
    const list = (items.get(r.customer.id) ?? []).sort((a, b) => b.daysOverdue - a.daysOverdue);
    const overdue = D(r.d1_30).plus(r.d31_60).plus(r.d61_90).plus(r.d90_plus);
    const last = lastReceipt.get(r.customer.id);
    const balance = D(r.total);
    return {
      customer: { ...r.customer, phone: c?.phone ?? null },
      overdue: overdue.toFixed(2),
      buckets: { d1_30: r.d1_30, d31_60: r.d31_60, d61_90: r.d61_90, d90_plus: r.d90_plus },
      notDue: r.current,
      unapplied: r.unapplied,
      balance: balance.toFixed(2),
      maxDaysOverdue: list.length ? list[0].daysOverdue : null,
      items: list,
      lastReceipt: last ? { number: last.number, date: last.date, amount: last.amount.toFixed(2), daysAgo: dayNo(asOf) - dayNo(last.date) } : null,
      credit: {
        limit: c?.creditLimit?.toFixed(2) ?? null,
        hold: c?.creditHold ?? false,
        holdReason: c?.creditHoldReason ?? null,
        paymentTermsDays: c?.paymentTermsDays ?? null,
        overLimit: c?.creditLimit != null ? balance.gt(c.creditLimit) : false,
      },
    };
  }).sort((a, b) => (b.maxDaysOverdue ?? 0) - (a.maxDaysOverdue ?? 0) || Number(D(b.overdue).minus(a.overdue)));
  return { asOf, rows, totals: { customers: rows.length, overdue: rows.reduce((s, r) => s.plus(r.overdue), D(0)).toFixed(2) } };
}
