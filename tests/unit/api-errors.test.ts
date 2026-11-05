/* Server faults the user can act on (Nov 2026): a transaction that ran out of time, or a
   request that waited too long for the database, reads as what it is — with the reference
   that ties it to the server log line — instead of a bare "خطأ في السيرفر". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { handleApiError, ApiError } from "@/lib/rbac";
import { apiErrorFrom, ApiClientError } from "@/lib/api-client";

/** What Prisma 5 throws: a PrismaClientKnownRequestError with a code. */
function prismaError(code: string, message: string) {
  const e = new Error(message) as Error & { code: string };
  e.name = "PrismaClientKnownRequestError";
  e.code = code;
  return e;
}
const req = (lang?: string) => new NextRequest("http://localhost/api/approvals/x/decide", { method: "POST", headers: lang ? { "accept-language": lang } : {} });

async function quietly<T>(fn: () => T): Promise<T> {
  const [err, warn] = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.error = err;
    console.warn = warn;
  }
}

test("an expired interactive transaction (P2028) → 503, says this step was cancelled and to check before retrying, keeps the ref", async () => {
  const res = await quietly(() => handleApiError(prismaError("P2028", "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 20000 ms, however 20012 ms passed since the start of the transaction."), req()));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /الخطوة دي اتلغت/);
  // A route may have committed an earlier transaction before this one timed out (e.g. a trip's
  // per-stop status moves), so the text never promises that nothing was saved.
  assert.ok(!/مفيش حاجة|اتسجلت/.test(body.error), "no promise that nothing was saved");
  assert.match(body.error, /اتأكد من الحالة قبل ما تجرّب تاني/);
  assert.match(body.error, /رقم المرجع/);
  assert.match(body.ref, /^[0-9a-f]{8}$/);
  assert.ok(!/Transaction|expired|20000/.test(body.error), "no internals in the message");
});

test("P2028 'unable to start' and P2024 (pool) → 503 busy, which does not promise nothing was saved", async () => {
  for (const e of [
    prismaError("P2028", "Transaction API error: Unable to start a transaction in the given time."),
    prismaError("P2024", "Timed out fetching a new connection from the connection pool. (Current connection pool timeout: 10, connection limit: 1)"),
  ]) {
    const res = await quietly(() => handleApiError(e, req()));
    assert.equal(res.status, 503, e.message);
    const body = await res.json();
    assert.match(body.error, /مشغول/);
    assert.ok(!/مفيش حاجة|اتسجلت/.test(body.error), "a busy server may have saved an earlier step");
    assert.match(body.error, /اتأكد من الحالة قبل ما تجرّب تاني/);
    assert.match(body.ref, /^[0-9a-f]{8}$/);
  }
});

test("English requests get the English text", async () => {
  const res = await quietly(() => handleApiError(prismaError("P2028", "Transaction already closed"), req("en")));
  const body = await res.json();
  assert.match(body.error, /this step was cancelled/);
  assert.match(body.error, /check the current state before trying again/);
  assert.ok(!/nothing .*saved/i.test(body.error), "no promise that nothing was saved");
  const busy = await (await quietly(() => handleApiError(prismaError("P2024", "Timed out fetching a new connection"), req("en")))).json();
  assert.match(busy.error, /server is busy/);
});

test("a write conflict (P2034) reads as the existing 'changed by someone else' 409", async () => {
  const res = await quietly(() => handleApiError(prismaError("P2034", "Transaction failed due to a write conflict or a deadlock. Please retry your transaction"), req()));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /اتغيّر من واحد تاني/);
});

test("unchanged: an unknown fault is still a 500 with a ref, and an ApiError is passed through", async () => {
  const res = await quietly(() => handleApiError(new Error("boom"), req()));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, "خطأ في السيرفر");
  assert.match(body.ref, /^[0-9a-f]{8}$/);
  const refused = handleApiError(new ApiError(403, "مالكش صلاحية تقرر في الطلب ده"), req());
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).ref, undefined, "a refusal carries no ref");
});

test("the client keeps the server's ref and shows it with a 5xx message only", () => {
  const e = apiErrorFrom(503, { error: "السيرفر مشغول دلوقتي", ref: "ab12cd34" });
  assert.ok(e instanceof ApiClientError);
  assert.equal(e.ref, "ab12cd34");
  assert.equal(e.status, 503);
  assert.equal(e.message, "السيرفر مشغول دلوقتي (رقم المرجع: ab12cd34)");
  const refused = apiErrorFrom(409, { error: "الطلب ده اتقفل بالفعل", code: "x", details: { a: 1 } });
  assert.equal(refused.message, "الطلب ده اتقفل بالفعل");
  assert.equal(refused.code, "x");
  assert.deepEqual(refused.details, { a: 1 });
  assert.equal(refused.ref, undefined);
  // A proxy page (no JSON) still reads as text.
  assert.equal(apiErrorFrom(502, {}).message, "خطأ (502)");
  assert.equal(apiErrorFrom(500, { error: { nested: true }, ref: "0000beef" }).message, "خطأ (500) (رقم المرجع: 0000beef)");
});
