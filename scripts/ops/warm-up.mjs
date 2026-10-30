/**
 * Post-deploy warm-up — read-only, no credentials.
 *
 *   node scripts/ops/warm-up.mjs [baseUrl]        (default http://127.0.0.1:3000)
 *
 * `next start` loads each route's server code on its first request, so the first person
 * to open a screen after a deploy waited ~0.85 s extra (Sprint 0 F-16). This requests
 * every page route of the build once, plus /api/health, before users arrive. The requests
 * carry no session: pages answer with their redirect to /login (which is enough to load
 * them) and nothing is read or written. Dynamic segments ([id]) are skipped.
 *
 * Run from the release directory (it reads .next/server/app-paths-manifest.json).
 * Exits 1 if /api/health does not answer 200.
 */
import { readFileSync } from "node:fs";

const base = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const manifest = JSON.parse(readFileSync(".next/server/app-paths-manifest.json", "utf8"));
const pages = Object.keys(manifest)
  .filter((k) => k.endsWith("/page") && !k.includes("[") && !k.startsWith("/_"))
  .map((k) => k.slice(0, -"/page".length) || "/")
  .sort();

async function hit(path) {
  const t0 = Date.now();
  try {
    const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    await res.arrayBuffer();
    return { path, status: res.status, ms: Date.now() - t0 };
  } catch (err) {
    return { path, status: 0, ms: Date.now() - t0, error: String(err?.cause?.code ?? err?.name ?? err) };
  }
}

const health = await hit("/api/health");
console.log(`health ${health.status} ${health.ms} ms`);
if (health.status !== 200) process.exit(1);

// A few at a time: enough to finish quickly, not enough to load a small VPS.
const results = [];
for (let i = 0; i < pages.length; i += 4) results.push(...(await Promise.all(pages.slice(i, i + 4).map(hit))));
const failed = results.filter((r) => r.status === 0 || r.status >= 500);
for (const r of results) console.log(`${String(r.status).padStart(3)} ${String(r.ms).padStart(5)} ms  ${r.path}${r.error ? "  " + r.error : ""}`);
console.log(`warmed ${results.length - failed.length}/${results.length} pages`);
if (failed.length) process.exitCode = 2;
