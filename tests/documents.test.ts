/* Document attachments end to end: multipart upload, content sniffing, size limit,
   per-record permissions, idempotent re-upload, download headers, soft delete, audit. */
import { call, login, makeChecker, BASE, cookieFor } from "./_harness";
import { stockUp } from "./_stock";

const { check, section, finish } = makeChecker();
const TAG = `ZZDOC-${Date.now()}`;

const PDF = new TextEncoder().encode(`%PDF-1.4\n% ${TAG}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...new TextEncoder().encode(TAG)]);
const HTML = new TextEncoder().encode(`<html><script>alert("${TAG}")</script></html>`);

async function upload(who: string | null, fields: Record<string, string>, file?: { bytes: Uint8Array; name: string; type?: string }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set("file", new Blob([file.bytes as BlobPart], { type: file.type ?? "application/octet-stream" }), file.name);
  const res = await fetch(BASE + "/api/attachments", {
    method: "POST",
    headers: who ? { cookie: cookieFor(who) } : {},
    body: form,
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

async function download(who: string | null, id: string, inline = false) {
  const res = await fetch(`${BASE}/api/attachments/${id}/download${inline ? "?inline=1" : ""}`, { headers: who ? { cookie: cookieFor(who) } : {} });
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

async function main() {
  for (const u of ["admin", "sara", "ahmed", "hossam"]) await login(u);
  const customer = (await call("admin", "POST", "/api/sales/customers", { name: `${TAG} فندق` })).body.customer;
  const product = (await call("admin", "POST", "/api/stock/products", { name: `${TAG} Mango`, unit: "KG" })).body.product;
  await stockUp(product.id, 5); // a confirmed line must be fully reservable (WF-01)
  const order = (await call("sara", "POST", "/api/orders", {
    customer_account_id: customer.id, customer_name: customer.name,
    delivery_date: "2026-12-03",
    items: [{ stock_product_id: product.id, product_name: product.name, quantity: 5, unit: product.unit }],
  })).body.order;
  const base = { entity_type: "order", entity_id: order.id };

  section("1. UPLOAD");
  let r = await upload("sara", { ...base, category: "delivery_note", description: "إذن تسليم موقّع" }, { bytes: PDF, name: "إذن تسليم.pdf", type: "text/html" });
  check("supervisor uploads a PDF -> 201", r.status === 201 && r.body.duplicate === false, r.body);
  const pdf = r.body.attachment;
  check("type taken from the bytes, not the declared MIME", pdf?.contentType === "application/pdf", pdf);
  check("Arabic display name kept; size and hash recorded", pdf?.fileName === "إذن تسليم.pdf" && pdf?.sizeBytes === PDF.length && /^[0-9a-f]{64}$/.test(pdf?.sha256));
  check("storage key is not exposed", pdf && !("storageKey" in pdf));
  r = await upload("sara", { ...base, category: "delivery_note" }, { bytes: PDF, name: "copy.pdf" });
  check("same file again is idempotent (200, same attachment)", r.status === 200 && r.body.duplicate === true && r.body.attachment.id === pdf.id, r.body);
  r = await upload("sara", { ...base, category: "quality_photo" }, { bytes: PNG, name: "IMG.png" });
  check("photo -> 201", r.status === 201 && r.body.attachment.contentType === "image/png");
  const png = r.body.attachment;

  section("2. REFUSALS");
  check("HTML disguised as a PDF -> 415", (await upload("sara", { ...base }, { bytes: HTML, name: "invoice.pdf", type: "application/pdf" })).status === 415);
  check("SVG -> 415", (await upload("sara", { ...base }, { bytes: new TextEncoder().encode("<svg onload=alert(1)>"), name: "x.svg" })).status === 415);
  check("no file -> 400", (await upload("sara", { ...base })).status === 400);
  check("empty file -> 400", (await upload("sara", { ...base }, { bytes: new Uint8Array(0), name: "e.pdf" })).status === 400);
  check("unknown category -> 400", (await upload("sara", { ...base, category: "meme" }, { bytes: PDF, name: "a.pdf" })).status === 400);
  check("unknown record type -> 400", (await upload("sara", { entity_type: "planet", entity_id: "x" }, { bytes: PDF, name: "a.pdf" })).status === 400);
  check("record that does not exist -> 404", (await upload("sara", { entity_type: "order", entity_id: "nope" }, { bytes: PNG, name: "a.png" })).status === 404);
  check("not multipart -> 400", (await call("sara", "POST", "/api/attachments", { entity_type: "order" })).status === 400);
  const sizeSetting = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((s: any) => s.key === "documents.max_upload_mb");
  await call("admin", "PATCH", "/api/admin/settings/documents.max_upload_mb", { value: 1, reason: TAG, expected_version: sizeSetting.version });
  const big = new Uint8Array(1024 * 1024 + 10);
  big.set(PDF.subarray(0, 8));
  check("over the configured size -> 413", (await upload("sara", { ...base }, { bytes: big, name: "big.pdf" })).status === 413);
  const sizeNow = (await call("admin", "GET", "/api/admin/settings")).body.settings.find((s: any) => s.key === "documents.max_upload_mb");
  await call("admin", "PATCH", "/api/admin/settings/documents.max_upload_mb", { value: null, reason: TAG, expected_version: sizeNow.version });

  section("3. PERMISSIONS FOLLOW THE RECORD");
  check("unauthenticated upload -> 401", (await upload(null, { ...base }, { bytes: PDF, name: "a.pdf" })).status === 401);
  check("preparer (orders.view, no orders.edit) cannot upload -> 403", (await upload("ahmed", { ...base }, { bytes: PNG, name: "p.png" })).status === 403);
  const list = await call("ahmed", "GET", `/api/attachments?entity_type=order&entity_id=${order.id}`);
  check("…but can see the order's documents", list.status === 200 && list.body.attachments.length === 2, list.body);
  check("stock controller (no orders.view) cannot list -> 403", (await call("hossam", "GET", `/api/attachments?entity_type=order&entity_id=${order.id}`)).status === 403);
  check("…nor download -> 403", (await download("hossam", pdf.id)).status === 403);
  check("unauthenticated download -> 401", (await download(null, pdf.id)).status === 401);

  section("4. DOWNLOAD");
  let d = await download("ahmed", pdf.id);
  check("bytes round-trip exactly", d.status === 200 && d.bytes.length === PDF.length && d.bytes.every((b, i) => b === PDF[i]));
  check("served as a download by default", (d.headers.get("content-disposition") ?? "").startsWith("attachment;"));
  check("UTF-8 file name in Content-Disposition", (d.headers.get("content-disposition") ?? "").includes("filename*=UTF-8''" + encodeURIComponent("إذن تسليم.pdf")));
  check("nosniff + sandbox CSP + no-store", d.headers.get("x-content-type-options") === "nosniff" && (d.headers.get("content-security-policy") ?? "").startsWith("sandbox") && (d.headers.get("cache-control") ?? "").includes("no-store"));
  d = await download("ahmed", png.id, true);
  check("images may be shown inline when asked", (d.headers.get("content-disposition") ?? "").startsWith("inline;"));
  check("unknown attachment -> 404", (await download("sara", "nope")).status === 404);

  section("5. SOFT DELETE");
  const del = (who: string, id: string, body: any) => call(who, "DELETE", `/api/attachments/${id}`, body);
  check("preparer cannot delete -> 403", (await del("ahmed", png.id, { reason: "x" })).status === 403);
  check("delete without a reason -> 400", (await del("sara", png.id, {})).status === 400);
  check("supervisor deletes with a reason", (await del("sara", png.id, { reason: "صورة غلط" })).status === 200);
  check("gone from the list", !(await call("sara", "GET", `/api/attachments?entity_type=order&entity_id=${order.id}`)).body.attachments.some((a: any) => a.id === png.id));
  const withDeleted = (await call("sara", "GET", `/api/attachments?entity_type=order&entity_id=${order.id}&include_deleted=1`)).body.attachments.find((a: any) => a.id === png.id);
  check("…but retained with who and why", withDeleted?.deletedBy === "سارة" && withDeleted?.deleteReason === "صورة غلط", withDeleted);
  check("deleted file no longer downloads -> 404", (await download("sara", png.id)).status === 404);
  check("deleting twice -> 404", (await del("sara", png.id, { reason: "x" })).status === 404);
  r = await upload("sara", { ...base, category: "quality_photo" }, { bytes: PNG, name: "IMG.png" });
  check("the same file can be attached again after deletion", r.status === 201 && r.body.attachment.id !== png.id, r.body);

  section("6. AUDIT ON THE ORDER TIMELINE");
  const timeline = (await call("sara", "GET", `/api/audit?orderId=${order.id}`)).body.logs;
  check("upload audited", timeline.some((l: any) => l.action === "attachment_added" && (l.newValue ?? "").includes("إذن تسليم.pdf")));
  check("removal audited with reason", timeline.some((l: any) => l.action === "attachment_removed" && l.reason === "صورة غلط"));
  check("refused uploads left no rows", !timeline.some((l: any) => (l.newValue ?? "").includes("invoice.pdf")));

  finish("DOCUMENTS");
}
main().catch((e) => { console.error("SUITE CRASHED", e); process.exit(2); });
