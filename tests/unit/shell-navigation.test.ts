/* Shell (Nov 2026): the page a visitor returns to after signing in, the shell shape remembered at
   sign-in, and report status codes in words. Pure helpers, no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { returnPath } from "@/lib/hooks/urlQuery";
import { shellShapeFor } from "@/lib/hooks/shellHint";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { codedText } from "@/lib/reports/labels";
import { reportCsv } from "@/lib/reports/engine";

const ORIGIN = "http://localhost:3705";

test("sign-in returns only to a page of this app", () => {
  assert.equal(returnPath("/orders/abc", ORIGIN), "/orders/abc");
  assert.equal(returnPath("/accounting?tab=health#x", ORIGIN), "/accounting?tab=health#x");
  for (const bad of [null, "", "orders", "//evil.example/x", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "/login", "/login?next=/x", "/mfa/setup"]) {
    assert.equal(returnPath(bad, ORIGIN), null, String(bad));
  }
});

test("the shell shape follows the permissions, as Nav decides it", () => {
  assert.equal(shellShapeFor(ROLE_PERMISSIONS.SUPER_ADMIN), "grouped");
  assert.equal(shellShapeFor(ROLE_PERMISSIONS.ACCOUNTANT), "grouped");
  assert.equal(shellShapeFor(ROLE_PERMISSIONS.PREPARER), "tabs");
  assert.equal(shellShapeFor(ROLE_PERMISSIONS.LOADER), "tabs");
  assert.equal(shellShapeFor([]), "tabs");
});

test("a coded report column reads as words on screen and in both exports", () => {
  const col = { labels: "orders.status" };
  assert.equal(codedText(col, "ready_for_loading", "ar"), "جاهز للتحميل");
  assert.equal(codedText(col, "ready_for_loading", "en"), "Ready for Loading");
  assert.equal(codedText(col, "no_such_status", "en"), null, "an unknown code is shown as stored");
  assert.equal(codedText({}, "new", "en"), null, "a plain text column is not touched");

  const ran = {
    key: "delayed-orders", title: { ar: "أوردرات متأخرة", en: "Delayed orders" }, params: { from: "2026-11-01", to: "2026-11-06" }, scope: null, totals: {},
    columns: [{ key: "number", label: { ar: "الأوردر", en: "Order" }, type: "code" }, { key: "status", label: { ar: "الحالة", en: "Status" }, type: "text", labels: "orders.status" }],
    rows: [{ number: "ORD-1", status: "preparing" }, { number: "ORD-2", status: "new" }],
  } as unknown as Parameters<typeof reportCsv>[0];
  assert.match(reportCsv(ran, "ar"), /ORD-1,جاري التجهيز\r\nORD-2,جديد/);
  assert.match(reportCsv(ran, "en"), /ORD-1,Preparing\r\nORD-2,New/);
});
