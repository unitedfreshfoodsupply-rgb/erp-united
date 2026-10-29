-- Optional email for signing in instead of the username. Additive: nullable, so existing
-- users are unchanged; unique and stored lower-case so one address is one account.
BEGIN;
ALTER TABLE "User" ADD COLUMN "email" TEXT;
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
ALTER TABLE "User" ADD CONSTRAINT "User_email_shape" CHECK ("email" IS NULL OR ("email" = lower("email") AND "email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
COMMIT;
