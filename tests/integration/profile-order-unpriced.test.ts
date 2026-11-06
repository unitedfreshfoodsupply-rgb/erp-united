/* ORD-08: on a customer's orders list, an order none of whose lines is priced yet is marked
   unpriced (the screen says so instead of 0.00); a partly priced one keeps its value. The
   amount itself is unchanged (still orderValue's total). Synthetic data on the test database. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor, taxNo } from "./_db";
import { createCustomer } from "@/lib/sales/customers";
import { profileSection } from "@/lib/profiles/service";

const TAG = `ZZUNP${Date.now()}`;
const day = `2099-11-${String(1 + (Date.now() % 28)).padStart(2, "0")}`;
const acct = actor("محاسب", ["sales.customers.manage"]);
after(() => prisma.$disconnect());

test("an order with no priced line is flagged unpriced; priced and partly priced ones are not", async () => {
  const customerId = (await createCustomer({ name: `${TAG} Customer`, tax_registration_no: taxNo() }, acct as never)).id;
  const make = async (lines: number, priced: number) => {
    const o = await prisma.order.create({
      data: { orderNumber: `${TAG}-${lines}-${priced}`, customerName: TAG, customerAccountId: customerId, deliveryDate: day, items: { create: Array.from({ length: lines }, (_, i) => ({ productName: `${TAG} ${i}`, unit: "KG", requiredQuantity: 2 })) } },
      include: { items: true },
    });
    for (const it of o.items.slice(0, priced)) await prisma.orderItemPrice.create({ data: { orderItemId: it.id, unitPrice: "10", discountPct: "0", taxCode: "EX", taxRate: "0", source: "manual", reason: TAG, setBy: TAG } });
    return o.id;
  };
  const full = await make(2, 2), part = await make(2, 1), none = await make(2, 0);
  const rows = ((await profileSection("customer", customerId, "orders", () => true, { limit: 50 })) as { rows: { id: string; amount: string | null; unpriced?: boolean }[] }).rows;
  const by = (id: string) => rows.find((r) => r.id === id)!;
  assert.deepEqual([by(full).amount, by(full).unpriced], ["40.00", undefined]);
  assert.deepEqual([by(part).amount, by(part).unpriced], ["20.00", undefined]);
  assert.deepEqual([by(none).amount, by(none).unpriced], ["0.00", true]);
  // Without the price permission there is no amount and no flag either.
  const blind = ((await profileSection("customer", customerId, "orders", (p) => p !== "sales.pricing.view", { limit: 50 })) as { rows: { amount: string | null; unpriced?: boolean }[] }).rows;
  assert.ok(blind.length === 3 && blind.every((r) => r.amount === null && r.unpriced === undefined));
});
