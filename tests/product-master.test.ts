/* Product Master: normalization, exact matching, aliases, ambiguity, mapping,
   RBAC, concurrency, and proof that history is untouched. */
import { call, login, makeChecker } from "./_harness";
import { stockUp } from "./_stock";

const TAG = `zzpm${Date.now().toString().slice(-8)}`;

const { check, section, finish } = makeChecker();
const createdProducts: string[] = [];
let r0: any;

async function main() {
  for (const u of ["admin", "sara", "hossam", "ahmed", "mostafa"]) await login(u);

  section("1. BASELINE — history before any mapping");
  const before = await call("sara", "GET", "/api/orders");
  const beforeItems = before.body.orders.flatMap((o: any) => o.items);
  const beforeSnapshot = JSON.stringify(
    beforeItems.map((i: any) => [i.id, i.productName, i.unit, i.requiredQuantity, i.preparedQuantity, i.loadedQuantity, i.version]).sort()
  );
  const beforeLedger = await call("hossam", "GET", "/api/stock/ledger?limit=500");
  const beforeLedgerSnapshot = JSON.stringify(beforeLedger.body.movements.map((m: any) => [m.id, m.quantityKg]).sort());
  check("baseline captured", beforeItems.length > 0, beforeItems.length);

  section("2. COVERAGE BASELINE — existing linked and unlinked items");
  const cov0 = await call("hossam", "GET", "/api/stock/products/coverage");
  check("coverage endpoint works", cov0.status === 200, cov0.body);
  const baselineMapped = cov0.body.summary.mapped;
  const baselineUnmapped = cov0.body.summary.unmapped;
  check("coverage accounts for every existing order name", baselineMapped + baselineUnmapped === cov0.body.summary.distinctNames, cov0.body.summary);
  check("nothing reported ambiguous", cov0.body.summary.ambiguous === 0, cov0.body.summary);
  check("coverage keeps the order's own unit", cov0.body.rows.every((r: any) => typeof r.unit === "string" && r.unit.length > 0));
  const distinctNames = cov0.body.summary.distinctNames;
  console.log(`  (baseline: ${distinctNames} distinct names; ${baselineMapped} already linked, ${baselineUnmapped} awaiting mapping)`);

  section("3. PRODUCT CREATION + UNIT VALIDATION");
  check("blank name rejected", (await call("hossam", "POST", "/api/stock/products", { name: "  " })).status === 400);
  check("stock-tracked product with no unit rejected", (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} NoUnit`, unit: "", stock_tracked: true })).status === 400);
  const untracked = await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Untracked`, unit: "", stock_tracked: false });
  check("untracked product may omit a unit", untracked.status === 201, untracked.body);
  createdProducts.push(untracked.body.product.id);

  const mango = await call("hossam", "POST", "/api/stock/products", {
    name: `${TAG} Mango Naomi`, name_ar: `${TAG} مانجا نعومي`, sku: `${TAG}-MN`, category: "Fruit", unit: "KG",
  });
  check("create product -> 201", mango.status === 201, mango.body);
  const MANGO = mango.body.product;
  createdProducts.push(MANGO.id);
  check("canonical fields stored", MANGO.nameAr?.includes("مانجا نعومي") && MANGO.sku === `${TAG}-MN` && MANGO.category === "Fruit" && MANGO.unit === "KG", MANGO);
  check("defaults active + stock-tracked", MANGO.active === true && MANGO.stockTracked === true);

  const lemon = await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Lemon`, name_ar: `${TAG} ليمون`, unit: "KG" });
  const LEMON = lemon.body.product;
  createdProducts.push(LEMON.id);
  check("second product created", lemon.status === 201);
  check("duplicate canonical name -> 409", (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Mango Naomi`, unit: "KG" })).status === 409);
  check("duplicate SKU -> 409", (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Other`, sku: `${TAG}-MN`, unit: "KG" })).status === 409);

  section("4. EXACT MATCHING VIA CANONICAL NAMES");
  const R = async (name: string) => (await call("hossam", "POST", "/api/stock/products/resolve", { name })).body.result;
  check("exact canonical English matches", (await R(`${TAG} Mango Naomi`)).status === "matched");
  check("matched reports which name it hit", (await R(`${TAG} Mango Naomi`)).matchedOn === "canonical");
  check("exact canonical Arabic matches", (await R(`${TAG} مانجا نعومي`)).status === "matched");
  check("Arabic match reports canonical_ar", (await R(`${TAG} مانجا نعومي`)).matchedOn === "canonical_ar");
  check("case-insensitive", (await R(`${TAG.toUpperCase()} MANGO NAOMI`)).status === "matched");
  check("extra whitespace collapses", (await R(`  ${TAG}   Mango    Naomi  `)).status === "matched");
  check("hyphen/underscore treated as space", (await R(`${TAG}-Mango_Naomi`)).status === "matched");
  check("resolves to the right product", (await R(`${TAG} Mango Naomi`)).product.id === MANGO.id);

  section("5. ARABIC NORMALIZATION");
  const arabicVariants = [
    [`${TAG} مانجا نعومى`, "alef maqsura ى -> ي"],
    [`${TAG} مَانجا نعومي`, "diacritics stripped"],
    [`${TAG} مانجــا نعومي`, "tatweel stripped"],
  ];
  for (const [variant, why] of arabicVariants) {
    const res = await R(variant);
    check(`Arabic variant matches (${why})`, res.status === "matched" && res.product.id === MANGO.id, { variant, res: res.status });
  }
  const digits = await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Crate 2`, name_ar: `${TAG} قفص ٢`, unit: "KG" });
  createdProducts.push(digits.body.product.id);
  check("Arabic-Indic digits fold to ASCII", (await R(`${TAG} قفص 2`)).product?.id === digits.body.product.id, await R(`${TAG} قفص 2`));

  section("6. NO FUZZY MATCHING");
  for (const near of [`${TAG} Mango Naom`, `${TAG} Mango Naomii`, `${TAG} Mango`, `${TAG} Naomi Mango`, `${TAG} Mangoo Naomi`]) {
    const res = await R(near);
    check(`near-miss stays UNMAPPED: "${near.replace(TAG, "…")}"`, res.status === "unmapped", res);
  }
  check("different product is not conflated", (await R(`${TAG} Mango Eweis`)).status === "unmapped");
  check("blank name -> unmapped/blank", (await R("   ")).status === "unmapped" && (await R("   ")).reason === "blank");

  section("7. ALIASES");
  const a1 = await call("hossam", "POST", `/api/stock/products/${MANGO.id}/aliases`, { alias: `${TAG} Naomi` });
  check("add alias -> 201", a1.status === 201, a1.body);
  check("alias resolves to its product", (await R(`${TAG} Naomi`)).product?.id === MANGO.id);
  check("alias match reports kind=manual", (await R(`${TAG} Naomi`)).matchedOn === "manual");
  const a2 = await call("hossam", "POST", `/api/stock/products/${MANGO.id}/aliases`, { alias: `${TAG} نعومي` });
  check("Arabic alias added", a2.status === 201);
  check("Arabic alias resolves", (await R(`${TAG} نعومي`)).product?.id === MANGO.id);
  check("Arabic alias normalization applies to aliases too", (await R(`${TAG} نعومى`)).product?.id === MANGO.id);

  check("same alias twice on same product -> 409", (await call("hossam", "POST", `/api/stock/products/${MANGO.id}/aliases`, { alias: `${TAG} Naomi` })).status === 409);
  const stolen = await call("hossam", "POST", `/api/stock/products/${LEMON.id}/aliases`, { alias: `${TAG} Naomi` });
  check("alias owned by another product -> 409", stolen.status === 409, stolen.body);
  check("...and the error names the owner", typeof stolen.body.error === "string" && stolen.body.error.includes("Mango Naomi"), stolen.body.error);
  check("alias colliding with a canonical name -> 409", (await call("hossam", "POST", `/api/stock/products/${LEMON.id}/aliases`, { alias: `${TAG} Mango Naomi` })).status === 409);
  check("blank alias rejected", (await call("hossam", "POST", `/api/stock/products/${MANGO.id}/aliases`, { alias: "  " })).status === 400);

  const detail = (await call("hossam", "GET", "/api/stock/products?all=1")).body.products.find((p: any) => p.id === MANGO.id);
  check("canonical names appear as system aliases", detail.aliases.filter((x: any) => x.kind !== "manual").length === 2, detail.aliases.map((x: any) => x.kind));
  const canonicalAlias = detail.aliases.find((x: any) => x.kind === "canonical");
  check("canonical alias cannot be deleted directly", (await call("hossam", "DELETE", `/api/stock/products/${MANGO.id}/aliases/${canonicalAlias.id}`)).status === 400);
  const manualAlias = detail.aliases.find((x: any) => x.kind === "manual");
  check("manual alias can be removed", (await call("hossam", "DELETE", `/api/stock/products/${MANGO.id}/aliases/${manualAlias.id}`)).status === 200);
  check("removed alias stops resolving", (await R(manualAlias.alias)).status === "unmapped");

  section("8. RENAME MOVES IDENTITY");
  const renamed = await call("hossam", "PATCH", `/api/stock/products/${LEMON.id}`, { name: `${TAG} Lemon Baladi`, expected_version: LEMON.version });
  check("rename -> 200", renamed.status === 200, renamed.body);
  check("new name resolves", (await R(`${TAG} Lemon Baladi`)).product?.id === LEMON.id);
  check("old name stops resolving", (await R(`${TAG} Lemon`)).status === "unmapped");
  check("Arabic canonical still resolves after English rename", (await R(`${TAG} ليمون`)).product?.id === LEMON.id);
  check("stale version -> 409", (await call("hossam", "PATCH", `/api/stock/products/${LEMON.id}`, { name: "x", expected_version: LEMON.version })).status === 409);

  section("9. INACTIVE PRODUCTS");
  const deact = await call("hossam", "PATCH", `/api/stock/products/${digits.body.product.id}`, { active: false, expected_version: digits.body.product.version });
  check("deactivate -> 200", deact.status === 200);
  const inactiveRes = await R(`${TAG} Crate 2`);
  check("inactive product still RESOLVES (identity survives)", inactiveRes.status === "matched", inactiveRes);
  check("...and is reported inactive so callers can refuse it", inactiveRes.product.active === false);
  check("cannot map an order name onto an inactive product", (await call("hossam", "POST", "/api/stock/products/mapping", { product_name: "Banana", product_id: digits.body.product.id })).status === 400);
  check("cannot record an intake for an inactive product", (await call("hossam", "POST", "/api/stock/intakes", { supplier_id: "x", product_id: digits.body.product.id, received_kg: 1 })).status >= 400);

  section("10. STOCK-TRACKED FLAG");
  const sup = (await call("hossam", "POST", "/api/stock/suppliers", { name: `${TAG} مورد` })).body.supplier;
  const untrackedIntake = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: sup.id, product_id: untracked.body.product.id, received_kg: 5 });
  check("untracked product cannot take an intake", untrackedIntake.status === 400, untrackedIntake.body);

  section("11. MANUAL MAPPING OF EXISTING ORDER LINES");
  // WF-01 setup: every confirmed line holds stock, so the products this section orders
  // or maps live lines onto receive stock first. These receipts are the only stock
  // movements the suite makes on purpose; section 15 sets them aside and still proves
  // mapping/aliasing/resolving created no stock.
  const ledgerBeforeSetup = new Set((await call("hossam", "GET", "/api/stock/ledger?limit=500")).body.movements.map((m: any) => m.id));
  const spare = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} Spare`, unit: "KG" })).body.product;
  createdProducts.push(spare.id);
  await stockUp(MANGO.id, 5);
  await stockUp(spare.id, 4);
  const setupMovementIds = new Set<string>((await call("hossam", "GET", "/api/stock/ledger?limit=500")).body.movements.map((m: any) => m.id).filter((id: string) => !ledgerBeforeSetup.has(id)));
  check("setup receipts recorded exactly two movements", setupMovementIds.size === 2, [...setupMovementIds]);

  const realName = cov0.body.rows.find((r: any) => r.productName === "Mango Naomi");
  check("the real order name 'Mango Naomi' exists and is unmapped", !!realName && realName.status === "unmapped", realName);
  const historyLine = () => call("sara", "GET", "/api/orders").then((x) => x.body.orders.find((o: any) => o.orderNumber === "UN-DEMO-0004")?.items.find((i: any) => i.productName === "Mango Naomi"));
  check("…it is a line of the dispatched seed order", (await historyLine())?.stockProductId === null);
  const mapped = await call("hossam", "POST", "/api/stock/products/mapping", {
    product_name: "Mango Naomi", product_id: MANGO.id, create_alias: true, reason: "اختبار الربط",
  });
  check("manual mapping -> 201", mapped.status === 201, mapped.body);
  // Remediation 2026-11 (replaces "it linked the existing order lines" = every line with
  // the name): history is never rewritten — only lines of live orders are linked, and the
  // only "Mango Naomi" line belongs to a dispatched order.
  check("it linked only live order lines: none (the only one is dispatched history)", mapped.body.linkedLines === 0, { linked: mapped.body.linkedLines, lineCount: realName.lineCount });
  check("…the dispatched order keeps the product it left with", (await historyLine())?.stockProductId === null);

  const cov1 = await call("hossam", "GET", "/api/stock/products/coverage");
  const mangoRow = cov1.body.rows.find((r: any) => r.productName === "Mango Naomi");
  // Replaces "coverage now shows it mapped" / "changed coverage by exactly one": coverage
  // counts order lines, and the history line was (rightly) not rewritten.
  check("coverage still shows the history line unmapped", mangoRow.status === "unmapped" && mangoRow.lineCount === realName.lineCount, mangoRow);
  check("mapping history changed coverage by nothing", cov1.body.summary.mapped === baselineMapped && cov1.body.summary.unmapped === baselineUnmapped, cov1.body.summary);
  check("future orders resolve that name automatically", (await R("Mango Naomi")).product?.id === MANGO.id);

  // WF-01 (replaces "unknown line stays unmapped, order not blocked"): an integration
  // order carrying a product the catalog does not know is refused whole with the line
  // marked unmapped — an unmapped line can never be reserved, prepared or invoiced.
  const mixedExt = `${TAG}-mixed-order`;
  const mixed = await call(null, "POST", "/api/orders", {
    source: "n8n", external_id: mixedExt,
    customer_name: `${TAG} عميل`, delivery_date: "2026-10-05",
    items: [{ stock_product_id: MANGO.id, product_name: "Mango Naomi", quantity: 5 }, { product_name: "Totally Unknown Thing", quantity: 3 }],
  }, { "x-api-key": process.env.N8N_API_KEY! });
  check("order with an unknown product -> 409 stock_unavailable", mixed.status === 409 && mixed.body.code === "stock_unavailable", mixed.body);
  check("…the unknown line is reported unmapped (line 2)", mixed.body.details?.shortfalls?.some((x: any) => x.line === 2 && x.reason === "unmapped"), mixed.body.details);
  check("…and nothing was created for it", !(await call("sara", "GET", "/api/orders")).body.orders.some((o: any) => o.externalId === mixedExt));

  const newOrder = await call(null, "POST", "/api/orders", {
    source: "n8n", external_id: `${TAG}-new-order`,
    customer_name: `${TAG} عميل`, delivery_date: "2026-10-05",
    items: [{ stock_product_id: MANGO.id, product_name: "Mango Naomi", quantity: 5 }],
  }, { "x-api-key": process.env.N8N_API_KEY! });
  check("new order created", newOrder.status === 201, newOrder.body);
  const newItems = newOrder.body.order.items;
  check("known line got the canonical link", newItems.find((i: any) => i.stockProductId === MANGO.id)?.stockProductId === MANGO.id, newItems);

  // Re-mapping a LIVE line moves its stock hold to the new product: refused while the
  // new product has no stock for it, accepted once it does.
  const liveOrder = (await call(null, "POST", "/api/orders", {
    source: "n8n", external_id: `${TAG}-live-order`,
    customer_name: `${TAG} عميل`, delivery_date: "2026-10-05",
    items: [{ stock_product_id: spare.id, product_name: spare.name, quantity: 4 }],
  }, { "x-api-key": process.env.N8N_API_KEY! })).body.order;
  check("a live order holds 4 kg of the spare product", liveOrder?.items?.[0]?.stockProductId === spare.id, liveOrder);
  // The card is renamed afterwards: the live line keeps the old name, which now resolves
  // to nothing — so it can be mapped by hand onto another product.
  const ren = await call("hossam", "PATCH", `/api/stock/products/${spare.id}`, { name: `${TAG} Spare Renamed`, expected_version: spare.version });
  check("spare card renamed; its old name no longer resolves", ren.status === 200 && (await R(spare.name)).status === "unmapped", ren.body);
  const lemonAvailable = async () => Number((await call("sara", "GET", `/api/inventory/products/${LEMON.id}`)).body.available);
  r0 = await call("hossam", "POST", "/api/stock/products/mapping", { product_name: spare.name, product_id: LEMON.id, reason: "اختبار الربط" });
  check("mapping a live line onto a product with no stock -> 409 stock_unavailable", r0.status === 409 && r0.body.code === "stock_unavailable", r0.body);
  check("…the live line keeps its product", (await call("sara", "GET", `/api/orders/${liveOrder.id}`)).body.order.items[0].stockProductId === spare.id);
  await stockUp(LEMON.id, 4);
  for (const m of (await call("hossam", "GET", "/api/stock/ledger?limit=500")).body.movements) if (!ledgerBeforeSetup.has(m.id) && m.productId === LEMON.id) setupMovementIds.add(m.id);
  r0 = await call("hossam", "POST", "/api/stock/products/mapping", { product_name: spare.name, product_id: LEMON.id, reason: "اختبار الربط" });
  check("with the stock received, the live line is re-mapped -> 201, one line", r0.status === 201 && r0.body.linkedLines === 1, r0.body);
  check("…and the order now holds the new product's 4 kg", (await call("sara", "GET", `/api/orders/${liveOrder.id}`)).body.order.items[0].stockProductId === LEMON.id && (await lemonAvailable()) === 0);

  section("12. UNMAPPING");
  const unmapped = await call("hossam", "DELETE", "/api/stock/products/mapping", { product_name: "Mango Naomi", remove_alias: true, reason: "اختبار" });
  check("unmap -> 200", unmapped.status === 200, unmapped.body);
  // Replaces "lines cleared > 0": the only "Mango Naomi" line is dispatched history.
  check("no history line is cleared", unmapped.body.clearedLines === 0, unmapped.body);
  check("alias removed so it stops auto-resolving", (await R("Mango Naomi")).status === "unmapped");
  const cov2 = await call("hossam", "GET", "/api/stock/products/coverage");
  check("coverage back to unmapped for that name", cov2.body.rows.find((r: any) => r.productName === "Mango Naomi").status === "unmapped");
  r0 = await call("hossam", "DELETE", "/api/stock/products/mapping", { product_name: spare.name, reason: "اختبار" });
  check("unmapping a name whose live line holds stock -> 409", r0.status === 409, r0.body);
  check("…the line keeps its product and its hold", (await call("sara", "GET", `/api/orders/${liveOrder.id}`)).body.order.items[0].stockProductId === LEMON.id && (await lemonAvailable()) === 0);
  const lv = (await call("sara", "GET", `/api/orders/${liveOrder.id}`)).body.order;
  check("the live order is cancelled (its hold released)", (await call("sara", "POST", `/api/orders/${liveOrder.id}/cancel`, { reason: "اختبار", expected_version: lv.version })).status === 200 && (await lemonAvailable()) === 4);
  r0 = await call("hossam", "DELETE", "/api/stock/products/mapping", { product_name: spare.name, reason: "اختبار" });
  check("unmapping it now -> 200 and the cancelled line (history) is not cleared", r0.status === 200 && r0.body.clearedLines === 0, r0.body);
  check("…the cancelled order keeps its product", (await call("sara", "GET", `/api/orders/${liveOrder.id}`)).body.order.items[0].stockProductId === LEMON.id);

  section("13. RBAC");
  check("PREPARER cannot read the master", (await call("ahmed", "GET", "/api/stock/products")).status === 403);
  check("PREPARER cannot resolve", (await call("ahmed", "POST", "/api/stock/products/resolve", { name: "x" })).status === 403);
  check("PREPARER cannot read coverage", (await call("ahmed", "GET", "/api/stock/products/coverage")).status === 403);
  check("LOADER cannot create a product", (await call("mostafa", "POST", "/api/stock/products", { name: "x", unit: "KG" })).status === 403);
  check("LOADER cannot map order products", (await call("mostafa", "POST", "/api/stock/products/mapping", { product_name: "Banana", product_id: MANGO.id })).status === 403);
  check("LOADER cannot add an alias", (await call("mostafa", "POST", `/api/stock/products/${MANGO.id}/aliases`, { alias: "x" })).status === 403);
  check("anonymous cannot resolve", (await call(null, "POST", "/api/stock/products/resolve", { name: "x" })).status === 401);
  check("anonymous cannot read coverage", (await call(null, "GET", "/api/stock/products/coverage")).status === 401);
  check("SUPERVISOR retains stock oversight", (await call("sara", "GET", "/api/stock/products/coverage")).status === 200);
  check("SUPER_ADMIN can manage the master", (await call("admin", "GET", "/api/stock/products?all=1")).status === 200);

  section("14. CONCURRENCY");
  const raceName = `${TAG} Race Alias`;
  const races = await Promise.all([1, 2, 3, 4, 5].map(() =>
    call("hossam", "POST", `/api/stock/products/${MANGO.id}/aliases`, { alias: raceName })
  ));
  check("5 simultaneous identical aliases: exactly one created", races.filter((r) => r.status === 201).length === 1, races.map((r) => r.status));
  check("the rest are refused as duplicates", races.filter((r) => r.status === 409).length === 4, races.map((r) => r.status));
  check("only one alias row exists for it", (await R(raceName)).status === "matched");

  const contested = `${TAG} Contested`;
  const twoWay = await Promise.all([
    call("hossam", "POST", `/api/stock/products/${MANGO.id}/aliases`, { alias: contested }),
    call("hossam", "POST", `/api/stock/products/${LEMON.id}/aliases`, { alias: contested }),
  ]);
  check("two products racing for one alias: exactly one wins", twoWay.filter((r) => r.status === 201).length === 1, twoWay.map((r) => r.status));
  check("the contested alias is never ambiguous", (await R(contested)).status === "matched");

  const mapRaces = await Promise.all([1, 2, 3].map(() =>
    call("hossam", "POST", "/api/stock/products/mapping", { product_name: "Lemon", product_id: LEMON.id })
  ));
  check("concurrent mapping of one name is safe", mapRaces.every((r) => r.status === 201 || r.status === 409), mapRaces.map((r) => r.status));
  check("...and resolves to exactly one product", (await R("Lemon")).status === "matched");

  section("15. HISTORY AND LEDGER UNTOUCHED");
  const after = await call("sara", "GET", "/api/orders");
  const afterItems = after.body.orders.flatMap((o: any) => o.items).filter((i: any) => beforeItems.some((b: any) => b.id === i.id));
  const afterSnapshot = JSON.stringify(
    afterItems.map((i: any) => [i.id, i.productName, i.unit, i.requiredQuantity, i.preparedQuantity, i.loadedQuantity, i.version]).sort()
  );
  check("no historical quantity, name, unit or version changed", afterSnapshot === beforeSnapshot, { before: beforeSnapshot.slice(0, 200), after: afterSnapshot.slice(0, 200) });
  const afterLedger = await call("hossam", "GET", "/api/stock/ledger?limit=500");
  const afterMovements = afterLedger.body.movements.filter((m: any) => !setupMovementIds.has(m.id));
  check("stock ledger unchanged (apart from the setup receipts)", JSON.stringify(afterMovements.map((m: any) => [m.id, m.quantityKg]).sort()) === beforeLedgerSnapshot);
  check("no stock was created by any of this", afterMovements.length === beforeLedger.body.movements.length);

  section("16. AUDIT");
  const audit = await call("hossam", "GET", "/api/stock/audit");
  const acts = new Set(audit.body.logs.map((l: any) => l.action));
  for (const a of ["product_created", "product_updated", "product_deactivated", "product_alias_added", "product_alias_removed", "order_product_mapped", "order_product_unmapped"]) {
    check(`audit records ${a}`, acts.has(a), [...acts]);
  }
  const mapLog = audit.body.logs.find((l: any) => l.action === "order_product_mapped");
  check("mapping audit has actor, target, old and new", !!mapLog?.userName && !!mapLog?.fieldChanged && !!mapLog?.oldValue && !!mapLog?.newValue && !!mapLog?.timestamp, mapLog);
  const renameLog = audit.body.logs.find((l: any) => l.action === "product_updated" && l.fieldChanged === "name");
  check("rename audit carries old -> new name", !!renameLog?.oldValue && !!renameLog?.newValue && renameLog.oldValue !== renameLog.newValue, renameLog);

  section("17. INTEGRATION CONTRACT (n8n / Hermes)");
  const batch = await call("hossam", "POST", "/api/stock/products/resolve", {
    names: [`${TAG} Mango Naomi`, "Totally Unknown Thing", "   "],
  });
  check("batch resolve -> 200", batch.status === 200, batch.body);
  check("batch returns one verdict per input", batch.body.results.length === 3);
  check("verdicts are only matched/ambiguous/unmapped", batch.body.results.every((r: any) => ["matched", "ambiguous", "unmapped"].includes(r.status)), batch.body.results.map((r: any) => r.status));
  check("known name -> matched", batch.body.results[0].status === "matched");
  check("unknown name -> unmapped, with the normalized form for a human", batch.body.results[1].status === "unmapped" && typeof batch.body.results[1].normalized === "string");
  check("no confidence score is ever returned", batch.body.results.every((r: any) => !("score" in r) && !("confidence" in r)));

  finish("PRODUCT MASTER");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
