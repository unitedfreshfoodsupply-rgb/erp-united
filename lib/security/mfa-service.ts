import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { inTx } from "@/lib/tx";
import { MFA_ENCRYPTION_KEY } from "@/lib/env";
import { getSetting } from "@/lib/core/settings-service";
import { ABSOLUTE_ROLE } from "@/lib/permissions";
import { decryptMfaSecret, encryptMfaSecret, hashRecoveryCode } from "@/lib/security/mfa-crypto";
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp } from "@/lib/security/totp";
import { verifyPassword } from "@/lib/security/password-policy";

/**
 * Two-step sign-in (TOTP) — enrolment, verification, recovery codes, disable, and the
 * administrator reset. Routes stay thin; every rule lives here.
 *
 * Invariants:
 *  - A secret is shown exactly once (at enrolment start) and stored only encrypted.
 *  - A code is accepted at most once (mfaLastStep, advanced with a conditional UPDATE so
 *    two requests racing with the same code cannot both pass).
 *  - A recovery code is consumed with a conditional UPDATE for the same reason.
 *  - Enrolling, and an administrator reset, end every other session (sessionEpoch + 1):
 *    a session minted before the second factor existed must not outlive it.
 *  - Every state change writes an audit row in the same transaction. No row ever holds a
 *    secret or a code — only that something happened.
 */

type Who = { id: string; name: string; username: string; role: string; deviceId?: string };

/** A pending enrolment that was never confirmed stops being usable after this. */
const PENDING_TTL_MS = 15 * 60_000;

export async function mfaRequiredRoles(): Promise<readonly string[]> {
  return getSetting("auth.mfa_required_roles");
}

export async function isMfaRequiredForRole(role: string): Promise<boolean> {
  return (await mfaRequiredRoles()).includes(role);
}

function audit(actor: Who, action: string, targetId: string, newValue: string | null, tx: Parameters<typeof writeAudit>[1], reason?: string) {
  return writeAudit(
    { userId: actor.id, userName: actor.name, role: actor.role, action, entityType: "user", entityId: targetId, fieldChanged: "mfa", newValue, reason, source: "user", deviceId: actor.deviceId },
    tx
  );
}

export async function mfaStatus(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, mfaEnabledAt: true } });
  if (!user) throw new ApiError(404, "المستخدم مش موجود");
  const remaining = user.mfaEnabledAt ? await prisma.userMfaRecoveryCode.count({ where: { userId, usedAt: null } }) : 0;
  return {
    enabled: !!user.mfaEnabledAt,
    enabledAt: user.mfaEnabledAt,
    required: await isMfaRequiredForRole(user.role),
    recoveryCodesRemaining: remaining,
  };
}

/** Step 1 of enrolment: a fresh secret, stored encrypted as pending and returned ONCE. */
export async function startEnrollment(user: Who) {
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaEnabledAt: true } });
  if (!row) throw new ApiError(404, "المستخدم مش موجود");
  if (row.mfaEnabledAt) throw new ApiError(409, "التحقق بخطوتين مفعّل بالفعل على حسابك");
  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaPendingSecret: encryptMfaSecret(secret, user.id, MFA_ENCRYPTION_KEY), mfaPendingAt: new Date() },
  });
  return { secret, otpauthUri: otpauthUri(secret, user.username) };
}

/**
 * Step 2 of enrolment: the first code from the app proves the secret was captured.
 * Returns the recovery codes (shown once) and the new session epoch — the caller
 * re-issues the current session under it, every other session ends.
 */
export async function confirmEnrollment(user: Who, code: unknown) {
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaEnabledAt: true, mfaPendingSecret: true, mfaPendingAt: true } });
  if (!row) throw new ApiError(404, "المستخدم مش موجود");
  if (row.mfaEnabledAt) throw new ApiError(409, "التحقق بخطوتين مفعّل بالفعل على حسابك");
  if (!row.mfaPendingSecret || !row.mfaPendingAt || Date.now() - row.mfaPendingAt.getTime() > PENDING_TTL_MS) {
    throw new ApiError(409, "ابدأ التفعيل من الأول — الكود اللي اتعرض انتهى");
  }
  const secret = decryptMfaSecret(row.mfaPendingSecret, user.id, MFA_ENCRYPTION_KEY);
  const step = verifyTotp(secret, code);
  if (step === null) throw new ApiError(400, "كود التحقق غلط — اكتب الكود اللي ظاهر في التطبيق دلوقتي");

  const codes = generateRecoveryCodes();
  const updated = await inTx(async (tx) => {
    const u = await tx.user.update({
      where: { id: user.id },
      data: {
        mfaSecret: row.mfaPendingSecret,
        mfaEnabledAt: new Date(),
        mfaPendingSecret: null,
        mfaPendingAt: null,
        mfaLastStep: step,
        sessionEpoch: { increment: 1 },
      },
      select: { sessionEpoch: true },
    });
    await tx.userMfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.userMfaRecoveryCode.createMany({
      data: codes.map((c) => ({ userId: user.id, codeHash: hashRecoveryCode(normalizeRecoveryCode(c)!, user.id, MFA_ENCRYPTION_KEY) })),
    });
    await audit(user, "mfa_enrolled", user.id, `${codes.length} recovery codes`, tx);
    return u;
  });
  return { recoveryCodes: codes, sessionEpoch: updated.sessionEpoch };
}

/**
 * Checks the second factor of an ENROLLED user: a 6-digit code, or a recovery code
 * (consumed, audited). Returns the method used, or null when it does not verify.
 */
export async function verifySecondFactor(
  user: Who,
  input: { code?: unknown; recoveryCode?: unknown },
  source: "login" | "disable" | "regenerate"
): Promise<"totp" | "recovery" | null> {
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaSecret: true, mfaLastStep: true } });
  if (!row?.mfaSecret) return null;

  if (input.code !== undefined && input.code !== null && input.code !== "") {
    const secret = decryptMfaSecret(row.mfaSecret, user.id, MFA_ENCRYPTION_KEY);
    const step = verifyTotp(secret, input.code, { lastUsedStep: row.mfaLastStep });
    if (step === null) return null;
    // Conditional advance: a concurrent request with the same code loses here.
    const won = await prisma.user.updateMany({
      where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
      data: { mfaLastStep: step },
    });
    return won.count === 1 ? "totp" : null;
  }

  const normalized = normalizeRecoveryCode(input.recoveryCode);
  if (!normalized) return null;
  const codeHash = hashRecoveryCode(normalized, user.id, MFA_ENCRYPTION_KEY);
  return inTx(async (tx) => {
    const used = await tx.userMfaRecoveryCode.updateMany({ where: { userId: user.id, codeHash, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) return null;
    const left = await tx.userMfaRecoveryCode.count({ where: { userId: user.id, usedAt: null } });
    await audit(user, "mfa_recovery_code_used", user.id, `${source} · ${left} left`, tx);
    return "recovery" as const;
  });
}

async function assertPasswordAndFactor(user: Who, password: unknown, input: { code?: unknown; recoveryCode?: unknown }, source: "disable" | "regenerate") {
  if (typeof password !== "string" || !password) throw new ApiError(400, "اكتب كلمة السر الحالية");
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true, mfaEnabledAt: true } });
  if (!row) throw new ApiError(404, "المستخدم مش موجود");
  if (!row.mfaEnabledAt) throw new ApiError(409, "التحقق بخطوتين مش مفعّل على حسابك");
  if (!(await verifyPassword(password, row.passwordHash))) throw new ApiError(401, "كلمة السر أو كود التحقق غلط");
  if (!(await verifySecondFactor(user, input, source))) throw new ApiError(401, "كلمة السر أو كود التحقق غلط");
}

/** The user turns their own MFA off: password AND a current code (or a recovery code). */
export async function disableOwnMfa(user: Who, password: unknown, input: { code?: unknown; recoveryCode?: unknown }) {
  if (await isMfaRequiredForRole(user.role)) {
    throw new ApiError(409, "دورك لازم يكون عليه التحقق بخطوتين — لو فقدت الجهاز اطلب من مدير النظام يعمل إعادة ضبط");
  }
  await assertPasswordAndFactor(user, password, input, "disable");
  await inTx(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { mfaSecret: null, mfaEnabledAt: null, mfaPendingSecret: null, mfaPendingAt: null, mfaLastStep: null } });
    await tx.userMfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await audit(user, "mfa_disabled", user.id, null, tx);
  });
  return { ok: true };
}

/** New recovery codes (the old ones stop working): password AND a current code. */
export async function regenerateRecoveryCodes(user: Who, password: unknown, input: { code?: unknown; recoveryCode?: unknown }) {
  await assertPasswordAndFactor(user, password, input, "regenerate");
  const codes = generateRecoveryCodes();
  await inTx(async (tx) => {
    await tx.userMfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.userMfaRecoveryCode.createMany({
      data: codes.map((c) => ({ userId: user.id, codeHash: hashRecoveryCode(normalizeRecoveryCode(c)!, user.id, MFA_ENCRYPTION_KEY) })),
    });
    await audit(user, "mfa_recovery_codes_regenerated", user.id, `${codes.length} recovery codes`, tx);
  });
  return { recoveryCodes: codes };
}

/**
 * Administrator reset (lost phone AND lost recovery codes): clears the second factor
 * and ends every session of the account; at its next sign-in a user in a required role
 * enrols again.
 *
 * Four-eyes: an administrator may not reset their OWN second factor while another
 * active super admin exists — the classic "attacker with a stolen admin password
 * removes the admin's MFA" path. Alone in the system, they may (it is audited as such).
 * A super admin's MFA is reset only by a super admin (same rule as their password).
 */
export async function adminResetMfa(actor: Who, targetId: string, rawReason: unknown) {
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (!reason) throw new ApiError(400, "لازم تكتب سبب إعادة ضبط التحقق بخطوتين");
  if (reason.length > 500) throw new ApiError(400, "السبب طويل (أقصى 500 حرف)");
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, username: true, role: true, mfaEnabledAt: true, mfaPendingAt: true } });
  if (!target) throw new ApiError(404, "المستخدم مش موجود");
  if (target.role === ABSOLUTE_ROLE && actor.role !== ABSOLUTE_ROLE) {
    throw new ApiError(403, "بس مدير النظام يقدر يعدّل حساب مدير نظام");
  }
  let self = false;
  if (target.id === actor.id) {
    const others = await prisma.user.count({ where: { role: ABSOLUTE_ROLE, active: true, id: { not: actor.id } } });
    if (others > 0) throw new ApiError(403, "إعادة ضبط التحقق بخطوتين لحسابك لازم يعملها مدير نظام تاني");
    self = true;
  }
  if (!target.mfaEnabledAt && !target.mfaPendingAt) throw new ApiError(409, "التحقق بخطوتين مش مفعّل على الحساب ده");
  await inTx(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: { mfaSecret: null, mfaEnabledAt: null, mfaPendingSecret: null, mfaPendingAt: null, mfaLastStep: null, sessionEpoch: { increment: 1 }, version: { increment: 1 } },
    });
    await tx.userMfaRecoveryCode.deleteMany({ where: { userId: target.id } });
    await audit(actor, self ? "mfa_reset_self_sole_admin" : "mfa_reset", target.id, target.username, tx, reason);
  });
  return { ok: true };
}
