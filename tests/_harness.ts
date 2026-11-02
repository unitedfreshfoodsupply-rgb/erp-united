/** Shared plumbing for the end-to-end suites: a cookie-jarred client and a counter. */
import { assertTestServer } from "./_guard";

export const BASE = process.env.BASE ?? "http://localhost:3111";
assertTestServer(BASE);
const jars: Record<string, string> = {};
/** Bearer tokens per user — tab-scoped equivalent for the test harness. */
const tokens: Record<string, string> = {};

export type Res = { status: number; body: any; location?: string | null };

export async function call(
  who: string | null,
  method: string,
  path: string,
  body?: any,
  extra: Record<string, string> = {}
): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  // Bearer token takes precedence (tab-scoped), falling back to cookie (shared).
  // This matches the server's precedence in getSessionUser().
  if (who && tokens[who]) {
    headers.authorization = `Bearer ${tokens[who]}`;
  } else if (who && jars[who]) {
    headers.cookie = jars[who];
  }
  const r = await fetch(BASE + path, {
    method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(45_000),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.get("set-cookie");
  if (who && set) {
    const m = /united_session=([^;]*)/.exec(set);
    if (m) jars[who] = m[0] === "united_session=" ? "" : `united_session=${m[1]}`;
  }
  const t = await r.text();
  let parsed: any = t;
  try { parsed = JSON.parse(t); } catch {}
  // A successful logout ends the tab's credentials, exactly like the browser
  // client: the server clears the cookie and Nav.tsx removes the sessionStorage
  // bearer token. Mirror that here so later calls from this "tab" are anonymous.
  if (who && method === "POST" && path === "/api/auth/logout" && r.status === 200) {
    delete tokens[who];
    jars[who] = "";
  }
  // Extract Bearer token from the login response body if present.
  // The test harness stores it alongside the cookie so a caller can use
  // either credential source.
  if (who && parsed?.token) {
    tokens[who] = parsed.token;
  }
  return { status: r.status, body: parsed, location: r.headers.get("location") };
}

export async function page(who: string | null, path: string) {
  const headers: Record<string, string> = {};
  if (who && tokens[who]) {
    headers.authorization = `Bearer ${tokens[who]}`;
  } else if (who && jars[who]) {
    headers.cookie = jars[who];
  }
  // Retry once after a short pause for transient 50x (DB connection-pool exhaustion
  // under heavy parallel test load — the canonical 24-suite chain can drain the pool).
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(BASE + path, { headers, redirect: "manual", signal: AbortSignal.timeout(45_000) });
    if (r.status < 500 || attempt === 1) return { status: r.status, location: r.headers.get("location"), html: await r.text() };
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return { status: 503, location: null, html: "" };
}

export const cookieFor = (who: string) => jars[who];
export const tokenFor = (who: string) => tokens[who];
export const login = (u: string, p = "1234") => call(u, "POST", "/api/auth/login", { username: u, password: p });

export function makeChecker() {
  const failures: string[] = [];
  let pass = 0;
  // UNITED_TEST_VERBOSE=1 lists every passing check too, so a run can be shown to have
  // actually executed a given assertion (evidence), not merely to have no failures.
  const verbose = process.env.UNITED_TEST_VERBOSE === "1";
  const check = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) {
      pass++;
      if (verbose) console.log(`  PASS  ${name}`);
    } else {
      failures.push(name);
      console.log(`  FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
    }
  };
  const section = (s: string) => console.log(`\n=== ${s} ===`);
  const finish = (suite: string) => {
    console.log(`\n======== ${suite}: ${pass} passed, ${failures.length} failed ========`);
    if (failures.length) console.log("FAILURES:\n" + failures.map((f) => " - " + f).join("\n"));
    process.exit(failures.length ? 1 : 0);
  };
  return { check, section, finish };
}