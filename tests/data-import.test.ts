/* Data loading regression: the downloadable templates, preview/commit boundary,
   customer/product/supplier masters, and opening balances/stock through multipart
   CSV and XLSX uploads. */
import { deflateRawSync } from "node:zlib";
import { call, login, makeChecker, BASE, cookieFor } from "./_harness";
import { todayBiz } from "./_days";

const { check, section, finish } = makeChecker();
const TAG = `ZZIMP${Date.now()}`;
const SKU = `${TAG}-MANGO`;
const taxId = String(100_000_000 + (Date.now() % 899_999_999)).slice(0, 9);

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const [filename, raw] of Object.entries(files)) {
    const name = Buffer.from(filename);
    const source = Buffer.from(raw);
    const compressed = deflateRawSync(source);
    const checksum = crc32(source);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42); name.copy(central, 46);
    centrals.push(central);
    localOffset += local.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function xlsxCustomer(name: string) {
  const cells = ["name", "name_ar", "external_ref"].map((value, i) => `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${value}</t></is></c>`).join("")
    + [name, `عميل ${TAG}`, `${TAG}-XLSX`].map((value, i) => `<c r="${String.fromCharCode(65 + i)}2" t="inlineStr"><is><t>${value}</t></is></c>`).join("");
  return zip({
    "xl/workbook.xml": `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1">${cells.slice(0, cells.indexOf(`<c r="A2"`))}</row><row r="2">${cells.slice(cells.indexOf(`<c r="A2"`))}</row></sheetData></worksheet>`,
  });
}

async function upload(who: string, kind: string, filename: string, bytes: Uint8Array, action: "preview" | "commit", businessDate?: string, lang?: "en") {
  const form = new FormData();
  form.set("action", action); form.set("kind", kind);
  if (businessDate) form.set("business_date", businessDate);
  form.set("file", new Blob([bytes as BlobPart]), filename);
  const response = await fetch(`${BASE}/api/admin/data-import`, { method: "POST", headers: { cookie: cookieFor(who) ?? "", ...(lang ? { "accept-language": lang } : {}) }, body: form });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; }
  catch { return { status: response.status, body: text }; }
}

const csv = (value: string) => new TextEncoder().encode(value);

async function main() {
  for (const username of ["admin", "sara", "ahmed", "hossam", "mona", "karim", "omar"]) await login(username);

  section("1. TEMPLATES AND PERMISSIONS");
  const template = await call("admin", "GET", "/api/admin/data-import?template=products");
  check("product CSV template is downloadable", template.status === 200 && String(template.body).includes("name,name_ar,sku,category,unit"), template.body);
  check("invalid template kind -> 400", (await call("admin", "GET", "/api/admin/data-import?template=unknown")).status === 400);
  check("preparer cannot import products", (await upload("ahmed", "products", "x.csv", csv("name,unit\nX,KG\n"), "preview")).status === 403);

  section("2. PREVIEW DOES NOT WRITE; FILE ERRORS BLOCK THE WHOLE COMMIT");
  const duplicateNames = csv(`name\n${TAG} مؤقت\n${TAG}   مؤقت\n`);
  const badPreview = await upload("admin", "customers", "customers.csv", duplicateNames, "preview");
  check("preview detects normalized duplicate customer names", badPreview.status === 200 && badPreview.body.errorCount === 1, badPreview.body);
  const blocked = await upload("admin", "customers", "customers.csv", duplicateNames, "commit");
  check("invalid file commit is refused without partial rows", blocked.status === 400, blocked.body);
  check("valid row from refused file was not created", !(await call("mona", "GET", `/api/sales/customers?q=${encodeURIComponent(`${TAG} مؤقت`)}`)).body.customers.length);

  section("3. XLSX CUSTOMER CARD IMPORT");
  const xlsx = await upload("admin", "customers", "customers.xlsx", xlsxCustomer(`${TAG} XLSX Hotel`), "preview");
  check("XLSX multipart preview reads first-sheet literal values", xlsx.status === 200 && xlsx.body.rowCount === 1 && xlsx.body.errorCount === 0, xlsx.body);
  const xlsxCommit = await upload("admin", "customers", "customers.xlsx", xlsxCustomer(`${TAG} XLSX Hotel`), "commit");
  check("XLSX commit creates the customer card", xlsxCommit.status === 200 && xlsxCommit.body.created === 1 && !!xlsxCommit.body.results[0].code, xlsxCommit.body);

  section("4. CSV CUSTOMER, SUPPLIER AND PRODUCT MASTERS");
  const customerCsv = csv(`name,name_ar,type,tax_registration_no,external_ref\n"${TAG} Main Hotel","فندق ${TAG}",hotel,${taxId},${TAG}-C1\n`);
  const customerPreview = await upload("admin", "customers", "customers.csv", customerCsv, "preview");
  check("CSV customer preview validates required fields", customerPreview.status === 200 && customerPreview.body.errorCount === 0, customerPreview.body);
  const customerCommit = await upload("admin", "customers", "customers.csv", customerCsv, "commit");
  check("CSV commit creates customer", customerCommit.status === 200 && customerCommit.body.created === 1, customerCommit.body);
  const customer = (await call("mona", "GET", `/api/sales/customers?q=${encodeURIComponent(`${TAG} Main`)}`)).body.customers[0];
  check("customer import persists a stable master ID and external reference", !!customer?.id && customer.externalRef === `${TAG}-C1`, customer);

  const supplierCsv = csv(`name,type,currency_code\n"${TAG} Farm",farm,EGP\n`);
  const supplierCommit = await upload("admin", "suppliers", "suppliers.csv", supplierCsv, "commit");
  check("CSV commit creates supplier", supplierCommit.status === 200 && supplierCommit.body.created === 1 && !!supplierCommit.body.results[0].code, supplierCommit.body);
  const supplier = (await call("omar", "GET", `/api/purchasing/suppliers?q=${encodeURIComponent(`${TAG} Farm`)}`)).body.suppliers[0];
  check("supplier import persists a stable master ID", !!supplier?.id, supplier);

  const productCsv = csv(`name,name_ar,sku,category,unit,stock_tracked,sales_tax_code\n"${TAG} Mango","مانجو ${TAG}",${SKU},Fruit,KG,true,EXEMPT\n`);
  const productPreview = await upload("admin", "products", "products.csv", productCsv, "preview");
  check("product preview validates SKU and EGP tax classification", productPreview.status === 200 && productPreview.body.errorCount === 0, productPreview.body);
  const productCommit = await upload("admin", "products", "products.csv", productCsv, "commit");
  check("CSV commit creates product card", productCommit.status === 200 && productCommit.body.created === 1, productCommit.body);
  const product = (await call("hossam", "GET", "/api/stock/products?all=1")).body.products.find((p: any) => p.sku === SKU);
  check("product import persists stable SKU/ID and tax class", !!product?.id && product.salesTaxCode === "EXEMPT", product);

  section("5. PRODUCT SETTINGS AND PACKAGING IMPORT");
  const settingsCsv = csv(`sku,shelf_life_days,removal_strategy,min_stock_qty,reorder_point_qty,max_stock_qty,cold_chain,costing_method\n${SKU},7,fefo,0,5,100,true,avco\n`);
  const settingsCommit = await upload("admin", "product_settings", "settings.csv", settingsCsv, "commit");
  check("product settings import updates existing SKU", settingsCommit.status === 200 && settingsCommit.body.created === 1, settingsCommit.body);
  const packageCsv = csv(`sku,uom,qty_in_base_unit,barcode,active\n${SKU},CRATE,18,${TAG}-BAR,true\n`);
  const packageCommit = await upload("admin", "product_packaging", "packaging.csv", packageCsv, "commit");
  check("product-specific packaging imports", packageCommit.status === 200 && packageCommit.body.created === 1, packageCommit.body);
  const productDetail = (await call("hossam", "GET", `/api/inventory/products/${product.id}`)).body;
  check("settings and packaging persisted on the product card", productDetail.product?.shelfLifeDays === 7 && productDetail.product?.packagings?.some((p: any) => p.uomCode === "CRATE" && p.qtyInBaseUnit === "18"), productDetail);

  section("6. OPENING STOCK AND PARTY BALANCES");
  const today = todayBiz();
  const stockCsv = csv(`sku,quantity,unit,unit_cost,expiry_date,location_code\n${SKU},20,KG,12,2099-12-31,COLD-1\n`);
  const stockPreview = await upload("admin", "opening_stock", "opening.csv", stockCsv, "preview", today);
  check("opening stock previews against SKU, location and business date", stockPreview.status === 200 && stockPreview.body.errorCount === 0, stockPreview.body);
  const stockCommit = await upload("admin", "opening_stock", "opening.csv", stockCsv, "commit", today);
  check("opening stock commits as one accounting document", stockCommit.status === 200 && stockCommit.body.created === 1, stockCommit.body);
  const afterFirst = (await call("hossam", "GET", `/api/inventory/products/${product.id}`)).body.onHand;
  const stockRetry = await upload("admin", "opening_stock", "opening.csv", stockCsv, "commit", today);
  const afterRetry = (await call("hossam", "GET", `/api/inventory/products/${product.id}`)).body.onHand;
  check("re-uploading identical opening stock is idempotent", stockRetry.status === 200 && afterRetry === afterFirst, { first: afterFirst, retry: afterRetry, result: stockRetry.body });

  const balanceCsv = csv(`party_type,party_code,date,due_date,amount,reference\ncustomer,${customer.code},${today},${today},500,${TAG}-AR\nsupplier,${supplier.code},${today},${today},300,${TAG}-AP\n`);
  const balancePreview = await upload("admin", "opening_balances", "balances.csv", balanceCsv, "preview");
  check("customer and supplier opening balance rows preview", balancePreview.status === 200 && balancePreview.body.errorCount === 0, balancePreview.body);
  const balanceCommit = await upload("admin", "opening_balances", "balances.csv", balanceCsv, "commit");
  check("customer and supplier balances import", balanceCommit.status === 200 && balanceCommit.body.created === 2 && balanceCommit.body.failed === 0, balanceCommit.body);
  check("imported customer balance is visible in its statement", (await call("karim", "GET", `/api/sales/customers/${customer.id}/statement?from=2000-01-01&to=2099-12-31`)).body.closing === "500.00");
  check("imported supplier balance is visible in its statement", (await call("karim", "GET", `/api/purchasing/suppliers/${supplier.id}/statement?from=2000-01-01&to=2099-12-31`)).body.payable === "300.00");

  section("7. BILINGUAL NAMES: CODE, name_ar AND name_en SURVIVE PREVIEW, COMMIT AND RE-READ");
  const BSKU = `${TAG}-GUAVA`;
  const biProductCsv = csv(`code,name_en,name_ar,unit\n${BSKU},"${TAG} Guava","جوافة ${TAG}",KG\n`);
  const biProductPreview = await upload("admin", "products", "products-bi.csv", biProductCsv, "preview");
  check("product preview accepts code/name_en/name_ar and labels the row with both names and its code",
    biProductPreview.status === 200 && biProductPreview.body.errorCount === 0 && biProductPreview.body.rows[0].label === `${TAG} Guava` && biProductPreview.body.rows[0].labelAr === `جوافة ${TAG}` && biProductPreview.body.rows[0].code === BSKU, biProductPreview.body);
  const biProductCommit = await upload("admin", "products", "products-bi.csv", biProductCsv, "commit");
  check("bilingual product commits", biProductCommit.status === 200 && biProductCommit.body.created === 1, biProductCommit.body);
  const biProduct = (await call("hossam", "GET", "/api/stock/products?all=1")).body.products.find((p: any) => p.sku === BSKU);
  check("product stores code as SKU, English as name and Arabic as nameAr — not swapped", biProduct?.name === `${TAG} Guava` && biProduct?.nameAr === `جوافة ${TAG}`, biProduct);

  const biSupplierCsv = csv(`name_en,name_ar,type\n"${TAG} Delta Farm","مزرعة الدلتا ${TAG}",farm\n`);
  const biSupplierPreview = await upload("admin", "suppliers", "suppliers-bi.csv", biSupplierCsv, "preview");
  check("supplier preview accepts name_ar", biSupplierPreview.status === 200 && biSupplierPreview.body.errorCount === 0, biSupplierPreview.body);
  const biSupplierCommit = await upload("admin", "suppliers", "suppliers-bi.csv", biSupplierCsv, "commit");
  check("bilingual supplier commits and returns its system code", biSupplierCommit.status === 200 && biSupplierCommit.body.created === 1 && /^SUP-/.test(biSupplierCommit.body.results[0].code ?? ""), biSupplierCommit.body);
  const biSupplier = (await call("omar", "GET", `/api/purchasing/suppliers?q=${encodeURIComponent(`مزرعة الدلتا ${TAG}`)}`)).body.suppliers[0];
  check("supplier keeps both names and is searchable by its Arabic name", biSupplier?.name === `${TAG} Delta Farm` && biSupplier?.nameAr === `مزرعة الدلتا ${TAG}` && biSupplier?.code === biSupplierCommit.body.results[0].code, biSupplier);

  // Arabic-only English column + Latin-only Arabic column: the classic swap.
  const swappedCsv = csv(`name,name_ar\n"مزرعة ${TAG.replace(/\D/g, "")}","${TAG} Farm Two"\n`);
  const swapped = await upload("admin", "suppliers", "suppliers-swapped.csv", swappedCsv, "preview");
  check("swapped name columns are reported in preview, not imported", swapped.status === 200 && swapped.body.errorCount === 1 && swapped.body.rows[0].errors.join(" ").includes("متبدلين"), swapped.body);
  const swappedCommit = await upload("admin", "suppliers", "suppliers-swapped.csv", swappedCsv, "commit");
  check("commit refuses the same swapped file — preview and commit agree", swappedCommit.status === 400, swappedCommit.body);
  const clash = await upload("admin", "products", "products-clash.csv", csv(`name,name_en,unit\nA,B,KG\n`), "preview");
  check("a file with both name and name_en is refused instead of one overwriting the other", clash.status === 400, clash.body);
  const codeForCustomer = await upload("admin", "customers", "customers-code.csv", csv(`code,name\nCUS-99999,"${TAG} Coded Hotel"\n`), "preview");
  check("a customer code in the file is reported (codes are system-assigned), not silently dropped", codeForCustomer.status === 200 && codeForCustomer.body.errorCount === 1, codeForCustomer.body);

  const biCustomerCsv = csv(`name_en,name_ar,external_ref\n"${TAG} Nile Hotel","فندق النيل ${TAG}",${TAG}-C2\n`);
  const biCustomerCommit = await upload("admin", "customers", "customers-bi.csv", biCustomerCsv, "commit");
  check("bilingual customer commits", biCustomerCommit.status === 200 && biCustomerCommit.body.created === 1, biCustomerCommit.body);
  // Re-import keyed by external_ref with the English column blank: the preview calls it
  // the existing card, the commit must agree (it used to compare the English name only)
  // and must not touch the stored names.
  const reimportCsv = csv(`name,name_ar,external_ref\n"${TAG} Nile Hotel (renamed)","فندق النيل ${TAG}",${TAG}-C2\n`);
  const reimportPreview = await upload("admin", "customers", "customers-re.csv", reimportCsv, "preview");
  const reimportCommit = await upload("admin", "customers", "customers-re.csv", reimportCsv, "commit");
  check("re-import matched by Arabic name previews clean and commits as 'already exists'", reimportPreview.status === 200 && reimportPreview.body.errorCount === 0 && reimportCommit.status === 200 && reimportCommit.body.created === 0 && reimportCommit.body.failed === 0 && reimportCommit.body.results[0].status === "موجود — لم يتكرر", { reimportPreview: reimportPreview.body, reimportCommit: reimportCommit.body });
  const biCustomer = (await call("mona", "GET", `/api/sales/customers?q=${encodeURIComponent(`${TAG} Nile`)}`)).body.customers.find((c: any) => c.externalRef === `${TAG}-C2`);
  check("the existing customer's names are unchanged by the re-import", biCustomer?.name === `${TAG} Nile Hotel` && biCustomer?.nameAr === `فندق النيل ${TAG}`, biCustomer);

  section("8. ERRORS FOLLOW THE USER'S LANGUAGE, WITH THEIR DETAILS");
  const enSwap = await upload("admin", "suppliers", "suppliers-swapped.csv", swappedCsv, "preview", undefined, "en");
  check("English preview row errors are English and keep the column names",
    enSwap.status === 200 && enSwap.body.rows[0].errors.join(" ").includes("name_ar and name look swapped") && !/[\u0600-\u06FF]/.test(enSwap.body.rows[0].errors.join(" ")), enSwap.body);
  check("the Arabic preview of the same file is unchanged", swapped.body.rows[0].errors.join(" ").includes("متبدلين"));
  const enMissing = await upload("admin", "products", "products-missing.csv", csv("name\nX\n"), "preview", undefined, "en");
  check("a file-level error (thrown ApiError) is English with the missing column named", enMissing.status === 400 && enMissing.body.error === "Missing required columns: unit", enMissing.body);
  const arMissing = await upload("admin", "products", "products-missing.csv", csv("name\nX\n"), "preview");
  check("…and stays Arabic without Accept-Language: en", arMissing.status === 400 && arMissing.body.error === "أعمدة مطلوبة ناقصة: unit", arMissing.body);
  const enCommit = await upload("admin", "suppliers", "suppliers-swapped.csv", swappedCsv, "commit", undefined, "en");
  check("a refused commit says how many rows need fixing, in English", enCommit.status === 400 && enCommit.body.error === "1 row(s) need fixing — nothing was saved", enCommit.body);
  const enService = await call("omar", "POST", "/api/purchasing/suppliers", { name: biSupplier.name }, { "accept-language": "en" });
  check("a service error (duplicate supplier) is English and keeps the supplier's name", enService.status === 409 && enService.body.error === `Supplier "${biSupplier.name}" already exists`, enService.body);

  finish("DATA IMPORT");
}
main().catch((err) => { console.error("SUITE CRASHED", err); process.exit(2); });
