-- WS4 ETA remediation: state machine, portal filings, evidence of what was sent, UUID history.
-- Additive only: new columns with defaults, a wider status CHECK (one new value), new
-- constraints and a guard trigger. No row is changed (production holds no EtaDocument rows).

ALTER TABLE "EtaDocument" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'api';
ALTER TABLE "EtaDocument" ADD COLUMN "priorUuids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "EtaDocument" ADD COLUMN "documentHash" TEXT;
ALTER TABLE "EtaDocument" ADD COLUMN "signedPayload" TEXT;
ALTER TABLE "EtaDocument" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

-- Status set gains `receiver_rejected` (a registered document the receiver rejected: never
-- resent). Same check otherwise; origin is a closed set.
ALTER TABLE "EtaDocument" DROP CONSTRAINT "EtaDocument_values";
ALTER TABLE "EtaDocument" ADD CONSTRAINT "EtaDocument_values" CHECK (
  "sourceType" IN ('sales_invoice', 'credit_note', 'debit_note')
  AND "documentType" IN ('i', 'c', 'd')
  AND "status" IN ('pending', 'submitting', 'submitted', 'valid', 'invalid', 'rejected', 'failed', 'unknown', 'cancelled', 'receiver_rejected')
  AND "attempts" >= 0
  AND "origin" IN ('api', 'portal')
);

-- A portal filing is recorded only with the UUID the portal gave it.
ALTER TABLE "EtaDocument" ADD CONSTRAINT "EtaDocument_portal_uuid" CHECK ("origin" <> 'portal' OR "uuid" IS NOT NULL);

-- A stored ETA UUID is never overwritten or erased. The one exception is a resend of an
-- API document ETA found `invalid`: the claim moves the old UUID into priorUuids (which only
-- ever grows) in the same update. A portal filing never turns into an API document.
CREATE OR REPLACE FUNCTION eta_document_uuid_guard() RETURNS trigger AS $$
BEGIN
  IF NOT (NEW."priorUuids" @> OLD."priorUuids") THEN
    RAISE EXCEPTION 'ETA UUID history is append-only (%)', OLD."internalId" USING ERRCODE = 'P0001';
  END IF;
  IF OLD."uuid" IS NOT NULL AND NEW."uuid" IS DISTINCT FROM OLD."uuid" THEN
    IF NOT (OLD."status" = 'invalid' AND OLD."origin" = 'api' AND NEW."status" = 'submitting' AND OLD."uuid" = ANY (NEW."priorUuids")) THEN
      RAISE EXCEPTION 'ETA UUID of % is permanent and cannot be overwritten', OLD."internalId" USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF OLD."origin" = 'portal' AND NEW."origin" <> 'portal' THEN
    RAISE EXCEPTION 'ETA document % was filed on the portal and cannot become an API submission', OLD."internalId" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EtaDocument_uuid_guard" BEFORE UPDATE ON "EtaDocument" FOR EACH ROW EXECUTE FUNCTION eta_document_uuid_guard();

CREATE INDEX "EtaDocument_origin_status_idx" ON "EtaDocument"("origin", "status");
