/* Cancel and reopen of an order (Nov 2026): one helper decides what the order screen offers
   and says, with the same words the services refuse with. No policy change: an issued invoice
   blocks reopen even when credit notes cover all of it — the message now says so. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORDER_ACTION_SAMPLE_TEXTS, ORDER_REFUSAL, orderActionState, type OrderActionFacts } from "@/lib/orderActions";
import { localizeServerMessage } from "@/lib/locale/server-messages";

const facts = (f: Partial<OrderActionFacts>): OrderActionFacts => ({ status: "new", liveStop: null, invoices: [], ...f });
const inv = (over: Partial<OrderActionFacts["invoices"][number]> = {}) => ({ id: "i1", number: "INV-2026-00007", status: "issued", fullyCredited: false, creditNotes: [], ...over });

test("an open order can be cancelled; reopen is offered only on cancelled, loaded and dispatched orders", () => {
  for (const status of ["new", "preparing", "ready_for_loading", "loading"]) {
    const s = orderActionState(facts({ status }));
    assert.deepEqual([s.cancel.offered, s.cancel.ok, s.reopen.offered], [true, true, false], status);
  }
  for (const status of ["cancelled", "loaded", "dispatched"]) assert.equal(orderActionState(facts({ status })).reopen.ok, true, status);
  assert.equal(orderActionState(facts({ status: "cancelled" })).cancel.offered, false);
});

test("dispatched: cancel says reopen first; on a trip: take it off the trip first", () => {
  const d = orderActionState(facts({ status: "dispatched" }));
  assert.deepEqual([d.cancel.ok, d.cancel.status, d.cancel.message], [false, 400, ORDER_REFUSAL.cancelDispatched]);
  assert.equal(d.cancel.message, "الأوردر خرج بالفعل — افتحه تاني الأول (إعادة فتح) وبعدين ألغيه");
  const t = orderActionState(facts({ status: "loaded", liveStop: { tripNumber: "TRP-1", tripStatus: "loaded" } }));
  assert.deepEqual([t.cancel.ok, t.cancel.status, t.cancel.message, t.cancel.trip], [false, 409, "الأوردر على رحلة — شيله من الرحلة الأول", "TRP-1"]);
  // A trip that has not left does not block reopening.
  assert.equal(t.reopen.ok, true);
});

test("a trip that has left blocks reopen; with an issued invoice the invoice is named instead (ORD-02)", () => {
  for (const tripStatus of ["dispatched", "in_transit", "completed"]) {
    const s = orderActionState(facts({ status: "dispatched", liveStop: { tripNumber: "TRP-9", tripStatus } }));
    assert.deepEqual([s.reopen.ok, s.reopen.status, s.reopen.message, s.reopen.trip], [false, 409, "الأوردر خرج على الرحلة TRP-9 — التصحيح بنتيجة التسليم (مرتجع/عجز)", "TRP-9"], tripStatus);
    // A draft invoice does not change that.
    const draft = orderActionState(facts({ status: "dispatched", liveStop: { tripNumber: "TRP-9", tripStatus }, invoices: [inv({ status: "draft", id: "d" })] }));
    assert.equal(draft.reopen.message, s.reopen.message, tripStatus);
    // Delivered and invoiced: the invoice blocks, and the note links it with the credit-note path.
    const invoiced = orderActionState(facts({ status: "dispatched", liveStop: { tripNumber: "TRP-9", tripStatus }, invoices: [inv()] }));
    assert.deepEqual([invoiced.reopen.ok, invoiced.reopen.status, invoiced.reopen.message, invoiced.reopen.invoice], [false, 409, ORDER_REFUSAL.reopenInvoiced(inv()), { id: "i1", number: "INV-2026-00007" }], tripStatus);
    // Fully credited: "closed by the credit note — copy the order".
    const credited = orderActionState(facts({ status: "dispatched", liveStop: { tripNumber: "TRP-9", tripStatus }, invoices: [inv({ fullyCredited: true, creditNotes: [{ number: "CN-1", restocked: true }] })] }));
    assert.match(credited.reopen.message!, /متخصومة بالكامل بالإشعار CN-1 — .*اعمل نسخة من الأوردر$/, tripStatus);
    assert.equal(credited.reopen.detail, "البضاعة رجعت المخزن مع الإشعار");
  }
});

test("an issued invoice blocks reopen and points to the credit note; a draft does not block", () => {
  assert.equal(orderActionState(facts({ status: "dispatched", invoices: [inv({ status: "draft", number: null })] })).reopen.ok, true);
  const s = orderActionState(facts({ status: "dispatched", invoices: [inv({ status: "draft", id: "d" }), inv()] }));
  assert.deepEqual([s.reopen.ok, s.reopen.status, s.reopen.invoice, s.reopen.detail], [false, 409, { id: "i1", number: "INV-2026-00007" }, undefined]);
  assert.equal(s.reopen.message, "الأوردر عليه فاتورة صادرة INV-2026-00007 — مينفعش يتفتح تاني؛ المرتجع أو الإلغاء بإشعار دائن من الفاتورة (مع رجوع البضاعة للمخزن لو رجعت)");
  // Partly credited: still the credit-note path.
  const partly = orderActionState(facts({ status: "dispatched", invoices: [inv({ creditNotes: [{ number: "CN-1", restocked: true }] })] }));
  assert.equal(partly.reopen.message, s.reopen.message);
  // Only a dispatched order is checked against its invoices (reopenOrder's rule).
  assert.equal(orderActionState(facts({ status: "loaded", invoices: [inv()] })).reopen.ok, true);
});

test("a fully credited invoice: still refused, and the message says the credit note closed the order", () => {
  const s = orderActionState(facts({ status: "dispatched", invoices: [inv({ fullyCredited: true, creditNotes: [{ number: "CN-2026-00003", restocked: true }] })] }));
  assert.deepEqual([s.reopen.ok, s.reopen.status], [false, 409]);
  assert.equal(s.reopen.message, "الفاتورة INV-2026-00007 متخصومة بالكامل بالإشعار CN-2026-00003 — الأوردر اتقفل بالإشعار ده ومفيش إعادة فتح بعد الفاتورة؛ لو هتبيعه تاني اعمل نسخة من الأوردر");
  assert.equal(s.reopen.detail, "البضاعة رجعت المخزن مع الإشعار");
  const noStock = orderActionState(facts({ status: "dispatched", invoices: [inv({ fullyCredited: true, creditNotes: [{ number: "CN-1", restocked: false }] })] }));
  assert.equal(noStock.reopen.detail, "الإشعار ماكانش معاه رجوع بضاعة للمخزن");
  const mixed = orderActionState(facts({ status: "dispatched", invoices: [inv({ fullyCredited: true, creditNotes: [{ number: "CN-1", restocked: false }, { number: "CN-2", restocked: true }] })] }));
  assert.equal(mixed.reopen.detail, undefined, "a mix is not summarised as either");
  assert.equal(mixed.reopen.message, "الفاتورة INV-2026-00007 متخصومة بالكامل بالإشعارات CN-1, CN-2 — الأوردر اتقفل بالإشعارات دي ومفيش إعادة فتح بعد الفاتورة؛ لو هتبيعه تاني اعمل نسخة من الأوردر");
  // Cancel stays "reopen first" (the reopen refusal explains why that is closed too).
  assert.equal(s.cancel.message, ORDER_REFUSAL.cancelDispatched);
});

test("every text the helper produces has an English translation", () => {
  for (const ar of ORDER_ACTION_SAMPLE_TEXTS) {
    const en = localizeServerMessage(ar, "en");
    assert.doesNotMatch(en, /[؀-ۿ]/, `${ar} → ${en}`);
  }
  assert.equal(localizeServerMessage(ORDER_REFUSAL.reopenTripLeft("TRP-2"), "en"), "The order left on trip TRP-2 — correct it through the delivery result (return/shortage)");
  assert.equal(
    localizeServerMessage(ORDER_REFUSAL.reopenInvoiced({ number: "INV-1", fullyCredited: true, creditNotes: [{ number: "CN-1", restocked: true }] }), "en"),
    "Invoice INV-1 is fully credited by credit note CN-1 — the order is closed by that credit note and is not reopened after invoicing; to sell it again, clone the order"
  );
  assert.equal(
    localizeServerMessage(ORDER_REFUSAL.reopenInvoiced({ number: "INV-1", fullyCredited: true, creditNotes: [{ number: "CN-1", restocked: true }, { number: "CN-2", restocked: true }] }), "en"),
    "Invoice INV-1 is fully credited by credit notes CN-1, CN-2 — the order is closed by those credit notes and is not reopened after invoicing; to sell it again, clone the order"
  );
});
