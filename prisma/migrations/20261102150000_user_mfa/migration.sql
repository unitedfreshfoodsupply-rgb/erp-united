-- WS6 / SEC-02: two-step sign-in (TOTP, RFC 6238) for privileged roles. Additive only:
-- every new User column is nullable, so no existing row changes and every existing
-- account keeps its password exactly as before. Who MUST enrol is the
-- auth.mfa_required_roles setting, enforced in code (lib/authz.ts).
--
-- The TOTP secret is never stored in clear: lib/security/mfa-crypto.ts encrypts it with
-- AES-256-GCM under a key derived from MFA_ENCRYPTION_KEY, bound to the user id.
BEGIN;

ALTER TABLE "User" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "mfaEnabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "mfaPendingSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "mfaPendingAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "mfaLastStep" INTEGER;

-- Enrolled means both: a secret and the moment it was confirmed. Same for a pending one.
ALTER TABLE "User" ADD CONSTRAINT "User_mfa_enrolled_consistent"
  CHECK (("mfaSecret" IS NULL) = ("mfaEnabledAt" IS NULL));
ALTER TABLE "User" ADD CONSTRAINT "User_mfa_pending_consistent"
  CHECK (("mfaPendingSecret" IS NULL) = ("mfaPendingAt" IS NULL));
-- Encrypted envelopes only ("v1.<iv>.<tag>.<ciphertext>") — a clear base32 secret is refused.
ALTER TABLE "User" ADD CONSTRAINT "User_mfa_secret_encrypted"
  CHECK ("mfaSecret" IS NULL OR "mfaSecret" LIKE 'v1.%');
ALTER TABLE "User" ADD CONSTRAINT "User_mfa_pending_secret_encrypted"
  CHECK ("mfaPendingSecret" IS NULL OR "mfaPendingSecret" LIKE 'v1.%');
ALTER TABLE "User" ADD CONSTRAINT "User_mfa_last_step_positive"
  CHECK ("mfaLastStep" IS NULL OR "mfaLastStep" > 0);

-- Single-use recovery codes. Only a keyed hash is kept; the codes are shown once.
CREATE TABLE "UserMfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "UserMfaRecoveryCode_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserMfaRecoveryCode_hash_shape" CHECK ("codeHash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "UserMfaRecoveryCode_userId_codeHash_key" ON "UserMfaRecoveryCode"("userId", "codeHash");
CREATE INDEX "UserMfaRecoveryCode_userId_idx" ON "UserMfaRecoveryCode"("userId");
ALTER TABLE "UserMfaRecoveryCode" ADD CONSTRAINT "UserMfaRecoveryCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserMfaRecoveryCode" ENABLE ROW LEVEL SECURITY;

-- Same posture as every other table (20261029090000): the Supabase Data API roles hold
-- nothing. Skipped where the roles do not exist (local, CI).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "UserMfaRecoveryCode" FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
