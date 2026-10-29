import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword, createSessionToken, setSessionCookie } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/rbac";
import { isLoginLocked, isIpLoginLocked, recordLoginFailure, recordLoginSuccess } from "@/lib/loginRateLimit";
import { getSetting } from "@/lib/core/settings-service";
import type { Role } from "@/lib/types";
import { readJson } from "@/lib/http";

/** A bcrypt hash (cost 10, same as real accounts) of a random string nobody knows. It
 * only exists so a failed lookup costs the same time as a failed password. */
const TIMING_DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8DXUhCeWbcnA1sAxP7QSL6kZt0RBzu";

/** The first client address from X-Forwarded-For (set by the reverse proxy). */
function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || null;
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const loc = req.headers.get("accept-language") === "en" ? "en" : "ar";
    const { username, password } = await readJson(req);
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      throw new ApiError(400, loc === "en" ? "Enter username and password" : "دخّل اسم المستخدم وكلمة السر");
    }
    const ip = clientIp(req);

    // IP-wide lockout first: a brute force that spreads guesses across usernames
    // still trips it, because the lock is on where the guesses come from.
    const ipLock = await isIpLoginLocked(ip, await getSetting("auth.login_ip_lockout_threshold"));
    if (ipLock.locked) {
      throw new ApiError(429, loc === "en" ? `Too many failed attempts from this IP — try again in ${Math.ceil(ipLock.retryAfterSec / 60)} minutes` : `محاولات كتير غلط من العنوان ده — حاول تاني بعد ${Math.ceil(ipLock.retryAfterSec / 60)} دقيقة`);
    }

    const lockState = await isLoginLocked(username);
    if (lockState.locked) {
      throw new ApiError(429, loc === "en" ? `Too many failed attempts — try again in ${Math.ceil(lockState.retryAfterSec / 60)} minutes` : `محاولات كتير غلط — حاول تاني بعد ${Math.ceil(lockState.retryAfterSec / 60)} دقيقة`);
    }

    // The username, or the account's email (stored lower-case) when the identifier has an "@".
    const identifier = username.trim();
    const user = identifier.includes("@")
      ? await prisma.user.findUnique({ where: { email: identifier.toLowerCase() } })
      : await prisma.user.findUnique({ where: { username } });
    // Always pay for one bcrypt comparison, even for an unknown or disabled account.
    // Answering those instantly while a real account takes ~70ms tells anyone timing
    // the endpoint which usernames exist.
    const ok = await verifyPassword(password, user?.passwordHash ?? TIMING_DUMMY_HASH);
    if (!user || !user.active) {
      await recordLoginFailure(username, ip);
      throw new ApiError(401, loc === "en" ? "Invalid login credentials" : "بيانات الدخول غلط");
    }
    if (!ok) {
      await recordLoginFailure(username, ip);
      throw new ApiError(401, loc === "en" ? "Invalid login credentials" : "بيانات الدخول غلط");
    }
    await recordLoginSuccess(username, ip);

    const role = user.role as Role;
    const ttlHours = await getSetting("auth.session_ttl_hours");
    const token = await createSessionToken(
      {
        id: user.id,
        name: user.name,
        username: user.username,
        role,
        sessionEpoch: user.sessionEpoch,
      },
      ttlHours
    );
    await setSessionCookie(
      {
        id: user.id,
        name: user.name,
        username: user.username,
        role,
        sessionEpoch: user.sessionEpoch,
      },
      ttlHours
    );

    return NextResponse.json({
      user: { id: user.id, name: user.name, role, username: user.username, mustChangePassword: user.mustChangePassword },
      token,
    });
  } catch (err) {
    return handleApiError(err, req);
  }
}
