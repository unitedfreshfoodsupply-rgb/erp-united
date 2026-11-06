/**
 * Cancel and reopen of an order: whether each is possible now, why not, and what to do
 * instead (Nov 2026).
 *
 * One source for the order screen (GET /api/orders/[id]/actions) and for the refusals that
 * cancelOrder, reopenOrder and releaseOrderInvoiceForReopen throw: the services build their
 * messages with ORDER_REFUSAL below, so the screen shows exactly what the server would answer.
 * The services still check everything again when they write; this only predicts their answer
 * from facts the caller read. Not predicted: whether a reopened order can hold its stock again
 * (commitOrderStock answers that at write time).
 *
 * Policy unchanged: an order with an issued invoice is never reopened or cancelled, even when
 * credit notes cover the whole invoice — the credit note (with its return to stock) is the
 * cancellation after invoicing. Only the wording says so now.
 *
 * Pure: no database, safe to import anywhere.
 */

/** A trip in these states has left with the order: it is corrected by the delivery result. */
export const DEPARTED_TRIP_STATUSES = ["dispatched", "in_transit", "completed"] as const;
/** Reopen is offered on these orders only (the order screen's long-standing rule). */
export const REOPEN_OFFERED_STATUSES = ["cancelled", "loaded", "dispatched"] as const;

export type OrderInvoiceFact = {
  id: string;
  number: string | null;
  status: string;
  /** Its credit notes add up to its total. */
  fullyCredited: boolean;
  /** Its credit notes, oldest first; `restocked` when the goods came back with it (a return document). */
  creditNotes: { number: string; restocked: boolean }[];
};

export type OrderActionFacts = {
  status: string;
  /** The order's live trip stop, if any. */
  liveStop: { tripNumber: string; tripStatus: string } | null;
  /** Its invoices that are not void, in the order releaseOrderInvoiceForReopen reads them
   * (only read for a dispatched order — the only one an invoice can block). */
  invoices: OrderInvoiceFact[];
};

export type OrderActionState = {
  /** The action is offered on this order at all. */
  offered: boolean;
  /** The server would accept it now (as far as these facts tell). */
  ok: boolean;
  /** Refused: the HTTP status the server answers with, and its message: why — what to do instead. */
  status?: 400 | 409;
  message?: string;
  /** A fact for the screen only, e.g. whether credited goods came back to stock. */
  detail?: string;
  /** Where the next step happens. */
  invoice?: { id: string; number: string | null };
  trip?: string;
};

const T = {
  dispatched: "الأوردر خرج بالفعل",
  reopenFirst: "افتحه تاني الأول (إعادة فتح) وبعدين ألغيه",
  onTrip: "الأوردر على رحلة",
  offTripFirst: "شيله من الرحلة الأول",
  deliveryResult: "التصحيح بنتيجة التسليم (مرتجع/عجز)",
  creditNotePath: "مينفعش يتفتح تاني؛ المرتجع أو الإلغاء بإشعار دائن من الفاتورة (مع رجوع البضاعة للمخزن لو رجعت)",
  closedByCredit: "الأوردر اتقفل بالإشعار ده ومفيش إعادة فتح بعد الفاتورة؛ لو هتبيعه تاني اعمل نسخة من الأوردر",
  closedByCredits: "الأوردر اتقفل بالإشعارات دي ومفيش إعادة فتح بعد الفاتورة؛ لو هتبيعه تاني اعمل نسخة من الأوردر",
  restocked: "البضاعة رجعت المخزن مع الإشعار",
  notRestocked: "الإشعار ماكانش معاه رجوع بضاعة للمخزن",
} as const;

const said = (why: string, next: string) => `${why} — ${next}`;

/** The refusal messages the services throw (and the screen shows), Arabic as thrown. */
export const ORDER_REFUSAL = {
  cancelDispatched: said(T.dispatched, T.reopenFirst),
  cancelOnTrip: said(T.onTrip, T.offTripFirst),
  reopenTripLeft: (tripNumber: string) => said(`الأوردر خرج على الرحلة ${tripNumber}`, T.deliveryResult),
  /** An issued invoice blocks reopening; when credit notes cover all of it, say the order is closed by them. */
  reopenInvoiced: (inv: Pick<OrderInvoiceFact, "number" | "fullyCredited" | "creditNotes">) =>
    !inv.fullyCredited || !inv.creditNotes.length
      ? said(`الأوردر عليه فاتورة صادرة ${inv.number ?? ""}`, T.creditNotePath)
      : inv.creditNotes.length === 1
        ? said(`الفاتورة ${inv.number ?? ""} متخصومة بالكامل بالإشعار ${inv.creditNotes[0].number}`, T.closedByCredit)
        : said(`الفاتورة ${inv.number ?? ""} متخصومة بالكامل بالإشعارات ${inv.creditNotes.map((c) => c.number).join(", ")}`, T.closedByCredits),
} as const;

/** Whether credited goods came back to stock — stated only when it is the same for every credit note. */
function restockDetail(inv: OrderInvoiceFact): string | undefined {
  if (!inv.fullyCredited || !inv.creditNotes.length) return undefined;
  if (inv.creditNotes.every((c) => c.restocked)) return T.restocked;
  if (inv.creditNotes.every((c) => !c.restocked)) return T.notRestocked;
  return undefined;
}

const OK: OrderActionState = { offered: true, ok: true };

/** Cancel and reopen for an order, checked in the same order the services check them. */
export function orderActionState(f: OrderActionFacts): { cancel: OrderActionState; reopen: OrderActionState } {
  const departed = f.liveStop && (DEPARTED_TRIP_STATUSES as readonly string[]).includes(f.liveStop.tripStatus) ? f.liveStop : null;

  // reopenOrder: (dispatched only) an issued invoice, then a trip that has left. The invoice
  // comes first (ORD-02): once a delivered order is invoiced, the delivery result is already
  // recorded and the invoice is what blocks — its correction is the credit note, not a return
  // on the trip. Both refuse with 409; only the words (and the invoice link) differ.
  let reopen: OrderActionState = OK;
  const issued = f.status === "dispatched" ? f.invoices.find((i) => i.status === "issued") : undefined;
  if (!(REOPEN_OFFERED_STATUSES as readonly string[]).includes(f.status)) reopen = { offered: false, ok: false };
  else if (issued) reopen = { offered: true, ok: false, status: 409, message: ORDER_REFUSAL.reopenInvoiced(issued), detail: restockDetail(issued), invoice: { id: issued.id, number: issued.number }, ...(departed ? { trip: departed.tripNumber } : {}) };
  else if (departed) reopen = { offered: true, ok: false, status: 409, message: ORDER_REFUSAL.reopenTripLeft(departed.tripNumber), trip: departed.tripNumber };

  // cancelOrder: already cancelled (not offered), dispatched, then on a live trip.
  let cancel: OrderActionState = OK;
  if (f.status === "cancelled") cancel = { offered: false, ok: false };
  else if (f.status === "dispatched") cancel = { offered: true, ok: false, status: 400, message: ORDER_REFUSAL.cancelDispatched };
  else if (f.liveStop) cancel = { offered: true, ok: false, status: 409, message: ORDER_REFUSAL.cancelOnTrip, trip: f.liveStop.tripNumber };

  return { cancel, reopen };
}

/** Every text this module can produce, with sample values — for the translation coverage test. */
export const ORDER_ACTION_SAMPLE_TEXTS: readonly string[] = [
  ORDER_REFUSAL.cancelDispatched,
  ORDER_REFUSAL.cancelOnTrip,
  ORDER_REFUSAL.reopenTripLeft("TRP-2026-00001"),
  ORDER_REFUSAL.reopenInvoiced({ number: "INV-2026-00001", fullyCredited: false, creditNotes: [] }),
  ORDER_REFUSAL.reopenInvoiced({ number: "INV-2026-00001", fullyCredited: true, creditNotes: [{ number: "CN-2026-00001", restocked: true }] }),
  ORDER_REFUSAL.reopenInvoiced({ number: "INV-2026-00001", fullyCredited: true, creditNotes: [{ number: "CN-2026-00001", restocked: true }, { number: "CN-2026-00002", restocked: false }] }),
  T.restocked,
  T.notRestocked,
];
