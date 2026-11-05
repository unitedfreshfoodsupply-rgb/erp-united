/* SEC-6 (Nov 2026): a failed data-import row shows what handleApiError would answer — a
   refusal's own message, a mapped database fault's fixed text, or "could not save the row"
   with a reference that is in the server log — never the raw Prisma or runtime text. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ApiError, rowErrorMessage } from "@/lib/rbac";
import { localizeServerMessage } from "@/lib/locale/server-messages";

const prismaError = (code: string, message: string) => Object.assign(new Error(message), { name: "PrismaClientKnownRequestError", code });
const quiet = <T>(fn: () => T) => {
  const error = mock.method(console, "error", () => undefined);
  const warn = mock.method(console, "warn", () => undefined);
  try { return { out: fn(), error: error.mock.calls.map((c) => c.arguments), warn: warn.mock.calls.map((c) => c.arguments) }; }
  finally { error.mock.restore(); warn.mock.restore(); }
};

test("a refusal keeps its own message (the import translates it like every other)", () => {
  assert.equal(rowErrorMessage(new ApiError(404, "الصنف غير موجود بكود SKU")), "الصنف غير موجود بكود SKU");
  assert.equal(rowErrorMessage(new ApiError(409, "المورد مش موجود"), "en"), "المورد مش موجود");
});

test("a database fault the row caused gets the mapped text, in the import's language", () => {
  const dup = prismaError("P2002", "\nInvalid `tx.customer.create()` invocation:\n\nUnique constraint failed on the fields: (`code`)");
  const r = quiet(() => rowErrorMessage(dup));
  assert.equal(r.out, "السجل ده موجود بالفعل (تكرار) — حدّث الصفحة وراجع");
  assert.equal(r.warn.length, 1, "logged once, with a reference");
  assert.match(String(r.warn[0][0]), /^\[api-409 [0-9a-f]{8}\]$/);
  assert.equal(quiet(() => rowErrorMessage(dup, "en")).out, "This record already exists (duplicate) — refresh and review");
  const fk = prismaError("P2003", "Foreign key constraint failed on the field: `Customer_priceListId_fkey (index)`");
  assert.equal(quiet(() => rowErrorMessage(fk)).out, "مرجع غير موجود (صنف/مكان/طرف غير معروف)");
});

test("anything else: logged in full with a reference; the row names only the reference", () => {
  const raw = Object.assign(new Error("\nInvalid `tx.customer.create()` invocation in\n/home/hermes/releases/united/.next/server/chunks/123.js:1:1\n\nTransaction already closed: A query cannot be executed on an expired transaction."), { name: "PrismaClientKnownRequestError", code: "P2028" });
  const r = quiet(() => rowErrorMessage(raw));
  const m = /^تعذر حفظ الصف — مرجع ([0-9a-f]{8})$/.exec(r.out);
  assert.ok(m, r.out);
  assert.ok(!/Invalid|Transaction|hermes|\.js/.test(r.out));
  assert.deepEqual(r.error, [[`[api-error ${m![1]}]`, raw]], "the server log has the detail under the same reference");
  assert.match(quiet(() => rowErrorMessage(new TypeError("Cannot read properties of undefined (reading 'id')"), "en")).out, /^Could not save the row — reference [0-9a-f]{8}$/);
  assert.match(quiet(() => rowErrorMessage("boom")).out, /^تعذر حفظ الصف — مرجع [0-9a-f]{8}$/);
  // The Arabic text is catalogued, so a caller that translates afterwards gets English too.
  assert.equal(localizeServerMessage("تعذر حفظ الصف — مرجع ab12cd34", "en"), "Could not save the row — reference ab12cd34");
});
