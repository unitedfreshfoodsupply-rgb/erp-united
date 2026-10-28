import type { Prisma } from "@prisma/client";

/** The transaction the audited change runs in. Required, not optional: an audit row
 * written after its change, in a separate statement, can be lost when that second
 * statement fails — leaving a real change with no record of it. Making the caller
 * pass the transaction lets the compiler prove every audit row commits (or rolls back)
 * together with the change it records. */
export type AuditDb = Pick<Prisma.TransactionClient, "auditLog">;

export type AuditInput = {
  userId?: string | null;
  userName: string;
  role: string;
  action: string;
  entityType:
    | "order"
    | "order_item"
    | "user"
    | "supplier"
    | "stock_product"
    | "stock_intake"
    | "stock_movement"
    | "user_permission"
    | "role_permission"
    | "product_alias"
    | "product_mapping"
    | "system_setting"
    | "company"
    | "branch"
    | "warehouse"
    | "storage_location"
    | "unit_of_measure"
    | "currency"
    | "approval_request"
    | "attachment"
    | "inventory_document"
    | "stock_lot"
    | "stock_reservation"
    | "stock_issue_exception"
    | "customer"
    | "customer_alias"
    | "customer_contact"
    | "price_list"
    | "quotation"
    | "sales_invoice"
    | "credit_note"
    | "purchase_order"
    | "rfq"
    | "supplier_bill"
    | "debit_note"
    | "trip"
    | "vehicle"
    | "driver"
    | "operational_exception"
    | "journal_entry"
    | "accounting_period"
    | "customer_receipt"
    | "customer_refund"
    | "supplier_refund"
    | "supplier_payment"
    | "bank_reconciliation"
    | "employee"
    | "department"
    | "employee_private"
    | "employee_bank_account"
    | "employee_document"
    | "work_schedule"
    | "public_holiday"
    | "attendance_day"
    | "attendance_correction"
    | "attendance_source"
    | "leave_type"
    | "leave_policy"
    | "leave_request"
    | "pay_component"
    | "employee_compensation"
    | "statutory_rule_set"
    | "payroll_run"
    | "payroll_adjustment"
    | "eta_document"
    | "eta_setup"
    | "expense"
    | "employee_transaction"
    | "integration"
    | "product_packaging"
    | "customer_group"
    | "customer_legal_entity";
  entityId: string;
  orderId?: string | null;
  fieldChanged?: string;
  oldValue?: string | number | null;
  newValue?: string | number | null;
  reason?: string;
  source: "user" | "manual" | "system" | "n8n" | "hermes";
  deviceId?: string;
};

/** Immutable append-only audit trail. Never expose update/delete for this model. */
export async function writeAudit(input: AuditInput, db: AuditDb) {
  return db.auditLog.create({
    data: {
      userId: input.userId ?? null,
      userName: input.userName,
      role: input.role,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      orderId: input.orderId ?? (input.entityType === "order" ? input.entityId : null),
      fieldChanged: input.fieldChanged,
      oldValue: input.oldValue?.toString(),
      newValue: input.newValue?.toString(),
      reason: input.reason,
      source: input.source,
      deviceId: input.deviceId,
    },
  });
}

/** Several audit rows in one insert. Same shape and guarantees as writeAudit, one
 * round trip instead of N — used where a single physical action produces a group of
 * entries (the dispatch manifest). */
export async function writeAuditMany(inputs: AuditInput[], db: AuditDb) {
  if (inputs.length === 0) return;
  return db.auditLog.createMany({
    data: inputs.map((input) => ({
      userId: input.userId ?? null,
      userName: input.userName,
      role: input.role,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      orderId: input.orderId ?? (input.entityType === "order" ? input.entityId : null),
      fieldChanged: input.fieldChanged,
      oldValue: input.oldValue?.toString(),
      newValue: input.newValue?.toString(),
      reason: input.reason,
      source: input.source,
      deviceId: input.deviceId,
    })),
  });
}
