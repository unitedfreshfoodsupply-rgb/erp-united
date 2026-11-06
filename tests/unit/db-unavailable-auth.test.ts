/* A database that cannot answer is a server fault, not a missing session (browser QA D1, Nov
   2026): under pool pressure the sign-in check itself failed, the route answered 401 and the
   client sent a signed-in user to the sign-in page, without the "server busy" message. The
   guards still refuse (nothing is granted) — they now refuse with handleApiError's 503 busy
   answer and its reference. Also: a database that is unreachable or drops the connection, and
   a deadlock reported by a raw query, read as their existing messages instead of a bare 500. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { handleApiError, isDatabaseUnavailable } from "@/lib/rbac";

function prismaError(code: string, message: string, name = "PrismaClientKnownRequestError") {
  const e = new Error(message) as Error & { code: string };
  e.name = name;
  e.code = code;
  return e;
}
const req = (lang?: string) => new NextRequest("http://localhost/api/accounting/journal-requests/x/cancel", { method: "POST", headers: lang ? { "accept-language": lang } : {} });

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

test("pool, transaction-start and connection failures count as 'the database did not answer'", () => {
  for (const code of ["P2024", "P2028", "P1001", "P1002", "P1008", "P1017"]) assert.equal(isDatabaseUnavailable(prismaError(code, "x")), true, code);
  const init = new Error("Can't reach database server");
  init.name = "PrismaClientInitializationError";
  assert.equal(isDatabaseUnavailable(init), true);
});

test("anything else stays a refusal as 'not signed in' (never a grant)", () => {
  assert.equal(isDatabaseUnavailable(prismaError("P2025", "not found")), false);
  assert.equal(isDatabaseUnavailable(prismaError("P2002", "unique")), false);
  assert.equal(isDatabaseUnavailable(new Error("JWSSignatureVerificationFailed")), false);
  assert.equal(isDatabaseUnavailable(null), false);
  assert.equal(isDatabaseUnavailable("P2024"), false);
});

test("the error a guard rethrows answers 503 busy with a reference — not 401", async () => {
  const res = await quietly(() => handleApiError(prismaError("P2024", "Timed out fetching a new connection from the connection pool."), req()));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /مشغول/);
  assert.match(body.ref, /^[0-9a-f]{8}$/);
});

test("an unreachable database or a lost connection → 503 busy (Arabic and English), not a bare 500", async () => {
  for (const e of [prismaError("P1001", "Can't reach database server at `localhost:5432`"), prismaError("P1017", "Server has closed the connection.")]) {
    const ar = await quietly(() => handleApiError(e, req()));
    assert.equal(ar.status, 503, e.message);
    assert.match((await ar.json()).error, /السيرفر مشغول/);
    const en = await quietly(() => handleApiError(e, req("en")));
    assert.equal(en.status, 503);
    assert.match((await en.json()).error, /server is busy/);
  }
  const init = new Error("Can't reach database server");
  init.name = "PrismaClientInitializationError";
  assert.equal((await quietly(() => handleApiError(init, req()))).status, 503);
});

test("a deadlock or serialization failure from a raw query (P2010 40P01/40001) → the 409 'changed by someone else'", async () => {
  for (const pg of ["40P01", "40001"]) {
    const res = await quietly(() => handleApiError(prismaError("P2010", `Raw query failed. Code: \`${pg}\`. Message: \`deadlock detected\``), req()));
    assert.equal(res.status, 409, pg);
    assert.match((await res.json()).error, /اتغيّر من واحد تاني/);
  }
  // Any other raw-query failure is still a server fault.
  const other = await quietly(() => handleApiError(prismaError("P2010", "Raw query failed. Code: `42P01`. Message: `relation does not exist`"), req()));
  assert.equal(other.status, 500);
});
