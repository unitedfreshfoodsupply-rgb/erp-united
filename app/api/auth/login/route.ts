import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword, needsRehash, hashPassword, setSessionCookie, createPreAuthToken, verifyPreAuthToken } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/rbac";
import { isLoginLocked, isIpLoginLocked, recordLoginFailure, recordLoginSuccess } from "@/lib/loginRateLimit";
import { getSetting } from "@/lib/core/settings-service";
import { isMfaRequiredForRole, verifySecondFactor } from "@/lib/security/mfa-service";
import type { Role } from "@/lib/types";
import { readJson } from "@/lib/http";

/** A bcrypt hash (cost 12, same as new and upgraded accounts) of a random string nobody
 * knows. It only exists so a failed lookup costs the same time as a failed password. */
const TIMING_DUMMY_HASH = "$2a$12$Ltu31N7nZC4dbi3I.Ytf7.x.mmnLEvn2V.cEWE1c.WqjxoRn1KGGm";

/** A sign-in body is a name, a password and perhaps a code or a 5-minute token. It is read
 * before anyone is known, so it gets a tight cap rather than the general JSON limit. */
const LOGIN_BODY_LIMIT = 16_000;

/** The first client address from X-Forwarded-For (set by the reverse proxy). */
function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || null;
  return null;
}

type UserRow = { id: string; name: string; username: string; role: string; sessionEpoch: number; mustChangePassword: boolean };

async function ipGuard(ip: string | null, loc: "ar" | "en") {
  // IP-wide lockout first: a brute force that spreads guesses across usernames
  // still trips it, because the lock is on where the guesses come from.
  const ipLock = await isIpLoginLocked(ip, await getSetting("auth.login_ip_lockout_threshold"));
  if (ipLock.locked) {
    throw new ApiError(429, loc === "en" ? `Too many failed attempts from this IP — try again in ${Math.ceil(ipLock.retryAfterSec / 60)} minutes` : `محاولات كتير غلط من العنوان ده — حاول تاني بعد ${Math.ceil(ipLock.retryAfterSec / 60)} دقيقة`);
  }
}

async function accountGuard(username: string, loc: "ar" | "en") {
  const lockState = await isLoginLocked(username);
  if (lockState.locked) {
    throw new ApiError(429, loc === "en" ? `Too many failed attempts — try again in ${Math.ceil(lockState.retryAfterSec / 60)} minutes` : `محاولات كتير غلط — حاول تاني بعد ${Math.ceil(lockState.retryAfterSec / 60)} دقيقة`);
  }
}

async function lockGuards(username: string, ip: string | null, loc: "ar" | "en") {
  await ipGuard(ip, loc);
  await accountGuard(username, loc);
}

/** Issues the session (cookie + the same token for the tab) and the response body. */
async function signIn(user: UserRow, mfaEnrolled: boolean) {
  const role = user.role as Role;
  const ttlHours = await getSetting("auth.session_ttl_hours");
  const token = await setSessionCookie({ id: user.id, name: user.name, username: user.username, role, sessionEpoch: user.sessionEpoch }, ttlHours);
  const mfaEnrollmentRequired = !mfaEnrolled && (await isMfaRequiredForRole(role));
  return NextResponse.json({
    user: { id: user.id, name: user.name, role, username: user.username, mustChangePassword: user.mustChangePassword },
    token,
    // WS6: the session is held at enrolment until a second factor is set up (/mfa/setup).
    mfa_enrollment_required: mfaEnrollmentRequired,
  });
}

/**
 * Sign-in, in one or two steps.
 *
 *  Step 1 — { username, password }. For an account WITHOUT a second factor this is the
 *  whole sign-in (as before). For an enrolled account a correct password returns only
 *  { mfa_required: true, mfa_token } — a 5-minute pre-authentication token, never a
 *  session — and records nothing as a success: the failure counter must keep counting
 *  across the code step, or alternating "right password, wrong code" would reset it.
 *
 *  Step 2 — { mfa_token, code } or { mfa_token, recovery_code }. Same IP and per-user
 *  lockouts as passwords: a wrong code is a failed sign-in for that username.
 */
export async function POST(req: NextRequest) {
  try {
    const loc = req.headers.get("accept-language") === "en" ? "en" : "ar";
    const body = await readJson(req, LOGIN_BODY_LIMIT);
    const ip = clientIp(req);
    const invalid = () => new ApiError(401, loc === "en" ? "Invalid login credentials" : "بيانات الدخول غلط");

    // ---- Step 2: the second factor -------------------------------------------------
    if (body?.mfa_token !== undefined) {
      const pre = await verifyPreAuthToken(body.mfa_token);
      if (!pre) throw new ApiError(401, loc === "en" ? "The sign-in step expired — enter your password again" : "خطوة الدخول انتهت — دخّل كلمة السر تاني");
      const user = await prisma.user.findUnique({ where: { id: pre.userId } });
      if (!user || !user.active || user.sessionEpoch !== pre.sessionEpoch || !user.mfaEnabledAt) {
        throw new ApiError(401, loc === "en" ? "The sign-in step expired — enter your password again" : "خطوة الدخول انتهت — دخّل كلمة السر تاني");
      }
      await lockGuards(user.username, ip, loc);
      const method = await verifySecondFactor(
        { id: user.id, name: user.name, username: user.username, role: user.role, deviceId: ip ?? undefined },
        { code: body.code, recoveryCode: body.recovery_code },
        "login"
      );
      if (!method) {
        await recordLoginFailure(user.username, ip);
        // A code is refused both when it is wrong and when its 30-second step was already used
        // (replay protection: e.g. signing in again right after enrolling). Saying which would
        // tell the caller the code was right, so the one message covers both and says what to do.
        throw new ApiError(401, loc === "en" ? "Wrong or already used verification code — wait for the next code in the app" : "كود التحقق غلط أو اتستخدم قبل كده — استنى الكود الجاي في التطبيق");
      }
      await recordLoginSuccess(user.username, ip);
      return signIn(user, true);
    }

    // ---- Step 1: the password ------------------------------------------------------
    const { username, password } = body ?? {};
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      throw new ApiError(400, loc === "en" ? "Enter username and password" : "دخّل اسم المستخدم وكلمة السر");
    }
    await ipGuard(ip, loc);

    // The username, or the account's email (stored lower-case) when the identifier has an "@".
    const identifier = username.trim();
    const user = identifier.includes("@")
      ? await prisma.user.findUnique({ where: { email: identifier.toLowerCase() } })
      : await prisma.user.findUnique({ where: { username } });
    // One failure counter per account: the email is another way to type the same
    // username, not a second set of five guesses. An unknown identifier counts as typed.
    // Known trade-off: while an account is locked, the 429 also answers for its email (and
    // a 401 for any other address), so whoever locked a username can test which email is
    // its own. Five wrong passwords buy one such probe per lock; that is accepted rather
    // than hiding the lock behind a generic 401, which would leave the real user guessing.
    const account = user?.username ?? username;
    await accountGuard(account, loc);
    // Always pay for one bcrypt comparison, even for an unknown or disabled account.
    // Answering those instantly while a real account takes ~250ms tells anyone timing
    // the endpoint which usernames exist.
    const ok = await verifyPassword(password, user?.passwordHash ?? TIMING_DUMMY_HASH);
    if (!user || !user.active || !ok) {
      await recordLoginFailure(account, ip);
      throw invalid();
    }

    // WS6: transparent upgrade of an older, cheaper hash (cost 10 → 12) while the clear
    // password is in hand. Conditional on the hash not having changed meanwhile (an
    // administrator reset wins); `version` is untouched so no admin screen sees a
    // spurious conflict. Best effort — a failure here never blocks the sign-in.
    if (needsRehash(user.passwordHash)) {
      try {
        await prisma.user.updateMany({ where: { id: user.id, passwordHash: user.passwordHash }, data: { passwordHash: await hashPassword(password) } });
      } catch (err) {
        console.warn("[login] password rehash skipped", (err as Error)?.message);
      }
    }

    if (user.mfaEnabledAt) {
      return NextResponse.json({ mfa_required: true, mfa_token: await createPreAuthToken({ userId: user.id, sessionEpoch: user.sessionEpoch }) });
    }

    await recordLoginSuccess(account, ip);
    return signIn(user, false);
  } catch (err) {
    return handleApiError(err, req);
  }
}
