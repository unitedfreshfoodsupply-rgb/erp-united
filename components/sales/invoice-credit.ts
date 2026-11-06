/** Every line credited in full: the credit notes add up to the invoice, so nothing is left to
 * credit. The same rule as the server (invoiceCreditFacts, invoiceDocument), for the list and the
 * detail alike. */
export const isFullyCredited = (i: { status: string; total: string; credited: string }) =>
  i.status === "issued" && Number(i.total) > 0 && Number(i.credited) >= Number(i.total);
