import type { Permission } from "@/lib/permissions";

/**
 * An order's timeline is part of working the order, so every role that may see the
 * order may see its timeline — but not the commercial events written into it.
 * Prices, credit decisions and invoices are visible only to the permissions that
 * would show the same facts elsewhere. Rows are dropped, not blanked: a preparer has
 * no business knowing that a price changed, let alone to what.
 */

type Row = { action: string; entityType: string; fieldChanged: string | null };

const RULES: { applies: (r: Row) => boolean; anyOf: Permission[] }[] = [
  { applies: (r) => r.action === "order_priced" || r.action === "order_line_price_overridden", anyOf: ["sales.pricing.view"] },
  { applies: (r) => r.action.startsWith("order_credit_"), anyOf: ["sales.customers.view", "sales.credit.manage"] },
  { applies: (r) => r.entityType === "approval_request" && r.fieldChanged === "sales.credit", anyOf: ["sales.customers.view", "sales.credit.manage"] },
  { applies: (r) => r.entityType === "sales_invoice" || r.entityType === "credit_note", anyOf: ["sales.invoices.view"] },
  // Purchasing: PO amounts, agreed supplier prices and quotes are price information;
  // bills and debit notes are payables.
  { applies: (r) => ["purchase_order_created", "purchase_order_edited", "purchase_order_submitted"].includes(r.action) || r.action.startsWith("supplier_price_") || r.entityType === "rfq", anyOf: ["purchasing.prices.view"] },
  { applies: (r) => r.entityType === "supplier_bill" || r.entityType === "debit_note", anyOf: ["purchasing.bills.view"] },
  { applies: (r) => r.entityType === "approval_request" && r.fieldChanged === "purchasing.bill", anyOf: ["purchasing.bills.view"] },
  // Private data, bank accounts and the document register: only those who may read the data
  // itself (the rows hold field names and masked numbers, but even who-looked-at-whom is private).
  { applies: (r) => ["employee_private", "employee_bank_account", "employee_document"].includes(r.entityType), anyOf: ["hr.private.view"] },
  // Attendance: who was absent or late, and every correction, stays with those who keep the register.
  { applies: (r) => ["work_schedule", "public_holiday", "attendance_day", "attendance_correction", "attendance_source"].includes(r.entityType) || (r.entityType === "approval_request" && r.fieldChanged === "hr.attendance_correction"), anyOf: ["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"] },
  // Leave: who is away and why stays with those who record, approve or configure leave.
  { applies: (r) => ["leave_type", "leave_policy", "leave_request"].includes(r.entityType) || (r.entityType === "approval_request" && r.fieldChanged === "hr.leave"), anyOf: ["hr.leave.request", "hr.leave.approve", "hr.leave.configure"] },
  // Salaries: who earns what, and every package decision, only for those who may read salaries.
  { applies: (r) => r.entityType === "employee_compensation" || (r.entityType === "approval_request" && r.fieldChanged === "hr.compensation_change"), anyOf: ["hr.compensation.view", "hr.payroll.approve"] },
  { applies: (r) => ["payroll_run", "payroll_adjustment", "payroll_payment"].includes(r.entityType) || (r.entityType === "approval_request" && r.fieldChanged === "hr.payroll_run"), anyOf: ["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"] },
  { applies: (r) => ["pay_component", "statutory_rule_set"].includes(r.entityType), anyOf: ["hr.compensation.view", "hr.statutory.manage", "hr.payroll.prepare", "hr.payroll.approve", "hr.payroll.view"] },
  { applies: (r) => ["employee", "department", "expense", "employee_transaction"].includes(r.entityType) || (r.entityType === "approval_request" && r.fieldChanged === "hr.expense"), anyOf: ["accounting.view", "hr.employees.manage", "hr.expenses.approve"] },
  { applies: (r) => ["journal_entry", "accounting_period", "customer_receipt", "supplier_payment", "bank_reconciliation"].includes(r.entityType), anyOf: ["accounting.view"] },
];

export function visibleAuditRows<T extends Row>(rows: T[], can: (p: Permission) => boolean): T[] {
  return rows.filter((r) => RULES.every((rule) => !rule.applies(r) || rule.anyOf.some((p) => can(p))));
}
