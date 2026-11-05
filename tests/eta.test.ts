/* E-invoicing (ETA) through the running server: who may see and do what, that no
   credential ever leaves the server, that an unready or unconfigured submission records
   nothing, and that the UNITED invoice prints in its own bilingual design. */
import { call, login, makeChecker, page } from "./_harness";

const { check, section, finish } = makeChecker();
let r: any;

async function main() {
  for (const u of ["admin", "sara", "karim", "mona", "ahmed", "mostafa", "hossam", "omar"]) await login(u);

  section("1. WHO SEES ETA STATUS");
  for (const u of ["admin", "karim", "sara"]) check(`${u} sees the e-invoicing overview`, (await call(u, "GET", "/api/eta")).status === 200);
  for (const u of ["mona", "ahmed", "mostafa", "hossam", "omar"]) check(`${u} cannot see ETA status or errors -> 403`, (await call(u, "GET", "/api/eta")).status === 403);
  r = await call("karim", "GET", "/api/eta");
  const ov = r.body.eta;
  check("configuration reports variable names only", JSON.stringify(Object.keys(ov.config).sort()) === JSON.stringify(["configured", "environment", "invalid", "missing"]) && [...ov.config.missing, ...ov.config.invalid].every((m: string) => /^ETA_[A-Z_0-9]+$/.test(m)), ov.config);
  // The missing/invalid lists hold variable NAMES (checked above); everything else must carry no credential.
  const rest = { ...ov, config: { ...ov.config, missing: [], invalid: [] } };
  check("…and no secret-looking value anywhere else in the response", !/client_secret|clientSecret|access_token|Bearer /i.test(JSON.stringify(rest)));
  check("tax classification is read from the existing tax rates (not duplicated)", ov.taxes.some((t: any) => t.code === "EXEMPT" && t.etaType));
  check("ETA stays disabled by default: not configured, and API submission has no start date", ov.config.configured === false && ov.api?.enabled === false, [ov.config.configured, ov.api]);
  r = await call("karim", "GET", "/api/eta/pending");
  check("the pending-registration list opens for finance (read only)", r.status === 200 && Array.isArray(r.body.pending?.rows) && r.body.pending.rows.every((x: any) => typeof x.ageHours === "number" || x.ageHours === null), r.body);
  check("…and for the supervisor; not for sales", (await call("sara", "GET", "/api/eta/pending")).status === 200 && (await call("mona", "GET", "/api/eta/pending")).status === 403);

  section("2. WHO MAY CHANGE ETA DATA");
  check("a supervisor follows but cannot change the issuer -> 403", (await call("sara", "PUT", "/api/eta/issuer", { activity_code: "1" })).status === 403);
  check("sales cannot set item codes -> 403", (await call("mona", "PUT", "/api/eta/items/x", { item_type: "EGS", item_code: "x" })).status === 403);
  check("an invalid item type -> 400", (await call("karim", "PUT", `/api/eta/items/${ov.products[0]?.id ?? "none"}`, { item_type: "UPC", item_code: "1" })).status === 400);
  check("an unknown unit -> 404", (await call("karim", "PUT", "/api/eta/units/NOPE", { eta_unit_type: "X" })).status === 404);

  section("3. SUBMISSION IS SAFE WHEN NOT READY OR NOT CONFIGURED");
  const inv = (await call("karim", "GET", "/api/sales/invoices?status=issued")).body.invoices?.[0];
  check("an issued invoice exists to work with", !!inv, r.body);
  if (inv) {
    r = await call("karim", "GET", `/api/eta/invoices/${inv.id}`);
    check("readiness: issues listed per field, the mapped v1.0 document previewed", r.status === 200 && Array.isArray(r.body.issues) && r.body.document?.documentTypeVersion === "1.0" && r.body.document?.internalID === inv.number, r.body);
    check("…supervisor may read it; sales may not", (await call("sara", "GET", `/api/eta/invoices/${inv.id}`)).status === 200 && (await call("mona", "GET", `/api/eta/invoices/${inv.id}`)).status === 403);
    check("a supervisor cannot submit -> 403", (await call("sara", "POST", `/api/eta/invoices/${inv.id}/submit`, {})).status === 403);
    const before = (await call("karim", "GET", `/api/eta/invoices/${inv.id}`)).body.eta;
    r = await call("karim", "POST", `/api/eta/invoices/${inv.id}/submit`, {});
    check("unready or unconfigured -> 422 / 503 with the reason", [422, 503].includes(r.status) && typeof r.body.error === "string", [r.status, r.body]);
    check("…and nothing was recorded", JSON.stringify((await call("karim", "GET", `/api/eta/invoices/${inv.id}`)).body.eta) === JSON.stringify(before));
    check("refresh of a never-sent invoice -> 404", (await call("karim", "POST", `/api/eta/invoices/${inv.id}/refresh`, {})).status === 404);
    check("lookup of a never-sent invoice -> 404", (await call("karim", "POST", `/api/eta/invoices/${inv.id}/lookup`, {})).status === 404);
    check("a supervisor cannot record a portal filing or look up -> 403", (await call("sara", "POST", `/api/eta/invoices/${inv.id}/portal`, {})).status === 403 && (await call("sara", "POST", `/api/eta/invoices/${inv.id}/lookup`, {})).status === 403);
    check("a portal filing needs an ETA-shaped UUID and evidence -> 400", (await call("karim", "POST", `/api/eta/invoices/${inv.id}/portal`, { uuid: "x", submitted_at: "2026-11-01T10:00:00Z" })).status === 400);
    check("the old one-person \"not received\" shortcut is refused -> 400", (await call("karim", "POST", `/api/eta/invoices/${inv.id}/reconcile`, { not_received: true, reason: "مش موجودة" })).status === 400);

    section("4. THE UNITED INVOICE (PRINT)");
    let p = await page("mona", `/sales/invoices/${inv.id}/print`);
    // Not submitted to the ETA: printed as UNITED's commercial sales invoice, never as a tax invoice (Nov 2026).
    check("Arabic by default: RTL, title, number, totals, payment", p.status === 200 && /dir="rtl"/.test(p.html) && p.html.includes("فاتورة مبيعات") && !p.html.includes("فاتورة ضريبية") && p.html.includes(inv.number) && p.html.includes("إجمالي الفاتورة") && p.html.includes("السداد"));
    check("…no ETA error or internal state on the customer document", !/lastError|submitting|مطابقة يدوية/.test(p.html));
    p = await page("mona", `/sales/invoices/${inv.id}/print?lang=en`);
    check("English from the same layout: LTR, English labels", p.status === 200 && /dir="ltr"/.test(p.html) && p.html.includes("Sales Invoice") && !p.html.includes("Tax Invoice") && p.html.includes("Invoice total") && p.html.includes(inv.number));
    p = await page("ahmed", `/sales/invoices/${inv.id}/print`);
    check("a preparer cannot open an invoice", !p.html.includes(inv.number) && p.html.includes("مش مسموح"));
  }

  section("5. PAGE");
  check("the e-invoicing page opens for the accountant and the supervisor", (await page("karim", "/eta")).html.includes("الفاتورة الإلكترونية") && !(await page("sara", "/eta")).html.includes("مش مسموح"));
  check("…not for the floor", (await page("mostafa", "/eta")).html.includes("مش مسموح"));
  finish("E-INVOICING (ETA)");
}

main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
