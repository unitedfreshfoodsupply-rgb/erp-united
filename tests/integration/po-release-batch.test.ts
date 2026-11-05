/* Releasing the purchase requests of a cancelled or closed PO (Nov 2026): each request was locked,
   counted, updated and audited one by one inside the PO's transaction (4–5 statements each). They
   are now locked in the same sequence in one statement and released in a fixed number of
   statements — the same statuses, versions and audit rows. (Each order's suggestion re-size that
   follows is unchanged; these requests serve no order.) */
import { countQueries } from "./_query-count";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, inTx, actor, withSetting } from "./_db";
import type { Tx } from "@/lib/tx";
import { todayLocalISO } from "@/lib/localDate";
import { nextDocumentNumber } from "@/lib/core/sequences";
import { createPurchaseOrder, releasePoCoverage } from "@/lib/purchasing/orders";

const TAG = `ZZPOR${Date.now()}`;
const today = todayLocalISO();
const buyer = actor("مشتريات", ["purchasing.orders.manage", "purchasing.prices.manage"], null, "BUYER");
let restore: (() => Promise<void>) | undefined;
let supplierId = "";
const products: string[] = [];

before(async () => {
  restore = await withSetting("purchasing.po_approval_threshold", 100000000);
  supplierId = (await prisma.supplier.create({ data: { code: `SUP-5${String(Date.now()).slice(-6)}1`, name: `${TAG} مورد`, category: "vegetable", paymentTermsDays: 0 } })).id;
  for (let i = 0; i < 40; i++) products.push((await prisma.stockProduct.create({ data: { name: `${TAG} صنف ${i}`, unit: "KG" } })).id);
});
after(async () => { await restore?.(); await prisma.$disconnect(); });

class Rollback extends Error {}
async function rolledBack(fn: (tx: Tx) => Promise<void>) {
  await assert.rejects(inTx(async (tx) => { await fn(tx); throw new Rollback(); }), (e) => { if (e instanceof Rollback) return true; throw e; });
}

test("a PO's requests are released in a fixed number of statements: 5 vs 40", async () => {
  async function measure(n: number) {
    const po = await createPurchaseOrder({ supplier_id: supplierId, lines: products.slice(0, n).map((p) => ({ product_id: p, quantity: 5, unit_price: "3" })) }, buyer as never);
    const lines = await prisma.purchaseOrderLine.findMany({ where: { poId: po.id }, orderBy: { lineNo: "asc" } });
    let queries = 0;
    await rolledBack(async (tx) => {
      for (const l of lines) {
        await tx.purchaseRequest.create({ data: { number: await nextDocumentNumber(tx, "purchasing.request", today), productId: l.productId, uomCode: "KG", quantity: 5, status: "ordered", purchaseOrderId: po.id, purchaseOrderLineId: l.id, requestedBy: "test", decidedBy: "approver", decidedAt: new Date() } });
      }
      const fresh = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
      queries = (await countQueries(() => releasePoCoverage(tx, fresh, "cancelled", `${TAG} المورد اعتذر`, buyer))).queries;
      const rows = await tx.purchaseRequest.findMany({ where: { productId: { in: lines.map((l) => l.productId) }, requestedBy: "test" } });
      assert.equal(rows.length, n);
      assert.ok(rows.every((r) => r.status === "approved" && r.purchaseOrderId === null && r.purchaseOrderLineId === null && r.version === 2), "every request back to approved, unlinked, one version up");
      const audits = await tx.auditLog.findMany({ where: { entityType: "purchase_request", entityId: { in: rows.map((r) => r.id) } } });
      assert.equal(audits.length, n);
      assert.ok(audits.every((a) => a.action === "purchase_request_reopened" && a.reason === `${TAG} المورد اعتذر` && a.newValue?.endsWith(`approved · ${fresh.number}`)));
    });
    return queries;
  }
  const small = await measure(5), large = await measure(40);
  assert.equal(large, small, `5 requests ${small}, 40 requests ${large}`);
});
