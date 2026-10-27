import { test } from "node:test";
import assert from "node:assert/strict";
import { DICTIONARY } from "@/lib/locale/dictionary";

const entries = Object.entries(DICTIONARY as Record<string, { ar: unknown; en: unknown }>);
const ARABIC = /[؀-ۿ]/;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("every dictionary entry has string Arabic and English text", () => {
  for (const [key, entry] of entries) {
    assert.equal(typeof entry.ar, "string", `${key}.ar`);
    assert.equal(typeof entry.en, "string", `${key}.en`);
    // Empty is allowed only when both sides are deliberately empty (a suffix slot).
    assert.equal((entry.ar as string) === "", (entry.en as string) === "", `${key}: one side is empty`);
  }
});

test("no generated placeholder translations (e.g. \"مورد empty\" / \"Supplier Empty\")", () => {
  for (const [key, entry] of entries) {
    const ar = entry.ar as string;
    assert.ok(!(ARABIC.test(ar) && /[؀-ۿ]+ [a-z]{2,}( [a-z]+)*$/.test(ar)), `${key}: ar looks generated: ${ar}`);
    const tail = key.split(/[.\-_]/).slice(1).join(" ").toLowerCase();
    assert.ok(!(/^[a-z]+( [a-z]+)*$/.test(ar) && tail.includes(ar)), `${key}: ar is the key's own words: ${ar}`);
  }
});

test("Arabic and English use the same {placeholders}, and none uses {{double}} braces", () => {
  for (const [key, entry] of entries) {
    const ar = entry.ar as string;
    const en = entry.en as string;
    assert.ok(!/\{\{/.test(ar) && !/\{\{/.test(en), `${key}: {{ }} is not interpolated`);
    assert.deepEqual(placeholders(en), placeholders(ar), `${key}: placeholder mismatch`);
  }
});

test("keys used through lookup tables exist (import statuses, location types, supplier names)", () => {
  for (const key of [
    "admin.data-import.status.done",
    "admin.data-import.status.failed",
    "admin.data-import.status.exists",
    "admin.data-import.status.opening-stock",
    "admin.data-import.help.names",
    "purchasing.supplier.form.name_ar",
    "admin.toggle-btn.activate",
    "admin.toggle-btn.deactivate",
    "sales.customer.nameAr",
  ]) {
    assert.ok(key in DICTIONARY, key);
  }
  // The duplicate placeholder that used to override this label is gone.
  assert.equal((DICTIONARY as Record<string, { ar: string }>)["sales.customer.nameAr"].ar, "الاسم بالعربي");
});

test("keys built from codes at render time all exist (the integrity script only sees literal keys)", () => {
  const families: Record<string, string[]> = {
    "picking.filter": ["all", "pending", "done", "rejected"],
    "picking.status": ["new", "preparing", "ready_for_loading", "loading"],
    "approvals.tab": ["pending", "all"],
    "approvals.status": ["pending", "approved", "rejected", "cancelled"],
    "approvals.type": ["orders.shortage", "inventory.adjustment", "purchasing.order", "purchasing.bill", "hr.expense", "sales.credit"],
    "attention.reason": ["blocked_approval", "stalled", "delivery_risk", "waiting_to_start", "ready_for_loading", "loading", "on_track"],
    "attention.why": ["blocked_approval", "stalled", "delivery_risk", "waiting_to_start", "ready_for_loading", "loading", "on_track"],
    "attention.action": ["blocked_approval", "stalled", "delivery_risk", "waiting_to_start", "ready_for_loading", "loading", "on_track"],
    "health.reason": ["blocked", "stalled", "delivery-risk"],
    "report.health": ["healthy", "attention", "critical"],
    "printdoc.source": ["n8n", "hermes", "manual", "system", "user"],
    "pricing.delivery": ["pending", "delivered", "partial", "failed"],
    "pricing.credit": ["warning", "pending_approval", "approved", "rejected"],
    "bills.status": ["draft", "pending_approval", "posted", "cancelled"],
    "bills.match": ["matched", "within_tolerance", "variance", "unpriced"],
    "audit.entity": ["sales_invoice", "credit_note", "supplier_bill", "debit_note", "journal_entry", "customer_receipt", "supplier_payment", "order", "purchase_order", "stock_intake", "inventory_document", "approval_request", "employee", "expense", "user", "settings"],
  };
  const dict = DICTIONARY as Record<string, { ar: string; en: string }>;
  const missing = Object.entries(families).flatMap(([prefix, codes]) => codes.map((c) => `${prefix}.${c}`)).filter((k) => !dict[k]?.ar || !dict[k]?.en);
  assert.deepEqual(missing, []);
});
