/* Customer groups (commercial brands) and legal billing entities end to end:
   the import sequence (groups → legal entities → customers), shared tax numbers
   across hotels of one legal entity, search by group, invoice buyer snapshot,
   and the rejection of invented or duplicated tax data. */
import { call, login, makeChecker, BASE, cookieFor } from "./_harness";
import { stockUp } from "./_stock";

const { check, section, finish } = makeChecker();
const TAG = `ZZGRP${Date.now() % 1_000_000_000}`;
const taxA = String(100_000_000 + (Date.now() % 899_999_999)).slice(0, 9);
const taxB = String(200_000_000 + (Date.now() % 599_999_999)).slice(0, 9);
const taxC = String(300_000_000 + (Date.now() % 499_999_999)).slice(0, 9);
const csv = (value: string) => new TextEncoder().encode(value);

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
  for (const username of ["admin", "mona", "karim", "hossam", "sara"]) await login(username);

  section("1. IMPORT ORDER: GROUPS FIRST");
  const groupsCsv = csv(`code,name,name_ar\n${TAG}-JAZ,JAZ Hotels,فنادق جاز\n${TAG}-FS,Four Seasons,فنادق فورسيزونز\n`);
  const groupsPreview = await upload("admin", "customer_groups", "groups.csv", groupsCsv, "preview");
  check("groups preview: no errors", groupsPreview.status === 200 && groupsPreview.body.errorCount === 0, groupsPreview.body);
  const groupsCommit = await upload("admin", "customer_groups", "groups.csv", groupsCsv, "commit");
  check("groups commit creates two groups", groupsCommit.status === 200 && groupsCommit.body.created === 2, groupsCommit.body);
  const dupGroup = await upload("admin", "customer_groups", "groups.csv", csv(`code,name\n${TAG}-JAZ,JAZ Again\n`), "preview");
  check("re-importing an existing group code -> preview error", dupGroup.status === 200 && dupGroup.body.errorCount === 1 && /مستخدم قبل كده/.test(dupGroup.body.rows[0].errors[0] ?? ""), dupGroup.body);

  section("2. LEGAL ENTITIES: ONE TAX NUMBER PER ENTITY");
  const legalCsv = csv(`code,name,name_ar,tax_registration_no,address,area,city,governate,region_city,street,building_number\n${TAG}-LEG1,JAZ Hospitality Holdings,شركة جاز للضيافة,${taxA},شارع التسعين,التجمع الخامس,القاهرة,القاهرة,التجمع الخامس,90th Street,12\n`);
  const legalPreview = await upload("admin", "customer_legal_entities", "legal.csv", legalCsv, "preview");
  check("legal entity preview: no errors", legalPreview.status === 200 && legalPreview.body.errorCount === 0, legalPreview.body);
  const legalCommit = await upload("admin", "customer_legal_entities", "legal.csv", legalCsv, "commit");
  check("legal entity commit creates it", legalCommit.status === 200 && legalCommit.body.created === 1, legalCommit.body);
  // Same tax number on a SECOND legal entity must be rejected.
  const legalDup = csv(`code,name,tax_registration_no\n${TAG}-LEG2,Another Entity,${taxA}\n`);
  const legalDupPreview = await upload("admin", "customer_legal_entities", "dup.csv", legalDup, "preview");
  check("same tax on a different legal entity -> preview error", legalDupPreview.status === 200 && legalDupPreview.body.errorCount === 1 && /مسجل لكيان قانوني آخر/.test(legalDupPreview.body.rows[0].errors[0] ?? ""), legalDupPreview.body);
  const legalDupCommit = await upload("admin", "customer_legal_entities", "dup.csv", legalDup, "commit");
  check("…and commit is refused", legalDupCommit.status === 400, legalDupCommit.body);
  // A legal entity whose tax is already on a standalone customer card is rejected.
  await call("mona", "POST", "/api/sales/customers", { name: `${TAG} Standalone`, tax_registration_no: taxB });
  const legalTaken = csv(`code,name,tax_registration_no\n${TAG}-LEG3,Taken,${taxB}\n`);
  const takenPreview = await upload("admin", "customer_legal_entities", "taken.csv", legalTaken, "preview");
  check("tax already on a hotel card -> preview error with direction", takenPreview.status === 200 && takenPreview.body.errorCount === 1 && /اربط العميل بالكيان/.test(takenPreview.body.rows[0].errors[0] ?? ""), takenPreview.body);
  const badFormat = csv(`code,name,tax_registration_no\n${TAG}-LEG4,Bad Tax,12345\n`);
  check("non-9-digit tax on a legal entity -> preview error", (await upload("admin", "customer_legal_entities", "bad.csv", badFormat, "preview")).body.errorCount === 1);
  check("invalid receiver_type -> preview error", (await upload("admin", "customer_legal_entities", "bad.csv", csv(`code,name,receiver_type\n${TAG}-LEG4,Bad,X\n`), "preview")).body.errorCount === 1);

  section("3. HOTELS SHARING ONE LEGAL ENTITY (SAME TAX)");
  // Two hotels of the same brand/legal entity — each with its own code and external
  // ref, tax number only on the legal entity. This must NOT be a duplicate.
  const hotelsCsv = csv(`name,name_ar,type,external_ref,group_code,legal_entity_code\n"${TAG} JAZ Zamalek","فندق جاز الزمالك",hotel,${TAG}-SLOT-1,${TAG}-JAZ,${TAG}-LEG1\n"${TAG} JAZ Aqua","فندق جاز أكوا",hotel,${TAG}-SLOT-2,${TAG}-JAZ,${TAG}-LEG1\n`);
  const hotelsPreview = await upload("admin", "customers", "hotels.csv", hotelsCsv, "preview");
  check("two hotels one legal entity previews clean", hotelsPreview.status === 200 && hotelsPreview.body.errorCount === 0, hotelsPreview.body);
  const hotelsCommit = await upload("admin", "customers", "hotels.csv", hotelsCsv, "commit");
  check("both hotels commit (shared tax is not a duplicate)", hotelsCommit.status === 200 && hotelsCommit.body.created === 2 && hotelsCommit.body.failed === 0, hotelsCommit.body);
  const h1 = (await call("mona", "GET", `/api/sales/customers?q=${encodeURIComponent(`${TAG} JAZ Zamalek`)}`)).body.customers[0];
  const h2 = (await call("mona", "GET", `/api/sales/customers?q=${encodeURIComponent(`${TAG} JAZ Aqua`)}`)).body.customers[0];
  check("each hotel got its own CUS code", h1.code !== h2.code && /^CUS-\d{5,}$/.test(h1.code) && /^CUS-\d{5,}$/.test(h2.code), [h1.code, h2.code]);
  check("external_ref kept as the source row id", h1.externalRef === `${TAG}-SLOT-1` && h2.externalRef === `${TAG}-SLOT-2`);
  check("hotels carry no own tax number (entity owns it)", h1.taxRegistrationNo === null && h2.taxRegistrationNo === null);
  check("customer card exposes its legal entity", h1.legalEntity?.code === `${TAG}-LEG1` && h1.legalEntity?.taxRegistrationNo === taxA, h1.legalEntity);

  section("4. SEARCH BY GROUP (NAME AND CODE)");
  const byCode = (await call("mona", "GET", `/api/sales/customers?q=${encodeURIComponent(`${TAG}-JAZ`)}`)).body.customers;
  check("searching the group code returns both hotels", byCode.length === 2 && byCode.every((c: any) => c.groups.some((g: any) => g.code === `${TAG}-JAZ`)), byCode.map((c: any) => c.code));
  const byBrand = (await call("mona", "GET", `/api/sales/customers?q=${encodeURIComponent(`${TAG}-FS`)}`)).body.customers;
  check("a brand with no hotels returns none", byBrand.length === 0);
  const byName = (await call("mona", "GET", `/api/sales/customers?q=${encodeURIComponent("فنادق جاز")}`)).body.customers;
  check("searching the group Arabic name returns both", byName.length === 2, byName.map((c: any) => c.code));

  section("5. HOTEL DISPLAY NAME STAYS SEPARATE FROM LEGAL NAME");
  const detail = (await call("mona", "GET", `/api/sales/customers/${h1.id}`)).body.customer;
  check("hotel name is its own", detail.name === `${TAG} JAZ Zamalek` && detail.nameAr === "فندق جاز الزمالك");
  check("legal entity is separate info", detail.legalEntity?.name === "JAZ Hospitality Holdings" && detail.legalEntity?.nameAr === "شركة جاز للضيافة");

  section("6. IMPORT REJECTIONS");
  // Hotel row may not carry its own tax number AND a legal entity link.
  const both = csv(`name,external_ref,tax_registration_no,legal_entity_code\n"${TAG} Both",${TAG}-BOTH,${taxA},${TAG}-LEG1\n`);
  const bothP = await upload("admin", "customers", "both.csv", both, "preview");
  check("tax + legal entity on same row is now valid (card authoritative)", bothP.status === 200 && bothP.body.errorCount === 0, bothP.body);
  // Duplicate customer name in file.
  const dupNames = csv(`name,external_ref\n"${TAG} JAZ Zamalek",${TAG}-DUP\n`);
  check("normalized duplicate hotel name -> preview error", (await upload("admin", "customers", "dup.csv", dupNames, "preview")).body.errorCount === 1);
  // Unresolved group / legal entity references.
  const ghostRef = csv(`name,external_ref,group_code,legal_entity_code\n"${TAG} Ghost",${TAG}-GHOST,${TAG}-NOPE,${TAG}-NOPE2\n`);
  const ghostP = await upload("admin", "customers", "ghost.csv", ghostRef, "preview");
  check("unknown group and legal entity codes -> two clear errors", ghostP.body.errorCount === 1 && ghostP.body.rows[0].errors.length === 2 && ghostP.body.rows[0].errors.every((e: string) => /غير موجود/.test(e)), ghostP.body);
  // Customer tax number colliding with an existing legal entity number.
  // Customer tax number matching a legal entity's tax is now allowed (card owns
  // its own tax; the legal entity link is legacy). The tax format must still be
  // valid 9 digits.
  const taxCollide = csv(`name,external_ref,tax_registration_no\n"${TAG} Collide",${TAG}-CLD,${taxA}\n`);
  check("hotel with a tax matching a legal entity is now permitted", (await upload("admin", "customers", "collide.csv", taxCollide, "preview")).body.errorCount === 0);
  // Duplicate tax on two standalone (no legal entity) rows — now ALLOWED (repeated).
  const dupTaxRows = csv(`name,external_ref,tax_registration_no\n"${TAG} DupA",${TAG}-DA,${taxC}\n"${TAG} DupB",${TAG}-DB,${taxC}\n`);
  check("same tax repeated across standalone rows is now valid (no errors)", (await upload("admin", "customers", "duptax.csv", dupTaxRows, "preview")).body.errorCount === 0);
  // Non-9-digit tax number on a hotel row.
  const badHotel = csv(`name,external_ref,tax_registration_no\n"${TAG} BadTax",${TAG}-BT,12AB\n`);
  check("invalid hotel tax format -> preview error", (await upload("admin", "customers", "badtax.csv", badHotel, "preview")).body.errorCount === 1);

  section("7. GROUPS AND LEGAL ENTITIES VIA THE API (MANUAL ENTRY)");
  const g = (await call("mona", "POST", "/api/sales/customer-groups", { code: `${TAG}-MT`, name: "Ministry", name_ar: "مجموعة الوزارة" })).body.group;
  check("API creates a group", g?.code === `${TAG}-MT`, g);
  check("duplicate group code via API -> 409", (await call("mona", "POST", "/api/sales/customer-groups", { code: `${TAG}-MT`, name: "x" })).status === 409);
  check("lowercase code becomes uppercase", (await call("mona", "POST", "/api/sales/customer-groups", { code: `${TAG.toLowerCase()}-up`, name: "x" })).body.group?.code === `${TAG}-UP`);
  const le = (await call("mona", "POST", "/api/sales/legal-entities", { code: `${TAG}-L2`, name: "API Legal", tax_registration_no: taxB.replace(/.$/, "1") })).body.legalEntity;
  check("API creates a legal entity", le?.code === `${TAG}-L2` && le?.taxRegistrationNo?.length === 9, le);
  check("no one can see groups without customers.view", (await call("hossam", "GET", "/api/sales/customer-groups")).status === 403);
  check("stock controller cannot create groups", (await call("hossam", "POST", "/api/sales/customer-groups", { code: "X", name: "x" })).status === 403);

  section("8. LINK, UNLINK, AND EDIT VIA THE CUSTOMER API");
  const mg = (await call("mona", "GET", "/api/sales/customer-groups")).body.groups.find((x: any) => x.code === `${TAG}-MT`);
  const le2 = (await call("mona", "GET", "/api/sales/legal-entities")).body.legalEntities.find((x: any) => x.code === `${TAG}-L2`);
  const cur = (await call("mona", "GET", `/api/sales/customers/${h1.id}`)).body.customer;
  r = await call("mona", "PATCH", `/api/sales/customers/${h1.id}`, { group_ids: [...cur.groups.map((x: any) => x.id), mg.id], legal_entity_id: le2.id, expected_version: cur.version });
  check("adding an extra group and switching legal entity via PATCH succeeds", r.status === 200, r.body);
  const after = (await call("mona", "GET", `/api/sales/customers/${h1.id}`)).body.customer;
  check("both groups present after edit", after.groups.length === 2 && after.legalEntity?.id === le2.id, after.groups.map((x: any) => x.code));
  r = await call("mona", "PATCH", `/api/sales/customers/${h1.id}`, { group_ids: [], legal_entity_id: null, expected_version: after.version });
  check("clearing groups and legal entity", r.status === 200);
  const cleared = (await call("mona", "GET", `/api/sales/customers/${h1.id}`)).body.customer;
  check("groups emptied, legal entity detached", cleared.groups.length === 0 && cleared.legalEntity === null);

  section("9. INVOICE BUYER SNAPSHOT USES THE CARD'S LEGAL NAME AND TAX");
  // Re-link h2 and set its own legal name + tax (repeated OK). The invoice freezes
  // the CARD's values, not any linked entity.
  const h2cur = (await call("mona", "GET", `/api/sales/customers/${h2.id}`)).body.customer;
  const cardTax = String(400_000_000 + (Date.now() % 199_999_999)).slice(0, 9);
  await call("mona", "PATCH", `/api/sales/customers/${h2.id}`, {
    legal_name: "API Legal",
    legal_name_ar: null,
    tax_registration_no: cardTax,
    legal_entity_id: le2.id,
    expected_version: h2cur.version,
  });
  const product = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Mango`, unit: "KG" })).body.product;
  await stockUp(product.id, 5); // WF-01: the order below must be fully reservable
  // Price the product first — an order must be priced before it can be invoiced.
  const pl = (await call("mona", "POST", "/api/sales/price-lists", { code: `${TAG}-PL`, name: "الأسعار العامة", is_default: true })).body.priceList;
  await call("mona", "POST", `/api/sales/price-lists/${pl.id}/prices`, { valid_from: "2026-12-01", prices: [{ product_id: product.id, unit_price: "20" }] });
  const form = new FormData();
  const orderBody = { customer_name: `${TAG} JAZ Aqua`, customer_account_id: h2.id, delivery_date: "2026-12-10", items: [{ product_name: `${TAG} Mango`, quantity: 5, product_id: product.id }] };
  const o = await call(null, "POST", "/api/orders", { ...orderBody, external_id: `${TAG}-ORD-1` }, { "x-api-key": process.env.N8N_API_KEY! });
  check("order created for the hotel", o.status === 201 && o.body.order.customerAccountId === h2.id, o.body.order);
  const oid = o.body.order.id;
  await call("sara", "POST", `/api/orders/${oid}/status`, { to: "loading", reason: "مباشر" });
  await call("sara", "POST", `/api/orders/${oid}/items/${o.body.order.items[0].id}/load`, { quantity: 5, mark_done: true });
  r = await call("sara", "POST", `/api/orders/${oid}/status`, { to: "dispatched", reason: "خرج", vehicle: "ن ق ل 1", driver_name: "سواق", crate_count: 1 });
  check("order dispatched", r.status === 200, r.body);
  const draft = await call("karim", "POST", "/api/sales/invoices", { order_id: oid });
  check("draft invoice created", draft.status === 201 && draft.body.invoice.status === "draft", draft.body);
  const issued = await call("karim", "POST", `/api/sales/invoices/${draft.body.invoice.id}/issue`, {});
  check("issued invoice buyer is the CARD's legal name, not the hotel name", issued.body.invoice?.buyerName === "API Legal" && issued.body.invoice?.buyerTaxId === cardTax, issued.body.invoice);
  check("…and the hotel display name is not the buyer name", issued.body.invoice?.buyerName !== h2.name, issued.body.invoice);

  section("10. ETA PAYLOAD CARRIES THE LEGAL ENTITY RECEIVER");
  // The ETA state endpoint validates the mapped document; the receiver identity
  // reflects the legal entity (tax id resolves, and only the entity's address
  // fields are missing because the API test entity has none — nothing invented).
  const gp = await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Grapes`, unit: "KG" });
  const grapes = gp.body.product;
  await stockUp(grapes.id, 2); // WF-01: the order below must be fully reservable
  await call("mona", "POST", `/api/sales/price-lists/${pl.id}/prices`, { valid_from: "2026-12-01", prices: [{ product_id: grapes.id, unit_price: "30" }] });
  const order2 = await call(null, "POST", "/api/orders", { customer_name: `${TAG} JAZ Aqua`, customer_account_id: h2.id, delivery_date: "2026-12-11", items: [{ product_name: `${TAG} Grapes`, quantity: 2, product_id: grapes.id }] }, { "x-api-key": process.env.N8N_API_KEY! });
  const oid2 = order2.body.order.id;
  await call("sara", "POST", `/api/orders/${oid2}/status`, { to: "loading", reason: "مباشر" });
  await call("sara", "POST", `/api/orders/${oid2}/items/${order2.body.order.items[0].id}/load`, { quantity: 2, mark_done: true });
  await call("sara", "POST", `/api/orders/${oid2}/status`, { to: "dispatched", reason: "خرج", vehicle: "ن ق ل 1", driver_name: "سواق", crate_count: 1 });
  const draft2 = await call("karim", "POST", "/api/sales/invoices", { order_id: oid2 });
  const issued2 = await call("karim", "POST", `/api/sales/invoices/${draft2.body.invoice.id}/issue`, {});
  const state = await call("karim", "GET", `/api/eta/invoices/${issued2.body.invoice.id}`);
  check("ETA state endpoint reachable", state.status === 200, state.body);
  const issues: { field: string; message: string }[] = state.body?.issues ?? [];
  const receiverIssues = issues.filter((i) => i.field.startsWith("receiver."));
  check("no receiver.id issue: the legal entity's tax resolves the B receiver", !receiverIssues.some((i) => i.field === "receiver.id"), receiverIssues);
  check("receiver.address issues: only the legal entity's missing address fields", receiverIssues.every((i) => i.field.startsWith("receiver.address.")), receiverIssues);
  check("the hotel name is not the receiver (legal name is)", !issues.some((i) => i.message.includes(`${TAG} JAZ Aqua`)), issues.slice(0, 8));

  section("11. AUDIT RECORDS THE LINKS");
  const hist = (await call("mona", "GET", `/api/sales/customers/${h2.id}/history`)).body.logs ?? [];
  check("history records the legal entity link", hist.some((l: any) => l.fieldChanged === "legalEntityId"), hist.slice(0, 8).map((l: any) => `${l.action}:${l.fieldChanged}`));

  finish("CUSTOMER GROUPS / LEGAL ENTITIES");
}

let r: any;
main().catch((err) => { console.error("SUITE CRASHED", err); process.exit(2); });