/* The supplier category migration (Nov 2026) classifies exactly the 83 suppliers imported into
   production on 1 Nov, from the import files' own provenance — SUP-00001..039 fruit, SUP-00040..083
   vegetables — matched by id AND code, only where no category is set yet. It infers nothing from
   names, and its column only accepts the two known values. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261104100000_supplier_category/migration.sql"), "utf8");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

function backfill(category: string) {
  const m = code.match(new RegExp(`UPDATE "Supplier" SET "category" = '${category}'\\s+WHERE "category" IS NULL AND \\("id", "code"\\) IN \\(VALUES([\\s\\S]*?)\\);`));
  assert.ok(m, `${category} backfill guarded by "category IS NULL" and matched on id and code`);
  return [...m[1].matchAll(/\('([a-z0-9]+)', '(SUP-\d{5})'\)/g)].map((x) => ({ id: x[1], code: x[2] }));
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `SUP-${String(from + i).padStart(5, "0")}`);

test("39 fruit suppliers, SUP-00001..00039, and 44 vegetable suppliers, SUP-00040..00083", () => {
  const fruit = backfill("fruit");
  const veg = backfill("vegetable");
  assert.deepEqual(fruit.map((r) => r.code), range(1, 39));
  assert.deepEqual(veg.map((r) => r.code), range(40, 83));
});

test("83 distinct suppliers, none in both lists, every id a database id", () => {
  const rows = [...backfill("fruit"), ...backfill("vegetable")];
  assert.equal(rows.length, 83);
  assert.equal(new Set(rows.map((r) => r.id)).size, 83);
  assert.equal(new Set(rows.map((r) => r.code)).size, 83);
  for (const r of rows) assert.match(r.id, /^c[a-z0-9]{24}$/);
});

test("additive and closed: a nullable column, a CHECK on the two values, no other write", () => {
  assert.match(code, /ALTER TABLE "Supplier" ADD COLUMN "category" TEXT;/);
  assert.match(code, /CHECK \("category" IS NULL OR "category" IN \('vegetable', 'fruit'\)\)/);
  // The only statements: the column, the CHECK, the index and the two guarded backfills.
  const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 5);
  assert.ok(!/\b(DELETE|DROP|TRUNCATE|INSERT)\b/i.test(code));
  assert.ok(!/"name"|"nameAr"|LIKE|ILIKE/.test(code), "no name matching");
});

// The third category (Nov 2026): services and non-produce suppliers. The constraint is widened
// in its own migration; no row is written, so the backfill above stays the only classification.
const other = readFileSync(join(process.cwd(), "prisma/migrations/20261104130000_supplier_category_other/migration.sql"), "utf8")
  .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

test("the 'other' category only widens the CHECK: same constraint name, every earlier value still valid, no row touched", () => {
  const statements = other.split(";").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, [
    'ALTER TABLE "Supplier" DROP CONSTRAINT "Supplier_category_known"',
    `ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_category_known" CHECK ("category" IS NULL OR "category" IN ('vegetable', 'fruit', 'other'))`,
  ]);
  assert.ok(!/\b(UPDATE|DELETE|INSERT|TRUNCATE|DROP COLUMN|DROP TABLE)\b/i.test(other));
});
