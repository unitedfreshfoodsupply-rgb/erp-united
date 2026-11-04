/* Ordinary commercial invoices over HTTP (Nov 2026): the printed sales invoice and supplier bill
   in Arabic (RTL) and English (LTR), as UNITED's commercial documents — no tax-invoice title, UUID
   or approval claim without an ETA document; who may open, edit, post and attach what, refused on
   the server; a bill recorded against its PO and receipt, posted once, printed with the supplier
   as it was at posting. Runs after the suites that issue invoices (it prints one of theirs). */
import { call, login, makeChecker, page } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { todayBiz } from "./_days";

const T = `ZZCIV${Date.now() % 1_000_000_000}`;
const { check, section, finish } = makeChecker();
const today = todayBiz();
const denied = (html: string) => html.includes("مش مسموح");

async function main() {
  assertTestDatabase();
  for (const u of ["admin", "karim", "mona", "omar", "hossam", "ahmed"]) await login(u);

  section("1. THE SALES INVOICE, PRINTED");
  const inv = (await call("karim", "GET", "/api/sales/invoices?status=issued&limit=5")).body.invoices?.[0];
  check("an issued invoice exists to print (from the earlier suites)", !!inv);
  if (inv) {
    const full = (await call("karim", "GET", `/api/sales/invoices/${inv.id}`)).body.invoice;
    let p = await page("mona", `/sales/invoices/${inv.id}/print`);
    check("Arabic: RTL, the commercial title and its note, the number, totals and signatures", p.status === 200 && /dir="rtl"/.test(p.html) && p.html.includes("فاتورة مبيعات") && p.html.includes("غير مُرسلة لمنظومة الفاتورة الإلكترونية") && p.html.includes(inv.number) && p.html.includes("إجمالي الفاتورة") && p.html.includes("استلام العميل"));
    check("…not a tax invoice, no UUID, no QR code while the ETA has no document", !p.html.includes("فاتورة ضريبية") && !p.html.includes("data-eta-uuid") && !/data-qr|alt="[^"]*qr|<canvas/i.test(p.html));
    check("…the page number and document number go in the print margin", p.html.includes("counter(page)") && p.html.includes(`"${inv.number}"`));
    p = await page("mona", `/sales/invoices/${inv.id}/print?lang=en`);
    check("English: LTR, Sales Invoice, the same number", p.status === 200 && /dir="ltr"/.test(p.html) && p.html.includes("Sales Invoice") && p.html.includes("Commercial invoice — not submitted to the ETA e-invoicing system") && p.html.includes(inv.number) && !p.html.includes("Tax Invoice"));
    check(`…printed from the issue snapshot when it has one (${full.issueSnapshot ? "snapshot" : "issued before snapshots"})`, p.html.includes(`data-source="${full.issueSnapshot ? "snapshot" : "legacy"}"`));
    check("a preparer cannot open an invoice", denied((await page("ahmed", `/sales/invoices/${inv.id}/print`)).html));
    check("sales cannot edit an invoice -> 403", (await call("mona", "PATCH", `/api/sales/invoices/${inv.id}`, { notes: "x" })).status === 403);
    check("an issued invoice's notes cannot change -> 409", (await call("karim", "PATCH", `/api/sales/invoices/${inv.id}`, { notes: "x", expected_version: full.version })).status === 409);
    check("its attachments: the accountant reads them, the preparer cannot", (await call("karim", "GET", `/api/attachments?entity_type=sales_invoice&entity_id=${inv.id}`)).status === 200 && (await call("ahmed", "GET", `/api/attachments?entity_type=sales_invoice&entity_id=${inv.id}`)).status === 403);
  }

  section("2. A SUPPLIER BILL: PO → RECEIPT → BILL");
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { category: "vegetable", name: `${T} مزرعة الأمل`, phone: "0111-200", payment_terms_days: 7 })).body.supplier;
  const product = (await call("hossam", "POST", "/api/stock/products", { name: `${T} Okra`, name_ar: `بامية ${T}`, unit: "KG" })).body.product;
  check("supplier and product created", !!supplier?.id && !!product?.id);
  let r = await call("omar", "POST", "/api/purchasing/orders", { supplier_id: supplier.id, lines: [{ product_id: product.id, quantity: 50, unit_price: "12" }] });
  const po = r.body.order;
  check("a purchase order -> 201", r.status === 201 && !!po?.id, r.body);
  await call("omar", "POST", `/api/purchasing/orders/${po.id}/submit`, {});
  await call("omar", "POST", `/api/purchasing/orders/${po.id}/send`, {});
  const poFull = (await call("omar", "GET", `/api/purchasing/orders/${po.id}`)).body.order;
  r = await call("hossam", "POST", "/api/stock/intakes", { purchase_order_line_id: poFull.lines[0].id, received_kg: 50, location_id: "loc_cold_2" });
  const intake = r.body.intake;
  check("received against the PO", r.status === 201 && !!intake?.id, r.body);
  check("the purchaser cannot record a bill -> 403", (await call("omar", "POST", "/api/purchasing/bills", { supplier_id: supplier.id, supplier_invoice_no: `${T}-1`, bill_date: today, lines: [{ intake_id: intake.id, unit_price: "12" }] })).status === 403);
  r = await call("karim", "POST", "/api/purchasing/bills", { supplier_id: supplier.id, supplier_invoice_no: `${T}-F77`, bill_date: today, lines: [{ intake_id: intake.id, unit_price: "12" }] });
  const bill = r.body.bill;
  check("the accountant records the supplier's invoice -> 201", r.status === 201 && bill?.status === "draft", r.body);
  check("the same supplier invoice number again -> 409", (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: supplier.id, supplier_invoice_no: `${T}-F77`, bill_date: today, lines: [{ intake_id: intake.id, unit_price: "12" }] })).status === 409);

  let p = await page("karim", `/purchasing/bills/${bill.id}/print`);
  check("draft print: RTL, purchase invoice, the supplier's invoice number, and 'draft' across it", p.status === 200 && /dir="rtl"/.test(p.html) && p.html.includes("فاتورة مشتريات") && p.html.includes(`${T}-F77`) && p.html.includes("bill-status-banner") && p.html.includes("مسودة"));
  r = await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {});
  check("posted -> the payable is recorded", r.status === 200 && r.body.bill?.status === "posted", r.body);
  const posted = (await call("karim", "GET", `/api/purchasing/bills/${bill.id}`)).body.bill;
  check("…with the supplier frozen as it was at posting", posted.postSnapshot?.supplier?.code === supplier.code && posted.postSnapshot?.supplier?.phone === "0111-200" && posted.postSnapshot?.lines?.["1"]?.poNumber === poFull.number);
  check("…posting twice -> 409", (await call("karim", "POST", `/api/purchasing/bills/${bill.id}/post`, {})).status === 409);
  check("…no payment was made by recording it", Number(posted.paid) === 0 && Number(posted.open) === Number(posted.total));
  const sv = (await call("omar", "GET", `/api/purchasing/suppliers/${supplier.id}`)).body.supplier;
  r = await call("omar", "PATCH", `/api/purchasing/suppliers/${supplier.id}`, { phone: "0111-999", expected_version: sv?.version });
  check("the supplier's phone changes on the card (master data)", r.status === 200 && r.body.supplier?.phone === "0111-999", r.body);
  p = await page("omar", `/purchasing/bills/${bill.id}/print?lang=en`);
  check("English print: LTR, Purchase Invoice, PO and receipt references, posted (no draft banner)", p.status === 200 && /dir="ltr"/.test(p.html) && p.html.includes("Purchase Invoice") && p.html.includes(poFull.number) && p.html.includes(intake.receiptNumber) && !p.html.includes("bill-status-banner"));
  check("…the phone it posted with, not today's", p.html.includes("0111-200") && !p.html.includes("0111-999"));
  check("…no copy of the supplier's invoice attached yet: said on the print", p.html.includes("No copy of the supplier"));
  check("sales and the stock controller cannot open a bill", denied((await page("mona", `/purchasing/bills/${bill.id}/print`)).html) && denied((await page("hossam", `/purchasing/bills/${bill.id}/print`)).html));
  check("bill attachments: the accountant may, sales may not", (await call("karim", "GET", `/api/attachments?entity_type=supplier_bill&entity_id=${bill.id}`)).status === 200 && (await call("mona", "GET", `/api/attachments?entity_type=supplier_bill&entity_id=${bill.id}`)).status === 403);

  section("3. THE COMPANY DETAILS DOCUMENTS PRINT");
  const md = (await call("admin", "GET", "/api/admin/master")).body;
  const company = md?.companies?.[0];
  check("the company record is read by the administrator", !!company?.id, md);
  if (company) {
    check("an IBAN that is not Egyptian -> 400", (await call("admin", "PATCH", `/api/admin/master/companies/${company.id}`, { iban: "DE89370400440532013000", expected_version: company.version })).status === 400);
    check("the accountant cannot change the company record -> 403", (await call("karim", "PATCH", `/api/admin/master/companies/${company.id}`, { bank_name: "x", expected_version: company.version })).status === 403);
  }
  return finish("COMMERCIAL INVOICES");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
