/* Report links (lib/reports/page-access.ts): a catalogue entry's screen and a row's drill-down are
   offered only to viewers who can open them. The page gates must be the ones the pages really
   check (read here from app/<route>/page.tsx), every link the reports build must point at a page
   the table knows, and each role gets exactly the links its permissions open. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAGE_GATES, mayOpenLink, pageOf } from "@/lib/reports/page-access";
import { REPORT_PAGE_PERMISSIONS } from "@/lib/nav";
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from "@/lib/permissions";

const can = (role: keyof typeof ROLE_PERMISSIONS) => (p: string) => (role === "SUPER_ADMIN" ? (ALL_PERMISSIONS as readonly string[]) : ROLE_PERMISSIONS[role] as readonly string[]).includes(p);

test("PAGE_GATES are the guards the pages check (app/<route>/page.tsx)", () => {
  for (const [route, gate] of Object.entries(PAGE_GATES)) {
    const src = readFileSync(`app${route}/page.tsx`, "utf8");
    const call = /require(Any)?PagePermission\(([\s\S]*?)\)\s*;/.exec(src);
    assert.ok(call, `${route}: the page has a guard`);
    const listed = [...call[2].matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]);
    const perms = call[2].includes("REPORT_PAGE_PERMISSIONS") ? [...REPORT_PAGE_PERMISSIONS, ...listed] : listed;
    // requirePagePermission([...]) needs every permission; the table reads "any one", so it must name one.
    if (!call[1]) assert.ok(perms.length === 1, `${route}: requirePagePermission with one permission`);
    assert.deepEqual([...gate].sort(), [...perms].sort(), `${route}: gate`);
  }
});

test("every link the reports build points at a page the table knows", () => {
  const src = readFileSync("lib/reports/definitions.ts", "utf8");
  const paths = [...new Set([...src.matchAll(/["`](\/[a-z][a-z/-]*)(?=[?$`"])/g)].map((m) => m[1]))];
  assert.ok(paths.length >= 10, `found ${paths.length} link paths`);
  for (const path of paths) assert.ok(pageOf(path.endsWith("/") ? `${path}x` : path), `${path} is in PAGE_GATES`);
  assert.equal(pageOf("/orders/abc"), "/orders/[orderId]");
  assert.equal(pageOf("/purchasing/requests"), null, "a sub-page is not its module");
  assert.equal(mayOpenLink("/supervisor", () => true), false, "a page the table does not know is not linked");
});

test("ACCOUNTING_CLERK: payables (bills, aging, statements) and the customer and supplier profiles open; stock, order and purchase-order drill-downs are not offered", () => {
  const clerk = can("ACCOUNTING_CLERK");
  for (const href of ["/purchasing?po=po1", "/purchasing?tab=orders", "/stock/inventory?product=p1", "/stock/products/p1", "/orders/o1", "/stock/entries?in_q=RC-1", "/accounting?tab=journals&j_q=JE-1", "/accounting?tab=analysis"]) {
    assert.equal(mayOpenLink(href, clerk), false, href);
  }
  for (const href of ["/purchasing", "/purchasing?tab=bills&btab=payables", "/purchasing?bill=b1", "/purchasing/suppliers/s1", "/sales", "/sales/customers/c1", "/sales?tab=invoices&invoice=i1", "/sales?tab=invoices&itab=aging", "/accounting?tab=payments", "/accounting?tab=receipts", "/reports/sales-by-product?category=x"]) {
    assert.equal(mayOpenLink(href, clerk), true, href);
  }
});

test("each role's drill-downs follow its page permissions", () => {
  const sales = can("SALES");
  assert.equal(mayOpenLink("/stock/inventory?product=p1", sales), false, "SALES: no stock.view");
  assert.equal(mayOpenLink("/stock/products/p1", sales), false, "SALES: no product profile");
  assert.equal(mayOpenLink("/sales/customers/c1", sales), true);
  assert.equal(mayOpenLink("/orders/o1", sales), true);
  const stock = can("STOCK_CONTROLLER");
  assert.equal(mayOpenLink("/purchasing?po=po1", stock), true, "STOCK_CONTROLLER sees purchase orders");
  // D-2 (Nov 2026): the stock controller reads supplier profiles — but never a supplier's money.
  assert.equal(mayOpenLink("/purchasing?supplier=s1", stock), true, "and the supplier profile (read-only, D-2)");
  assert.equal(mayOpenLink("/purchasing/suppliers/s1", stock), true, "the profile page itself");
  assert.equal(mayOpenLink("/purchasing?tab=bills", stock), false, "but not supplier bills");
  assert.equal(mayOpenLink("/stock/products/p1", stock), true);
  assert.equal(mayOpenLink("/orders/o1", stock), false);
  const buyer = can("PURCHASER");
  assert.equal(mayOpenLink("/purchasing?supplier=s1", buyer), true);
  assert.equal(mayOpenLink("/stock/entries?in_q=RC-1", buyer), false, "PURCHASER: no stock.receive");
  assert.equal(mayOpenLink("/orders/o1", buyer), false);
  const accountant = can("ACCOUNTANT");
  for (const href of ["/accounting?tab=analysis", "/purchasing?tab=bills&btab=payables", "/stock/inventory?tab=valuation", "/management/cash-flow", "/orders/o1"]) assert.equal(mayOpenLink(href, accountant), true, href);
  assert.equal(mayOpenLink("/stock/entries?in_q=RC-1", accountant), false, "ACCOUNTANT: no stock.receive");
  const supervisor = can("SUPERVISOR");
  assert.equal(mayOpenLink("/stock/inventory?tab=valuation", supervisor), true);
  assert.equal(mayOpenLink("/accounting?tab=health", supervisor), false);
  assert.equal(mayOpenLink("/sales?tab=invoices&itab=aging", supervisor), false, "SUPERVISOR: customers but no invoices tab");
  assert.equal(mayOpenLink("/sales?tab=invoices&invoice=i1", supervisor), false, "…nor an invoice");
  assert.equal(mayOpenLink("/sales/customers/c1", supervisor), true);
  for (const route of Object.keys(PAGE_GATES)) assert.equal(mayOpenLink(route.replace(/\[[^\]]+\]/g, "x"), can("SUPER_ADMIN")), true, `SUPER_ADMIN opens ${route}`);
});
