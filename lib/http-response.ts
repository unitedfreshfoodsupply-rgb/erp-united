import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { NextResponse } from "next/server";

/**
 * JSON for the large and polled GET endpoints (boards, lists, overview).
 *
 * `next start` sends route-handler JSON uncompressed, and the boards poll every 3–5 s with
 * the full payload (docs/erp/PERFORMANCE_AND_COST.md §3.1: ~2.6 MB raw vs ~72 KB gzip per
 * command-center poll at 1,200 orders). Two cheap fixes, no change to freshness:
 *  - a weak ETag + `no-cache`, so the browser revalidates every poll and an unchanged
 *    payload costs a body-less 304 (fetch hands the cached body back to the caller);
 *  - gzip when the client accepts it. A proxy in front never re-compresses a response that
 *    already carries Content-Encoding.
 * `private` + `Vary: Cookie` keep one user's payload out of any shared cache.
 *
 * `etagOf` names what the ETag covers when the payload carries a field that changes on
 * every call without the data changing (a "generated at" stamp); default: the payload.
 */
const MIN_GZIP_BYTES = 1024;

export function jsonResponse(req: Request, data: unknown, init: { status?: number; etagOf?: unknown } = {}): NextResponse {
  const status = init.status ?? 200;
  const body = JSON.stringify(data);
  const tagged = init.etagOf === undefined ? body : JSON.stringify(init.etagOf);
  const etag = `W/"${createHash("sha1").update(tagged).digest("base64url")}"`;
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-cache",
    vary: "Accept-Encoding, Cookie, Authorization, Accept-Language",
    etag,
  });
  if (status === 200 && ifNoneMatch(req.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  if (Buffer.byteLength(body) >= MIN_GZIP_BYTES && acceptsGzip(req.headers.get("accept-encoding"))) {
    headers.set("content-encoding", "gzip");
    return new NextResponse(gzipSync(body), { status, headers });
  }
  return new NextResponse(body, { status, headers });
}

function ifNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v === etag || v.replace(/^W\//, "") === bare;
  });
}

function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (name !== "gzip" && name !== "*") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}
