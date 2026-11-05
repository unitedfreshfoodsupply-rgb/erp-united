import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DOC_STATUS_TONE, docTone, requestTone } from "@/components/ui/StatusPill";
import { STATUS_LABEL, STATUS_LABEL_EN } from "@/lib/orderPresentation";
import { DICTIONARY } from "@/lib/locale/dictionary";
import { ORDER_STATUSES } from "@/lib/types";
import { localizeServerMessage } from "@/lib/locale/server-messages";
import { previewRows } from "@/components/admin/DataImportPanel";

test("docTone: one tone per shared document state; a screen's extra states never override it", () => {
  assert.equal(docTone("draft"), "neutral");
  assert.equal(docTone("cancelled"), "neutral");
  assert.equal(docTone("reversed"), "neutral");
  assert.equal(docTone("pending_approval"), "warn");
  assert.equal(docTone("approved"), "info");
  assert.equal(docTone("posted"), "success");
  assert.equal(docTone("rejected"), "danger");
  // A local map can add its own states but cannot recolour a shared one.
  assert.equal(docTone("draft", { draft: "warn", in_service: "success" }), "neutral");
  assert.equal(docTone("in_service", { in_service: "success" }), "success");
  assert.equal(docTone("something_new"), "neutral");
  assert.equal(docTone(null), "neutral");
});

test("requestTone: a decided request's approval is its outcome (success), not a step (info)", () => {
  assert.equal(requestTone("pending"), "warn");
  assert.equal(requestTone("pending_approval"), "warn");
  assert.equal(requestTone("approved"), "success");
  assert.equal(requestTone("rejected"), "danger");
  assert.equal(requestTone("cancelled"), "neutral");
  assert.equal(requestTone("superseded"), "neutral");
  assert.equal(requestTone("approved", { approved: "info" }), "success");
  assert.equal(requestTone(undefined), "neutral");
});

test("order stage names come from the dictionary, so every screen uses the same words", () => {
  for (const s of ORDER_STATUSES) {
    const entry = DICTIONARY[`orders.status.${s}`];
    assert.equal(STATUS_LABEL[s], entry.ar, s);
    assert.equal(STATUS_LABEL_EN[s], entry.en, s);
  }
  // The stage name inside a server refusal still translates to English.
  for (const current of ["new", "dispatched", "cancelled"] as const) {
    const msg = `مينفعش تسجّل كمية تجهيز — الأوردر مش في مرحلة "${STATUS_LABEL.preparing}" دلوقتي (الحالة الحالية: ${STATUS_LABEL[current]})`;
    assert.ok(localizeServerMessage(msg, "en").endsWith(`the order is not in the "Preparing" stage now (current status: ${STATUS_LABEL_EN[current]})`), localizeServerMessage(msg, "en"));
  }
});

const row = (n: number, bad: boolean) => ({ rowNumber: n, label: `R${n}`, errors: bad ? ["x"] : [] });

test("data-import preview: every error row is shown, wherever it is in the file", () => {
  const rows = Array.from({ length: 150 }, (_, i) => row(i + 2, [60, 90, 140].includes(i + 2)));
  const shown = previewRows({ rows });
  assert.equal(shown.length, 50);
  assert.deepEqual(shown.slice(0, 3).map((r) => r.rowNumber), [60, 90, 140]);
  // The ready rows that follow keep their file order.
  assert.deepEqual(shown.slice(3, 6).map((r) => r.rowNumber), [2, 3, 4]);

  const many = Array.from({ length: 207 }, (_, i) => row(i + 2, i % 3 === 0));
  const errors = many.filter((r) => r.errors.length).length;
  assert.ok(errors > 50);
  const all = previewRows({ rows: many });
  assert.equal(all.length, errors);
  assert.ok(all.every((r) => r.errors.length));

  // A file that fits in the table keeps its file order.
  const small = [row(2, false), row(3, true)];
  assert.deepEqual(previewRows({ rows: small }).map((r) => r.rowNumber), [2, 3]);
  const fifty = Array.from({ length: 50 }, (_, i) => row(i + 2, i === 40));
  assert.deepEqual(previewRows({ rows: fifty }).map((r) => r.rowNumber), fifty.map((r) => r.rowNumber));
});

// Screens migrated to the shared vocabulary keep using it: no hardcoded Tailwind palette
// colours, no undefined `.input` class and no sub-AA status tints in these modules.
function tsx(dir: string, acc: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) tsx(p, acc);
    else if (f.endsWith(".tsx")) acc.push(p);
  }
  return acc;
}

test("hr, admin, operations, assets and security screens use the kit's status colours", () => {
  const offenders: string[] = [];
  for (const dir of ["hr", "admin", "operations", "assets", "security"]) {
    for (const file of tsx(path.join("components", dir))) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/\b(bg|text|border)-(blue|red|green|amber|yellow|orange|purple)-\d{2,3}\b/.test(line) || /className="input\b/.test(line)) offenders.push(`${file}:${i + 1}`);
        // Tinted text on its own light tint below 4.5:1: warn on warn/10 (4.39) or /15 (4.08),
        // green on green/15 (4.24). Use the pill fills (#FDF3E2, #E7F3EA) instead.
        if ((/\bbg-united-warn\/(10|15)\b/.test(line) && /\btext-united-warn(?!\/)\b/.test(line)) || (/\bbg-united-green\/15\b/.test(line) && /\btext-united-green(?!\/)\b/.test(line))) offenders.push(`${file}:${i + 1} (sub-AA tint)`);
      });
    }
  }
  assert.deepEqual(offenders, []);
  assert.ok(Object.keys(DOC_STATUS_TONE).length > 20);
});
