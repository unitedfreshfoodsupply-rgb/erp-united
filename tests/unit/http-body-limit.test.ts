import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { JSON_BODY_LIMIT, readFormLimited, readJson, readJsonLimited, readLimitedBody } from "@/lib/http";
import { localizeServerMessage } from "@/lib/locale/server-messages";

test("request body limits reject oversize streams without relying on Content-Length", async () => {
  const request = new NextRequest("http://localhost/api/admin/data-import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array(11),
  });
  await assert.rejects(readLimitedBody(request, 10), (error: any) => error.status === 413);
});

test("bounded JSON import keeps valid objects and rejects malformed JSON", async () => {
  const valid = new NextRequest("http://localhost/api/admin/data-import", { method: "POST", body: JSON.stringify({ action: "preview" }) });
  assert.deepEqual(await readJsonLimited(valid, 100), { action: "preview" });
  const malformed = new NextRequest("http://localhost/api/admin/data-import", { method: "POST", body: "{" });
  await assert.rejects(readJsonLimited(malformed, 100), (error: any) => error.status === 400);
});

// SEC-3: every JSON route reads through readJson, which now has a streaming cap too.
const streamOf = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ pull(c) { const next = chunks.shift(); if (next) c.enqueue(next); else c.close(); } });
const jsonReq = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body, ...({ duplex: "half" } as object) });

test("readJson refuses a declared Content-Length over the limit with 413, before reading", async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(10)); } });
  await assert.rejects(readJson(jsonReq(body, { "content-length": "5000000" })), (e: any) => e.status === 413 && e.message === "حجم الطلب أكبر من الحد المسموح (4 ميجابايت)");
  assert.ok(pulled <= 1, "the body was not read");
  await assert.rejects(readJson(jsonReq("{}", { "content-length": "20000", "accept-language": "en" }), 16_000), (e: any) => e.status === 413 && e.message === "The request is larger than the allowed size (16 KB)");
  assert.equal(JSON_BODY_LIMIT, 4_000_000);
  // Translated from the Arabic too, unit included (never "4 ميجابايت" inside English).
  assert.equal(localizeServerMessage("حجم الطلب أكبر من الحد المسموح (4 ميجابايت)", "en"), "The request is larger than the allowed size (4 MB)");
  assert.equal(localizeServerMessage("حجم الطلب أكبر من الحد المسموح (16 كيلوبايت)", "en"), "The request is larger than the allowed size (16 KB)");
});

test("readJson stops a body without a Content-Length at the limit", async () => {
  const chunks = Array.from({ length: 5 }, () => new TextEncoder().encode(`{"a":"${"x".repeat(5000)}"`));
  await assert.rejects(readJson(jsonReq(streamOf(chunks)), 16_000), (e: any) => e.status === 413);
});

test("readJson reads what req.json() read: objects, UTF-8 (BOM dropped), Arabic-Indic digits; 400 on bad or empty JSON", async () => {
  assert.deepEqual(await readJson(jsonReq(JSON.stringify({ name: "طماطم", qty: "١٢" }))), { name: "طماطم", qty: "12" });
  assert.deepEqual(await readJson(jsonReq(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]))), { a: 1 });
  const chunked = new TextEncoder().encode(JSON.stringify({ note: "ملاحظة طويلة ".repeat(200) }));
  assert.equal((await readJson(jsonReq(streamOf([chunked.slice(0, 7), chunked.slice(7, 1001), chunked.slice(1001)])))).note, "ملاحظة طويلة ".repeat(200));
  for (const bad of ["{", "", "nope"]) await assert.rejects(readJson(jsonReq(bad)), (e: any) => e.status === 400 && e.message === "جسم الطلب مش JSON صالح", JSON.stringify(bad));
  await assert.rejects(readJson(jsonReq(null)), (e: any) => e.status === 400);
  await assert.rejects(readJson(jsonReq("[1]")), (e: any) => e.status === 400 && e.message === "جسم الطلب لازم يكون كائن JSON");
});

test("readFormLimited: an upload over the limit is refused declared or not; a form within it parses", async () => {
  const form = new FormData();
  form.set("entity_type", "order");
  form.set("file", new File([new Uint8Array(2000)], "scan.pdf", { type: "application/pdf" }));
  const encoded = new Request("http://localhost", { method: "POST", body: form });
  const type = encoded.headers.get("content-type")!;
  const raw = new Uint8Array(await encoded.arrayBuffer());
  const upload = (headers: Record<string, string>, body: BodyInit) => new NextRequest("http://localhost/api/attachments", { method: "POST", headers: { "content-type": type, ...headers }, body, ...({ duplex: "half" } as object) });

  await assert.rejects(readFormLimited(upload({ "content-length": String(raw.length) }, raw), 1000, "الملف أكبر من 1 ميجا", "مش فورم"), (e: any) => e.status === 413 && e.message === "الملف أكبر من 1 ميجا");
  await assert.rejects(readFormLimited(upload({}, streamOf([raw.slice(0, 600), raw.slice(600)])), 1000, "الملف أكبر من 1 ميجا", "مش فورم"), (e: any) => e.status === 413);
  const parsed = await readFormLimited(upload({}, streamOf([raw.slice(0, 600), raw.slice(600)])), 10_000, "x", "مش فورم");
  assert.equal(parsed.get("entity_type"), "order");
  assert.equal((parsed.get("file") as File).size, 2000);
  assert.equal((parsed.get("file") as File).name, "scan.pdf");
  await assert.rejects(readFormLimited(upload({ "content-type": "application/json" }, "{}"), 10_000, "x", "مش فورم"), (e: any) => e.status === 400 && e.message === "مش فورم");
});
