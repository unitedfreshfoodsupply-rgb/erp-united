import { NextResponse } from "next/server";
import { probeDatabase, DB_PROBE_TIMEOUT_MS } from "@/lib/security/health";

/**
 * Liveness/readiness probe for whatever keeps this long-lived Node server up
 * (a process supervisor, a reverse proxy's upstream check, an uptime monitor).
 *
 * No auth: a health check has to work before anyone can sign in. It answers with
 * `{ status }` only — no version, no timings, no error text — so it tells an outsider
 * nothing beyond up/down. It does test the database (a single trivial query, raced
 * against a 2-second timeout: a hung pooler must read as down, not as a probe that
 * never answers). The session pooler has a small connection budget (see .env), so the
 * probe stays this cheap. The detailed view is /api/health/deep (administrators).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await probeDatabase(DB_PROBE_TIMEOUT_MS);
  if (db.ok) return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  // Log the category only — a driver error can carry the connection string's host.
  console.error(`[health] database check failed (${db.reason})`);
  return NextResponse.json({ status: "error" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
