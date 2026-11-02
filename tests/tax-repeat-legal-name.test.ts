/* Focused: repeated tax IDs, distinct legal names, group search, format handling.
   No real customer data is imported; only ephemeral TEST-prefixed data. */
import { call, login, makeChecker, BASE, cookieFor } from "./_harness";
import { stockUp } from "./_stock";

const { check, section, finish } = makeChecker();
const TAG = `ZZTAX${Date.now() % 1_000_000_000}`;
const csv = (value: string) => new TextEncoder().encode(value);

const csvTax = String(500_000_000 + (Date.now() % 299_999_999)).slice(0, 9);
const csvGroup = `${TAG}-JAZ`;

async function upload(who: string, kind: string, filename: string, bytes: Uint8Array, action: "preview" | "commit") {
  const form = new FormData();
  form.set("action", action); form.set("kind", kind);
  form.set("file", new Blob([bytes as BlobPart]), filename);
  const response = await fetch(`${BASE}/api/admin/data-import`, { method: "POST", headers: { cookie: cookieFor(who) ?? "" }, body: form });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; }
  catch { return { status: response.status, body: text }; }
}

async function main() {
  for (const u of ["admin", "mona", "karim", "hossam", "sara"]) await login(u);

  section("1. 5 HOTELS SHARE ONE TAX ID — ALL CREATED, DISTINCT LEGAL NAMES");
  // Create the group
  const groupResp = await call("mona", "POST", "/api/sales/customer-groups", { code: csvGroup, name: "JAZ Hotels" });
    const groupId = groupResp.body.group.id;
    // Create 5 customers with the same tax and distinct legal names
    const taxRepeated = csvTax;
    const names = ["JAZ Aqua", "JAZ Marine", "JAZ Star", "JAZ Elite", "JAZ Palms"];
    const legalNames = ["JAZ Aqua Resort Co", "JAZ Marine Operations", "JAZ Star Hospitality", "JAZ Elite Management", "JAZ Palms Investments"];
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await call("mona", "POST", "/api/sales/customers", {
        name: `${TAG} ${names[i]}`,
        legal_name: legalNames[i],
        tax_registration_no: taxRepeated,
        external_ref: `${TAG}-${i}`,
        group_ids: [groupId],
    });
    check(`create ${names[i]} with same tax succeeds`, r.status === 201 && !!r.body.customer?.code, r.body);
    ids.push(r.body.customer.id);
  }
  // Every card got a unique CUS code
  check("five distinct CUS codes", new Set(ids).size === 5, ids);
  // Search by group returns all five
  const byGroup = (await call("mona", "GET", `/api/sales/customers?q=${encodeURIComponent(csvGroup)}`)).body.customers;
  check("search by group code returns all 5", byGroup.length === 5, byGroup.map((c: any) => c.code));
  // Each card has its own legal name
  for (let i = 0; i < 5; i++) {
    const c = (await call("mona", "GET", `/api/sales/customers/${ids[i]}`)).body.customer;
    check(`card ${i} legal name persists: ${legalNames[i]}`, c.legalName === legalNames[i], c.legalName);
    check(`card ${i} tax equals the shared number`, c.taxRegistrationNo === taxRepeated);
  }
  // The same tax appears 5 times — no uniqueness enforced
  const taxCheck = (await call("mona", "GET", `/api/sales/customers?q=${encodeURIComponent(taxRepeated)}`)).body.customers;
  check("tax search returns all 5", taxCheck.length === 5, taxCheck.map((c: any) => c.taxRegistrationNo));

  section("2. NON-STANDARD TAX FORMATS — FLAGGED, NEVER INVENTED");
  const bad1 = csv(`name,external_ref,tax_registration_no\n"${TAG} Bad1",${TAG}-B1,قسم قصر النيل\n`);
  const p1 = await upload("admin", "customers", "bad1.csv", bad1, "preview");
  check("Arabic text in tax field is rejected (not a 9‑digit number)", p1.body.errorCount === 1 && /رقم التسجيل الضريبي/.test(p1.body.rows[0].errors[0] ?? ""), p1.body);
  const bad2 = csv(`name,external_ref,tax_registration_no\n"${TAG} Bad2",${TAG}-B2,555-5-00074-199\n`);
  const p2 = await upload("admin", "customers", "bad2.csv", bad2, "preview");
  check("12‑digit number after strip dashes is rejected, not truncated", p2.body.errorCount === 1 && /رقم التسجيل الضريبي/.test(p2.body.rows[0].errors[0] ?? ""), p2.body);
  // A blank tax field is always valid
  const clean = csv(`name,external_ref\n"${TAG} Clean",${TAG}-B3\n`);
  check("blank tax is valid (no known tax data)", (await upload("admin", "customers", "clean.csv", clean, "preview")).body.errorCount === 0);

  section("3. NAME RECONCILIATION BY EXTERNAL_REF");
  // Create one customer first
  const c1 = await call("mona", "POST", "/api/sales/customers", { name: `${TAG} Recon Hotel`, external_ref: `${TAG}-RECON-1` });
  check("created for reconciliation test", c1.status === 201, c1.body);
  // Re-import the same row (same name, same external_ref) — should NOT error
  const reconGood = csv(`name,external_ref\n"${TAG} Recon Hotel",${TAG}-RECON-1\n`);
  const r1 = await upload("admin", "customers", "recon.csv", reconGood, "preview");
  check("same name + same external_ref → info note, not blocked", r1.body.errorCount === 0, r1.body);
  const r1c = await upload("admin", "customers", "recon.csv", reconGood, "commit");
  check("commit skips the duplicate row (no new card created)", r1c.body.created === 0 && r1c.body.results[0].status.includes("موجود"), r1c.body);
  // Re-import with same name but DIFFERENT external_ref → error with existing code
  const reconBad = csv(`name,external_ref\n"${TAG} Recon Hotel",${TAG}-OTHER-REF\n`);
  const r2 = await upload("admin", "customers", "recon.csv", reconBad, "preview");
  check("same name + different external_ref → error reports existing code", r2.body.errorCount === 1 && /موجود في دليل العملاء/.test(r2.body.rows[0].errors[0] ?? ""), r2.body);

  section("4. INVOICE SNAPSHOT USES CARD LEGAL NAME AND TAX");
  const card = (await call("mona", "GET", `/api/sales/customers/${ids[0]}`)).body.customer;
  await call("mona", "PATCH", `/api/sales/customers/${card.id}`, {
    legal_name: "JAZ Aqua Co",
    tax_registration_no: taxRepeated,
    payment_terms_days: 15,
    expected_version: card.version,
  });
  // order → dispatch → draft → issue
  const prod = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Mango`, unit: "KG" })).body.product;
  await stockUp(prod.id, 2); // WF-01: the integration order below must be fully reservable
  const pl = (await call("mona", "POST", "/api/sales/price-lists", { code: `${TAG}-PL`, name: "P", is_default: true })).body.priceList;
  await call("mona", "POST", `/api/sales/price-lists/${pl.id}/prices`, { valid_from: "2026-12-01", prices: [{ product_id: prod.id, unit_price: "20" }] });
  const o = await call(null, "POST", "/api/orders", { customer_name: `${TAG} JAZ Aqua`, customer_account_id: card.id, delivery_date: "2026-12-10", items: [{ product_name: `${TAG} Mango`, quantity: 2, product_id: prod.id }] }, { "x-api-key": process.env.N8N_API_KEY! });
  const oid = o.body.order.id;
  await call("sara", "POST", `/api/orders/${oid}/status`, { to: "loading", reason: "مباشر" });
  await call("sara", "POST", `/api/orders/${oid}/items/${o.body.order.items[0].id}/load`, { quantity: 2, mark_done: true });
  await call("sara", "POST", `/api/orders/${oid}/status`, { to: "dispatched", reason: "خرج", vehicle: "ن ق ل 1", driver_name: "سواق", crate_count: 1 });
  const draft = await call("karim", "POST", "/api/sales/invoices", { order_id: oid });
  const issued = await call("karim", "POST", `/api/sales/invoices/${draft.body.invoice.id}/issue`, {});
  check("invoice buyerName = card legal_name (not hotel name)", issued.body.invoice?.buyerName === "JAZ Aqua Co", issued.body.invoice);
  check("invoice buyerTaxId = card tax (repeated across cards)", issued.body.invoice?.buyerTaxId === taxRepeated, issued.body.invoice);
  check("invoice buyerAddress = card address", issued.body.invoice?.buyerAddress === null, issued.body.invoice); // no address set on card
  // ETA: receiver.id issue must NOT fire (legal name + tax from card are frozen)
  const eta = await call("karim", "GET", `/api/eta/invoices/${issued.body.invoice.id}`);
  check("ETA state reachable", eta.status === 200, eta.body);
  const etaIssues: { field: string }[] = eta.body?.issues ?? [];
  check("no receiver.id issue (card tax resolves B receiver)", !etaIssues.some((i) => i.field === "receiver.id"), etaIssues.slice(0, 6));

  finish("REPEATED TAX / LEGAL NAME / FORMATS");
}
main().catch((err) => { console.error("SUITE CRASHED", err); process.exit(2); });