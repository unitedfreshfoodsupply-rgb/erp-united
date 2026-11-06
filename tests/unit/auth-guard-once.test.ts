/* The D1 fix itself (review, Nov 2026): a guard that refuses must decide from ONE read of the
   session. React's cache() does not memoise in a route handler, so a guard that asked the database
   twice — once for the context, once more to explain the refusal — could see it fail and then
   answer, and refuse a signed-in user as 401 "not signed in" (the client then opens /login).
   Here the database fails on the first query and answers every later one: each guard must answer
   with the database's own error (handleApiError: 503 busy), and must query exactly once. */
import { test, mock, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest } from "next/server";

// Next's request scope (headers()) needs the runtime's AsyncLocalStorage, which the server sets
// up before loading any of these modules — so they are loaded after it, here.
async function load() {
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
  return {
    ...(await import("next/dist/client/components/request-async-storage.external")),
    ...(await import("@/lib/prisma")),
    ...(await import("@/lib/auth")),
    ...(await import("@/lib/authz")),
    ...(await import("@/lib/rbac")),
    authMe: (await import("@/app/api/auth/me/route")).GET,
  };
}
let m: Awaited<ReturnType<typeof load>>;
before(async () => {
  m = await load();
});

const USER = { id: "u-guard-test", name: "Guard Test", username: "guard.test", role: "SUPER_ADMIN" as const, sessionEpoch: 1 };
const row = { id: USER.id, name: USER.name, username: USER.username, role: USER.role, active: true, sessionEpoch: 1, mustChangePassword: false, mfa_enabled: true, effect: null, permission_key: null };

function poolTimeout() {
  return Object.assign(new Error("Timed out fetching a new connection from the connection pool."), { name: "PrismaClientKnownRequestError", code: "P2024" });
}

/** The database fails the first `failures` queries, then answers with the user's row. */
function stubDatabase(failures: number) {
  let calls = 0;
  const stub = mock.method(m.prisma, "$queryRaw", async () => {
    calls++;
    if (calls <= failures) throw poolTimeout();
    return [row];
  });
  return { calls: () => calls, restore: () => stub.mock.restore() };
}

async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const token = await m.createSessionToken(USER, 12);
  const headers = new Headers({ authorization: `Bearer ${token}` });
  const store = { headers, cookies: { get: () => undefined }, mutableCookies: { get: () => undefined } };
  return m.requestAsyncStorage.run(store as never, fn);
}

const quiet = () => {
  const e = mock.method(console, "error", () => undefined);
  const w = mock.method(console, "warn", () => undefined);
  return () => { e.mock.restore(); w.mock.restore(); };
};
let restoreConsole: () => void = () => {};
afterEach(() => restoreConsole());

const req = () => new NextRequest("http://localhost/api/accounting/journal-requests/x/cancel", { method: "POST" });

const guards: [string, () => Promise<unknown>][] = [
  ["requirePermission", () => m.requirePermission(req(), "approvals.view" as never)],
  ["requireAnyPermission", () => m.requireAnyPermission(req(), ["approvals.view" as never])],
  ["requireAuth", () => m.requireAuth(req())],
  ["requireMfaSession", () => m.requireMfaSession(req())],
];

for (const [name, guard] of guards) {
  test(`${name}: the database fails, then answers → the database's error (503 busy), never 401`, async () => {
    restoreConsole = quiet();
    const db = stubDatabase(1);
    try {
      const err = await inRequest(() => guard().then(() => null, (e: unknown) => e));
      assert.ok(err, "the guard must refuse");
      assert.equal((err as { code?: string }).code, "P2024", "the guard rethrows the database's own error");
      const res = m.handleApiError(err, req());
      assert.equal(res.status, 503);
      assert.equal(db.calls(), 1, "one read of the session per guard");
    } finally {
      db.restore();
    }
  });
}

test("guards still pass when the database answers (one query)", async () => {
  const db = stubDatabase(0);
  try {
    const ctx = await inRequest(() => m.requireAuth(req()));
    assert.equal(ctx.id, USER.id);
    assert.equal(db.calls(), 1);
  } finally {
    db.restore();
  }
});

test("resolveAuth: a database that did not answer is 'unavailable', not 'none'", async () => {
  restoreConsole = quiet();
  const db = stubDatabase(1);
  try {
    const outcome = await inRequest(() => m.resolveAuth());
    assert.equal(outcome.kind, "unavailable");
  } finally {
    db.restore();
  }
});

test("/api/auth/me: the database fails, then answers → 503 busy, not user: null", async () => {
  restoreConsole = quiet();
  const db = stubDatabase(1);
  try {
    const res = await inRequest(() => m.authMe(new NextRequest("http://localhost/api/auth/me")));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /مشغول/);
    assert.equal(db.calls(), 1);
  } finally {
    db.restore();
  }
});
