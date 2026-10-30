import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/http-response";

/**
 * What stock is worth is finance information (stock.valuation.view). Quantities are
 * not. Every stock / inventory response passes through here, so a cost field can
 * never reach someone without that permission by way of an endpoint that simply
 * forgot to strip it — the rule lives in one place, not in each route.
 *
 * Redaction is by field name, deep: cost fields become null. Audit rows that record a
 * change to a cost field keep the fact of the change but lose the old and new values.
 */

const COST_KEYS = new Set(["unitCost", "standardCost", "averageCost", "stockValue", "totalValue", "valuation", "goodUnitCost", "gradeBUnitCost", "wasteUnitCost", "wasteLoss"]);

type Viewer = { permissions?: readonly string[] | Set<string>; can?: (p: never) => boolean } | null | undefined;

export function canSeeCosts(viewer: Viewer): boolean {
  if (!viewer) return false;
  if (typeof viewer.can === "function") return (viewer.can as (p: string) => boolean)("stock.valuation.view");
  const p = viewer.permissions;
  if (!p) return false;
  return p instanceof Set ? p.has("stock.valuation.view") : p.includes("stock.valuation.view");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function redactCosts<T>(data: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isPlainObject(v)) return v; // Decimal, Date, primitives: left as they are
    const out: Record<string, unknown> = {};
    const costChange = typeof v.fieldChanged === "string" && COST_KEYS.has(v.fieldChanged);
    for (const [k, val] of Object.entries(v)) {
      if (COST_KEYS.has(k)) out[k] = null;
      else if (costChange && (k === "oldValue" || k === "newValue")) out[k] = null;
      else out[k] = walk(val);
    }
    return out;
  };
  return walk(data) as T;
}

/** NextResponse.json, with costs removed unless the viewer may see them. */
export function jsonFor(viewer: Viewer, data: unknown, init?: ResponseInit) {
  return NextResponse.json(canSeeCosts(viewer) ? data : redactCosts(data), init);
}

/** jsonFor for the large, polled GET lists: same redaction, then gzip + ETag revalidation. */
export function jsonForGet(req: Request, viewer: Viewer, data: unknown) {
  return jsonResponse(req, canSeeCosts(viewer) ? data : redactCosts(data));
}
