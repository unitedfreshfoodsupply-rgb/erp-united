import type { Prisma } from "@prisma/client";

/**
 * Document numbering.
 *
 * Which sequences exist, their prefix, width and reset period are defined here in
 * code; the database holds only the counter for each (sequence, period). Prefixes are
 * deliberately not editable at runtime: invoice numbering must be continuous for the
 * tax authority, and a prefix changed mid-year breaks that silently.
 *
 * Allocation is one statement — INSERT … ON CONFLICT DO UPDATE … RETURNING — run in
 * the caller's transaction. The row lock it takes serialises concurrent allocators,
 * so two documents can never share a number, and because it commits or rolls back
 * with the document it numbers, a failed save does not burn a number: committed
 * documents are gapless.
 *
 * The two numbering schemes that predate this (orders UN-YYYYMMDD-####, receipts
 * RC-YYYYMMDD-####) keep their own generators; nothing here renumbers them.
 */

export type ResetPeriod = "never" | "yearly" | "monthly" | "daily";

export type SequenceDef = {
  prefix: string;
  /** Digits in the running number. */
  padding: number;
  reset: ResetPeriod;
  label: string;
};

export const SEQUENCE_DEFS = {
  "inventory.receipt": { prefix: "GRN", padding: 5, reset: "yearly", label: "إذن استلام" },
  "inventory.transfer": { prefix: "TRF", padding: 5, reset: "yearly", label: "تحويل مخزني" },
  "inventory.adjustment": { prefix: "ADJ", padding: 5, reset: "yearly", label: "تسوية مخزون" },
  "inventory.return": { prefix: "RET", padding: 5, reset: "yearly", label: "مرتجع" },
  "inventory.issue": { prefix: "ISS", padding: 5, reset: "yearly", label: "إذن صرف" },
  "inventory.sorting": { prefix: "SRT", padding: 5, reset: "yearly", label: "فرز مخزون" },
  "inventory.release": { prefix: "REL", padding: 5, reset: "yearly", label: "إفراج محجوز" },
  "inventory.lot": { prefix: "LOT", padding: 4, reset: "daily", label: "دفعة (لوت)" },
  "core.approval": { prefix: "APR", padding: 5, reset: "yearly", label: "طلب موافقة" },
  "sales.customer": { prefix: "CUS", padding: 5, reset: "never", label: "كود عميل" },
  "sales.quotation": { prefix: "QUO", padding: 5, reset: "yearly", label: "عرض سعر" },
  "sales.invoice": { prefix: "INV", padding: 5, reset: "yearly", label: "فاتورة مبيعات" },
  "sales.credit_note": { prefix: "CN", padding: 5, reset: "yearly", label: "إشعار دائن" },
  "purchasing.supplier": { prefix: "SUP", padding: 5, reset: "never", label: "كود مورد" },
  "purchasing.rfq": { prefix: "RFQ", padding: 5, reset: "yearly", label: "طلب عرض سعر" },
  "purchasing.order": { prefix: "PO", padding: 5, reset: "yearly", label: "أمر شراء" },
  "purchasing.bill": { prefix: "BILL", padding: 5, reset: "yearly", label: "فاتورة مورد" },
  "purchasing.debit_note": { prefix: "DN", padding: 5, reset: "yearly", label: "إشعار مدين لمورد" },
  "operations.trip": { prefix: "TRP", padding: 5, reset: "yearly", label: "رحلة توزيع" },
  "accounting.journal": { prefix: "JE", padding: 5, reset: "yearly", label: "قيد يومية" },
  "accounting.receipt": { prefix: "RCT", padding: 5, reset: "yearly", label: "إيصال تحصيل" },
  "accounting.payment": { prefix: "PAY", padding: 5, reset: "yearly", label: "سند صرف لمورد" },
  "accounting.customer_refund": { prefix: "RFD", padding: 5, reset: "yearly", label: "رد مبلغ لعميل" },
  "accounting.supplier_refund": { prefix: "SRF", padding: 5, reset: "yearly", label: "استرداد مبلغ من مورد" },
  "hr.employee": { prefix: "EMP", padding: 5, reset: "never", label: "كود موظف" },
  "hr.expense": { prefix: "EXP", padding: 5, reset: "yearly", label: "مصروف" },
  "hr.attendance_correction": { prefix: "ATC", padding: 5, reset: "yearly", label: "تصحيح حضور" },
  "hr.leave_request": { prefix: "LVR", padding: 5, reset: "yearly", label: "طلب إجازة" },
  "hr.compensation": { prefix: "CMP", padding: 5, reset: "yearly", label: "مرتب مقترح" },
  "hr.payroll_run": { prefix: "PRL", padding: 5, reset: "yearly", label: "مسير مرتبات" },
  "hr.payroll_adjustment": { prefix: "PAD", padding: 5, reset: "yearly", label: "تسوية مرتب" },
} as const satisfies Record<string, SequenceDef>;

export type SequenceKey = keyof typeof SEQUENCE_DEFS;

/** The counter bucket a date falls in, from a YYYY-MM-DD business date. */
export function periodOf(reset: ResetPeriod, businessDate: string): string {
  const [y, m, d] = businessDate.split("-");
  switch (reset) {
    case "never":
      return "all";
    case "yearly":
      return y;
    case "monthly":
      return `${y}${m}`;
    case "daily":
      return `${y}${m}${d}`;
  }
}

export function formatDocumentNumber(def: SequenceDef, period: string, value: number) {
  const run = String(value).padStart(def.padding, "0");
  return def.reset === "never" ? `${def.prefix}-${run}` : `${def.prefix}-${period}-${run}`;
}

/** Allocates the next number. MUST be called inside the transaction that saves the
 * document, so the number and the document commit (or roll back) together. */
export async function nextDocumentNumber(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  key: SequenceKey,
  businessDate: string
): Promise<string> {
  const def: SequenceDef = SEQUENCE_DEFS[key];
  const period = periodOf(def.reset, businessDate);
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "NumberSequenceCounter" ("sequenceKey", "period", "lastValue", "updatedAt")
    VALUES (${key}, ${period}, 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("sequenceKey", "period")
    DO UPDATE SET "lastValue" = "NumberSequenceCounter"."lastValue" + 1, "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "lastValue"
  `;
  return formatDocumentNumber(def, period, Number(rows[0].lastValue));
}
