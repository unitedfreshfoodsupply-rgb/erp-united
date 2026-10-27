/* A settlement difference is written off only by someone who manages the accounts —
   recording receipts is not enough. No seeded role records receipts without also
   managing the accounts, so the refusal is pinned here with an actor that has exactly
   accounting.receipts.manage. Settings are restored afterwards. */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma, actor } from "./_db";
import { createReceipt } from "@/lib/accounting/cash";
import { updateSetting } from "@/lib/core/settings-service";
import { createCustomer } from "@/lib/sales/customers";

const TAG = `ZZDIFF${Date.now()}`;
const admin = actor("مدير", ["settings.manage"], null, "SUPER_ADMIN");
const cashier = actor("كاشير", ["accounting.receipts.manage"]);
const manager = actor("محاسب", ["accounting.receipts.manage", "accounting.manage"]);
let customerId = "";

before(async () => {
  const account = await prisma.account.create({ data: { code: String(Date.now()).slice(-7), name: `${TAG} differences`, nameAr: `${TAG} فروق`, type: "expense", parentId: "acc_6000" } });
  await updateSetting("accounting.write_off_account", account.code, admin, { reason: TAG });
  await updateSetting("accounting.write_off_limit", 1, admin, { reason: TAG });
  customerId = (await createCustomer({ name: `${TAG} عميل` }, actor("مبيعات", ["sales.customers.manage"]))).id;
});

after(async () => {
  await updateSetting("accounting.write_off_account", null, admin, { reason: TAG });
  await updateSetting("accounting.write_off_limit", null, admin, { reason: TAG });
  await prisma.$disconnect();
});

const receipt = (who: typeof cashier) =>
  createReceipt({ party_id: customerId, cash_account_id: "cash_main", amount: "100", method: "cash", deductions: [{ kind: "write_off", amount: "0.50" }] }, who);

test("recording receipts alone cannot write off a difference (403)", async () => {
  await assert.rejects(receipt(cashier), (e: any) => e.status === 403);
});

test("the same difference by someone who manages the accounts posts", async () => {
  const r = await receipt(manager);
  const d = await prisma.receiptDeduction.findMany({ where: { receiptId: r.id } });
  assert.equal(d.length, 1);
  assert.equal(d[0].amount.toFixed(2), "0.50");
});

test("a deduction row is permanent (database-enforced)", async () => {
  const d = await prisma.receiptDeduction.findFirstOrThrow({ where: { receipt: { customerId }, kind: "write_off" }, orderBy: { id: "desc" } });
  await assert.rejects(prisma.receiptDeduction.update({ where: { id: d.id }, data: { amount: "0.10" } }));
  await assert.rejects(prisma.receiptDeduction.delete({ where: { id: d.id } }));
});
