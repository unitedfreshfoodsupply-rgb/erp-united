/* SEC-2 / SEC-3 (Nov 2026): the per-account sign-in lock counts the account, not the spelling. The
   username and the account's email are two ways to type the same account, so five wrong
   passwords across both lock it (before, each had its own five). Only failures are driven
   here: the route is called directly, without a server, and a success would set a cookie.
   Synthetic user on the test database; no X-Forwarded-For, so the IP lock stays out of it. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "./_db";
import { POST } from "@/app/api/auth/login/route";
import { hashPassword } from "@/lib/security/password-policy";

const TAG = `zzlock${Date.now()}`;
const email = `${TAG}@example.test`;
const created: string[] = [];

// LoginAttempt is append-only (a database rule); the tagged attempts stay, the users are switched off.
after(async () => {
  await prisma.user.updateMany({ where: { id: { in: created } }, data: { active: false } });
  await prisma.$disconnect();
});

const attempt = async (username: string) => {
  const res = await POST(new NextRequest("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: `wrong-${randomUUID()}` }) }));
  return { status: res.status, body: await res.json() };
};

test("wrong passwords through the username and the email share one five-attempt counter", async () => {
  const user = await prisma.user.create({ data: { username: TAG, name: `${TAG} preparer`, role: "PREPARER", email, passwordHash: await hashPassword(randomUUID()) } });
  created.push(user.id);

  for (const id of [TAG, email, TAG, email.toUpperCase(), TAG]) assert.equal((await attempt(id)).status, 401, id);
  // The fifth failure locked the account, whichever spelling comes next.
  const byEmail = await attempt(email);
  assert.equal(byEmail.status, 429, JSON.stringify(byEmail.body));
  assert.equal((await attempt(TAG)).status, 429);
  // Counted under the account's username; the typed email left no counter of its own.
  assert.equal(await prisma.loginAttempt.count({ where: { username: TAG, success: false } }), 5);
  assert.equal(await prisma.loginAttempt.count({ where: { username: email } }), 0);
  // The lock is recorded once, against the account (found by its username, not "unknown:").
  const locked = await prisma.auditLog.findMany({ where: { action: "login_locked", userName: TAG } });
  assert.deepEqual(locked.map((l) => l.entityId), [user.id]);
});

test("an unknown identifier still counts as typed, and does not lock a real account", async () => {
  const other = await prisma.user.create({ data: { username: `${TAG}-other`, name: `${TAG} other`, role: "PREPARER", passwordHash: await hashPassword(randomUUID()) } });
  created.push(other.id);
  const ghost = `${TAG}-ghost@example.test`;
  for (let i = 0; i < 5; i++) assert.equal((await attempt(ghost)).status, 401);
  assert.equal((await attempt(ghost)).status, 429);
  assert.equal(await prisma.loginAttempt.count({ where: { username: ghost } }), 5);
  assert.equal((await attempt(`${TAG}-other`)).status, 401, "another account is not affected");
});

test("SEC-3: a sign-in body over 16 KB is refused with 413 before anything is looked up or counted", async () => {
  const before = await prisma.loginAttempt.count();
  const huge = JSON.stringify({ username: `${TAG}-huge`, password: "x".repeat(20_000) });
  const res = await POST(new NextRequest("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: huge }));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, "حجم الطلب أكبر من الحد المسموح (16 كيلوبايت)");
  const en = await POST(new NextRequest("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "accept-language": "en" }, body: huge }));
  assert.equal((await en.json()).error, "The request is larger than the allowed size (16 KB)");
  assert.equal(await prisma.loginAttempt.count(), before);
  // An ordinary body is unaffected.
  assert.equal((await attempt(`${TAG}-nobody`)).status, 401);
});
