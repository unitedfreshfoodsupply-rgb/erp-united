/* P0 guard: a recovered invoice draft must not be issued on stale prices.
   An order's prices are frozen into invoice lines at draft time. The ONLY path
   that can silently diverge is: draft → void → price change (allowed while no
   draft exists) → recover → issue. issueInvoice now compares each draft line's
   frozen unitPrice/discount/tax against the order item's CURRENT OrderItemPrice
   and refuses to issue on a mismatch; the accountant must explicitly reprice
   the draft (audited) before issuing. Issued invoices are never touched. */
import { call, login, makeChecker } from "./_harness";
import { taxNo, stockUp } from "./_stock";

async function main() {
  const { check, section, finish } = makeChecker();
  const TAG = `rp${Date.now() % 100000}`;
  let n = 0;

  for (const u of ["admin", "karim", "ahmed", "sara", "mostafa"]) await login(u);

  async function setupOrder() {
    n += 1;
    // MIG-01: invoices issued below need the buyer's 9-digit tax number (on the card).
    const cust = (await call("admin", "POST", "/api/sales/customers", { name: `${TAG} عميل ${n}`, tax_registration_no: taxNo() })).body.customer;
    const prod = (await call("admin", "POST", "/api/stock/products", { name: `${TAG} برتقال ${n}`, unit: "KG" })).body.product;
    await stockUp(prod.id, 10, { unitCost: "5" }); // WF-01: the 10 kg line must be fully reservable (cost below the price of 10)
    const priceList = (await call("admin", "POST", "/api/sales/price-lists", { code: `${TAG}PL`, name: `${TAG} لستة` })).body.priceList ?? (await call("admin", "POST", "/api/sales/price-lists", { code: `${TAG}PL`, name: `${TAG} لستة` })).body;
    const created = await call("sara", "POST", "/api/orders", {
      customer_account_id: cust.id, customer_name: cust.name, delivery_date: "2026-12-20",
      items: [{ stock_product_id: prod.id, product_name: prod.name, quantity: 10, unit: "KG" }],
    });
    return { cust, prod, priceList, order: created.body.order };
  }

  const finalize = async (order: any) => {
    // Price the order line, prepare/load full and dispatch.
    await call("admin", "PATCH", `/api/orders/${order.id}/items/${order.items[0].id}/price`, { unit_price: 10, reason: `${TAG} تسعير` });
    let o = (await call("sara", "GET", `/api/orders/${order.id}`)).body.order;
    const move = async (to: string, who = "sara") => {
      const fresh = (await call("sara", "GET", `/api/orders/${order.id}`)).body.order;
      const r = await call(who, "POST", `/api/orders/${order.id}/status`, { to, expected_version: fresh.version });
      return r.body.order ?? fresh;
    };
    o = await move("preparing");
    for (const i of (await call("sara", "GET", `/api/orders/${order.id}`)).body.order.items) {
      await call("ahmed", "POST", `/api/orders/${order.id}/items/${i.id}/prepare`, { quantity: i.requiredQuantity, mark_done: true });
    }
    o = await move("ready_for_loading");
    o = await move("loading", "mostafa");
    for (const i of (await call("sara", "GET", `/api/orders/${order.id}`)).body.order.items) {
      await call("mostafa", "POST", `/api/orders/${order.id}/items/${i.id}/load`, { quantity: i.requiredQuantity, mark_done: true });
    }
    o = await move("loaded", "mostafa");
    // Dispatch requires the physical run facts (vehicle/driver/crates).
    const freshD = (await call("sara", "GET", `/api/orders/${order.id}`)).body.order;
    const d = await call("mostafa", "POST", `/api/orders/${order.id}/status`, { to: "dispatched", expected_version: freshD.version, vehicle: "TEST-123", driver_name: "محمود", crate_count: 2 });
    return d.body?.order ?? freshD;
  }

  section("0. CONTROL: NORMAL DRAFT → ISSUE (prices unchanged) PASSES");
  const c = await setupOrder();
  const cOrder = await finalize(c.order);
  const cInv = (await call("karim", "POST", "/api/sales/invoices", { order_id: cOrder.id })).body.invoice;
  check("draft created", !!cInv?.id && cInv.status === "draft", cInv?.status);
  const cIssue = await call("karim", "POST", `/api/sales/invoices/${cInv.id}/issue`, {});
  check("issue passes when prices are current", cIssue.status === 200 && cIssue.body.invoice?.status === "issued", cIssue.status);

  section("1. THE STALE-PRICE PATH: DRAFT → VOID → REPRICE → RECOVER → ISSUE");
  const o = await setupOrder();
  const order = await finalize(o.order);
  const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: order.id })).body.invoice;
  check("draft created for the scenario", !!inv?.id && inv.status === "draft", inv?.status);
  // Capture the frozen draft price
  const origTotal = Number(inv.total);
  check("draft total is non-zero", origTotal > 0, origTotal);

  const voided = await call("karim", "POST", `/api/sales/invoices/${inv.id}/void`, { reason: `${TAG} استعادة لمراجعة السعر` });
  check("draft voided", voided.status === 200, voided.status);

  // Price the order line UP (allowed: no draft exists now).
  const item = (await call("sara", "GET", `/api/orders/${order.id}`)).body.order.items[0];
  const repriced = await call("admin", "PATCH", `/api/orders/${order.id}/items/${item.id}/price`, { unit_price: 25, reason: `${TAG} رفع السعر بعد إلغاء المسودة` });
  check("order line repriced after void (no draft in the way)", repriced.status === 200, repriced.status);

  // Recover the draft — it still carries the OLD frozen prices.
  const rec = await call("karim", "POST", `/api/sales/invoices/${inv.id}/recover`, { reason: `${TAG} استرجاع المسودة`, expected_version: voided.body?.invoice?.version ?? undefined });
  check("draft recovered", rec.status === 200 && rec.body?.invoice?.status === "draft", rec.status);

  // THE GUARD: issuing on stale prices must be blocked.
  const staleIssue = await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {});
  check("issue BLOCKED on stale prices (409 with pricing error)", staleIssue.status === 409 && /الأسعار/.test(staleIssue.body?.error ?? ""), staleIssue);

  section("2. EPUBLIC REPRICING OF THE DRAFT (explicit, audited)");
  const rp = await call("karim", "POST", `/api/sales/invoices/${inv.id}/reprice`, {});
  check("draft reprice succeeds", rp.status === 201 && rp.body?.invoice?.status === "draft", rp.status);
  check("invoice total reflects the new price (25 × 10)", rp.body?.invoice?.total === "250", rp.body?.invoice?.total);

  section("3. ISSUE AFTER REPRICE SUCCEEDS");
  const issue = await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {});
  check("issue succeeds after explicit reprice", issue.status === 200 && issue.body?.invoice?.status === "issued", issue.status);
  const lines = issue.body?.invoice?.lines ?? (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice?.lines ?? [];
  check("issued line carries the NEW unit price", lines[0]?.unitPrice === "25", lines[0]?.unitPrice);

  section("4. ISSUED INVOICES ARE NEVER TOUCHED");
  const t1 = (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice;
  const rp2 = await call("karim", "POST", `/api/sales/invoices/${inv.id}/reprice`, {});
  check("reprice on an issued invoice refused (409)", rp2.status === 409, rp2.status);
  check("invoice total unchanged after refused reprice", (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice?.total === t1.total, t1.total);
  check("duplicate issue refused", (await call("karim", "POST", `/api/sales/invoices/${inv.id}/issue`, {})).status === 409);

  section("5. AUTHORIZATION + VERSION GUARDS ON REPRICE");
  const o2 = await setupOrder();
  const order2 = await finalize(o2.order);
  const inv2 = (await call("karim", "POST", "/api/sales/invoices", { order_id: order2.id })).body.invoice;
  await call("karim", "POST", `/api/sales/invoices/${inv2.id}/void`, { reason: `${TAG} v` });
  const item2 = (await call("sara", "GET", `/api/orders/${order2.id}`)).body.order.items[0];
  await call("admin", "PATCH", `/api/orders/${order2.id}/items/${item2.id}/price`, { unit_price: 33, reason: `${TAG} v` });
  await call("karim", "POST", `/api/sales/invoices/${inv2.id}/recover`, { reason: `${TAG} v` });
  check("preparer cannot reprice a draft (403)", (await call("ahmed", "POST", `/api/sales/invoices/${inv2.id}/reprice`, {})).status === 403);
  const stale2 = await call("karim", "POST", `/api/sales/invoices/${inv2.id}/reprice`, { expected_version: 999 });
  check("stale version on reprice refused (409)", stale2.status === 409, stale2.status);

  section("6. UNRELATED DRAFT (never voided) STILL ISSUES FREE");
  const stInv = (await call("karim", "GET", `/api/sales/invoices/${cInv.id}`)).body.invoice;
  check("earlier invoice still issued (control)", stInv?.status === "issued" && Number(stInv?.total) > 0, stInv?.status);

  finish("REPRICE-STALE-GUARD");
}

main().catch((e) => {
  console.error("CRASH:", e);
  process.exit(1);
});