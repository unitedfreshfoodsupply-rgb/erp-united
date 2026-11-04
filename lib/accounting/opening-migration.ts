import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { isValidISODate } from "@/lib/dates";
import { optText, parse, text } from "@/lib/core/validation";
import { getSetting } from "@/lib/core/settings-service";
import { cancelPendingApproval, requestApproval, type Decider } from "@/lib/core/approvals";
import type { ServiceActor } from "@/lib/core/actor";
import { SUPPLIER_CATEGORIES } from "@/lib/purchasing/suppliers";
import { addLinesInTx, sourceKey, type LineInput } from "@/lib/accounting/opening-batches";

/**
 * The phased opening migration (Nov 2026).
 *
 * UNITED goes live before the complete legacy trial balance is known, so the opening position
 * is entered in phases, in the order the figures become known:
 *   1. suppliers' balances (a phase batch, segment "suppliers"),
 *   2. customers' balances (segment "customers"),
 *   3. the rest — cash, banks, stock, fixed assets, loans, capital… (segment "other"),
 *      including the transfer of opening-balance equity (3300) into the clearing account,
 *   4. reconciliation of the complete opening position, and
 *   5. formal closure, approved by a second person.
 *
 * Every phase batch is approved by someone other than its preparer and posts double-entry
 * against one dedicated, provisional account: 3900 "Opening balance clearing (provisional)"
 * (system key opening_clearing). Nothing invents a balance to make a batch balance: what a phase
 * leaves is its movement on the clearing account, traced to the batch. The parties' balances
 * are in their statements and aging from the moment their batch posts. The migration closes only
 * when the clearing account is back to zero, every sub-ledger agrees with its control account,
 * opening-balance equity is zero, no source row is left undecided, the people responsible have
 * confirmed what the data cannot show (cash count, bank statements, completeness) — and a
 * second person approves. Until then every financial report says its opening figures are provisional.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const isoDate = (label: string) => z.string().refine(isValidISODate, `${label} لازم يكون YYYY-MM-DD`);

/** What people must confirm before closure: the data cannot show these on its own. */
export const ATTESTATIONS = ["suppliers_complete", "customers_complete", "cash_bank_verified", "other_accounts_reconciled"] as const;
export type AttestationKey = (typeof ATTESTATIONS)[number];
type Attestation = { by: string; byId: string | null; at: string; note: string };

export type MigrationStatus = "not_started" | "in_progress" | "awaiting_approval" | "reconciliation_required" | "ready_for_closure" | "closed";

export type ClosureCheck = { key: string; ok: boolean; label: string; labelEn: string; value?: string; count?: number };

/**
 * The migration's state as the control center shows it (pure).
 *   closed                  closure approved
 *   awaiting_approval       a phase batch or the closure waits for a second person
 *   in_progress             nothing posted yet, or a batch still being prepared
 *   ready_for_closure       everything posted and every closure check passes
 *   reconciliation_required everything posted, a check fails
 */
export function migrationStatus(f: { migration: { status: string } | null; draft: number; pending: number; posted: number; checksOk: boolean }): MigrationStatus {
  if (!f.migration) return "not_started";
  if (f.migration.status === "closed") return "closed";
  if (f.migration.status === "closing" || f.pending > 0) return "awaiting_approval";
  if (f.draft > 0 || f.posted === 0) return "in_progress";
  return f.checksOk ? "ready_for_closure" : "reconciliation_required";
}

/** The closure checks (pure): every one must pass before closure can be requested, and again when it is approved. */
export function closureChecks(f: {
  draft: number; pending: number;
  integrity: Record<string, { ok: boolean; subledger?: string; ledger?: string; difference?: string } | undefined>;
  clearing: Prisma.Decimal; untraced: Prisma.Decimal; openingEquity: Prisma.Decimal;
  openExceptions: number; attestations: Partial<Record<AttestationKey, Attestation>>;
  users: number; differentApprover: boolean;
}): ClosureCheck[] {
  const sub = (k: string) => { const c = f.integrity[k]; return c ? `${c.subledger ?? ""} / ${c.ledger ?? ""}` : undefined; };
  const att = (k: AttestationKey) => f.attestations[k];
  return [
    { key: "batches_settled", ok: f.draft === 0 && f.pending === 0, label: "كل دفعات الترحيل اترحّلت أو اتلغت (مفيش مسودة ولا دفعة مستنية اعتماد)", labelEn: "Every migration batch is posted or cancelled (none in draft or awaiting approval)", count: f.draft + f.pending },
    { key: "ap_reconciled", ok: !!f.integrity.ap?.ok, label: "أرصدة الموردين = حساب الموردين (2100) — إجمالي ولكل مورد", labelEn: "Supplier sub-ledger equals the payables control account (2100), in total and per supplier", value: sub("ap") },
    { key: "ar_reconciled", ok: !!f.integrity.ar?.ok, label: "أرصدة العملاء = حساب العملاء (1300) — إجمالي ولكل عميل", labelEn: "Customer sub-ledger equals the receivables control account (1300), in total and per customer", value: sub("ar") },
    { key: "inventory_reconciled", ok: !!f.integrity.inventory?.ok, label: "قيمة المخزون = حساب المخزون (1400)", labelEn: "Inventory valuation equals the inventory account (1400)", value: sub("inventory") },
    { key: "fixed_assets_reconciled", ok: !!f.integrity.fixed_assets?.ok, label: "سجل الأصول الثابتة = حساباتها (تكلفة ومجمع إهلاك)", labelEn: "Fixed-asset register equals its accounts (cost and accumulated depreciation)", value: sub("fixed_assets") },
    { key: "trial_balance", ok: !!f.integrity.trial_balance?.ok, label: "ميزان المراجعة متوازن", labelEn: "The trial balance balances", value: sub("trial_balance") },
    { key: "clearing_traced", ok: f.untraced.isZero(), label: "كل حركة على الحساب الوسيط جاية من دفعة ترحيل معتمدة", labelEn: "Every movement on the clearing account comes from an approved migration batch", value: f.untraced.toFixed(2) },
    { key: "clearing_zero", ok: f.clearing.isZero(), label: "الحساب الوسيط (3900) رصيده صفر — الأرصدة الافتتاحية كاملة ومتوازنة", labelEn: "The clearing account (3900) is zero — the opening position is complete and balanced", value: f.clearing.toFixed(2) },
    { key: "opening_equity_zero", ok: f.openingEquity.isZero(), label: "حساب الأرصدة الافتتاحية (3300) رصيده صفر", labelEn: "Opening-balance equity (3300) is zero", value: f.openingEquity.toFixed(2) },
    { key: "exceptions_decided", ok: f.openExceptions === 0, label: "كل صفوف المصدر اللي ماتطابقتش اتحسمت (اتحلّت أو اتستبعدت بسبب)", labelEn: "Every unmatched source row is decided (resolved, or excluded with a reason)", count: f.openExceptions },
    { key: "attest_suppliers_complete", ok: !!att("suppliers_complete"), label: "تأكيد: كل أرصدة الموردين في تاريخ القطع اتسجلت", labelEn: "Confirmed: every supplier balance at the cut-off is in", value: att("suppliers_complete")?.by },
    { key: "attest_customers_complete", ok: !!att("customers_complete"), label: "تأكيد: كل أرصدة العملاء في تاريخ القطع اتسجلت", labelEn: "Confirmed: every customer balance at the cut-off is in", value: att("customers_complete")?.by },
    { key: "attest_cash_bank_verified", ok: !!att("cash_bank_verified"), label: "تأكيد: أرصدة الخزائن مطابقة للجرد والبنوك مطابقة لكشف الحساب", labelEn: "Confirmed: cash agrees with the count and banks with their statements", value: att("cash_bank_verified")?.by },
    { key: "attest_other_accounts_reconciled", ok: !!att("other_accounts_reconciled"), label: "تأكيد: باقي الحسابات الافتتاحية مطابقة لميزان المراجعة القديم", labelEn: "Confirmed: the other opening accounts agree with the legacy trial balance", value: att("other_accounts_reconciled")?.by },
    { key: "second_person", ok: f.users >= 2 && f.differentApprover, label: "فيه شخص تاني يعتمد القفل (فصل المهام)", labelEn: "A second person exists to approve the closure (segregation of duties)", count: f.users },
  ];
}

async function keyBalance(db: Tx | typeof prisma, systemKey: string) {
  const r = await db.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT sum(l."debit" - l."credit") AS v FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" WHERE a."systemKey" = ${systemKey}`;
  return D(r[0]?.v);
}

/** Each posted phase batch's movement on the clearing account, from the ledger (its own entries and its parties' opening entries). */
async function clearingByBatch(db: Tx | typeof prisma, migrationId: string) {
  return db.$queryRaw<{ id: string; v: Prisma.Decimal | null }[]>`
    SELECT b."id", sum(l."debit" - l."credit") AS v
    FROM "OpeningBatch" b
    JOIN "JournalEntry" e ON (e."sourceType" = 'opening_batch' AND e."sourceId" LIKE b."id" || ':%')
      OR (e."sourceType" = 'opening_balance' AND e."sourceId" IN (SELECT o."id" FROM "PartyOpeningBalance" o WHERE o."openingBatchId" = b."id"))
    JOIN "JournalLine" l ON l."entryId" = e."id"
    JOIN "Account" a ON a."id" = l."accountId" AND a."systemKey" = 'opening_clearing'
    WHERE b."migrationId" = ${migrationId}
    GROUP BY b."id"`;
}

const getMigration = (db: Tx | typeof prisma) => db.openingMigration.findUnique({ where: { key: "opening" } });

/** Everything the control center and the closure checks read, in one place. */
async function facts(db: Tx | typeof prisma = prisma) {
  const migration = await getMigration(db);
  if (!migration) return null;
  const batches = await db.openingBatch.findMany({
    where: { migrationId: migration.id }, orderBy: { createdAt: "asc" },
    select: { id: true, number: true, segment: true, status: true, sourceFile: true, createdBy: true, submittedBy: true, decidedBy: true, postedAt: true, lines: { select: { kind: true, data: true, debit: true, credit: true } } },
  });
  const [clearing, openingEquity, traced, exceptionRows, users, differentApprover] = await Promise.all([
    keyBalance(db, "opening_clearing"), keyBalance(db, "opening_equity"), clearingByBatch(db, migration.id),
    db.openingException.groupBy({ by: ["segment", "status", "reason"], where: { migrationId: migration.id }, _count: { _all: true }, _sum: { sourceAmount: true } }),
    db.user.count({ where: { active: true } }), getSetting("approvals.require_different_approver"),
  ]);
  const { integrityReport } = await import("@/lib/accounting/integrity");
  const integrity = Object.fromEntries((await integrityReport()).checks.map((c) => [c.key, c]));
  return { migration, batches, clearing, openingEquity, traced, exceptionRows, users, differentApprover: !!differentApprover, integrity };
}

function summarize(f: NonNullable<Awaited<ReturnType<typeof facts>>>) {
  const tracedMap = new Map(f.traced.map((t) => [t.id, D(t.v)]));
  const tracedTotal = [...tracedMap.values()].reduce((s, v) => s.plus(v), D(0));
  const untraced = f.clearing.minus(tracedTotal);
  const attestations = (f.migration.attestations ?? {}) as Partial<Record<AttestationKey, Attestation>>;
  const draft = f.batches.filter((b) => b.status === "draft").length;
  const pending = f.batches.filter((b) => b.status === "pending_approval").length;
  const posted = f.batches.filter((b) => b.status === "posted").length;
  const openExceptions = f.exceptionRows.filter((r) => r.status === "open").reduce((n, r) => n + r._count._all, 0);
  const checks = closureChecks({ draft, pending, integrity: f.integrity, clearing: f.clearing, untraced, openingEquity: f.openingEquity, openExceptions, attestations, users: f.users, differentApprover: f.differentApprover });
  const checksOk = checks.every((c) => c.ok);
  const status = migrationStatus({ migration: f.migration, draft, pending, posted, checksOk });
  return { tracedMap, tracedTotal, untraced, attestations, draft, pending, posted, openExceptions, checks, checksOk, status };
}

/** The control center: status, each segment by stage, totals, the clearing account traced to its batches, exceptions, approvals, the closure checks. */
export async function migrationOverview() {
  const f = await facts();
  if (!f) {
    const initial = await prisma.openingBatch.findFirst({ where: { kind: "initial", status: { not: "cancelled" } }, select: { number: true, status: true } });
    return { status: "not_started" as MigrationStatus, migration: null, blockedBy: initial ?? null };
  }
  const s = summarize(f);
  const stage = (st: string) => st === "draft" ? "imported" : st === "pending_approval" ? "pending" : st === "posted" ? "posted" : "cancelled";
  type Bucket = { batches: number; lines: number; debit: Prisma.Decimal; credit: Prisma.Decimal; amount: Prisma.Decimal };
  const empty = (): Bucket => ({ batches: 0, lines: 0, debit: D(0), credit: D(0), amount: D(0) });
  const segments: Record<string, Record<string, Bucket>> = {};
  for (const seg of ["suppliers", "customers", "other"]) segments[seg] = { imported: empty(), pending: empty(), posted: empty(), cancelled: empty() };
  for (const b of f.batches) {
    const bucket = segments[b.segment ?? "other"][stage(b.status)];
    bucket.batches += 1;
    for (const l of b.lines) {
      bucket.lines += 1;
      bucket.debit = bucket.debit.plus(l.debit);
      bucket.credit = bucket.credit.plus(l.credit);
      // Parties: their balances as entered (customers owe us, we owe suppliers — positive).
      if (l.kind === "customer" || l.kind === "supplier") bucket.amount = bucket.amount.plus(D((l.data as { amount?: string }).amount));
    }
  }
  const money = (b: Bucket) => ({ batches: b.batches, lines: b.lines, debit: b.debit.toFixed(2), credit: b.credit.toFixed(2), amount: b.amount.toFixed(2) });
  const postedLines = f.batches.filter((b) => b.status === "posted").flatMap((b) => b.lines);
  const exceptions = { open: 0, resolved: 0, excluded: 0, openAmount: D(0), bySegment: {} as Record<string, { open: number; openAmount: string; unmatched: number }> };
  for (const r of f.exceptionRows) {
    exceptions[r.status as "open" | "resolved" | "excluded"] += r._count._all;
    if (r.status !== "open") continue;
    exceptions.openAmount = exceptions.openAmount.plus(D(r._sum.sourceAmount));
    const seg = (exceptions.bySegment[r.segment] ??= { open: 0, openAmount: "0.00", unmatched: 0 });
    seg.open += r._count._all;
    seg.openAmount = D(seg.openAmount).plus(D(r._sum.sourceAmount)).toFixed(2);
    if (r.reason === "no_match") seg.unmatched += r._count._all;
  }
  const closeRequest = f.migration.status === "closing" ? await prisma.approvalRequest.findFirst({ where: { type: "accounting.opening_migration_close", entityId: f.migration.id, status: "pending" }, select: { id: true, number: true, requestedBy: true, createdAt: true } }) : null;
  return {
    status: s.status,
    migration: { id: f.migration.id, cutoverDate: f.migration.cutoverDate, state: f.migration.status, notes: f.migration.notes, createdBy: f.migration.createdBy, createdAt: f.migration.createdAt, closeRequestedBy: f.migration.closeRequestedBy, closeRequestedAt: f.migration.closeRequestedAt, closedBy: f.migration.closedBy, closedAt: f.migration.closedAt, version: f.migration.version },
    segments: Object.fromEntries(Object.entries(segments).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([st, b]) => [st, money(b)]))])),
    totals: { debit: postedLines.reduce((x, l) => x.plus(l.debit), D(0)).toFixed(2), credit: postedLines.reduce((x, l) => x.plus(l.credit), D(0)).toFixed(2) },
    clearing: {
      balance: f.clearing.toFixed(2), traced: s.tracedTotal.toFixed(2), untraced: s.untraced.toFixed(2),
      byBatch: f.batches.filter((b) => b.status === "posted").map((b) => ({ id: b.id, number: b.number, segment: b.segment, sourceFile: b.sourceFile, postedAt: b.postedAt, decidedBy: b.decidedBy, movement: (s.tracedMap.get(b.id) ?? D(0)).toFixed(2) })),
    },
    openingEquity: f.openingEquity.toFixed(2),
    batches: f.batches.map((b) => ({ id: b.id, number: b.number, segment: b.segment, status: b.status, sourceFile: b.sourceFile, lines: b.lines.length, createdBy: b.createdBy, submittedBy: b.submittedBy, decidedBy: b.decidedBy })),
    exceptions: { open: exceptions.open, resolved: exceptions.resolved, excluded: exceptions.excluded, openAmount: exceptions.openAmount.toFixed(2), bySegment: exceptions.bySegment },
    pendingApprovals: { batches: f.batches.filter((b) => b.status === "pending_approval").map((b) => ({ id: b.id, number: b.number, segment: b.segment })), closure: closeRequest },
    attestations: s.attestations,
    checks: s.checks,
    readyForClosure: s.checksOk && f.migration.status === "open",
  };
}

/**
 * Whether the books' opening figures are final — read by the trial balance, the balance sheet
 * and the P&L, so no report claims a reconciled opening that is not. Final: the one-batch
 * opening posted (it balanced on its own), or the phased migration closed.
 */
export async function openingPosition(db: Tx | typeof prisma = prisma) {
  const [m, initial] = await Promise.all([
    db.openingMigration.findUnique({ where: { key: "opening" }, select: { status: true, cutoverDate: true } }),
    db.openingBatch.findFirst({ where: { kind: "initial", status: "posted" }, select: { cutoverDate: true } }),
  ]);
  const clearing = await keyBalance(db, "opening_clearing");
  const state = m ? m.status : initial ? "batch" : "none";
  return { final: m ? m.status === "closed" : !!initial, state, cutoverDate: m?.cutoverDate ?? initial?.cutoverDate ?? null, clearing: clearing.toFixed(2) };
}

const audit = (tx: Tx, actor: { id: string | null; name: string; role: string; deviceId?: string }, id: string, action: string, detail: string, reason?: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType: "opening_migration", entityId: id, newValue: detail, reason, source: "user", deviceId: actor.deviceId }, tx);

/** Starts the phased migration at a cut-off date (once; a repeat with the same date returns it). */
export async function startMigration(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ cutover_date: isoDate("تاريخ القطع"), notes: optText("ملاحظات", 1000).optional() }), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, "accounting:opening-batch");
    const existing = await getMigration(tx);
    if (existing) {
      if (existing.cutoverDate === v.cutover_date) return existing;
      throw new ApiError(409, `الترحيل الافتتاحي بدأ بالفعل بتاريخ قطع ${existing.cutoverDate}`);
    }
    const initial = await tx.openingBatch.findFirst({ where: { kind: "initial", status: { not: "cancelled" } }, select: { number: true, status: true } });
    if (initial) throw new ApiError(409, `فيه دفعة افتتاحية واحدة ${initial.status === "posted" ? "مترحّلة" : "مفتوحة"} (${initial.number}) — الترحيل المرحلي بديل عنها مش إضافة ليها`);
    const m = await tx.openingMigration.create({ data: { cutoverDate: v.cutover_date, notes: v.notes ?? null, createdById: actor.id, createdBy: actor.name } });
    await audit(tx, actor, m.id, "opening_migration_started", `cut-off ${v.cutover_date}`);
    return m;
  });
}

async function openMigration(tx: Tx, expectedVersion?: number) {
  const m = await getMigration(tx);
  if (!m) throw new ApiError(404, "الترحيل الافتتاحي مبدأش");
  if (m.status === "closed") throw new ApiError(409, "الترحيل الافتتاحي اتقفل");
  if (expectedVersion !== undefined && expectedVersion !== m.version) throw new ApiError(409, "الترحيل اتعدّل من شخص تاني — حدّث الشاشة");
  return m;
}

/** A person's confirmation (or its withdrawal) of something the data cannot show. */
export async function attest(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ key: z.enum(ATTESTATIONS), confirmed: z.boolean(), note: text("البيان", 500), expected_version: z.number().int() }), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, "accounting:opening-batch");
    const m = await openMigration(tx, v.expected_version);
    if (m.status !== "open") throw new ApiError(409, "طلب القفل مستني الاعتماد — اسحبه الأول");
    const current = { ...((m.attestations ?? {}) as Record<string, Attestation>) };
    if (v.confirmed) current[v.key] = { by: actor.name, byId: actor.id, at: new Date().toISOString(), note: v.note };
    else delete current[v.key];
    const updated = await tx.openingMigration.update({ where: { id: m.id, version: m.version }, data: { attestations: current as Prisma.InputJsonValue, version: { increment: 1 } } });
    await audit(tx, actor, m.id, v.confirmed ? "opening_migration_attested" : "opening_migration_attestation_withdrawn", v.key, v.note);
    return updated;
  });
}

/** Asks a second person to close the migration; refused while any closure check fails. */
export async function requestClosure(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ expected_version: z.number().int(), note: optText("ملاحظات", 500).optional() }), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, "accounting:opening-batch");
    const m = await openMigration(tx, v.expected_version);
    if (m.status !== "open") throw new ApiError(409, "طلب القفل اتبعت بالفعل");
    const f = (await facts(tx))!;
    const s = summarize(f);
    const failing = s.checks.filter((c) => !c.ok);
    if (failing.length) throw new ApiError(409, `مينفعش يتقفل لسه: ${failing.map((c) => c.label).join("؛ ")}`, "opening_migration_not_ready");
    const updated = await tx.openingMigration.update({ where: { id: m.id, version: m.version }, data: { status: "closing", closeRequestedById: actor.id, closeRequestedBy: actor.name, closeRequestedAt: new Date(), version: { increment: 1 } } });
    await requestApproval(tx, { type: "accounting.opening_migration_close", entityId: m.id, title: `قفل الترحيل الافتتاحي (تاريخ القطع ${m.cutoverDate})`, summary: `${s.posted} دفعة مترحّلة · الحساب الوسيط ${f.clearing.toFixed(2)} · كل فحوصات القفل ناجحة`, requester: actor, reason: v.note ?? undefined });
    await audit(tx, actor, m.id, "opening_migration_close_requested", `${s.posted} batches`, v.note ?? undefined);
    return updated;
  });
}

/** Takes the closure request back (to post a forgotten batch, say). */
export async function withdrawClosure(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ reason: text("السبب", 500) }), input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, "accounting:opening-batch");
    const m = await openMigration(tx);
    if (m.status !== "closing") throw new ApiError(409, "مفيش طلب قفل مستني");
    await cancelPendingApproval(tx, { type: "accounting.opening_migration_close", entityId: m.id, reason: v.reason, actor });
    const updated = await tx.openingMigration.update({ where: { id: m.id, version: m.version }, data: { status: "open", closeRequestedById: null, closeRequestedBy: null, closeRequestedAt: null, version: { increment: 1 } } });
    await audit(tx, actor, m.id, "opening_migration_close_withdrawn", m.cutoverDate, v.reason);
    return updated;
  });
}

/** Approval handler: closes the migration for good (checks run again, inside the approval) or returns it to open. */
export async function applyClosureDecision(tx: Tx, id: string, approved: boolean, decider: Decider, comment?: string) {
  await advisoryXactLock(tx, "accounting:opening-batch");
  const m = await tx.openingMigration.findUniqueOrThrow({ where: { id } });
  if (m.status !== "closing") throw new ApiError(409, "الترحيل مش مستني اعتماد القفل");
  if (m.closeRequestedById && m.closeRequestedById === decider.id) throw new ApiError(403, "اللي طلب القفل مينفعش يعتمده");
  if (!approved) {
    await tx.openingMigration.update({ where: { id, version: m.version }, data: { status: "open", closeRequestedById: null, closeRequestedBy: null, closeRequestedAt: null, version: { increment: 1 } } });
    await audit(tx, decider, id, "opening_migration_close_rejected", m.cutoverDate, comment);
    return;
  }
  const f = (await facts(tx))!;
  const s = summarize(f);
  const failing = s.checks.filter((c) => !c.ok);
  if (failing.length) throw new ApiError(409, `فحوصات القفل اتغيّرت من وقت الطلب: ${failing.map((c) => c.label).join("؛ ")} — ارفض الطلب وراجع`, "opening_migration_not_ready");
  const evidence = { checkedAt: new Date().toISOString(), checks: s.checks, clearing: f.clearing.toFixed(2), openingEquity: f.openingEquity.toFixed(2), batches: f.batches.filter((b) => b.status === "posted").map((b) => ({ number: b.number, segment: b.segment, movement: (s.tracedMap.get(b.id) ?? D(0)).toFixed(2) })), approvedBy: decider.name, comment: comment ?? null };
  await tx.openingMigration.update({ where: { id, version: m.version }, data: { status: "closed", closedById: decider.id, closedBy: decider.name, closedAt: new Date(), closeEvidence: evidence as Prisma.InputJsonValue, version: { increment: 1 } } });
  await audit(tx, decider, id, "opening_migration_closed", `${m.cutoverDate} · ${evidence.batches.length} batches`, comment);
}

// ---------------------------------------------------------------------------
// The exception register: source rows that could not be posted, kept with their evidence.

const SEGMENTS = ["suppliers", "customers", "other"] as const;
const money = (label: string) => z.union([z.number(), z.string()]).transform((v, ctx) => {
  const s = typeof v === "number" ? String(v) : v.trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label}: رقم بحد أقصى خانتين عشريتين` }); return z.NEVER; }
  return D(s);
});

export async function listExceptions(filters: { status?: string | null; segment?: string | null }) {
  const m = await getMigration(prisma);
  if (!m) return [];
  const rows = await prisma.openingException.findMany({
    where: { migrationId: m.id, ...(filters.status && ["open", "resolved", "excluded"].includes(filters.status) ? { status: filters.status } : {}), ...(filters.segment && (SEGMENTS as readonly string[]).includes(filters.segment) ? { segment: filters.segment } : {}) },
    orderBy: [{ status: "asc" }, { segment: "asc" }, { sourceFile: "asc" }, { createdAt: "asc" }], take: 2000,
  });
  return rows.map((r) => ({ ...r, sourceAmount: r.sourceAmount.toFixed(2) }));
}

/** Records a question about the source by hand (a figure to decide, a column to place) — kept until decided. */
export async function recordException(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ segment: z.enum(SEGMENTS), source_file: text("ملف المصدر", 200), source_row: text("صف المصدر", 50), source_name: text("الاسم في المصدر", 200), source_amount: money("المبلغ"), reason: z.enum(["no_match", "category_mismatch", "duplicate_party", "party_in_other_batch", "needs_decision"]), detail: optText("التفاصيل", 1000).optional() }), input);
  return inTx(async (tx) => {
    const m = await openMigration(tx);
    try {
      const e = await tx.openingException.create({ data: { migrationId: m.id, segment: v.segment, sourceFile: v.source_file, sourceRow: v.source_row, sourceName: v.source_name, sourceAmount: v.source_amount, reason: v.reason, detail: v.detail ?? null, createdById: actor.id, createdBy: actor.name } });
      await audit(tx, actor, m.id, "opening_exception_recorded", `${v.segment} · ${v.source_file} · ${v.source_row} · ${v.source_amount.toFixed(2)} · ${v.reason}`);
      return e;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ApiError(409, "الصف ده متسجل في الاستثناءات بالفعل");
      throw err;
    }
  });
}

/** Decides an exception: resolved (it was posted, or found to need nothing) or excluded — always with the reason. */
export async function resolveException(id: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(z.object({ status: z.enum(["resolved", "excluded"]), resolution: z.string().trim().min(3, "اكتب القرار وسببه").max(1000), expected_version: z.number().int() }), input);
  return inTx(async (tx) => {
    const m = await openMigration(tx);
    const e = await tx.openingException.findUnique({ where: { id } });
    if (!e || e.migrationId !== m.id) throw new ApiError(404, "الاستثناء مش موجود");
    if (e.status !== "open") throw new ApiError(409, "الاستثناء اتحسم بالفعل");
    if (e.version !== v.expected_version) throw new ApiError(409, "الاستثناء اتعدّل من شخص تاني — حدّث الشاشة");
    const updated = await tx.openingException.update({ where: { id, version: e.version }, data: { status: v.status, resolution: v.resolution, resolvedById: actor.id, resolvedBy: actor.name, resolvedAt: new Date(), version: { increment: 1 } } });
    await audit(tx, actor, m.id, v.status === "resolved" ? "opening_exception_resolved" : "opening_exception_excluded", `${e.segment} · ${e.sourceFile} · ${e.sourceRow} · ${e.sourceAmount.toFixed(2)}`, v.resolution);
    return { ...updated, sourceAmount: updated.sourceAmount.toFixed(2) };
  });
}

// ---------------------------------------------------------------------------
// Importing a party sheet (suppliers or customers) into a phase batch.

const importInput = z.object({
  segment: z.enum(["suppliers", "customers"]),
  mode: z.enum(["preview", "commit"]),
  batch_id: z.string().min(1).optional(),
  source_file: text("ملف المصدر", 200),
  /** Suppliers only: every row must belong to a supplier of this category (a vegetable sheet maps to vegetable suppliers only). */
  category: z.enum(SUPPLIER_CATEGORIES).optional(),
  due_date: isoDate("تاريخ الاستحقاق").optional(),
  rows: z.array(z.object({
    source_row: z.union([z.string(), z.number()]).transform((x) => String(x).trim()).pipe(z.string().min(1, "صف المصدر مطلوب").max(50)),
    source_name: text("الاسم في المصدر", 200),
    party_code: optText("الكود", 50).optional(),
    amount: money("المبلغ"),
  })).min(1, "مفيش صفوف").max(5000, "أقصى 5000 صف في المرة"),
});

type Outcome = "matched" | "zero" | "already_in_migration" | "exception";

/**
 * A sheet of balances: each row names its customer or supplier by the ERP code only (the
 * canonical record) — the name in the sheet is kept as evidence and never used to find a
 * record. Preview says what each row would become; commit adds the matched rows to the draft
 * phase batch with their evidence and records the others in the exception register, in one
 * transaction. Running the same sheet again changes nothing (rows already in, exceptions
 * already recorded). Zero balances post nothing and are listed as such.
 */
export async function importPartyRows(input: unknown, actor: ServiceActor) {
  assertPermission(actor, "accounting.manage");
  const v = parse(importInput, input);
  if (v.category && v.segment !== "suppliers") throw new ApiError(400, "الفئة للموردين بس");
  const rowKeys = new Set<string>();
  for (const r of v.rows) {
    if (rowKeys.has(r.source_row)) throw new ApiError(400, `صف المصدر ${r.source_row} متكرر في الملف`);
    rowKeys.add(r.source_row);
  }
  const run = async (tx: Tx) => {
    await advisoryXactLock(tx, "accounting:opening-migration:lines");
    const m = await openMigration(tx);
    if (m.status !== "open") throw new ApiError(409, "طلب قفل الترحيل مستني الاعتماد");
    let batch: { id: string; number: string; sourceFile: string | null } | null = null;
    if (v.mode === "commit" || v.batch_id) {
      if (!v.batch_id) throw new ApiError(400, "اختار الدفعة اللي الصفوف هتتضاف لها");
      const b = await tx.openingBatch.findUnique({ where: { id: v.batch_id } });
      if (!b || b.migrationId !== m.id || b.kind !== "phase") throw new ApiError(404, "الدفعة مش من الترحيل الافتتاحي");
      if (b.segment !== v.segment) throw new ApiError(400, "قسم الدفعة غير قسم الملف");
      if (b.status !== "draft") throw new ApiError(409, "الدفعة اتبعتت للاعتماد — السطور مقفولة");
      if (b.sourceFile && b.sourceFile !== v.source_file) throw new ApiError(400, `الدفعة دي لملف ${b.sourceFile}`);
      batch = { id: b.id, number: b.number, sourceFile: b.sourceFile };
    }
    const kind = v.segment === "suppliers" ? "supplier" : "customer";
    const codes = [...new Set(v.rows.map((r) => r.party_code).filter((c): c is string => !!c))];
    const parties = new Map<string, { id: string; code: string; name: string; nameAr: string | null; category: string | null; active: boolean }>();
    if (kind === "supplier") for (const p of await tx.supplier.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, name: true, nameAr: true, category: true, active: true } })) parties.set(p.code, p);
    else for (const p of await tx.customer.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, name: true, nameAr: true, active: true } })) parties.set(p.code, { ...p, category: null });
    // Already in the migration: the same source row in any live batch, or the party carried by another live batch.
    const lines = await tx.openingBatchLine.findMany({ where: { batch: { migrationId: m.id, status: { not: "cancelled" } } }, select: { kind: true, data: true, lineNo: true, batchId: true, batch: { select: { number: true, sourceFile: true } } } });
    const takenRows = new Map<string, string>();
    const takenParties = new Map<string, string>();
    for (const l of lines) {
      const d = l.data as { source_file?: string; source_row?: string; party_id?: string };
      const k = sourceKey(d, l.batch.sourceFile);
      if (k) takenRows.set(k, `${l.batch.number}#${l.lineNo}`);
      if (l.kind === kind && d.party_id && l.batchId !== batch?.id) takenParties.set(d.party_id, `${l.batch.number}#${l.lineNo}`);
    }
    const existing = new Map((await tx.openingException.findMany({ where: { migrationId: m.id, segment: v.segment, sourceFile: v.source_file } })).map((e) => [e.sourceRow, e]));
    const perCode = new Map<string, number>();
    for (const r of v.rows) if (r.party_code && !r.amount.isZero()) perCode.set(r.party_code, (perCode.get(r.party_code) ?? 0) + 1);

    const results: { source_row: string; source_name: string; party_code: string | null; amount: string; outcome: Outcome; reason?: string; detail?: string; party?: { id: string; code: string; name: string; nameAr: string | null; category: string | null } }[] = [];
    for (const r of v.rows) {
      const base = { source_row: r.source_row, source_name: r.source_name, party_code: r.party_code ?? null, amount: r.amount.toFixed(2) };
      const k = `${v.source_file} · ${r.source_row}`;
      if (takenRows.has(k)) { results.push({ ...base, outcome: "already_in_migration", detail: takenRows.get(k) }); continue; }
      if (r.amount.isZero()) { results.push({ ...base, outcome: "zero" }); continue; }
      const p = r.party_code ? parties.get(r.party_code) : undefined;
      const exception = (reason: string, detail: string) => results.push({ ...base, outcome: "exception", reason, detail, ...(p ? { party: { id: p.id, code: p.code, name: p.name, nameAr: p.nameAr, category: p.category } } : {}) });
      if (!r.party_code) { exception("no_match", "مفيش كود في الصف — الاسم وحده مش دليل على الهوية"); continue; }
      if (!p) { exception("no_match", `مفيش ${kind === "supplier" ? "مورد" : "عميل"} بالكود ${r.party_code}`); continue; }
      if (v.category && p.category !== v.category) { exception("category_mismatch", `${p.code} فئته ${p.category ?? "غير مصنّف"} مش ${v.category}`); continue; }
      if ((perCode.get(r.party_code) ?? 0) > 1) { exception("duplicate_party", `الكود ${r.party_code} على أكتر من صف — رصيد واحد لكل ${kind === "supplier" ? "مورد" : "عميل"}`); continue; }
      if (takenParties.has(p.id)) { exception("party_in_other_batch", `${p.code} له رصيد في ${takenParties.get(p.id)}`); continue; }
      results.push({ ...base, outcome: "matched", party: { id: p.id, code: p.code, name: p.name, nameAr: p.nameAr, category: p.category } });
    }
    const sum = (o: Outcome) => results.filter((x) => x.outcome === o).reduce((s, x) => s.plus(x.amount), D(0)).toFixed(2);
    const count = (o: Outcome) => results.filter((x) => x.outcome === o).length;
    const summary = {
      rows: results.length, total: results.reduce((s, x) => s.plus(x.amount), D(0)).toFixed(2),
      matched: count("matched"), matchedAmount: sum("matched"), exceptions: count("exception"), exceptionAmount: sum("exception"),
      zero: count("zero"), alreadyInMigration: count("already_in_migration"), alreadyAmount: sum("already_in_migration"),
      newExceptions: results.filter((x) => x.outcome === "exception" && !existing.has(x.source_row)).length,
    };
    if (v.mode === "preview") return { mode: "preview" as const, batch, summary, rows: results };

    const matched = results.filter((x) => x.outcome === "matched");
    if (matched.length) {
      await addLinesInTx(tx, batch!.id, matched.map((x): LineInput => ({
        kind, party_id: x.party!.id, amount: new Prisma.Decimal(x.amount), ...(v.due_date ? { due_date: v.due_date } : {}),
        reference: `${v.source_file} · ${x.source_row}`.slice(0, 100), source_file: v.source_file, source_row: x.source_row, source_name: x.source_name, source_amount: new Prisma.Decimal(x.amount),
      })), actor);
    }
    // A row recorded as an exception earlier and matched now (its ERP code was found): decided by the match.
    for (const x of matched) {
      const e = existing.get(x.source_row);
      if (e?.status === "open") await tx.openingException.update({ where: { id: e.id, version: e.version }, data: { status: "resolved", resolution: `اتطابق بالكود ${x.party!.code} واتضاف لدفعة ${batch!.number}`, resolvedById: actor.id, resolvedBy: actor.name, resolvedAt: new Date(), version: { increment: 1 } } });
    }
    const fresh = results.filter((x) => x.outcome === "exception" && !existing.has(x.source_row));
    if (fresh.length) await tx.openingException.createMany({ data: fresh.map((x) => ({ migrationId: m.id, segment: v.segment, sourceFile: v.source_file, sourceRow: x.source_row, sourceName: x.source_name, sourceAmount: new Prisma.Decimal(x.amount), reason: x.reason!, detail: x.detail ?? null, createdById: actor.id, createdBy: actor.name })), skipDuplicates: true });
    if (!batch!.sourceFile) await tx.openingBatch.update({ where: { id: batch!.id }, data: { sourceFile: v.source_file } });
    await audit(tx, actor, m.id, "opening_rows_imported", `${batch!.number} · ${v.source_file} · ${summary.matched} matched ${summary.matchedAmount} · ${summary.newExceptions} new exceptions · ${summary.zero} zero · ${summary.alreadyInMigration} already in`);
    return { mode: "commit" as const, batch, summary, rows: results };
  };
  return inTx(run);
}

/** The opening position as posted so far, for export: per account, and per party (customers and suppliers). */
export async function openingPositionExport() {
  const m = await getMigration(prisma);
  if (!m) throw new ApiError(404, "الترحيل الافتتاحي مبدأش");
  const accounts = await prisma.$queryRaw<{ code: string; nameAr: string; name: string; v: Prisma.Decimal }[]>`
    SELECT a."code", a."nameAr", a."name", sum(l."debit" - l."credit") AS v
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE e."date" <= ${m.cutoverDate}
    GROUP BY a."code", a."nameAr", a."name" HAVING sum(l."debit" - l."credit") <> 0 ORDER BY a."code"`;
  const parties = await prisma.$queryRaw<{ partyType: string; code: string | null; name: string | null; batch: string | null; v: Prisma.Decimal }[]>`
    SELECT o."partyType", coalesce(c."code", s."code") AS code, coalesce(c."name", s."name") AS name, b."number" AS batch, sum(o."amount") AS v
    FROM "PartyOpeningBalance" o LEFT JOIN "Customer" c ON o."partyType" = 'customer' AND c."id" = o."partyId" LEFT JOIN "Supplier" s ON o."partyType" = 'supplier' AND s."id" = o."partyId"
    LEFT JOIN "OpeningBatch" b ON b."id" = o."openingBatchId"
    GROUP BY 1, 2, 3, 4 ORDER BY 1, 2`;
  return { cutoverDate: m.cutoverDate, status: m.status, accounts: accounts.map((a) => ({ ...a, v: D(a.v).toFixed(2) })), parties: parties.map((p) => ({ ...p, v: D(p.v).toFixed(2) })) };
}
