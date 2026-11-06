type BillDebitInput = {
  status: string;
  service: boolean;
  lines: { quantity: string; debitedQty: string }[];
  serviceLines: { net: string; debitedNet: string }[];
  debitNotes: unknown[];
};

/** A debit note is limited by what is left to debit on the lines, as on the server — not by the
 * open amount: a bill paid in full can still take one for goods returned afterwards. Debit notes
 * that took everything back make the bill "fully debited", with nothing left to debit. */
export function billDebitFacts(b: BillDebitInput) {
  const debitable = b.service ? b.serviceLines.some((l) => Number(l.debitedNet) < Number(l.net)) : b.lines.some((l) => Number(l.debitedQty) < Number(l.quantity));
  return { debitable, fullyDebited: b.status === "posted" && !debitable && b.debitNotes.length > 0 };
}
