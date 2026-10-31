/** Pure (imported by the journal form as well as the server). */

/**
 * Accounts whose balance is the sum of a document ledger (customer statements, supplier
 * statements, the stock ledger, employee balances). A manual journal on them would move
 * the GL without the documents and the two would silently disagree; the document that
 * moves each one is named instead.
 */
export const CONTROL_ACCOUNTS: Record<string, string> = {
  ar: "فاتورة أو إشعار دائن أو تحصيل أو رصيد افتتاحي للعميل",
  ap: "فاتورة مورد أو إشعار مدين أو سداد أو رصيد افتتاحي للمورد",
  inventory: "حركة مخزون (استلام، صرف، تسوية، مخزون افتتاحي)",
  grni: "استلام بضاعة أو فاتورة مورد",
  employee_advances: "حركة موظف (سلفة / تسوية)",
  employee_payable: "مصروف موظف أو حركة موظف",
  vat_input: "فاتورة مورد أو إشعار مدين أو إقرار ضريبة القيمة المضافة",
  vat_output: "فاتورة مبيعات أو إشعار دائن أو بيع أصل أو إقرار ضريبة القيمة المضافة",
  vat_payable: "إقرار ضريبة القيمة المضافة وسداده",
};
/** Accounts owned by a subledger through their own column (category accounts of fixed assets). */
const CONTROLLED_BY: Record<string, string> = {
  fixed_assets: "سجل الأصول الثابتة (شراء، إهلاك، استبعاد)",
};

/** The document that moves a control account, or undefined for an ordinary account. */
export function controlAccountMovedBy(systemKey: string | null | undefined, controlledBy?: string | null): string | undefined {
  return (systemKey ? CONTROL_ACCOUNTS[systemKey] : undefined) ?? (controlledBy ? CONTROLLED_BY[controlledBy] : undefined);
}

