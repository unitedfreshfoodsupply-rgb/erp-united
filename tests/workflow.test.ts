/* Approval engine + notification centre, driven through the real order workflow:
   a preparer records a short quantity, the engine raises a request, approvers are
   notified, and the decision — from the inbox or the order screen — releases the
   order in the same transaction. */
import { call, login, makeChecker, BASE, cookieFor } from "./_harness";
import { stockUp } from "./_stock";

const { check, section, finish } = makeChecker();
const TAG = `ZZWF-${Date.now()}`;
let r: any;
let workflowCustomer: any;
let workflowProduct: any;

async function newOrderInPreparation(qty = 100) {
  workflowCustomer ??= (await call("admin", "POST", "/api/sales/customers", { name: `${TAG} عميل` })).body.customer;
  if (!workflowProduct) {
    workflowProduct = (await call("admin", "POST", "/api/stock/products", { name: `${TAG} Mango`, unit: "KG" })).body.product;
    await stockUp(workflowProduct.id, 1000); // confirmed lines must be fully reservable (WF-01)
  }
  const customer = workflowCustomer;
  const product = workflowProduct;
  const created = (await call("sara", "POST", "/api/orders", {
    customer_account_id: customer.id, customer_name: customer.name,
    delivery_date: "2026-12-02",
    items: [{ stock_product_id: product.id, product_name: product.name, quantity: qty, unit: "KG" }],
  })).body.order;
  const moved = await call("ahmed", "POST", `/api/orders/${created.id}/status`, { to: "preparing", expected_version: created.version });
  return moved.body.order;
}

async function prepare(orderId: string, qty: number, who = "ahmed") {
  const o = (await call(who, "GET", `/api/orders/${orderId}`)).body.order;
  const it = o.items[0];
  return call(who, "POST", `/api/orders/${orderId}/items/${it.id}/prepare`, { quantity: qty, expected_version: it.version });
}

async function approvalsFor(who: string, entityId: string, status?: string) {
  const res = await call(who, "GET", `/api/approvals${status ? `?status=${status}` : ""}`);
  return (res.body.approvals ?? []).filter((a: any) => a.entityId === entityId);
}

async function notificationsFor(who: string) {
  return (await call(who, "GET", "/api/notifications?limit=100")).body;
}

async function main() {
  for (const u of ["admin", "sara", "ahmed", "mostafa", "hossam"]) await login(u);

  section("1. A SHORT LINE RAISES ONE APPROVAL REQUEST");
  const o1 = await newOrderInPreparation();
  check("order in preparation", o1?.status === "preparing", o1);
  r = await prepare(o1.id, 80);
  check("20% short -> needs review", r.status === 200 && r.body.flags.needsReview === true, r.body);
  let mine = await approvalsFor("sara", o1.id, "pending");
  check("supervisor sees exactly one pending request", mine.length === 1, mine);
  const req1 = mine[0];
  check("request is typed, numbered, attributed to the preparer", req1?.type === "orders.shortage" && /^APR-\d{4}-\d{5}$/.test(req1?.number) && req1?.requestedBy === "أحمد", req1);
  check("summary names the product and the variance", typeof req1?.summary === "string" && req1.summary.includes("Mango") && req1.summary.includes("20%"), req1?.summary);
  check("supervisor can decide it", req1?.canDecide === true);
  const asRequester = await approvalsFor("ahmed", o1.id, "pending");
  check("the preparer sees their own request but cannot decide it", asRequester.length === 1 && asRequester[0].canDecide === false);
  check("a loader sees nothing", (await approvalsFor("mostafa", o1.id)).length === 0);

  section("2. APPROVERS ARE NOTIFIED — ONCE");
  const saraN = (await notificationsFor("sara")).items.filter((n: any) => n.entityId === req1.id);
  check("supervisor notified", saraN.length === 1 && saraN[0].type === "approval.requested" && saraN[0].severity === "warning" && saraN[0].link === `/orders/${o1.id}`, saraN);
  check("super admin (also an approver) notified", (await notificationsFor("admin")).items.some((n: any) => n.entityId === req1.id));
  check("the requester is not notified of their own request", !(await notificationsFor("ahmed")).items.some((n: any) => n.entityId === req1.id));
  check("stock controller (no orders.approve) not notified", !(await notificationsFor("hossam")).items.some((n: any) => n.entityId === req1.id));
  r = await prepare(o1.id, 79);
  check("another short entry keeps the SAME request", (await approvalsFor("sara", o1.id, "pending")).map((a: any) => a.id).join() === req1.id);
  check("and does not notify again", (await notificationsFor("sara")).items.filter((n: any) => n.entityId === req1.id).length === 1);

  section("3. WHO MAY DECIDE");
  const decide = (who: string | null, id: string, body: any) => call(who, "POST", `/api/approvals/${id}/decide`, body);
  check("unauthenticated -> 401", (await decide(null, req1.id, { decision: "approve" })).status === 401);
  check("the preparer cannot decide -> 403", (await decide("ahmed", req1.id, { decision: "approve" })).status === 403);
  check("a loader cannot decide -> 403", (await decide("mostafa", req1.id, { decision: "approve" })).status === 403);
  check("unknown decision -> 400", (await decide("sara", req1.id, { decision: "maybe" })).status === 400);
  check("reject without a reason -> 400", (await decide("sara", req1.id, { decision: "reject" })).status === 400);
  check("unknown request -> 404", (await decide("sara", "nope", { decision: "approve" })).status === 404);
  check("stale version -> 409", (await decide("sara", req1.id, { decision: "approve", expected_version: req1.version + 7 })).status === 409);

  section("4. CORRECTING THE QUANTITY CANCELS THE REQUEST");
  r = await prepare(o1.id, 98);
  check("2% short is within tolerance", r.status === 200 && r.body.flags.needsReview === false, r.body);
  const cancelled = (await approvalsFor("sara", o1.id)).find((a: any) => a.id === req1.id);
  check("the stale request is cancelled with a reason", cancelled?.status === "cancelled" && !!cancelled?.closedReason, cancelled);
  check("nothing pending any more", (await approvalsFor("sara", o1.id, "pending")).length === 0);

  section("5. REJECT KEEPS THE ORDER BLOCKED");
  await prepare(o1.id, 70);
  const req2 = (await approvalsFor("sara", o1.id, "pending"))[0];
  check("a new variance opens a NEW request", !!req2 && req2.id !== req1.id && req2.number !== req1.number);
  r = await decide("sara", req2.id, { decision: "reject", comment: "اوزن تاني", expected_version: req2.version });
  check("rejected", r.status === 200 && r.body.request.status === "rejected" && r.body.request.decisions.length === 1, r.body);
  const o1b = (await call("sara", "GET", `/api/orders/${o1.id}`)).body.order;
  check("order still needs review after a rejection", o1b.needsReview === true);
  check("the preparer is told it was rejected", (await notificationsFor("ahmed")).items.some((n: any) => n.type === "approval.decided" && n.entityId === req2.id && n.body.includes("اوزن تاني")));
  check("a closed request cannot be decided again -> 409", (await decide("sara", req2.id, { decision: "approve" })).status === 409);
  check("the order cannot advance while blocked", (await call("ahmed", "POST", `/api/orders/${o1.id}/status`, { to: "ready_for_loading", expected_version: o1b.version })).status === 409);

  section("6. APPROVE FROM THE INBOX RELEASES THE ORDER");
  await prepare(o1.id, 71);
  const req3 = (await approvalsFor("sara", o1.id, "pending"))[0];
  check("re-entering a short quantity after a rejection re-raises", !!req3 && ![req1.id, req2.id].includes(req3.id));
  r = await decide("sara", req3.id, { decision: "approve", comment: "العميل وافق على 71", expected_version: req3.version });
  check("approved", r.status === 200 && r.body.request.status === "approved" && r.body.request.approvedLevels === 1, r.body);
  const o1c = (await call("sara", "GET", `/api/orders/${o1.id}`)).body.order;
  check("…and the order is released in the same step", o1c.needsReview === false);
  const timeline = (await call("sara", "GET", `/api/audit?orderId=${o1.id}`)).body.logs.map((l: any) => l.action);
  for (const a of ["approval_requested", "approval_cancelled", "approval_rejected", "approval_approved", "shortage_approved"]) {
    check(`order timeline records ${a}`, timeline.includes(a), timeline);
  }

  section("7. THE ORDER-SCREEN BUTTON DECIDES THE SAME REQUEST");
  const o2 = await newOrderInPreparation();
  await prepare(o2.id, 50);
  const req4 = (await approvalsFor("sara", o2.id, "pending"))[0];
  const o2v = (await call("sara", "GET", `/api/orders/${o2.id}`)).body.order;
  r = await call("sara", "POST", `/api/orders/${o2.id}/approve`, { reason: "نقص في السوق", expected_version: o2v.version });
  check("approve from the order screen", r.status === 200 && r.body.order.needsReview === false, r.body);
  const req4after = (await approvalsFor("sara", o2.id)).find((a: any) => a.id === req4.id);
  check("…closes the pending request as approved", req4after?.status === "approved" && req4after?.decisions[0]?.comment === "نقص في السوق", req4after);

  section("8. CONCURRENT DECISIONS: EXACTLY ONE WINS");
  const o3 = await newOrderInPreparation();
  await prepare(o3.id, 40);
  const req5 = (await approvalsFor("sara", o3.id, "pending"))[0];
  const race = await Promise.all([
    decide("sara", req5.id, { decision: "approve", comment: "أ", expected_version: req5.version }),
    decide("admin", req5.id, { decision: "approve", comment: "ب", expected_version: req5.version }),
  ]);
  check("one 200, one 409", race.filter((x) => x.status === 200).length === 1 && race.filter((x) => x.status === 409).length === 1, race.map((x) => x.status));
  const req5after = (await approvalsFor("sara", o3.id)).find((a: any) => a.id === req5.id);
  check("one decision recorded", req5after?.decisions.length === 1);

  section("9. ORDERS FLAGGED BEFORE THE ENGINE STILL GET A RECORD");
  const legacy = (await call("sara", "GET", "/api/orders")).body.orders.find((o: any) => o.orderNumber === "UN-DEMO-0002");
  check("seeded legacy order needs review with no request", legacy?.needsReview === true && (await approvalsFor("sara", legacy.id)).length === 0, legacy);
  r = await call("sara", "POST", `/api/orders/${legacy.id}/approve`, { reason: "قديم", expected_version: legacy.version });
  check("approving it works as before", r.status === 200 && r.body.order.needsReview === false, r.body);
  const legacyReq = await approvalsFor("sara", legacy.id);
  check("…and leaves an approved request raised by the system", legacyReq.length === 1 && legacyReq[0].status === "approved" && legacyReq[0].requestedBy === "النظام", legacyReq);
  check("no 'please approve' was broadcast for it", !(await notificationsFor("admin")).items.some((n: any) => n.entityId === legacyReq[0].id && n.type === "approval.requested"));

  section("10. SEGREGATION OF DUTIES (SETTING)");
  const seg = "approvals.require_different_approver";
  const segRow = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((s: any) => s.key === seg);
  // CTL-01 (replaces "off by default" + "admin turns it on"): segregation is the default,
  // nobody has to switch it on.
  check("on by default (CTL-01)", segRow?.value === true && segRow?.isDefault === true, segRow);
  const o4 = await newOrderInPreparation();
  await prepare(o4.id, 60, "sara"); // the supervisor records the short quantity herself
  const req6 = (await approvalsFor("sara", o4.id, "pending"))[0];
  check("request attributed to the supervisor", req6?.requestedBy === "سارة", req6);
  check("she cannot approve her own (inbox) -> 403", (await decide("sara", req6.id, { decision: "approve" })).status === 403);
  const o4v = (await call("sara", "GET", `/api/orders/${o4.id}`)).body.order;
  check("…nor from the order screen -> 403", (await call("sara", "POST", `/api/orders/${o4.id}/approve`, { reason: "x", expected_version: o4v.version })).status === 403);
  check("someone else can", (await decide("admin", req6.id, { decision: "approve", comment: "تمام" })).status === 200);
  const segNow = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((s: any) => s.key === seg);
  check("setting still on its default (on), untouched by the scenario", segNow?.value === true && segNow?.isDefault === true && segNow?.version === segRow.version, segNow);

  section("11. NOTIFICATION INBOX");
  check("unauthenticated -> 401", (await call(null, "GET", "/api/notifications")).status === 401);
  const before = await notificationsFor("sara");
  check("unread count is reported", typeof before.unread === "number" && before.unread > 0, before.unread);
  const first = before.items.find((n: any) => !n.readAt);
  r = await call("sara", "POST", "/api/notifications/read", { ids: [first.id] });
  check("mark one read", r.status === 200 && r.body.marked === 1);
  check("unread count went down by one", (await notificationsFor("sara")).unread === before.unread - 1);
  const adminUnread = (await notificationsFor("admin")).items.find((n: any) => !n.readAt);
  r = await call("sara", "POST", "/api/notifications/read", { ids: [adminUnread.id] });
  check("cannot mark someone else's notification (no IDOR)", r.status === 200 && r.body.marked === 0);
  check("…it is still unread for its owner", (await notificationsFor("admin")).items.find((n: any) => n.id === adminUnread.id)?.readAt === null);
  check("bad body -> 400", (await call("sara", "POST", "/api/notifications/read", { ids: "x" })).status === 400);
  r = await call("sara", "POST", "/api/notifications/read", { all: true });
  check("mark all read", r.status === 200 && (await notificationsFor("sara")).unread === 0);
  const badJson = await fetch(BASE + "/api/notifications/read", { method: "POST", headers: { "content-type": "application/json", cookie: cookieFor("sara") }, body: "{" });
  check("malformed JSON -> 400", badJson.status === 400);

  section("12. INBOX PAGE");
  const pageRes = await fetch(BASE + "/approvals", { headers: { cookie: cookieFor("sara") }, redirect: "manual" });
  check("/approvals renders for a supervisor", pageRes.status === 200);
  check("/approvals requires sign-in", [302, 307].includes((await fetch(BASE + "/approvals", { redirect: "manual" })).status));

  finish("WORKFLOW (APPROVALS + NOTIFICATIONS)");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
