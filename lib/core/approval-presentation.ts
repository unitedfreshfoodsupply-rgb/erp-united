/**
 * How screens present approval types (client-safe; the definitions live in lib/core/approvals.ts,
 * which reads the database). tests/unit/approval-presentation.test.ts keeps every name here a
 * real approval type.
 */

/** The approval types a record's own screen shows a "waiting for approval" notice for. */
export const APPROVAL_TYPE = {
  openingBatch: "accounting.opening_batch",
  openingMigrationClose: "accounting.opening_migration_close",
  manualJournal: "accounting.manual_journal",
} as const;

/** Types whose request `amount` is money (others carry a quantity, or nothing). */
export const MONEY_TYPES: ReadonlySet<string> = new Set([
  "accounting.supplier_payment", "accounting.cash_transfer", "accounting.manual_journal", "accounting.opening_batch",
  "hr.expense", "hr.custody_advance", "hr.payroll_run", "hr.compensation_change",
  "purchasing.order", "purchasing.bill", "sales.credit", "inventory.grading_loss",
]);

/** Approving these posts to the ledger, moves money or stock, or cannot be taken back: the screen asks first. */
export const CONFIRM_TYPES: ReadonlySet<string> = new Set([
  "accounting.supplier_payment", "accounting.cash_transfer", "accounting.manual_journal", "accounting.opening_batch",
  "accounting.opening_migration_close", "accounting.year_reopen",
  "hr.expense", "hr.custody_advance", "hr.payroll_run", "purchasing.bill", "inventory.adjustment",
]);

/** The emergency self-approval needs a written reason of at least this many characters (recordDecision). */
export const EMERGENCY_REASON_MIN = 10;
