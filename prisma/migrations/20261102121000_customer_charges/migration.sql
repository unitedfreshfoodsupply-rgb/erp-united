-- WS3 (remediation 2026-11) G1 — a fixed asset sold on credit to a customer.
-- Additive: a customer receivable that is not a sales invoice (today: an asset sale). It is
-- part of the customer's balance (statement, aging, credit exposure, AR per party) and is
-- settled by money received on account. Append-only, like the other customer documents.

CREATE TABLE "CustomerCharge" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'EGP',
    "net" DECIMAL(18,2) NOT NULL,
    "tax" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "entryId" TEXT,
    "createdById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerCharge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CustomerCharge_source_known" CHECK ("sourceType" IN ('asset_disposal')),
    CONSTRAINT "CustomerCharge_amounts" CHECK ("net" > 0 AND "tax" >= 0 AND "total" = "net" + "tax"),
    CONSTRAINT "CustomerCharge_dates" CHECK ("date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "dueDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "dueDate" >= "date"),
    CONSTRAINT "CustomerCharge_egp" CHECK ("currencyCode" = 'EGP')
);
CREATE UNIQUE INDEX "CustomerCharge_sourceType_sourceId_key" ON "CustomerCharge"("sourceType", "sourceId");
CREATE INDEX "CustomerCharge_customerId_dueDate_idx" ON "CustomerCharge"("customerId", "dueDate");
CREATE INDEX "CustomerCharge_entryId_idx" ON "CustomerCharge"("entryId");
ALTER TABLE "CustomerCharge" ADD CONSTRAINT "CustomerCharge_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCharge" ADD CONSTRAINT "CustomerCharge_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "CustomerCharge_append_only" BEFORE UPDATE OR DELETE ON "CustomerCharge" FOR EACH ROW EXECUTE FUNCTION sales_append_only();
ALTER TABLE "CustomerCharge" ENABLE ROW LEVEL SECURITY;
