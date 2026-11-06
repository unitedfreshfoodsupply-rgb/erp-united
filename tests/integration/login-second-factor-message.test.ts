/* SH-15 (Nov 2026): the message for a refused second factor fits the kind of code typed. A code from
   the app is refused when it is wrong or its 30-second step was already used, and the message says
   to wait for the next one. A recovery code is single-use and has no "next code", so its message says
   only that it is wrong or used. Only refusals are driven: the route is called directly, without a
   server, and a success would set a cookie. Synthetic enrolled user on the test database; the
   pre-authentication token is made directly, so no password is involved. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "./_db";
import { POST } from "@/app/api/auth/login/route";
import { createPreAuthToken, hashPassword } from "@/lib/auth";
import { encryptMfaSecret } from "@/lib/security/mfa-crypto";
import { generateTotpSecret } from "@/lib/security/totp";
import { MFA_ENCRYPTION_KEY } from "@/lib/env";

const TAG = `zzmfamsg${Date.now()}`;
const created: string[] = [];

// LoginAttempt is append-only (a database rule); the tagged attempts stay, the user is switched off.
after(async () => {
  await prisma.user.updateMany({ where: { id: { in: created } }, data: { active: false } });
  await prisma.$disconnect();
});

async function enrolledUser() {
  const user = await prisma.user.create({ data: { username: TAG, name: `${TAG} accountant`, role: "ACCOUNTANT", passwordHash: await hashPassword(randomUUID()) } });
  created.push(user.id);
  return prisma.user.update({
    where: { id: user.id },
    data: { mfaSecret: encryptMfaSecret(generateTotpSecret(), user.id, MFA_ENCRYPTION_KEY), mfaEnabledAt: new Date() },
  });
}

async function secondStep(user: { id: string; sessionEpoch: number }, factor: Record<string, string>, lang?: "en") {
  const mfa_token = await createPreAuthToken({ userId: user.id, sessionEpoch: user.sessionEpoch });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (lang) headers["accept-language"] = lang;
  const res = await POST(new NextRequest("http://localhost/api/auth/login", { method: "POST", headers, body: JSON.stringify({ mfa_token, ...factor }) }));
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

test("a refused app code says to wait for the next code; a refused recovery code does not", async () => {
  const user = await enrolledUser();

  // "000000" may by chance be the current code; "abc" is never one.
  const app = await secondStep(user, { code: "abc" }, "en");
  assert.equal(app.status, 401);
  assert.equal(app.body.error, "Wrong or already used verification code — wait for the next code in the app");

  const recovery = await secondStep(user, { recovery_code: "ZZZZZ-ZZZZZ" }, "en");
  assert.equal(recovery.status, 401);
  assert.equal(recovery.body.error, "Wrong or already used recovery code");

  const recoveryAr = await secondStep(user, { recovery_code: "ZZZZZ-ZZZZZ" });
  assert.equal(recoveryAr.status, 401);
  assert.equal(recoveryAr.body.error, "كود الاسترداد غلط أو اتستخدم قبل كده");

  // Both sent: the app code is the one checked (as verifySecondFactor does), so its message answers.
  const both = await secondStep(user, { code: "abc", recovery_code: "ZZZZZ-ZZZZZ" }, "en");
  assert.equal(both.status, 401);
  assert.match(both.body.error ?? "", /wait for the next code/);

  // Each refusal counted as a failed sign-in for the account, as before.
  assert.equal(await prisma.loginAttempt.count({ where: { username: TAG, success: false } }), 4);
});
