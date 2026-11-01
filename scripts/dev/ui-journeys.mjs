/**
 * Browser journeys — click through the real UI the way an employee does, against a LOCAL
 * server on a disposable database (it creates one customer).
 *
 *   BASE=http://localhost:3111 node scripts/dev/ui-journeys.mjs
 *
 * Needs Playwright (not a project dependency; available in the development container).
 * Every step records pass/fail; console errors and failed requests on any page fail the run.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const BASE = process.env.BASE ?? "http://localhost:3111";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("refused: local server only");

const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push([true, name]); } catch (e) { results.push([false, `${name} — ${String(e.message ?? e).split("\n")[0].slice(0, 200)}`]); }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

async function signIn(ctx, user) {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await p.locator('input[autocomplete="username"]').fill(user);
  await p.locator('input[autocomplete="current-password"]').fill("1234");
  // The form goes to "/", which the server redirects to the role's landing page.
  await Promise.all([p.waitForURL((u) => !["/login", "/"].includes(u.pathname), { timeout: 20000 }), p.locator('button[type="submit"]').click()]);
  await p.waitForLoadState("networkidle");
  return p;
}

const browser = await chromium.launch();
const errors = [];
const watch = (p) => {
  p.on("pageerror", (e) => errors.push(`pageerror ${p.url()}: ${e}`));
  p.on("console", (m) => { if (m.type() === "error") errors.push(`console ${p.url()}: ${m.text().slice(0, 160)}`); });
  p.on("response", (r) => { if (r.status() >= 500 && r.url().startsWith(BASE)) errors.push(`${r.status()} ${r.url()}`); });
};

// --- Desk: administrator --------------------------------------------------------------
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { try { localStorage.setItem("united_locale", "ar"); } catch {} });
let p;
await step("J1 admin signs in through the form and lands on Home", async () => {
  p = await signIn(ctx, "admin"); watch(p);
  expect(new URL(p.url()).pathname === "/home", `landed on ${p.url()}`);
  await p.getByRole("heading", { level: 1 }).waitFor();
  expect((await p.getByRole("heading", { level: 1 }).innerText()).includes("أهلاً"), "no greeting");
});
await step("J2 sidebar link opens the module and marks it current", async () => {
  await p.locator('aside nav a[href="/sales"]').click(); await p.waitForURL("**/sales"); await p.waitForLoadState("networkidle");
  expect(await p.locator('aside nav a[href="/sales"][aria-current="page"]').count() === 1, "not marked current");
});
await step("J3 sidebar folds to an icon rail, survives a reload, and unfolds", async () => {
  await p.locator("aside button[aria-pressed]").click();
  expect(await p.evaluate(() => document.documentElement.dataset.rail) === "1", "rail not applied");
  await p.reload({ waitUntil: "networkidle" });
  expect(await p.evaluate(() => document.documentElement.dataset.rail) === "1", "rail lost on reload");
  expect(await p.locator('aside nav a[href="/sales"][aria-label]').count() === 1, "rail link has no accessible name");
  await p.locator("aside button[aria-pressed]").click();
  expect(await p.evaluate(() => document.documentElement.dataset.rail) === "0", "rail not removed");
});
await step("J4 a sidebar group folds and unfolds", async () => {
  const header = p.locator("aside nav section button[aria-expanded]").first();
  await header.click(); expect(await header.getAttribute("aria-expanded") === "false", "did not fold");
  await header.click(); expect(await header.getAttribute("aria-expanded") === "true", "did not unfold");
});
await step("J5 language switch turns the page English and LTR, and back", async () => {
  await p.getByRole("button", { name: /English/ }).first().click(); await p.waitForTimeout(300);
  expect(await p.evaluate(() => document.documentElement.dir) === "ltr", "not LTR");
  expect(await p.locator('aside nav a[href="/sales"]').innerText() === "Customers", "label not English");
  await p.getByRole("button", { name: /العربية/ }).first().click(); await p.waitForTimeout(300);
  expect(await p.evaluate(() => document.documentElement.dir) === "rtl", "not back to RTL");
});
await step("J6 account menu opens the read-only profile", async () => {
  await p.locator('header button[aria-haspopup="menu"], header button[aria-expanded]').last().click();
  await p.locator('a[href="/profile"]').first().click(); await p.waitForURL("**/profile"); await p.waitForLoadState("networkidle");
  expect(await p.getByText("للاطلاع فقط").count() > 0, "read-only notice missing");
  expect(await p.locator("input:not([type=hidden])").count() === 0, "profile exposes an editable field");
});
await step("J7 users list: More menu opens and Esc closes it; Suspend asks first and Cancel keeps the user active", async () => {
  await p.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  const row = p.locator("li", { hasText: "@mona" });
  await row.locator('button[aria-haspopup="menu"]').click();
  expect(await p.getByRole("menu").count() === 1, "menu did not open");
  await p.keyboard.press("Escape"); expect(await p.getByRole("menu").count() === 0, "Esc did not close");
  await row.locator('button[aria-haspopup="menu"]').click();
  await p.getByRole("menuitem", { name: "إيقاف" }).click();
  const dialog = p.getByRole("dialog"); await dialog.waitFor();
  await dialog.getByRole("button", { name: /إلغاء|رجوع|لا/ }).first().click();
  await p.waitForTimeout(300);
  expect(await row.getByText("موقوف").count() === 0, "user was suspended");
});
await step("J8 new customer: the form creates it and opens its card", async () => {
  await p.goto(`${BASE}/sales`, { waitUntil: "networkidle" });
  await p.getByRole("tab", { name: /عميل جديد/ }).click();
  const name = `Journey Café ${Date.now() % 100000}`;
  await p.getByLabel("الاسم", { exact: true }).fill(name);
  await p.locator("form button[type=submit], section button.btn-primary").last().click();
  await p.getByText(name).first().waitFor({ timeout: 10000 });
});
await step("J9 management overview: Show as table swaps the chart for its table", async () => {
  await p.goto(`${BASE}/management/overview`, { waitUntil: "networkidle" });
  const card = p.locator("section.viz").first();
  await card.getByRole("button", { pressed: false }).click();
  expect(await card.locator("table").count() === 1, "no table");
  await card.getByRole("button", { pressed: true }).click();
  await card.locator("svg[role=img]").waitFor({ timeout: 5000 }); // the chart measures its width, then draws
  expect(await card.locator("svg[role=img]").count() === 1, "chart not back");
});
await step("J10 home: an action row leads to the screen that holds its records", async () => {
  await p.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  const link = p.locator('section[aria-labelledby="home-actions"] a').first();
  if (await link.count()) {
    const href = await link.getAttribute("href");
    await link.click(); await p.waitForURL(`**${href}`); await p.waitForLoadState("networkidle");
  }
});
await step("J13 accounting: every finance tab opens (cash & banks, chart, cost centers, VAT, periods, opening)", async () => {
  await p.goto(`${BASE}/accounting`, { waitUntil: "networkidle" });
  for (const name of ["الخزائن والبنوك", "دليل الحسابات", "مراكز التكلفة", "ملخص الضريبة", "الفترات", "الأرصدة الافتتاحية"]) {
    const tab = p.getByRole("tab", { name: new RegExp(name) });
    if (!(await tab.count())) throw new Error(`no tab ${name}`);
    await tab.first().click(); await p.waitForLoadState("networkidle");
    expect(await p.locator(".page-container").innerText().then((x) => x.length > 50), `${name} rendered nothing`);
  }
});
await step("J14 cash & banks: add a bank account through the form", async () => {
  await p.goto(`${BASE}/accounting?tab=treasury`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: /إضافة خزينة أو بنك/ }).click();
  const name = `Journey Bank ${Date.now() % 100000}`;
  await p.getByLabel("الاسم بالعربي").first().fill(name);
  await p.getByLabel("الاسم بالإنجليزي").first().fill(name);
  await p.locator("form").getByRole("button", { name: /إضافة خزينة أو بنك/ }).click();
  await p.getByText(name).first().waitFor({ timeout: 10000 });
});
await step("J15 fixed assets: the register, categories, depreciation and reports tabs open", async () => {
  await p.goto(`${BASE}/assets`, { waitUntil: "networkidle" });
  await p.getByRole("heading", { level: 1, name: /الأصول الثابتة/ }).waitFor();
  for (const name of ["الفئات", "الإهلاك الشهري", "التقارير", "سجل الأصول"]) { await p.getByRole("tab", { name }).click(); await p.waitForLoadState("networkidle"); }
});
await step("J16 the new finance screens in English, left to right, with no Arabic labels leaking", async () => {
  // The context's init script sets Arabic on every page load, so switch after each navigation.
  const english = async () => { await p.getByRole("button", { name: /English/ }).first().click(); await p.waitForTimeout(300); };
  await p.goto(`${BASE}/assets`, { waitUntil: "networkidle" }); await english();
  expect(await p.evaluate(() => document.documentElement.dir) === "ltr", "not LTR");
  expect((await p.getByRole("heading", { level: 1 }).innerText()).includes("Fixed assets"), "assets title not English");
  await p.goto(`${BASE}/accounting?tab=periods`, { waitUntil: "networkidle" }); await english();
  const text = await p.locator(".page-container").innerText();
  expect(/Fiscal years/.test(text) && !/السنوات المالية/.test(text), "periods tab not English");
  await p.getByRole("button", { name: /العربية/ }).first().click(); await p.waitForTimeout(300);
});
await step("J18 comparatives & ratios: the ratio table and both statements render, in Arabic and English", async () => {
  await p.goto(`${BASE}/accounting?tab=analysis`, { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: /النسب المالية/ }).waitFor({ timeout: 15000 });
  expect(await p.getByText("نسبة التداول").count() > 0, "current ratio row missing");
  await p.getByRole("heading", { name: /قائمة الدخل المقارنة/ }).waitFor();
  await p.getByRole("button", { name: /English/ }).first().click(); await p.waitForTimeout(400);
  const text = await p.locator(".page-container").innerText();
  expect(/Financial ratios/.test(text) && /Current ratio/.test(text) && !/النسب المالية/.test(text), "comparatives not English");
  await p.getByRole("button", { name: /العربية/ }).first().click(); await p.waitForTimeout(300);
});
await step("J19 bank reconciliation: start or resume one, the statement-import box is there", async () => {
  await p.goto(`${BASE}/accounting?tab=reconcile`, { waitUntil: "networkidle" });
  const resume = p.getByRole("button", { name: /كمّل/ });
  if (await resume.count()) await resume.first().click();
  else { await p.getByLabel("رصيد الكشف").first().fill("0"); await p.getByRole("button", { name: /ابدأ التسوية/ }).first().click(); }
  await p.getByRole("heading", { name: /استيراد كشف الحساب/ }).waitFor({ timeout: 15000 });
  await p.getByRole("textbox", { name: /استيراد كشف الحساب/ }).fill("2026-01-01,1.00,x");
  await p.getByRole("button", { name: /عاين المطابقة/ }).click();
  await p.getByRole("status").filter({ hasText: /سطر في الكشف/ }).first().waitFor({ timeout: 10000 });
});
await step("J20 fixed assets: the physical-count tab and the run-reversal column render", async () => {
  await p.goto(`${BASE}/assets`, { waitUntil: "networkidle" });
  await p.getByRole("tab", { name: "الجرد" }).click(); await p.waitForLoadState("networkidle");
  expect(await p.locator(".page-container").innerText().then((x) => /علّم كل أصل اتلاقى/.test(x)), "count tab empty");
  await p.getByRole("tab", { name: "الإهلاك الشهري" }).click(); await p.waitForLoadState("networkidle");
  await p.getByRole("heading", { name: "قيود الإهلاك" }).first().waitFor();
});
await ctx.close();

// --- Tablet: finance screens fit without sideways scrolling ------------------------------
const tab = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
await tab.addInitScript(() => { try { localStorage.setItem("united_locale", "ar"); } catch {} });
await step("J17 tablet: cash & banks, assets and opening batch fit the screen", async () => {
  const q = await signIn(tab, "admin"); watch(q);
  for (const path of ["/accounting?tab=treasury", "/assets", "/accounting?tab=opening", "/accounting?tab=costcenters"]) {
    await q.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    expect(await q.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `horizontal overflow on ${path}`);
  }
});
await tab.close();

// --- Floor: preparer on a phone ---------------------------------------------------------
const floor = await browser.newContext({ ...devices["Pixel 7"] });
await floor.addInitScript(() => { try { localStorage.setItem("united_locale", "ar"); } catch {} });
await step("J11 preparer signs in on a phone, lands on Preparation with tabs (no sidebar)", async () => {
  const q = await signIn(floor, "ahmed"); watch(q);
  expect(new URL(q.url()).pathname === "/prep", `landed on ${q.url()}`);
  expect(await q.locator("aside.u-shell-sidebar").count() === 0, "floor role got the sidebar");
  expect(await q.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "horizontal overflow");
});
await step("J12 preparer opening Home sees an access-denied page, not the dashboard", async () => {
  const q = floor.pages()[0];
  const r = await q.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  expect(r.status() === 200, `status ${r.status()}`);
  expect(await q.locator('section[aria-labelledby="home-actions"]').count() === 0, "dashboard rendered for a floor role");
});
await floor.close();
await browser.close();

for (const [ok, name] of results) console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
for (const e of errors) console.log(`  ERR  ${e}`);
const failed = results.filter(([ok]) => !ok).length + errors.length;
console.log(`======== UI JOURNEYS: ${results.length - results.filter(([ok]) => !ok).length} passed, ${failed} failed ========`);
process.exit(failed ? 1 : 0);
