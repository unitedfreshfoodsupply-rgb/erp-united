// F-06 — Pagination: verify limit/offset/total metadata, ordering, empty/final pages,
// RBAC, and max page size.
import { call, login, makeChecker } from "./_harness";
import { todayBiz } from "./_days";

const TAG = `ZZF06${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const today = todayBiz(); // the Cairo business day the server books on (tests/_days.ts)
const n = (v: any) => Number(v ?? 0);

async function main() {
  for (const u of ["admin", "sara", "hossam", "mona", "mostafa", "ahmed", "karim"]) await login(u);

  // Seed data already has some transactions. We'll test pagination on receipts,
  // journals, payments, and inventory documents.

  // =========================================================================
  section("N1. RECEIPTS — PAGINATION METADATA");
  const r1 = await call("admin", "GET", "/api/accounting/receipts?limit=2&offset=0");
  check("N1 receipts 200", r1.status === 200, [r1.status, r1.body?.error]);
  const p1 = r1.body.pagination;
  check("N1 pagination exists", !!p1, !!p1);
  check("N1 total > 0", p1.total > 0, p1.total);
  check("N1 limit=2", p1.limit === 2, p1.limit);
  check("N1 offset=0", p1.offset === 0, p1.offset);
  check("N1 receipts count ≤ 2", r1.body.receipts.length <= 2, r1.body.receipts.length);

  // =========================================================================
  section("N2. RECEIPTS — SECOND PAGE, NO OVERLAP");
  const r2 = await call("admin", "GET", `/api/accounting/receipts?limit=2&offset=2`);
  check("N2 second page 200", r2.status === 200);
  check("N2 offset=2", r2.body.pagination.offset === 2, r2.body.pagination.offset);
  const ids1 = new Set(r1.body.receipts.map((x: any) => x.id));
  const ids2 = new Set(r2.body.receipts.map((x: any) => x.id));
  const overlap = [...ids1].filter((id) => ids2.has(id));
  check("N2 no overlap between pages", overlap.length === 0, overlap.length);

  // =========================================================================
  section("N3. RECEIPTS — EMPTY OFFSET (BEYOND TOTAL)");
  const r3 = await call("admin", "GET", `/api/accounting/receipts?limit=50&offset=99999`);
  check("N3 beyond total 200", r3.status === 200);
  check("N3 empty result", r3.body.receipts.length === 0, r3.body.receipts.length);

  // =========================================================================
  section("N4. RECEIPTS — MAX PAGE SIZE ENFORCED");
  const r4 = await call("admin", "GET", "/api/accounting/receipts?limit=9999");
  check("N4 large limit clamped to 200", r4.body.pagination.limit <= 200, r4.body.pagination.limit);

  // =========================================================================
  section("N5. JOURNALS — PAGINATION METADATA");
  const r5 = await call("admin", "GET", "/api/accounting/journals?limit=3&offset=0");
  check("N5 journals 200", r5.status === 200);
  check("N5 pagination exists", !!r5.body.pagination, !!r5.body.pagination);
  check("N5 total > 0", r5.body.pagination.total > 0, r5.body.pagination.total);
  check("N5 journals count ≤ 3", r5.body.journals.length <= 3, r5.body.journals.length);

  // =========================================================================
  section("N6. JOURNALS — NO OVERLAP BETWEEN PAGES");
  const r6 = await call("admin", "GET", "/api/accounting/journals?limit=3&offset=3");
  const ids5 = new Set(r5.body.journals.map((x: any) => x.id));
  const ids6 = new Set(r6.body.journals.map((x: any) => x.id));
  const overlapJ = [...ids5].filter((id) => ids6.has(id));
  check("N6 no overlap between journal pages", overlapJ.length === 0, overlapJ.length);

  // =========================================================================
  section("N7. INVENTORY DOCUMENTS — PAGINATION METADATA");
  const r7 = await call("admin", "GET", "/api/inventory/documents?limit=5&offset=0");
  check("N7 documents 200", r7.status === 200);
  check("N7 pagination exists", !!r7.body.pagination, !!r7.body.pagination);
  check("N7 total > 0", r7.body.pagination.total > 0, r7.body.pagination.total);
  check("N7 limit=5", r7.body.pagination.limit === 5, r7.body.pagination.limit);

  // =========================================================================
  section("N8. INVENTORY DOCUMENTS — TYPE FILTER + PAGINATION");
  const r8 = await call("admin", "GET", "/api/inventory/documents?limit=5&offset=0&type=intake");
  check("N8 filtered 200", r8.status === 200);
  check("N8 only intake docs", r8.body.documents.every((d: any) => d.type === "intake"), r8.body.documents.map((d: any) => d.type));

  // =========================================================================
  section("N9. RBAC — UNAUTHORIZED PAGINATED ACCESS → 403");
  const r9 = await call("mostafa", "GET", "/api/accounting/journals?limit=5&offset=0");
  check("N9 LOADER journals → 403", r9.status === 403, [r9.status, r9.body?.error]);
  const r9b = await call("mostafa", "GET", "/api/inventory/documents?limit=5&offset=0");
  check("N9b LOADER documents → 403", r9b.status === 403, [r9b.status, r9b.body?.error]);

  // =========================================================================
  section("N10. DETERMINISTIC ORDERING — SAME QUERY RETURNS SAME IDS");
  const r10a = await call("admin", "GET", "/api/accounting/journals?limit=10&offset=0");
  const r10b = await call("admin", "GET", "/api/accounting/journals?limit=10&offset=0");
  const ids10a = r10a.body.journals.map((x: any) => x.id);
  const ids10b = r10b.body.journals.map((x: any) => x.id);
  check("N10 same order across requests", JSON.stringify(ids10a) === JSON.stringify(ids10b), ids10a.length);

  finish("PAGINATION");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(1); });