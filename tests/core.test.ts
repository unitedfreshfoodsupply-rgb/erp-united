/* Core module: configuration service (and, as Phase 1 lands, organisation master
   data). Covers RBAC, validation, optimistic concurrency, audit, and that a changed
   setting actually changes business behaviour — not just a stored number. */
import { call, login, makeChecker } from "./_harness";

const { check, section, finish } = makeChecker();
const TAG = `ZZCORE-${Date.now()}`;
const SHORTAGE = "orders.shortage_review_threshold_pct";

async function rawPatch(who: string, path: string, body: string) {
  // Bypasses the harness's JSON.stringify to send a deliberately malformed body.
  const { cookieFor, BASE } = await import("./_harness");
  const r = await fetch(BASE + path, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: cookieFor(who) ?? "" },
    body,
  });
  return r.status;
}

async function settingRow(key: string) {
  const r = await call("admin", "GET", "/api/admin/settings");
  return r.body.settings.find((s: any) => s.key === key);
}

/** Creates an order with one 100 KG line and moves it into preparation. */
async function orderInPreparation() {
  const customer = (await call("admin", "POST", "/api/sales/customers", { name: `${TAG} عميل` })).body.customer;
  const product = (await call("admin", "POST", "/api/stock/products", { name: `${TAG} Mango`, unit: "KG" })).body.product;
  const created = await call("sara", "POST", "/api/orders", {
    customer_account_id: customer.id, customer_name: customer.name,
    delivery_date: "2026-12-01",
    items: [{ stock_product_id: product.id, product_name: product.name, quantity: 100, unit: "KG" }],
  });
  const order = created.body.order;
  const moved = await call("sara", "POST", `/api/orders/${order.id}/status`, { to: "preparing", expected_version: order.version });
  return moved.body.order;
}

async function prepare(order: any, qty: number) {
  const item = order.items[0];
  const fresh = (await call("sara", "GET", `/api/orders/${order.id}`)).body.order;
  const it = fresh.items.find((i: any) => i.id === item.id);
  return call("sara", "POST", `/api/orders/${order.id}/items/${item.id}/prepare`, { quantity: qty, expected_version: it.version });
}

async function main() {
  let r: any;
  for (const u of ["admin", "sara", "ahmed", "hossam"]) await login(u);

  // Keep this suite repeatable even when the same test database has been used before.
  const initialThreshold = await settingRow(SHORTAGE);
  if (initialThreshold && !initialThreshold.isDefault) {
    await call("admin", "PATCH", `/api/admin/settings/${SHORTAGE}`, {
      value: null, reason: "إعادة ضبط تجهيز الاختبار", expected_version: initialThreshold.version,
    });
  }

  section("1. OPERATIONAL SETTINGS ARE READABLE BY EVERY SIGNED-IN USER");
  check("unauthenticated -> 401", (await call(null, "GET", "/api/settings/operational")).status === 401);
  const opsAhmed = await call("ahmed", "GET", "/api/settings/operational");
  check("preparer reads operational settings", opsAhmed.status === 200, opsAhmed.body);
  check("defaults: 5% / 20 / 45 / 60", JSON.stringify(opsAhmed.body.settings) === JSON.stringify({
    shortageReviewThresholdPct: 5, waitingToStartMinutes: 20, stalledMinutes: 45, deliverySoonMinutes: 60,
  }), opsAhmed.body.settings);

  section("2. ADMIN LISTING IS GATED ON settings.manage");
  check("supervisor cannot list settings -> 403", (await call("sara", "GET", "/api/admin/settings")).status === 403);
  check("stock controller cannot list settings -> 403", (await call("hossam", "GET", "/api/admin/settings")).status === 403);
  const list = await call("admin", "GET", "/api/admin/settings");
  check("admin lists settings", list.status === 200 && list.body.settings.length >= 4, list.body);
  const s0 = list.body.settings.find((s: any) => s.key === SHORTAGE);
  check("shortage threshold starts on its default, version 0", s0?.isDefault === true && s0?.version === 0 && s0?.value === 5, s0);
  check("rows carry Arabic label and unit", !!s0?.label && s0?.unit === "%");

  section("3. VALIDATION");
  const patch = (who: string, key: string, body: any) => call(who, "PATCH", `/api/admin/settings/${key}`, body);
  check("supervisor cannot change a setting -> 403", (await patch("sara", SHORTAGE, { value: 9, reason: "x", expected_version: 0 })).status === 403);
  check("preparer cannot change a setting -> 403", (await patch("ahmed", SHORTAGE, { value: 9, reason: "x" })).status === 403);
  check("unauthenticated -> 401", (await patch(null as any, SHORTAGE, { value: 9, reason: "x" })).status === 401);
  check("missing reason -> 400", (await patch("admin", SHORTAGE, { value: 9, expected_version: 0 })).status === 400);
  check("missing value -> 400", (await patch("admin", SHORTAGE, { reason: "x" })).status === 400);
  check("out of range (150%) -> 400", (await patch("admin", SHORTAGE, { value: 150, reason: "x" })).status === 400);
  check("negative -> 400", (await patch("admin", SHORTAGE, { value: -1, reason: "x" })).status === 400);
  check("string value -> 400", (await patch("admin", SHORTAGE, { value: "10", reason: "x" })).status === 400);
  check("fractional minutes -> 400", (await patch("admin", "orders.stalled_minutes", { value: 12.5, reason: "x" })).status === 400);
  check("unknown key -> 404", (await patch("admin", "orders.nope", { value: 1, reason: "x" })).status === 404);
  check("malformed JSON body -> 400 (not 500)", (await rawPatch("admin", `/api/admin/settings/${SHORTAGE}`, "{not json")) === 400);
  check("nothing stored by refused writes", (await settingRow(SHORTAGE))?.isDefault === true);

  section("4. CHANGE + OPTIMISTIC CONCURRENCY");
  r = await patch("admin", SHORTAGE, { value: 10, reason: `${TAG} موسم المانجا`, expected_version: 0 });
  check("admin raises tolerance to 10%", r.status === 200 && r.body.setting.value === 10 && r.body.setting.version === 1, r.body);
  const adminName = (await call("admin", "GET", "/api/auth/me")).body?.user?.name;
  check("row now attributed and not default", r.body.setting.isDefault === false && !!adminName && r.body.setting.updatedBy === adminName, { updatedBy: r.body.setting.updatedBy, adminName });
  check("stale version -> 409", (await patch("admin", SHORTAGE, { value: 12, reason: "x", expected_version: 0 })).status === 409);
  const race = await Promise.all([
    patch("admin", SHORTAGE, { value: 11, reason: "أ", expected_version: 1 }),
    patch("admin", SHORTAGE, { value: 12, reason: "ب", expected_version: 1 }),
  ]);
  check("two editors on one version: exactly one wins", race.filter((x) => x.status === 200).length === 1 && race.filter((x) => x.status === 409).length === 1, race.map((x) => x.status));
  const afterRace = await settingRow(SHORTAGE);
  check("version advanced exactly once", afterRace.version === 2, afterRace);
  r = await patch("admin", SHORTAGE, { value: 10, reason: `${TAG} نرجع لـ 10`, expected_version: 2 });
  check("set back to 10", r.status === 200 && r.body.setting.version === 3, r.body);
  check("same value again is a no-op (no version bump)", (await patch("admin", SHORTAGE, { value: 10, reason: "x", expected_version: 3 })).body?.changed === false);
  check("operational endpoint reflects the change immediately", (await call("ahmed", "GET", "/api/settings/operational")).body.settings.shortageReviewThresholdPct === 10);

  section("5. THE SETTING DRIVES THE SHORTAGE GATE");
  const o1 = await orderInPreparation();
  check("test order is in preparation", o1?.status === "preparing", o1);
  r = await prepare(o1, 92); // 8% short
  check("8% short under a 10% tolerance: shortage, but no review", r.status === 200 && r.body.flags.shortage === true && r.body.flags.needsReview === false, r.body);

  const v = (await settingRow(SHORTAGE)).version;
  r = await patch("admin", SHORTAGE, { value: null, reason: `${TAG} رجوع للافتراضي`, expected_version: v });
  check("reset to default (value: null)", r.status === 200 && r.body.setting.isDefault === true && r.body.setting.value === 5, r.body);
  r = await prepare(o1, 93); // 7% short, now over the 5% default
  check("7% short under the 5% default: review required", r.status === 200 && r.body.flags.needsReview === true, r.body);

  section("6. AUDIT");
  const overview = await call("admin", "GET", "/api/admin/overview");
  const rows = overview.body.audit.filter((l: any) => l.entityType === "system_setting" && l.entityId === SHORTAGE);
  check("setting changes appear in the security audit trail", rows.some((l: any) => l.action === "setting_changed"), rows.map((l: any) => l.action));
  check("reset is audited distinctly", rows.some((l: any) => l.action === "setting_reset"));
  const change = rows.find((l: any) => l.action === "setting_changed" && l.reason === `${TAG} موسم المانجا`);
  check("audit carries old value, new value and reason", change?.oldValue === "5" && change?.newValue === "10", change);
  check("refused writes left no audit rows", !rows.some((l: any) => l.newValue === "150"));

  // -------------------------------------------------------------------------
  // Organisation master data
  // -------------------------------------------------------------------------
  const M = (entity: string, body: any, who = "admin") => call(who, "POST", `/api/admin/master/${entity}`, body);
  const P = (entity: string, id: string, body: any, who = "admin") => call(who, "PATCH", `/api/admin/master/${entity}/${id}`, body);
  const master = async () => (await call("admin", "GET", "/api/admin/master")).body;

  section("7. BASELINE ORGANISATION + REFERENCE DATA");
  const md = await master();
  const united = md.companies?.find((c: any) => c.code === "UNITED");
  check("company UNITED exists, base currency EGP", united?.baseCurrencyCode === "EGP", united);
  const main = united?.branches?.find((b: any) => b.code === "MAIN");
  const whMain = main?.warehouses?.find((w: any) => w.code === "WH-MAIN");
  check("main warehouse carries area and daily capacity as data", whMain?.areaM2 === "1200" && whMain?.dailyCapacityKg === "60000", whMain);
  check("two cold rooms + receiving + dispatch", ["COLD-1", "COLD-2", "RECV", "DISP"].every((c) => whMain?.locations?.some((l: any) => l.code === c)));
  check("cold rooms are typed and sized", whMain?.locations?.filter((l: any) => l.type === "cold_room" && l.capacityKg === "10000").length === 2);
  check("12 baseline units incl. KG as weight reference", md.uoms?.length >= 12 && md.uoms.some((u: any) => u.code === "KG" && u.isReference));
  check("crate is a package unit with no global ratio", md.uoms.some((u: any) => u.code === "CRATE" && u.category === "package" && u.ratioToReference === null));

  section("8. ACCESS");
  check("unauthenticated master data -> 401", (await call(null, "GET", "/api/admin/master")).status === 401);
  check("supervisor cannot open master-data admin -> 403", (await call("sara", "GET", "/api/admin/master")).status === 403);
  const refSara = await call("sara", "GET", "/api/core/reference");
  check("supervisor reads reference lists through orders.view", refSara.status === 200 && refSara.body.warehouses.some((w: any) => w.code === "WH-MAIN"), refSara.status);
  const refHossam = await call("hossam", "GET", "/api/core/reference");
  check("stock controller reads reference lists through stock.view", refHossam.status === 200 && refHossam.body.uoms.some((u: any) => u.code === "KG"));
  check("reference lists exclude inactive rows", refHossam.body.uoms.every((u: any) => u.active) && refHossam.body.warehouses.every((w: any) => w.active));
  check("unauthenticated reference -> 401", (await call(null, "GET", "/api/core/reference")).status === 401);
  check("supervisor cannot create a warehouse -> 403", (await M("warehouses", { branch_id: main.id, code: "X1", name: "x" }, "sara")).status === 403);
  check("stock controller cannot edit a location -> 403", (await P("locations", "loc_cold_1", { capacity_kg: 1 }, "hossam")).status === 403);
  check("preparer cannot add a unit -> 403", (await M("uoms", { code: "XX", name: "x", category: "count", ratio_to_reference: 2 }, "ahmed")).status === 403);
  check("unknown entity -> 404", (await M("planets", { name: "x" })).status === 404);
  check("unknown entity still needs auth first -> 401", (await call(null, "POST", "/api/admin/master/planets", {})).status === 401);

  section("9. VALIDATION");
  const WH = `${TAG}-WH`;
  check("code with a space -> 400", (await M("warehouses", { branch_id: main.id, code: "WH 2", name: "x" })).status === 400);
  check("blank name -> 400", (await M("warehouses", { branch_id: main.id, code: `${WH}X`, name: "  " })).status === 400);
  check("negative capacity -> 400", (await M("warehouses", { branch_id: main.id, code: `${WH}X`, name: "x", daily_capacity_kg: -5 })).status === 400);
  check("non-numeric area -> 400", (await M("warehouses", { branch_id: main.id, code: `${WH}X`, name: "x", area_m2: "big" })).status === 400);
  check("unknown branch -> 404", (await M("warehouses", { branch_id: "nope", code: `${WH}X`, name: "x" })).status === 404);
  check("unknown location type -> 400", (await M("locations", { warehouse_id: whMain.id, code: `${TAG}-L`, name: "x", type: "garage" })).status === 400);
  check("temperature band inverted -> 400", (await M("locations", { warehouse_id: whMain.id, code: `${TAG}-L`, name: "x", type: "chiller", temp_min_c: 8, temp_max_c: 2 })).status === 400);
  check("package unit with a ratio -> 400", (await M("uoms", { code: "ZZSACK", name: "Sack", category: "package", ratio_to_reference: 25 })).status === 400);
  check("weight unit without a ratio -> 400", (await M("uoms", { code: "ZZLB", name: "Pound", category: "weight" })).status === 400);
  check("weight unit with zero ratio -> 400", (await M("uoms", { code: "ZZLB", name: "Pound", category: "weight", ratio_to_reference: 0 })).status === 400);
  check("currency code not ISO-shaped -> 400", (await M("currencies", { code: "EGPP", name: "x" })).status === 400);
  check("nothing was created by refused writes", !(await master()).companies[0].branches[0].warehouses.some((w: any) => w.code.startsWith(`${WH}X`)));

  section("10. WAREHOUSE + LOCATION LIFECYCLE");
  r = await M("warehouses", { branch_id: main.id, code: WH.toLowerCase(), name: "Test warehouse", name_ar: "مخزن اختبار", area_m2: 1234.56, daily_capacity_kg: "15000.5" });
  const wh = r.body.row;
  check("create warehouse -> 201; code upper-cased", r.status === 201 && wh?.code === WH, r.body);
  check("decimals round-trip exactly", wh?.areaM2 === "1234.56" && wh?.dailyCapacityKg === "15000.5", wh);
  check("duplicate warehouse code -> 409", (await M("warehouses", { branch_id: main.id, code: WH, name: "again" })).status === 409);
  const room = (await M("locations", { warehouse_id: wh.id, code: "ROOM", name: "Room", type: "cold_room", capacity_kg: 5000, temp_min_c: 2, temp_max_c: 6 })).body.row;
  check("create cold room", room?.code === "ROOM" && room?.tempMinC === "2" && room?.tempMaxC === "6", room);
  check("same location code in the same warehouse -> 409", (await M("locations", { warehouse_id: wh.id, code: "ROOM", name: "x", type: "dry" })).status === 409);
  check("same location code in another warehouse is fine", (await M("locations", { warehouse_id: whMain.id, code: `${TAG}-ROOM`, name: "x", type: "dry" })).status === 201);
  const zone = (await M("locations", { warehouse_id: wh.id, parent_id: room.id, code: "ZONE-A", name: "Zone A", type: "cold_room" })).body.row;
  check("create a zone inside the room", zone?.parentId === room.id, zone);
  check("parent from another warehouse -> 400", (await M("locations", { warehouse_id: whMain.id, parent_id: room.id, code: `${TAG}-Z`, name: "x", type: "dry" })).status === 400);
  check("moving the room inside its own zone (cycle) -> 400", (await P("locations", room.id, { parent_id: zone.id, expected_version: room.version })).status === 400);
  check("edit that inverts the stored band -> 400", (await P("locations", room.id, { temp_min_c: 9, expected_version: room.version })).status === 400);

  r = await P("locations", room.id, { capacity_kg: 6000, expected_version: room.version });
  check("edit capacity -> new version", r.status === 200 && r.body.row.capacityKg === "6000" && r.body.row.version === room.version + 1, r.body);
  check("stale version -> 409", (await P("locations", room.id, { capacity_kg: 7000, expected_version: room.version })).status === 409);
  const sameVer = r.body.row.version;
  const locRace = await Promise.all([
    P("locations", room.id, { name: "Room A", expected_version: sameVer }),
    P("locations", room.id, { name: "Room B", expected_version: sameVer }),
  ]);
  check("concurrent edits on one version: exactly one wins", locRace.filter((x) => x.status === 200).length === 1 && locRace.filter((x) => x.status === 409).length === 1, locRace.map((x) => x.status));
  const noop = await P("locations", room.id, { capacity_kg: "6000.000" });
  check("an unchanged value writes nothing (no version bump)", noop.status === 200 && noop.body.row.version === sameVer + 1, noop.body);

  const cur = async (id: string) => {
    const all = (await master()).companies.flatMap((c: any) => c.branches.flatMap((b: any) => b.warehouses));
    const w = all.find((x: any) => x.id === id);
    return { w, loc: (lid: string) => w.locations.find((l: any) => l.id === lid) };
  };
  let st = await cur(wh.id);
  check("deactivate warehouse with active locations -> 409", (await P("warehouses", wh.id, { active: false, expected_version: st.w.version })).status === 409);
  check("deactivate room with an active zone -> 409", (await P("locations", room.id, { active: false, expected_version: st.loc(room.id).version })).status === 409);
  check("deactivate the zone", (await P("locations", zone.id, { active: false, expected_version: st.loc(zone.id).version })).status === 200);
  st = await cur(wh.id);
  check("then the room", (await P("locations", room.id, { active: false, expected_version: st.loc(room.id).version })).status === 200);
  st = await cur(wh.id);
  check("then the warehouse", (await P("warehouses", wh.id, { active: false, expected_version: st.w.version })).status === 200);
  st = await cur(wh.id);
  check("no new location under an inactive warehouse -> 400", (await M("locations", { warehouse_id: wh.id, code: "LATE", name: "x", type: "dry" })).status === 400);
  check("no reactivating a location under an inactive warehouse -> 409", (await P("locations", room.id, { active: true, expected_version: st.loc(room.id).version })).status === 409);
  check("warehouse gone from the operational reference list", !(await call("hossam", "GET", "/api/core/reference")).body.warehouses.some((w: any) => w.id === wh.id));
  check("but still present (inactive) in admin — nothing is deleted", st.w && st.w.active === false);

  section("11. UNITS OF MEASURE");
  const sack = await M("uoms", { code: `ZZSACK${Date.now() % 100000}`, name: "Sack", name_ar: "شيكارة", category: "package" });
  check("create package unit without a ratio", sack.status === 201 && sack.body.row.ratioToReference === null && sack.body.row.precision === 0, sack.body);
  const lb = await M("uoms", { code: `ZZLB${Date.now() % 100000}`, name: "Pound", category: "weight", ratio_to_reference: "0.45359237" });
  check("create weight unit; ratio stored exactly", lb.status === 201 && lb.body.row.ratioToReference === "0.45359237", lb.body);
  check("ratio cannot be changed after creation -> 400", (await P("uoms", lb.body.row.id, { ratio_to_reference: 0.5 })).status === 400);
  check("category cannot be changed after creation -> 400", (await P("uoms", lb.body.row.id, { category: "count" })).status === 400);
  check("precision and names are editable", (await P("uoms", lb.body.row.id, { precision: 2, name_ar: "رطل", expected_version: 1 })).body?.row?.precision === 2);
  const kg = md.uoms.find((u: any) => u.code === "KG");
  check("the reference unit cannot be deactivated -> 409", (await P("uoms", kg.id, { active: false, expected_version: kg.version })).status === 409);
  check("duplicate unit code -> 409", (await M("uoms", { code: "KG", name: "again", category: "weight", ratio_to_reference: 1 })).status === 409);

  section("12. CURRENCIES");
  const egp = md.currencies.find((c: any) => c.code === "EGP");
  check("base currency of an active company cannot be deactivated -> 409", (await P("currencies", "EGP", { active: false, expected_version: egp.version })).status === 409);
  // Currencies cannot be deleted, so pick an unused 3-letter code (Q + two random letters).
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const taken = new Set(md.currencies.map((c: any) => c.code));
  let newCode = "";
  do newCode = "Q" + letters[Math.floor(Math.random() * 26)] + letters[Math.floor(Math.random() * 26)];
  while (taken.has(newCode));
  const cr = await M("currencies", { code: newCode.toLowerCase(), name: "Test currency", decimal_places: 3 });
  check("non-EGP currencies are refused for the single-currency ledger", cr.status === 400, cr.body);
  check("duplicate currency -> 409", (await M("currencies", { code: "EGP", name: "again" })).status === 409);

  section("13. MASTER-DATA AUDIT");
  const log = (await call("admin", "GET", "/api/audit")).body.logs;
  const mine = log.filter((l: any) => ["warehouse", "storage_location", "unit_of_measure"].includes(l.entityType));
  for (const a of ["warehouse_created", "storage_location_created", "storage_location_updated", "storage_location_deactivated", "warehouse_deactivated", "unit_of_measure_created", "unit_of_measure_updated"]) {
    check(`audit records ${a}`, mine.some((l: any) => l.action === a), [...new Set(mine.map((l: any) => l.action))]);
  }
  const capChange = mine.find((l: any) => l.entityId === room.id && l.fieldChanged === "capacityKg");
  check("field-level audit with before/after", capChange?.oldValue === "5000" && capChange?.newValue === "6000", capChange);
  check("refused and stale writes left no audit rows", !mine.some((l: any) => l.entityId === room.id && l.newValue === "7000"));

  finish("CORE MODULE");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
