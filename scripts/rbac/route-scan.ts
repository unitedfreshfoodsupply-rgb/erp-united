/**
 * Reads every API route handler and extracts the permission it is gated on — from the
 * source, so the RBAC matrix and the security suite describe the code as it is, not
 * as someone remembers it. A handler whose gate cannot be read is reported as such
 * (never silently treated as open or closed).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type Gate =
  | { kind: "public" }
  | { kind: "authenticated" } // signed in; finer checks in the service
  | { kind: "all"; permissions: string[] } // every listed permission
  | { kind: "any"; permissions: string[] } // at least one
  | { kind: "per-field" } // PATCH /api/admin/users/[id]: each field its own permission
  | { kind: "per-import-kind"; basePermission: string; permissions: string[] } // admin data importer selects the exact permission from its validated kind
  | { kind: "api-key-or"; permissions: string[] }
  | { kind: "api-key"; scope: string }; // integration channels only (no user session path)

export type RouteHandler = { path: string; method: string; gate: Gate; file: string };

const PUBLIC = new Set(["/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/health", "/api/auth/password"]);

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

const list = (raw: string) => [...raw.matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]);

export function scanRoutes(root = process.cwd()): RouteHandler[] {
  const apiDir = join(root, "app", "api");
  const out: RouteHandler[] = [];
  for (const file of walk(apiDir).sort()) {
    const src = readFileSync(file, "utf8");
    const path = "/" + relative(join(root, "app"), file).split(sep).slice(0, -1).join("/");
    const parts = src.split(/export (?:async function|const) (GET|POST|PATCH|PUT|DELETE)\b/);
    for (let i = 1; i < parts.length; i += 2) {
      const method = parts[i];
      const body = parts[i + 1];
      let gate: Gate;
      const all = [...body.matchAll(/(requirePermission|requireStockActor|requireServiceActor|requireOrderActor|postHandler)\(\s*(?:req\s*,\s*)?(\[[^\]]*\]|"[^"]*")/g)];
      const any = /requireAnyPermission\(\s*req\s*,\s*(\[[^\]]*\])/.exec(body) ?? /\banyOf\(\s*(\[[^\]]*\])/.exec(body);
      if (PUBLIC.has(path)) gate = { kind: "public" };
      else if (path === "/api/admin/users/[id]" && method === "PATCH") gate = { kind: "per-field" };
      else if (path === "/api/admin/data-import") gate = { kind: "per-import-kind", basePermission: "users.view", permissions: ["accounting.manage", "purchasing.prices.manage", "purchasing.suppliers.manage", "sales.credit.manage", "sales.customers.manage", "sales.pricing.manage", "sales.tax.manage", "stock.manage_products"] };
      // One order's timeline needs orders.view; the whole log needs audit.view. The
      // matrix records the stricter, unscoped form (what a bare call needs).
      else if (path === "/api/audit" && method === "GET") gate = { kind: "all", permissions: ["audit.view"] };
      else if (/requireOrderCreateActor\(/.test(body)) gate = { kind: "api-key-or", permissions: ["orders.create"] };
      else if (/loggedIntegrationCall\(/.test(body)) gate = { kind: "api-key", scope: /requireScope\(\s*caller\s*,\s*"([^"]+)"/.exec(body)?.[1] ?? "?" };
      else if (any) gate = { kind: "any", permissions: list(any[1]) };
      else if (all.length) gate = { kind: "all", permissions: [...new Set(all.flatMap((m) => list(m[2])))] };
      else if (/requireAuth\(/.test(body)) gate = { kind: "authenticated" };
      else throw new Error(`route-scan: cannot read the gate of ${method} ${path}`);
      out.push({ path, method, gate, file: relative(root, file) });
    }
  }
  return out;
}

export function allowed(gate: Gate, held: Set<string>): boolean | null {
  switch (gate.kind) {
    case "public":
    case "per-field":
    case "per-import-kind":
    case "api-key": // a user session never reaches it; tested with keys in the integrations suite
      return null;
    case "authenticated":
      return true;
    case "all":
      return gate.permissions.every((p) => held.has(p));
    case "any":
    case "api-key-or":
      return gate.permissions.some((p) => held.has(p));
  }
}
