import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy, generateNonce } from "@/lib/security/csp";

/**
 * WS6: per-request Content-Security-Policy.
 *
 * The policy is set on the REQUEST (Next.js reads the nonce from it and stamps it on
 * every script it renders) and on the RESPONSE (what the browser enforces). The root
 * layout already reads cookies, so every page is rendered per request and always
 * carries a fresh nonce — no statically prerendered HTML with a stale one.
 *
 * Deliberately nothing else here: no auth, no database (this runs on the edge
 * runtime). Authorization stays in lib/authz.ts on every route and page.
 */
export function middleware(req: NextRequest) {
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy(nonce, { dev: process.env.NODE_ENV !== "production" });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  // An attachment download carries its own, stricter policy (sandbox; default-src 'none'):
  // user-uploaded bytes must never run with the app's script policy. Leave it in charge.
  if (!/^\/api\/attachments\/[^/]+\/download\/?$/.test(req.nextUrl.pathname)) res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  // Static build assets and image optimisation responses carry no HTML: skip them.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|brand/).*)"],
};
