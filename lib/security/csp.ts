/**
 * Content-Security-Policy (WS6). Edge-safe: no Node imports — middleware.ts runs it on
 * every request, and unit tests call it directly.
 *
 * Scripts: a fresh nonce per request plus 'strict-dynamic'. Next.js reads the nonce from
 * the request's CSP header and puts it on every script it emits (its runtime chunks and
 * the inline hydration payload), so nothing inline runs unless the server wrote it in
 * this response. 'self' is listed for older browsers that do not understand
 * 'strict-dynamic' (CSP3 browsers ignore it once a nonce is present).
 *
 * Styles keep 'unsafe-inline': React renders `style="…"` attributes on the server
 * (progress bars, widths) and a nonce cannot cover attributes. Style injection is a far
 * smaller risk than script injection, and every other directive stays strict.
 *
 * Development adds 'unsafe-eval' (React Refresh needs it); production never does.
 */
export function buildContentSecurityPolicy(nonce: string, opts: { dev?: boolean } = {}): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(opts.dev ? ["'unsafe-eval'"] : [])];
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", ...(opts.dev ? ["ws:"] : [])]],
    ["media-src", ["'self'", "blob:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    // Attachments (PDF/images) open in a new tab, never in a frame of this app.
    ["frame-src", ["'self'", "blob:"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/** 128 random bits, base64 — what a CSP nonce should carry. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
