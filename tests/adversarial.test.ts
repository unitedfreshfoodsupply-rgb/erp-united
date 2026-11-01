/* Adversarial scenarios against the accounting extensions: what a busy office, a double
   click, a retrying network or a careless user does to them.
     - the same request fired many times at once (approvals, depreciation runs, VAT filings,
       year closes, transfer reversals, disposals, idempotent transfers);
     - writers racing each other on shared state (draining a cash box, posting VAT into a
       period while its return is filed, posting into a month while it is closed, running
       a month's depreciation while the month is closed);
     - invalid, negative, over-precise and absurd amounts; dates out of range;
     - every new write endpoint called by someone without the permission.
   Expectations: exactly one winner where one is right, clean 4xx for the losers (never a
   500 or a deadlock), and books that still reconcile afterwards. */
import { Prisma, PrismaClient } from "@prisma/client";
import { call, login, makeChecker, type Res } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { todayBiz } from "./_days";

const TAG = `ZZADV${Date.now() % 1_000_000_000}`;
const SUF = String(Date.now()).slice(-6);
const { check, section, finish } = makeChecker();
const n = (v: unknown) => Number(v ?? 0);
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const statuses = (rs: Res[]) => rs.map((r) => r.status).sort().join(",");
const no5xx = (rs: Res[]) => rs.every((r) => r.status < 500);
const count = (rs: Res[], s: number | ((x: number) => boolean)) => rs.filter((r) => (typeof s === "number" ? r.status === s : s(r.status))).length;

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  for (const u of ["admin", "karim", "mona", "omar", "mostafa"]) await login(u);
  const today = todayBiz();
  const balanceOf = async (accountId: string) => { const [r] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`SELECT sum("debit" - "credit") AS b FROM "JournalLine" WHERE "accountId" = ${accountId}`; return n(r?.b); };
  const pendingFor = async (entityId: string) => (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === entityId);

  section("1. A CASH BOX DRAINED BY PARALLEL TRANSFERS NEVER GOES NEGATIVE");
  const box = (await call("karim", "POST", "/api/accounting/cash-accounts", { type: "cash", name: `${TAG} box`, name_ar: `${TAG} خزنة` })).body.cashAccount;
  const bank = (await call("karim", "POST", "/api/accounting/cash-accounts", { type: "bank", name: `${TAG} bank`, name_ar: `${TAG} بنك`, bank_name: "T" })).body.cashAccount;
  check("a fresh cash box and bank", !!box?.id && !!bank?.id, [box, bank]);
  let r = await call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: "bank_main", to_cash_account_id: box.id, amount: "1000", date: today });
  if (r.status === 202 || r.body.transfer?.status === "pending_approval") { const a = await pendingFor(r.body.transfer.id); await call("admin", "POST", `/api/approvals/${a.id}/decide`, { decision: "approve", expected_version: a.version }); }
  check("the box holds 1000", (await balanceOf(box.accountId)) === 1000, await balanceOf(box.accountId));
  const drain = await Promise.all(Array.from({ length: 6 }, (_, i) => call("karim", "POST", "/api/accounting/transfers", { from_cash_account_id: box.id, to_cash_account_id: bank.id, amount: "300", date: today, reference: `${TAG}-d${i}` })));
  check("6 parallel transfers of 300 out of 1000: exactly 3 go through, the rest are refused (409)", count(drain, 201) === 3 && count(drain, 409) === 3, statuses(drain));
  check("…the box ends at 100, never below zero", (await balanceOf(box.accountId)) === 100, await balanceOf(box.accountId));

  section("2. THE SAME TRANSFER SUBMITTED 5 TIMES AT ONCE (ONE IDEMPOTENCY KEY)");
  const body = { from_cash_account_id: "bank_main", to_cash_account_id: bank.id, amount: "250", date: today, idempotency_key: `${TAG}-idem` };
  const same = await Promise.all(Array.from({ length: 5 }, () => call("karim", "POST", "/api/accounting/transfers", body)));
  const ids = new Set(same.filter((x) => x.status < 300).map((x) => x.body.transfer?.id));
  check("one transfer, every answer names it, no error", ids.size === 1 && no5xx(same) && count(same, (s) => s >= 400) === 0, statuses(same));
  check("…posted once in the journal", (await db.journalEntry.count({ where: { sourceType: "cash_transfer", sourceId: [...ids][0] } })) === 1);
  const tid = [...ids][0];
  const revs = await Promise.all(Array.from({ length: 4 }, () => call("karim", "POST", `/api/accounting/transfers/${tid}/reverse`, { reason: `${TAG} مكرر` })));
  check("4 parallel reversals: one succeeds, the others 409", count(revs, 200) === 1 && count(revs, 409) === 3, statuses(revs));
  check("…one reversing entry", (await db.journalEntry.count({ where: { sourceType: "cash_transfer_reversal", sourceId: tid } })) === 1);

  section("3. ONE APPROVAL DECIDED TWICE AT ONCE");
  await call("admin", "PATCH", "/api/admin/settings/accounting.manual_journal_approval", { value: true, reason: `${TAG} اختبار` });
  await call("admin", "PATCH", "/api/admin/settings/accounting.manual_journal_approval_threshold", { value: 100, reason: `${TAG} اختبار` });
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} يحتاج اعتماد`, lines: [{ account_id: "acc_6100", debit: 500 }, { account_id: "acc_1200", credit: 500 }] });
  const jr = r.body.journalRequest;
  check("a manual journal over the threshold waits (202)", r.status === 202 && !!jr?.id, r.body);
  const ap = await pendingFor(jr.id);
  const dec = await Promise.all([1, 2, 3].map(() => call("admin", "POST", `/api/approvals/${ap.id}/decide`, { decision: "approve", expected_version: ap.version })));
  check("3 parallel approvals: one 200, the others 409, no 500", count(dec, 200) === 1 && count(dec, 409) === 2, statuses(dec));
  check("…exactly one journal posted for it", (await db.journalEntry.count({ where: { sourceType: "manual", description: `${TAG} يحتاج اعتماد` } })) === 1);
  await call("admin", "PATCH", "/api/admin/settings/accounting.manual_journal_approval", { value: null, reason: `${TAG} اختبار` });
  await call("admin", "PATCH", "/api/admin/settings/accounting.manual_journal_approval_threshold", { value: null, reason: `${TAG} اختبار` });

  section("4. DEPRECIATION RUN FIRED 5 TIMES; DISPOSAL FIRED 3 TIMES");
  const cat = (await call("karim", "POST", "/api/assets/categories", { code: `AD${SUF}`, name: `${TAG} Tools`, name_ar: `${TAG} عدد`, useful_life_months: 10, residual_percent: 0, depreciation_start: "same_month" })).body.category;
  const prev = (() => { const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  const a1 = (await call("karim", "POST", "/api/assets", { category_id: cat.id, name: `${TAG} مكبس`, cost: "1000", acquisition_date: `${prev}-01`, in_service_date: `${prev}-01`, cash_account_id: "bank_main" })).body.asset;
  check("an asset in service since last month", a1?.status === "in_service", a1);
  const runsBefore = await db.depreciationRun.count({ where: { period: prev } });
  const dep = await Promise.all(Array.from({ length: 5 }, () => call("karim", "POST", "/api/assets/depreciation", { period: prev })));
  check("5 parallel runs for the month: one 201, the rest 409 (nothing more due), no 500", count(dep, 201) === 1 && count(dep, 409) === 4, statuses(dep));
  check("…one run, one month of depreciation on the asset (100)", (await db.depreciationRun.count({ where: { period: prev } })) === runsBefore + 1 && (await db.assetDepreciationLine.count({ where: { assetId: a1.id } })) === 1 && n((await db.fixedAsset.findUnique({ where: { id: a1.id } }))?.accumulated) === 100);
  const disp = await Promise.all([1, 2, 3].map(() => call("karim", "POST", `/api/assets/${a1.id}/dispose`, { kind: "sale", date: today, proceeds: "950", cash_account_id: "bank_main", reason: `${TAG} بيع` })));
  check("3 parallel disposals: one 201/200, the others 409", count(disp, (s) => s === 200 || s === 201) === 1 && count(disp, 409) === 2, statuses(disp));
  check("…one disposal event and entry", (await db.assetEvent.count({ where: { assetId: a1.id, type: "disposal" } })) === 1);

  section("4b. A DEPRECIATION RUN REVERSED (AND RUN AGAIN)");
  const prev2 = (() => { const d = new Date(`${prev}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  const a2 = (await call("karim", "POST", "/api/assets", { category_id: cat.id, name: `${TAG} رافعة`, cost: "2000", acquisition_date: `${prev2}-01`, in_service_date: `${prev2}-01`, cash_account_id: "bank_main" })).body.asset;
  const r1 = (await call("karim", "POST", "/api/assets/depreciation", { period: prev2 })).body.run;
  const r2 = (await call("karim", "POST", "/api/assets/depreciation", { period: prev })).body.run;
  const acc = async () => n((await db.fixedAsset.findUnique({ where: { id: a2.id } }))?.accumulated);
  check("an asset depreciated two months (200 + 200)", !!r1?.id && !!r2?.id && (await acc()) === 400, [r1, r2, await acc()]);
  const rvEarly = await call("karim", "POST", `/api/assets/depreciation/runs/${r1.id}/reverse`, { reason: `${TAG} عمر خاطئ` });
  check("the earlier run cannot be reversed while a later month stands -> 409", rvEarly.status === 409, rvEarly.body);
  check("a reason is required (10+ characters) -> 400", (await call("karim", "POST", `/api/assets/depreciation/runs/${r2.id}/reverse`, { reason: "غلط" })).status === 400);
  check("sales cannot reverse -> 403", (await call("mona", "POST", `/api/assets/depreciation/runs/${r2.id}/reverse`, { reason: `${TAG} عمر خاطئ` })).status === 403);
  const twice = await Promise.all([1, 2].map(() => call("karim", "POST", `/api/assets/depreciation/runs/${r2.id}/reverse`, { reason: `${TAG} عمر خاطئ للأصل` })));
  check("the later run reversed (2 parallel requests: one 200, one 409)", count(twice, 200) === 1 && count(twice, 409) === 1, statuses(twice));
  check("…the asset is back to one month (200)", (await acc()) === 200, await acc());
  const rev = await db.depreciationRun.findUnique({ where: { id: r2.id } });
  const revLines = await db.journalLine.findMany({ where: { entryId: rev?.reversalEntryId ?? "x" } });
  const origLines = await db.journalLine.findMany({ where: { entryId: r2.entryId } });
  check("…the reversing entry mirrors the run's entry", revLines.length === origLines.length && origLines.every((o) => revLines.some((x) => x.accountId === o.accountId && n(x.debit) === n(o.credit) && n(x.credit) === n(o.debit) && x.costCenterId === o.costCenterId)), [origLines.length, revLines.length]);
  const again = await call("karim", "POST", "/api/assets/depreciation", { period: prev });
  check("the month can be depreciated again -> 201, asset back at 400", again.status === 201 && (await acc()) === 400, [again.status, await acc()]);
  let refusedDb = false;
  try { await db.$executeRawUnsafe(`UPDATE "AssetDepreciationLine" SET "reversed" = false WHERE "runId" = '${r2.id}'`); } catch { refusedDb = true; }
  check("DB: a reversed line cannot be brought back", refusedDb);
  refusedDb = false;
  try { await db.$executeRawUnsafe(`UPDATE "FixedAsset" SET "accumulated" = 0 WHERE "id" = '${a2.id}'`); } catch { refusedDb = true; }
  check("DB: accumulated depreciation cannot be lowered by hand", refusedDb);
  refusedDb = false;
  try { await db.$executeRawUnsafe(`UPDATE "AssetDepreciationLine" SET "reversed" = true WHERE "runId" = '${r1.id}'`); } catch { refusedDb = true; }
  check("DB: a line cannot be marked reversed without its run", refusedDb);

  section("5. VAT RETURN FILED WHILE BILLS ARE POSTED INTO ITS PERIOD");
  const vat = (await call("karim", "GET", "/api/accounting/vat-returns")).body;
  const P1 = vat.nextFrom ?? "2025-01-01", P2 = addDays(P1, 2);
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const bills: string[] = [];
  for (let i = 0; i < 4; i++) {
    const b = (await call("karim", "POST", "/api/purchasing/bills", { kind: "service", supplier_id: supplier.id, supplier_invoice_no: `${TAG}-v${i}`, bill_date: P1, lines: [{ account_id: "acc_6100", description: "خدمة", amount: "100", tax_code: "VAT14" }] })).body.bill;
    bills.push(b.id);
  }
  // Service bills wait for approval at the default threshold: queue the approvals, then race
  // their posting (by the approver) against the filing of the return for that period.
  for (const id of bills) await call("karim", "POST", `/api/purchasing/bills/${id}/post`, {});
  const approvals = await Promise.all(bills.map(pendingFor));
  const race = await Promise.all([
    ...approvals.map((a: any) => a ? call("admin", "POST", `/api/approvals/${a.id}/decide`, { decision: "approve", expected_version: a.version }) : Promise.resolve({ status: 0, body: null } as Res)),
    call("karim", "POST", "/api/accounting/vat-returns", { period_from: P1, period_to: P2 }),
  ]);
  check("bills and the filing race: no 500, no deadlock", no5xx(race), statuses(race));
  const ret = await db.vatReturn.findFirst({ where: { periodFrom: P1, periodTo: P2, status: { not: "voided" } } });
  if (ret) {
    // Whatever won the race, the return must equal the ledger as it stands now (its own
    // settlement aside): a bill that posted after the return read the balances would show here.
    const [inp] = await db.$queryRaw<{ b: Prisma.Decimal | null }[]>`
      SELECT sum(l."debit" - l."credit") AS b FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
      WHERE a."systemKey" = 'vat_input' AND e."date" <= ${P2} AND e."id" IS DISTINCT FROM ${ret.entryId}`;
    check("the return's input VAT = the ledger's input VAT at its end date now (nothing slipped in)", Math.abs(n(ret.inputTax) - n(inp?.b)) < 0.005, [ret.inputTax, inp?.b]);
    const decided = race.slice(0, approvals.length);
    check("…each bill either posted or was refused with 409", decided.every((x) => x.status === 200 || x.status === 409), statuses(decided));
    const vd = await call("karim", "POST", `/api/accounting/vat-returns/${ret.id}/void`, { reason: `${TAG} إلغاء بعد الاختبار` });
    check(`…and it can be voided afterwards (${ret.status === "paid" ? "a nil return" : "unpaid"}) -> 200`, vd.status === 200, [vd.status, vd.body]);
  } else check("the filing lost the race cleanly (409)", race[race.length - 1].status === 409, race[race.length - 1].body);

  section("6. POSTINGS RACING A MONTH CLOSE; DEPRECIATION RACING THE SAME CLOSE");
  // Months close in order: close every open month before 2016 (isolated test DB), then race
  // on the first 2016 month still open.
  const months2016 = await db.accountingPeriod.findMany({ where: { code: { gte: "2016-01", lte: "2016-12" } } });
  const M = Array.from({ length: 12 }, (_, i) => `2016-${String(i + 1).padStart(2, "0")}`).find((m) => months2016.find((p) => p.code === m)?.status !== "closed");
  for (const p of await db.accountingPeriod.findMany({ where: { status: "open", code: { lt: M ?? "2016-01" } }, orderBy: { code: "asc" } })) await call("karim", "POST", `/api/accounting/periods/${p.code}/close`, {});
  if (M && !(await db.accountingPeriod.findFirst({ where: { status: "open", code: { lt: M } } }))) {
    const posts = Array.from({ length: 8 }, (_, i) => call("karim", "POST", "/api/accounting/journals", { date: `${M}-15`, description: `${TAG} سباق ${i}`, lines: [{ account_id: "acc_6100", debit: 10 }, { account_id: "acc_1200", credit: 10 }] }));
    const closeIt = call("karim", "POST", `/api/accounting/periods/${M}/close`, {});
    const depIt = call("karim", "POST", "/api/assets/depreciation", { period: M });
    const all = await Promise.all([...posts, closeIt, depIt]);
    check(`8 postings + depreciation + the close of ${M} at once: no 500 / deadlock`, no5xx(all), statuses(all));
    const p = await db.accountingPeriod.findUnique({ where: { code: M } });
    check("…the month is closed", p?.status === "closed", p);
    const late = await db.journalEntry.count({ where: { date: { startsWith: M }, createdAt: { gt: p!.closedAt! } } });
    check("…every posting either landed before the close or was refused (409)", late === 0 && all.slice(0, 8).every((x) => x.status === 201 || x.status === 409), [late, statuses(all.slice(0, 8))]);
  } else console.log(`  info: section 6 found no open 2016 month with every earlier month closed — skipped`);

  section("7. A YEAR CLOSED 3 TIMES AT ONCE");
  const fy2014 = await db.fiscalYear.findUnique({ where: { code: "2014" } });
  if (fy2014?.status !== "closed") {
    const yc = await Promise.all([1, 2, 3].map(() => call("karim", "POST", "/api/accounting/fiscal-years/2014/close", {})));
    check("one 200, the others 409; no 500", count(yc, 200) === 1 && count(yc, 409) === 2, statuses(yc));
    const y = await db.fiscalYear.findUnique({ where: { code: "2014" } });
    check("…closed once (closeCount 1, at most one closing entry)", y?.status === "closed" && y.closeCount === 1 && (await db.journalEntry.count({ where: { sourceType: "year_end_close", sourceId: { startsWith: `${y.id}:` } } })) <= 1, y);
  } else console.log("  info: 2014 already closed by an earlier run — skipped");

  section("8. INVALID, NEGATIVE, OVER-PRECISE AND ABSURD INPUT");
  const bad = [
    ["transfer: negative", "/api/accounting/transfers", { from_cash_account_id: "bank_main", to_cash_account_id: bank.id, amount: "-5", date: today }],
    ["transfer: zero", "/api/accounting/transfers", { from_cash_account_id: "bank_main", to_cash_account_id: bank.id, amount: "0", date: today }],
    ["transfer: 3 decimals", "/api/accounting/transfers", { from_cash_account_id: "bank_main", to_cash_account_id: bank.id, amount: "1.005", date: today }],
    ["transfer: not a number", "/api/accounting/transfers", { from_cash_account_id: "bank_main", to_cash_account_id: bank.id, amount: "1e3", date: today }],
    ["transfer: absurd", "/api/accounting/transfers", { from_cash_account_id: "bank_main", to_cash_account_id: bank.id, amount: "99999999999999999999", date: today }],
    ["transfer: bad date", "/api/accounting/transfers", { from_cash_account_id: "bank_main", to_cash_account_id: bank.id, amount: "1", date: "2026-02-30" }],
    ["transfer: unknown account", "/api/accounting/transfers", { from_cash_account_id: "nope", to_cash_account_id: bank.id, amount: "1", date: today }],
    ["journal: unbalanced", "/api/accounting/journals", { date: today, description: "x", lines: [{ account_id: "acc_6100", debit: 10 }, { account_id: "acc_1200", credit: 9 }] }],
    ["journal: 3 decimals", "/api/accounting/journals", { date: today, description: "x", lines: [{ account_id: "acc_6100", debit: 0.001 }, { account_id: "acc_1200", credit: 0.001 }] }],
    ["journal: debit and credit on one line", "/api/accounting/journals", { date: today, description: "x", lines: [{ account_id: "acc_6100", debit: 5, credit: 5 }, { account_id: "acc_1200", credit: 0 }] }],
    ["journal: header account", "/api/accounting/journals", { date: today, description: "x", lines: [{ account_id: "acc_1000", debit: 5 }, { account_id: "acc_1200", credit: 5 }] }],
    ["journal: AR directly", "/api/accounting/journals", { date: today, description: "x", lines: [{ account_id: "acc_1300", debit: 5 }, { account_id: "acc_1200", credit: 5 }] }],
    ["journal: VAT account directly", "/api/accounting/journals", { date: today, description: "x", lines: [{ account_id: (await db.account.findUnique({ where: { systemKey: "vat_input" } }))!.id, debit: 5 }, { account_id: "acc_1200", credit: 5 }] }],
    ["asset: negative cost", "/api/assets", { category_id: cat.id, name: "x", cost: "-100", acquisition_date: today, cash_account_id: "bank_main" }],
    ["asset: in service before purchase", "/api/assets", { category_id: cat.id, name: "x", cost: "100", acquisition_date: today, in_service_date: addDays(today, -40), cash_account_id: "bank_main" }],
    ["depreciation: future month", "/api/assets/depreciation", { period: "2099-01" }],
    ["depreciation: garbage month", "/api/assets/depreciation", { period: "2026-13" }],
    ["VAT return: reversed range", "/api/accounting/vat-returns", { period_from: P2, period_to: P1 }],
    ["VAT return: not ended", "/api/accounting/vat-returns", { period_from: P1, period_to: "2099-12-31" }],
    ["cost center: lower-case code", "/api/accounting/cost-centers", { code: "abc", name: "x", name_ar: "x", kind: "other" }],
    ["opening batch: bad date", "/api/accounting/opening-batches", { cutover_date: "31-12-2025" }],
  ] as const;
  for (const [label, path, b] of bad) {
    const res = await call("karim", "POST", path, b);
    check(`${label} -> 4xx (got ${res.status})`, res.status >= 400 && res.status < 500, [res.status, res.body]);
  }
  const ent = await call("karim", "POST", "/api/accounting/journals", { date: today, description: "x", lines: [{ account_id: "acc_6100", debit: 1 }, { account_id: "acc_1200", credit: 1 }], unknown_field: { $ne: 1 } });
  check("unexpected extra field does not break anything (no 500)", ent.status < 500, ent.status);

  section("9. UNAUTHORIZED: EVERY NEW WRITE ENDPOINT, AS SALES AND AS THE FLOOR");
  const writes: [string, string, unknown][] = [
    ["POST", "/api/accounting/cash-accounts", { type: "cash", name: "x", name_ar: "x" }],
    ["PATCH", `/api/accounting/cash-accounts/${box.id}`, { active: false }],
    ["POST", "/api/accounting/transfers", body],
    ["POST", `/api/accounting/transfers/${tid}/reverse`, { reason: "xxxxxxxxxxxx" }],
    ["PATCH", "/api/accounting/accounts/acc_6100", { name: "x" }],
    ["POST", "/api/accounting/vat-returns", { period_from: P1, period_to: P2 }],
    ["POST", "/api/accounting/fiscal-years/2013/close", {}],
    ["POST", "/api/accounting/fiscal-years/2015/reopen", { reason: "xxxxxxxxxxxx" }],
    ["POST", "/api/accounting/periods/2015-01/reopen", { reason: "xxxxxxxxxxxx" }],
    ["POST", "/api/accounting/opening-batches", { cutover_date: today }],
    ["POST", "/api/accounting/cost-centers", { code: "QQ1", name: "x", name_ar: "x", kind: "other" }],
    ["POST", "/api/assets", { category_id: cat.id, name: "x", cost: "1", acquisition_date: today }],
    ["POST", "/api/assets/categories", { code: "QQ", name: "x", name_ar: "x", useful_life_months: 12 }],
    ["POST", "/api/assets/depreciation", { period: prev }],
    ["POST", `/api/assets/${a1.id}/dispose`, { kind: "scrap", date: today, reason: "x" }],
    ["POST", `/api/assets/${a1.id}/transfer`, { reason: "x" }],
    ["POST", `/api/assets/${a1.id}/improve`, { amount: "1", date: today, description: "x" }],
  ];
  for (const who of ["mona", "mostafa"]) {
    const res = await Promise.all(writes.map(([m, p, b]) => call(who, m, p, b)));
    const leaks = res.map((x, i) => [writes[i][1], x.status] as const).filter(([, s]) => s !== 403 && s !== 401);
    check(`${who}: all ${writes.length} writes refused (403)`, leaks.length === 0, leaks);
  }
  const anon = await call(null, "POST", "/api/accounting/transfers", body);
  check("no session -> 401", anon.status === 401, anon.status);
  const reads = ["/api/accounting/vat-returns", "/api/accounting/fiscal-years", "/api/accounting/opening-batches", "/api/assets", "/api/accounting/cost-centers/report?from=2026-01-01&to=2026-01-31", "/api/accounting/transfers"];
  const rr = await Promise.all(reads.map((p) => call("mostafa", "GET", p)));
  check("the floor reads none of the accounting registers (403)", rr.every((x) => x.status === 403), reads.map((p, i) => [p, rr[i].status]));

  section("10. A REVERSAL KEEPS THE COST CENTER (AND THE PARTY)");
  const cc = (await call("karim", "POST", "/api/accounting/cost-centers", { code: `RV${SUF}`, name: `${TAG} cc`, name_ar: `${TAG} مركز`, kind: "other" })).body.costCenter;
  r = await call("karim", "POST", "/api/accounting/journals", { date: today, description: `${TAG} بمركز`, lines: [{ account_id: "acc_6100", debit: 77, cost_center_id: cc.id }, { account_id: "acc_1200", credit: 77 }] });
  check("a manual journal on a cost center", r.status === 201, r.body);
  const rv = await call("karim", "POST", `/api/accounting/journals/${r.body.journal.id}/reverse`, { reason: `${TAG} عكس` });
  check("…reversed", rv.status === 200 || rv.status === 201, rv.body);
  const rep = (await call("karim", "GET", `/api/accounting/cost-centers/report?from=${today}&to=${today}`)).body.report;
  const row = rep.centers.find((g: any) => g.costCenter?.id === cc.id);
  check("…the center nets to zero (the reversal did not fall into 'unallocated')", !row || n(row.expenses) === 0, row);

  section("11. THE BOOKS STILL RECONCILE");
  const health = (await call("karim", "GET", "/api/accounting/integrity")).body.integrity;
  check("integrity check green after all of the above", health.ok === true, health.checks.filter((c: any) => !c.ok));

  await db.$disconnect();
  finish("ADVERSARIAL");
}

main().catch((e) => { console.error(e); process.exit(1); });
