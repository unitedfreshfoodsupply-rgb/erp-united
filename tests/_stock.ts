/**
 * Scenario setup for the November 2026 rules (remediation WF-01 / CTL-01 / MIG-01 / L2).
 *
 * A confirmed order line must be fully reservable at creation, dispatch is strict, an
 * invoice needs a buyer tax identity, approvals need a different person and cash never
 * goes negative. Suites that are about something else (numbering, RBAC, documents…)
 * still need orders, so they provision the stock the legitimate way first: a normal
 * receipt (POST /api/stock/intakes) by the storekeeper, with a unit cost and no waste.
 * Nothing here bypasses a rule — every helper goes through the public API.
 */
import { call, login, type Res } from "./_harness";
import { todayBiz } from "./_days";

const loggedIn = new Set<string>();
async function ensureLogin(who: string) {
  if (loggedIn.has(who)) return;
  const r = await login(who);
  if (r.status !== 200) throw new Error(`stock setup: login ${who} failed: ${r.status}`);
  loggedIn.add(who);
}

const suppliers = new Map<string, Promise<string>>();
/** One provisioning supplier per process (and per receiving user), so its AP stays apart from the suite's own suppliers. */
function provisioningSupplier(who: string): Promise<string> {
  let p = suppliers.get(who);
  if (!p) {
    p = (async () => {
      const r = await call(who, "POST", "/api/stock/suppliers", { name: `ZZSTOCKSETUP-${process.pid}-${Date.now() % 1_000_000} مورد تجهيز` });
      if (r.status !== 201 && r.status !== 200) throw new Error(`stock setup: supplier: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.supplier.id as string;
    })();
    suppliers.set(who, p);
  }
  return p;
}

export type StockUpOptions = {
  /** Receiving user (needs stock.receive). Default: hossam (storekeeper). */
  who?: string;
  /** Unit cost per base unit. Default "10". */
  unitCost?: string;
  /** Receipt date. Default: today (business calendar). */
  date?: string;
  supplierId?: string;
  warehouseId?: string;
  locationId?: string;
  expiryDate?: string;
};

/**
 * Receives `qty` of a product as sellable stock (no waste, no grade B), the way a
 * storekeeper would. Returns the intake.
 */
export async function stockUp(productId: string, qty: number | string, opts: StockUpOptions = {}) {
  const who = opts.who ?? "hossam";
  await ensureLogin(who);
  const supplierId = opts.supplierId ?? (await provisioningSupplier(who));
  const body: Record<string, unknown> = {
    supplier_id: supplierId,
    product_id: productId,
    received_date: opts.date ?? todayBiz(),
    received_kg: qty,
    unit_cost: opts.unitCost ?? "10",
  };
  if (opts.warehouseId) body.warehouse_id = opts.warehouseId;
  if (opts.locationId) body.location_id = opts.locationId;
  if (opts.expiryDate) body.expiry_date = opts.expiryDate;
  const r = await call(who, "POST", "/api/stock/intakes", body);
  if (r.status !== 201 && r.status !== 200) throw new Error(`stock setup: intake ${productId} x ${qty}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.intake;
}

/** Looks a product card up by exact name (any unit when `unit` is omitted). */
export async function findProduct(name: string, unit?: string, who = "admin") {
  await ensureLogin(who);
  const list = await call(who, "GET", `/api/stock/products?q=${encodeURIComponent(name)}`);
  return (list.body?.products ?? []).find((p: { name: string; unit: string }) => p.name === name && (!unit || p.unit === unit)) ?? null;
}

/**
 * The catalog card for `name` with `qty` of sellable stock received on it — created
 * when missing. Used for integration (n8n) orders, which map lines by product name.
 */
export async function stockedProduct(name: string, qty: number | string, opts: StockUpOptions & { unit?: string; creator?: string } = {}) {
  const creator = opts.creator ?? "admin";
  await ensureLogin(creator);
  const unit = opts.unit ?? "KG";
  let product = await findProduct(name, unit, creator);
  if (!product) {
    const r = await call(creator, "POST", "/api/stock/products", { name, unit });
    product = r.status === 201 || r.status === 200 ? r.body.product : await findProduct(name, unit, creator);
    if (!product) throw new Error(`stock setup: product ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  await stockUp(product.id, qty, opts);
  return product;
}

/** Current value + version of a setting (admin). */
export async function getSetting(key: string) {
  await ensureLogin("admin");
  const r = await call("admin", "GET", "/api/admin/settings");
  return ((r.body?.settings ?? []) as { key: string; value: unknown; version: number; isDefault?: boolean }[]).find((s) => s.key === key);
}

/** PATCH a setting through the audited admin route (value null restores the default). */
export async function setSetting(key: string, value: unknown, reason = "e2e scenario setup") {
  const cur = await getSetting(key);
  return call("admin", "PATCH", `/api/admin/settings/${key}`, { value, reason, expected_version: cur?.version });
}

/** A 9-digit tax registration number, unique enough per run. */
let taxSeq = 0;
export function taxNo(): string {
  // 9 digits: 3 from the process id, 4 from the clock, 2 from a per-process counter —
  // distinct within a run and very unlikely to repeat across runs on one test database.
  const n = ((process.pid % 900) + 100) * 1_000_000 + (Date.now() % 10_000) * 100 + (taxSeq++ % 100);
  return String(n);
}

/** Customer card with a 9-digit tax registration number (MIG-01: invoices need a buyer tax identity). */
export async function taxedCustomer(name: string, who = "mona", extra: Record<string, unknown> = {}) {
  await ensureLogin(who);
  const r = await call(who, "POST", "/api/sales/customers", { name, tax_registration_no: taxNo(), ...extra });
  if (r.status !== 201 && r.status !== 200) throw new Error(`customer setup: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.customer;
}

/** Approves every pending grading-loss request whose entity is one of `entityIds` (as `approver`, not the receiver). */
export async function approveGradingLoss(entityIds: string[], approver = "sara") {
  await ensureLogin(approver);
  const list = ((await call(approver, "GET", "/api/approvals?status=pending")).body?.approvals ?? []) as { id: string; type: string; entityId: string }[];
  const out: Res[] = [];
  for (const a of list.filter((x) => x.type === "inventory.grading_loss" && entityIds.includes(x.entityId))) out.push(await approve(approver, a.id));
  return out;
}

/** Finds the pending approval request of `type` for `entityId` (or whose title contains `titleIncludes`). */
export async function pendingApproval(who: string, type: string, match: { entityId?: string; titleIncludes?: string }) {
  await ensureLogin(who);
  const r = await call(who, "GET", "/api/approvals?status=pending");
  const list = (r.body?.approvals ?? []) as { id: string; type: string; entityId: string; title: string }[];
  return list.find((x) => x.type === type && (match.entityId ? x.entityId === match.entityId : true) && (match.titleIncludes ? (x.title ?? "").includes(match.titleIncludes) : true)) ?? null;
}

/** Approves a pending request as `who` (who must not be the requester). */
export async function approve(who: string, requestId: string, comment = "e2e approval by a different user") {
  await ensureLogin(who);
  return call(who, "POST", `/api/approvals/${requestId}/decide`, { decision: "approve", comment });
}

/**
 * A stock adjustment the CTL-01 way: `who` requests it (202, nothing moves yet) and a
 * different user holding stock.approve_adjustments approves it, which posts it.
 * Returns the request response and the decision (null when the request did not wait).
 */
export async function adjustWithApproval(body: Record<string, unknown>, opts: { who?: string; approver?: string } = {}) {
  const who = opts.who ?? "hossam";
  const approver = opts.approver ?? "sara";
  await ensureLogin(who);
  const request = await call(who, "POST", "/api/stock/adjustments", body);
  if (request.status !== 202) return { request, decision: null as Res | null };
  const pending = await pendingApproval(approver, "inventory.adjustment", { entityId: request.body.document.id });
  if (!pending) throw new Error(`adjustment setup: no pending approval for ${request.body.document.id}`);
  const decision: Res = await approve(approver, pending.id);
  return { request, decision };
}
