import type { Permission } from "@/lib/permissions";
import type { Tx } from "@/lib/tx";

/**
 * Which business records can carry attachments, and who may see / add to them.
 * Access to a file is access to the record it belongs to — the same permissions,
 * resolved the same way. A module adds its record type here when it needs files.
 */
type EntityDef = {
  view: Permission[];
  manage: Permission[];
  exists: (db: Tx, id: string) => Promise<boolean>;
};

const found = (row: unknown) => row !== null;

export const ATTACHMENT_ENTITIES: Record<string, EntityDef> = {
  order: {
    view: ["orders.view"],
    manage: ["orders.edit"],
    exists: (db, id) => db.order.findUnique({ where: { id }, select: { id: true } }).then(found),
  },
  supplier: {
    view: ["stock.view"],
    manage: ["stock.manage_suppliers"],
    exists: (db, id) => db.supplier.findUnique({ where: { id }, select: { id: true } }).then(found),
  },
  stock_intake: {
    view: ["stock.view"],
    manage: ["stock.receive", "stock.sort"],
    exists: (db, id) => db.stockIntake.findUnique({ where: { id }, select: { id: true } }).then(found),
  },
  stock_product: {
    view: ["stock.view"],
    manage: ["stock.manage_products"],
    exists: (db, id) => db.stockProduct.findUnique({ where: { id }, select: { id: true } }).then(found),
  },
  company: {
    view: ["core.masterdata.view"],
    manage: ["core.masterdata.manage"],
    exists: (db, id) => db.company.findUnique({ where: { id }, select: { id: true } }).then(found),
  },
  warehouse: {
    view: ["core.masterdata.view"],
    manage: ["core.masterdata.manage"],
    exists: (db, id) => db.warehouse.findUnique({ where: { id }, select: { id: true } }).then(found),
  },
  // An employee's file (ID copy, contract, insurance forms…) is private data: the same
  // permissions as the national ID and bank account, not the directory's.
  employee: {
    view: ["hr.private.view"],
    manage: ["hr.private.manage"],
    exists: (db, id) => db.employee.findUnique({ where: { id }, select: { id: true } }).then(found),
  },
  // The supplier's receipt or invoice for a payment — for a payment from purchasing custody, a
  // payment with no file is a missing receipt (lib/hr/custody.ts). Finance and payment clerks.
  // The supplier's own invoice (scan or PDF) and its supporting documents, on UNITED's bill.
  supplier_bill: {
    view: ["purchasing.bills.view"],
    manage: ["purchasing.bills.manage"],
    exists: (db, id) => db.supplierBill.findUnique({ where: { id }, select: { id: true } }).then(found),
  },
  // A sales invoice's supporting documents (the customer's signed delivery note, their PO).
  sales_invoice: {
    view: ["sales.invoices.view"],
    manage: ["sales.invoices.manage"],
    exists: (db, id) => db.salesInvoice.findUnique({ where: { id }, select: { id: true } }).then(found),
  },
  supplier_payment: {
    view: ["accounting.view", "accounting.payments.manage"],
    manage: ["accounting.payments.manage"],
    exists: (db, id) => db.supplierPayment.findUnique({ where: { id }, select: { id: true } }).then(found),
  },
  // A medical certificate or other proof for a leave request: seen by whoever handles leave.
  leave_request: {
    view: ["hr.leave.request", "hr.leave.approve"],
    manage: ["hr.leave.request"],
    exists: (db, id) => db.leaveRequest.findUnique({ where: { id }, select: { id: true } }).then(found),
  },
};

export const ATTACHMENT_CATEGORIES = [
  "contract",
  "invoice",
  "delivery_note",
  "purchase_document",
  "quality_photo",
  "receipt",
  "tax_document",
  "other",
  // Employee files (HR phase 1).
  "id_document",
  "employment_contract",
  "insurance_form",
  "certificate",
  "medical",
] as const;
export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number];

export const ATTACHMENT_CATEGORY_LABEL: Record<AttachmentCategory, string> = {
  contract: "عقد",
  invoice: "فاتورة",
  delivery_note: "إذن تسليم",
  purchase_document: "مستند شراء",
  quality_photo: "صورة جودة",
  receipt: "إيصال",
  tax_document: "مستند ضريبي",
  other: "أخرى",
  id_document: "إثبات شخصية",
  employment_contract: "عقد عمل",
  insurance_form: "استمارة تأمينات",
  certificate: "شهادة",
  medical: "مستند طبي",
};

/** The categories offered when filing on a given record type (all others keep the original list). */
export const ATTACHMENT_CATEGORIES_FOR: Partial<Record<string, readonly AttachmentCategory[]>> = {
  leave_request: ["medical", "certificate", "other"],
  employee: ["id_document", "employment_contract", "insurance_form", "certificate", "medical", "other"],
  supplier_payment: ["receipt", "invoice", "purchase_document", "other"],
  supplier_bill: ["invoice", "tax_document", "purchase_document", "delivery_note", "other"],
  sales_invoice: ["delivery_note", "purchase_document", "contract", "other"],
};
