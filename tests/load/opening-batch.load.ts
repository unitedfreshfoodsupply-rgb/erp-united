/**
 * Load test: approving a large phase batch of the opening migration on production latency
 * (Nov 2026). Production is a VPS talking to Supabase through the eu-west-1 pooler, ~37 ms per
 * round trip, one connection per process; a 49-line suppliers batch took ~30 s to approve and
 * died at the 20 s transaction limit. Not part of test:e2e; run by hand on a disposable LOCAL
 * database:
 *
 *   setup:   tsx tests/load/opening-batch.load.ts setup <suppliers|customers> <lines> <out.json>
 *   measure: PRISMA_LOG_QUERIES=1 tsx tests/load/opening-batch.load.ts measure <out.json> [proxyStats.json]
 *
 * setup (direct to the database) starts the migration if it has not started, creates <lines> new
 * suppliers or customers, then a phase batch with one line each (amounts with cents, a few
 * negative), adds and submits it as the preparer. measure (DATABASE_URL pointing at
 * tests/load/pg-latency-proxy.mjs, ?connection_limit=1 like production) approves it as a second
 * user through decideApproval — the inbox path — and reports the time, the queries Prisma sent
 * and the round trips the proxy counted. It then checks what an approval must leave: the batch
 * posted once, one open item and one balanced two-line entry per line naming the party, the
 * clearing account moved by exactly the batch's total, the audit rows, AR/AP = their
 * sub-ledgers party by party; or, when the approval failed, nothing written at all.
 */
import fs from "node:fs";
import { assertTestDatabase } from "../_guard";
assertTestDatabase();

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { todayLocalISO } from "@/lib/localDate";
import { createCustomer } from "@/lib/sales/customers";
import { createSupplierFull } from "@/lib/purchasing/suppliers";
import { startMigration } from "@/lib/accounting/opening-migration";
import { addLines, createBatch, submitBatch } from "@/lib/accounting/opening-batches";
import { integrityReport } from "@/lib/accounting/integrity";
import { decideApproval } from "@/lib/core/approval-handlers";

type Segment = "suppliers" | "customers";
type Setup = { tag: string; segment: Segment; lines: number; batchId: string; number: string; total: string; requestId: string; checkerId: string };
const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);

async function users() {
  const [u1, u2] = await prisma.user.findMany({ where: { active: true }, orderBy: { username: "asc" }, take: 2, select: { id: true, name: true } });
  const as = (u: { id: string; name: string }) => ({ id: u.id, name: u.name, role: "SUPER_ADMIN" as const, permissions: ROLE_PERMISSIONS.SUPER_ADMIN as string[], source: "user" as const });
  return { prep: as(u1), checker: as(u2) };
}

/** Deterministic, varied amounts: cents on every line, every 9th one negative (an advance / a debit balance). */
const amount = (i: number) => { const v = D(1000 + ((i * 7919) % 250000)).plus(D((i * 37) % 100).div(100)); return i % 9 === 8 ? v.negated() : v; };

async function setup(segment: Segment, lines: number, out: string) {
  if (segment !== "suppliers" && segment !== "customers") throw new Error("segment: suppliers | customers");
  const { prep } = await users();
  const t0 = Date.now();
  const tag = `ZZOBL${t0}`;
  const m = await prisma.openingMigration.findUnique({ where: { key: "opening" } });
  if (!m) await startMigration({ cutover_date: todayLocalISO(), notes: "load test" }, prep as never);
  else if (m.status !== "open") throw new Error(`the migration on this database is ${m.status}: use a fresh database`);
  const codes: string[] = [];
  for (let i = 0; i < lines; i++) {
    const p = segment === "suppliers"
      ? await createSupplierFull({ name: `${tag} مورد ${i + 1}`, category: "vegetable" }, prep as never)
      : await createCustomer({ name: `${tag} عميل ${i + 1}` }, prep as never);
    codes.push(p.code!);
  }
  const b = await createBatch({ kind: "phase", segment, source_file: `${tag}.xlsx` }, prep as never);
  await addLines(b.id, { lines: codes.map((code, i) => ({ kind: segment === "suppliers" ? "supplier" : "customer", party_code: code, amount: amount(i).toFixed(2), source_row: String(i + 2), source_name: `${tag} ${i + 1}`, source_amount: amount(i).toFixed(2) })) }, prep as never);
  await submitBatch(b.id, prep as never);
  const r = await prisma.approvalRequest.findFirstOrThrow({ where: { entityId: b.id, status: "pending" } });
  const { checker } = await users();
  const total = codes.reduce((s, _c, i) => s.plus(amount(i)), D(0));
  const s: Setup = { tag, segment, lines, batchId: b.id, number: b.number, total: total.toFixed(2), requestId: r.id, checkerId: checker.id };
  fs.writeFileSync(out, JSON.stringify(s));
  console.log(JSON.stringify({ setup: { tag, segment, lines, batch: b.number, seconds: (Date.now() - t0) / 1000 } }));
}

const readStats = (file?: string) => { try { return file ? (JSON.parse(fs.readFileSync(file, "utf8")) as { roundTrips: number; rttMs: number }) : null; } catch { return null; } };
const flushed = () => new Promise((r) => setTimeout(r, 450)); // the proxy writes its stats every 200 ms

async function measure(file: string, statsFile?: string) {
  const s: Setup = JSON.parse(fs.readFileSync(file, "utf8"));
  const { checker } = await users();
  if (checker.id !== s.checkerId) throw new Error("checker changed since setup");
  let queries = 0;
  (prisma as unknown as { $on: (e: "query", cb: () => void) => void }).$on("query", () => { queries++; });
  await prisma.user.count(); // warm the connection
  const req = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: s.requestId } });
  await flushed();
  const rt0 = readStats(statsFile)?.roundTrips;
  const q0 = queries;
  const t0 = performance.now();
  let error: string | null = null;
  try {
    await decideApproval(s.requestId, "approve", checker as never, { expectedVersion: req.version });
  } catch (err) {
    error = `${(err as { code?: string }).code ?? ""} ${(err as Error).message}`.replace(/\s+/g, " ").slice(0, 300);
  }
  const ms = Math.round(performance.now() - t0);
  const approvalQueries = queries - q0;
  await flushed();
  const stats = readStats(statsFile);
  const roundTrips = stats && rt0 !== undefined ? stats.roundTrips - rt0 : null;

  // What the approval left.
  const b = await prisma.openingBatch.findUniqueOrThrow({ where: { id: s.batchId } });
  const rows = await prisma.partyOpeningBalance.findMany({ where: { openingBatchId: s.batchId }, select: { id: true, partyType: true, partyId: true, amount: true } });
  const entries = await prisma.journalEntry.findMany({ where: { sourceType: "opening_balance", sourceId: { in: rows.map((r) => r.id) } }, include: { lines: { include: { account: { select: { systemKey: true } } } } } });
  const bySource = new Map(entries.map((e) => [e.sourceId, e]));
  const kind = s.segment === "suppliers" ? "supplier" : "customer";
  const partyKey = s.segment === "suppliers" ? "ap" : "ar";
  let entryShapeOk = entries.length === rows.length;
  for (const r of rows) {
    const e = bySource.get(r.id);
    const party = e?.lines.find((l) => l.account.systemKey === partyKey);
    const other = e?.lines.find((l) => l.account.systemKey === "opening_clearing");
    const signed = kind === "customer" ? D(r.amount) : D(r.amount).negated(); // debit-positive effect on AR/AP
    if (!e || e.lines.length !== 2 || !party || !other || party.partyType !== kind || party.partyId !== r.partyId
      || !D(party.debit).minus(D(party.credit)).equals(signed) || !D(other.debit).minus(D(other.credit)).equals(signed.negated())
      || !D(e.total).equals(signed.abs())) entryShapeOk = false;
  }
  const numbers = entries.map((e) => e.number);
  const [clearing] = await prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT sum(l."debit" - l."credit") AS v FROM "JournalLine" l JOIN "Account" a ON a."id" = l."accountId" JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE a."systemKey" = 'opening_clearing' AND e."sourceType" = 'opening_balance' AND e."sourceId" = ANY(${rows.map((r) => r.id)})`;
  const expectedClearing = kind === "customer" ? D(s.total).negated() : D(s.total);
  const audits = await prisma.auditLog.groupBy({ by: ["action"], where: { OR: [{ entityType: "opening_batch", entityId: s.batchId }, { entityType: "journal_entry", entityId: { in: [...rows.map((r) => r.id), ...entries.map((e) => e.id)] } }] }, _count: { _all: true } });
  const auditCount = (a: string) => audits.find((x) => x.action === a)?._count._all ?? 0;
  const integrity = await integrityReport();
  const check = (key: string) => (integrity as { checks: { key: string; ok: boolean }[] }).checks.find((c) => c.key === key)?.ok ?? null;

  console.log(JSON.stringify({
    segment: s.segment, lines: s.lines, batch: s.number, rttMs: stats?.rttMs ?? null,
    approval: { ok: error === null, ms, queries: approvalQueries, roundTrips, error },
    checks: {
      status: b.status,
      openItems: rows.length,
      openItemsTotal: rows.reduce((t, r) => t.plus(r.amount), D(0)).toFixed(2),
      expectedTotal: s.total,
      entries: entries.length,
      entryShapeOk,
      entryNumbersUnique: new Set(numbers).size === numbers.length,
      clearingMoved: D(clearing?.v).toFixed(2),
      clearingExpected: error === null ? expectedClearing.toFixed(2) : "0.00",
      audit: { journal_posted: auditCount("journal_posted"), opening_balance_recorded: auditCount("opening_balance_recorded"), opening_batch_posted: auditCount("opening_batch_posted") },
      integrity: { trial_balance: check("trial_balance"), ar: check("ar"), ap: check("ap"), traceable: check("traceable"), party_references: check("party_references") },
    },
  }));
}

const [mode, a, b, c] = process.argv.slice(2);
(mode === "setup" ? setup(a as Segment, Number(b), c) : mode === "measure" ? measure(a, b) : Promise.reject(new Error("mode: setup | measure")))
  .then(() => prisma.$disconnect())
  .catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
