-- Remediation 2026-11 (WF-01): a stock-issue exception is closed by a reconciliation,
-- never by a note alone. Additive: two nullable columns and their integrity rules.
ALTER TABLE "StockIssueException" ADD COLUMN "resolutionKind" TEXT;
ALTER TABLE "StockIssueException" ADD COLUMN "resolutionDocumentId" TEXT;

ALTER TABLE "StockIssueException" ADD CONSTRAINT "StockIssueException_resolutionKind_known"
  CHECK ("resolutionKind" IS NULL OR "resolutionKind" IN ('late_issue', 'no_movement', 'legacy_note'));
-- A late issue always names the issue document that carried the goods (and its COGS).
ALTER TABLE "StockIssueException" ADD CONSTRAINT "StockIssueException_late_issue_document"
  CHECK ("resolutionKind" IS DISTINCT FROM 'late_issue' OR "resolutionDocumentId" IS NOT NULL);
ALTER TABLE "StockIssueException" ADD CONSTRAINT "StockIssueException_resolutionDocumentId_fkey"
  FOREIGN KEY ("resolutionDocumentId") REFERENCES "InventoryDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Exceptions closed before this release were closed with a note: label them as such.
UPDATE "StockIssueException" SET "resolutionKind" = 'legacy_note' WHERE "status" = 'resolved' AND "resolutionKind" IS NULL;
