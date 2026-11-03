/* CUSTOMER, SUPPLIER AND PRODUCT PROFILES OVER HTTP (Nov 2026) — every tab of every profile, as
   every role (the 8 seeded users and an ACCOUNTING_CLERK created here): a section answers 200
   exactly when lib/profiles/access.ts says the user may read it (403 otherwise), money appears
   only with its own permission (receivables, selling prices, payables, purchase prices, stock
   cost), every row links to its source document only when the user can open it, and the pages
   themselves open for the right roles. The run builds its own customer, supplier and product
   with a receipt, a bill, an order, an invoice and a collection; where earlier suites left
   returns, notes and payments, those profiles are checked too. */
import { PrismaClient } from "@prisma/client";
import { call, login, makeChecker, page } from "./_harness";
import { assertTestDatabase } from "./_guard";
import { approveGradingLoss, taxNo } from "./_stock";
import { todayBiz } from "./_days";
import { MONEY, PROFILE_SECTIONS, maySeeSection, type ProfileKind } from "@/lib/profiles/access";
import { mayOpenLink } from "@/lib/reports/page-access";

const { check, section, finish } = makeChecker();
const TAG = `ZZPF${Date.now() % 1_000_000_000}`;
const DENIED_PAGE = "مالكش صلاحية للصفحة دي";
const SEEDED = ["admin", "sara", "hossam", "ahmed", "mostafa", "mona", "karim", "omar"];
const BASE = process.env.BASE ?? "http://localhost:3111";

type Row = { kind: string; number: string; href: string | null; amount?: string | null; open?: string | null; price?: string | null; unitCost?: string | null; party?: { href: string | null } | null; product?: { href: string | null } | null; via?: { href: string | null } | null; detail?: string | null; qty?: string | null };
type Group = { entity: { id: string | null; href: string | null }; qty: string; count: number; lastPrice: string | null; avgPrice: string | null; agreed?: string | null };

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  for (const u of SEEDED) await login(u);
  const clerk = `${TAG.toLowerCase()}_clerk`;
  const created = await call("admin", "POST", "/api/admin/users", { name: `${TAG} Clerk`, username: clerk, password: "longenoughpw", role: "ACCOUNTING_CLERK" });
  check("an accounting clerk is created for the run", created.status === 200 || created.status === 201, [created.status, created.body?.error]);
  check("the clerk signs in", (await login(clerk, "longenoughpw")).status === 200);
  const users = [...SEEDED, clerk];
  const perms: Record<string, Set<string>> = {};
  const roles: Record<string, string> = {};
  for (const u of users) {
    const me = (await call(u, "GET", "/api/auth/me")).body?.user;
    perms[u] = new Set<string>(me?.permissions ?? []);
    roles[u] = me?.role ?? "?";
  }
  const can = (u: string) => (p: string) => perms[u].has(p);

  section("0. DATA: a supplier, a product and a customer with a receipt, a bill, an order, an invoice and a collection of the run's own");
  const today = todayBiz();
  const supplier = (await call("omar", "POST", "/api/purchasing/suppliers", { name: `${TAG} مزرعة`, payment_terms_days: 15 })).body.supplier;
  const product = (await call("hossam", "POST", "/api/stock/products", { name: `${TAG} خيار`, unit: "KG" })).body.product;
  const customer = (await call("mona", "POST", "/api/sales/customers", { name: `${TAG} مطعم`, tax_registration_no: taxNo() })).body.customer;
  const rc = await call("hossam", "POST", "/api/stock/intakes", { supplier_id: supplier?.id, product_id: product?.id, received_date: today, received_kg: 200, waste_qty: 10, unit_cost: "5" });
  check("a receipt: 200 kg at 5, 10 kg waste", rc.status === 201, [rc.status, rc.body?.error]);
  const intake = rc.body?.intake;
  // A receipt with waste waits for the grading-loss decision (made by someone else) before it can be billed.
  await approveGradingLoss([intake?.id]);
  const bill = (await call("karim", "POST", "/api/purchasing/bills", { supplier_id: supplier?.id, supplier_invoice_no: `${TAG}-B1`, bill_date: today, lines: [{ intake_id: intake?.id, unit_price: "5" }] })).body.bill;
  let r = await call("karim", "POST", `/api/purchasing/bills/${bill?.id}/post`, {});
  if (r.body?.bill?.status === "pending_approval") {
    const a = (await call("admin", "GET", "/api/approvals?status=pending")).body.approvals.find((x: any) => x.entityId === bill.id);
    await call("admin", "POST", `/api/approvals/${a.id}/decide`, { decision: "approve", expected_version: a.version });
  }
  const posted = (await call("karim", "GET", `/api/purchasing/bills/${bill?.id}`)).body?.bill;
  check("…billed and posted", posted?.status === "posted", posted?.status);
  const ord = (await call("mona", "POST", "/api/orders", { customer_account_id: customer?.id, customer_name: customer?.name, delivery_date: today, items: [{ stock_product_id: product?.id, product_name: product?.name, quantity: 40 }] })).body.order;
  const item = ord?.items?.[0]?.id;
  await call("mona", "PATCH", `/api/orders/${ord?.id}/items/${item}/price`, { unit_price: "9", reason: "قائمة" });
  await call("ahmed", "POST", `/api/orders/${ord?.id}/status`, { to: "preparing" });
  await call("ahmed", "POST", `/api/orders/${ord?.id}/items/${item}/prepare`, { quantity: 40, mark_done: true });
  await call("ahmed", "POST", `/api/orders/${ord?.id}/status`, { to: "ready_for_loading" });
  await call("mostafa", "POST", `/api/orders/${ord?.id}/status`, { to: "loading" });
  await call("mostafa", "POST", `/api/orders/${ord?.id}/items/${item}/load`, { quantity: 40, mark_done: true });
  await call("mostafa", "POST", `/api/orders/${ord?.id}/status`, { to: "loaded" });
  await call("mostafa", "POST", `/api/orders/${ord?.id}/status`, { to: "dispatched", vehicle: "x", driver_name: "y", crate_count: 1 });
  const inv = (await call("karim", "POST", "/api/sales/invoices", { order_id: ord?.id })).body.invoice;
  r = await call("karim", "POST", `/api/sales/invoices/${inv?.id}/issue`, {});
  check("an order of 40 kg at 9, dispatched and invoiced", r.status === 200 && r.body?.invoice?.status === "issued", [r.status, r.body?.error]);
  const total = r.body?.invoice?.total;
  r = await call("karim", "POST", "/api/accounting/receipts", { party_id: customer?.id, cash_account_id: "cash_main", amount: "100", method: "cash", allocations: [{ document_id: inv?.id, amount: "100" }], idempotency_key: `${TAG}-rct` });
  check("a collection of 100 against the invoice", r.status === 201 || r.status === 200, [r.status, r.body?.error]);
  const ids: Record<ProfileKind, string> = { customer: customer.id, supplier: supplier.id, product: product.id };

  section("1. ANONYMOUS AND BAD REQUESTS");
  check("anonymous → 401", (await fetch(`${BASE}/api/profiles/customer/${customer.id}/summary`)).status === 401);
  check("an unknown profile kind → 404", (await call("admin", "GET", `/api/profiles/employee/${customer.id}/summary`)).status === 404);
  check("an unknown section → 403 (nobody may read what is not in the table)", (await call("admin", "GET", `/api/profiles/customer/${customer.id}/ledger`)).status === 403);
  check("an unknown customer → 404", (await call("admin", "GET", "/api/profiles/customer/nope/orders")).status === 404);
  check("a reversed date range → 400", (await call("admin", "GET", `/api/profiles/customer/${customer.id}/orders?from=2026-02-01&to=2026-01-01`)).status === 400);

  section("2. EVERY SECTION, EVERY ROLE: 200 exactly when the access table says so");
  const data: Record<string, any> = {};
  for (const u of users) {
    const wrong: string[] = [];
    for (const kind of Object.keys(PROFILE_SECTIONS) as ProfileKind[]) {
      for (const s of Object.keys(PROFILE_SECTIONS[kind])) {
        const res = await call(u, "GET", `/api/profiles/${kind}/${ids[kind]}/${s}?limit=200`);
        const allowed = maySeeSection(kind, s, can(u));
        if (res.status !== (allowed ? 200 : 403)) wrong.push(`${kind}/${s} ${res.status}`);
        if (allowed) data[`${u}|${kind}|${s}`] = res.body;
      }
    }
    check(`${roles[u]} (${u}): every profile section answers as its permissions say`, wrong.length === 0, wrong);
  }

  section("3. MONEY: only with its own permission (and never left as an empty value for those without it)");
  // Which money a row's amount is: receivables for a customer's invoices, notes, receipts and
  // returns; payables for a supplier's bills, notes, payments and returns; prices on orders.
  // Receipts and payments are also read by the clerk who records them (their workflow permission).
  const amountAllowed = (u: string, profile: string, rowKind: string) => {
    const has = (p: string) => perms[u].has(p);
    if (rowKind === "order") return has(MONEY.salesPrice);
    if (rowKind === "purchase_order") return has(MONEY.purchasePrice);
    if (profile === "customer") return has(MONEY.receivable) || ((rowKind === "receipt" || rowKind === "refund") && (has("accounting.view") || has("accounting.receipts.manage")));
    if (profile === "supplier") return has(MONEY.payable) || ((rowKind === "payment" || rowKind === "refund") && (has("accounting.view") || has("accounting.payments.manage")));
    return false;
  };
  for (const u of users) {
    const wrong: string[] = [];
    for (const [key, body] of Object.entries(data).filter(([k]) => k.startsWith(`${u}|`))) {
      const [, kind, s] = key.split("|");
      const rows: Row[] = body?.rows ?? [];
      const groups: Group[] = body?.groups ?? [];
      for (const row of rows) {
        if (row.amount != null && !amountAllowed(u, kind, row.kind)) wrong.push(`${kind}/${s} ${row.kind} ${row.number}: amount without its permission`);
        if (row.unitCost != null && !perms[u].has(MONEY.cost)) wrong.push(`${kind}/${s} ${row.number}: unit cost without ${MONEY.cost}`);
        if (row.price != null && row.kind === "order_line" && !perms[u].has(MONEY.salesPrice)) wrong.push(`${kind}/${s} ${row.number}: selling price without ${MONEY.salesPrice}`);
        if (row.price != null && row.kind === "intake" && !perms[u].has(MONEY.payable) && !perms[u].has(MONEY.purchasePrice)) wrong.push(`${kind}/${s} ${row.number}: bill price without payables or purchase prices`);
      }
      for (const g of groups) {
        if ((s === "purchases" || (kind === "supplier" && s === "products")) && g.avgPrice != null && !perms[u].has(MONEY.cost)) wrong.push(`${kind}/${s}: average cost without ${MONEY.cost}`);
        if ((s === "sales" || (kind === "customer" && s === "products")) && (g.lastPrice != null || g.avgPrice != null) && !perms[u].has(MONEY.salesPrice)) wrong.push(`${kind}/${s}: selling prices without ${MONEY.salesPrice}`);
        if (g.agreed != null && !perms[u].has(MONEY.purchasePrice)) wrong.push(`${kind}/${s}: agreed price without ${MONEY.purchasePrice}`);
      }
      if (s === "summary" && kind === "customer" && (body.receivable !== undefined || body.netSales !== undefined) && !perms[u].has(MONEY.receivable)) wrong.push("customer summary: receivable without sales.invoices.view");
      if (s === "summary" && kind === "customer" && body.creditLimit !== undefined && !perms[u].has(MONEY.receivable) && !perms[u].has("sales.credit.manage")) wrong.push("customer summary: credit limit without finance");
      if (s === "summary" && kind === "supplier" && (body.payable !== undefined || body.netPurchases !== undefined) && !perms[u].has(MONEY.payable)) wrong.push("supplier summary: payable without purchasing.bills.view");
    }
    check(`${roles[u]} (${u}): no money beyond its permissions`, wrong.length === 0, wrong.slice(0, 10));
  }
  // Not vacuous: the figures are there for whoever may see them.
  const a = (kind: string, s: string, u = "admin") => data[`${u}|${kind}|${s}`];
  const adminInv = (a("customer", "invoices").rows as Row[]).find((x) => x.kind === "invoice");
  check("admin: the invoice with its total and what is still open (total − 100)", Number(adminInv?.amount) === Number(total) && Number(adminInv?.open) === Number(total) - 100, [adminInv, total]);
  check("admin: the order valued as invoiced (40 × 9)", Number((a("customer", "orders").rows as Row[])[0]?.amount) === Number(total) && Number(total) > 0, [a("customer", "orders").rows[0], total]);
  check("admin: the receipt's cost 5.0000 and the bill price on the supplier's receipts", (a("supplier", "receipts").rows as Row[])[0]?.unitCost === "5.0000" && (a("supplier", "receipts").rows as Row[])[0]?.price === "5.0000", a("supplier", "receipts").rows[0]);
  check("the customer's figures for an accountant: receivable = invoice − 100, net sales 360.00", Number(a("customer", "summary", "karim").receivable) === Number(total) - 100 && a("customer", "summary", "karim").netSales === "360.00", a("customer", "summary", "karim"));
  check("a supervisor (customers, no invoices) gets no receivable, sales or credit figures", !("receivable" in a("customer", "summary", "sara")) && !("creditLimit" in a("customer", "summary", "sara")) && !("netSales" in a("customer", "summary", "sara")), a("customer", "summary", "sara"));
  check("…and the customer-exposure API refuses a supervisor (403), answers the accountant (200)", (await call("sara", "GET", `/api/sales/customers/${customer.id}/exposure`)).status === 403 && (await call("karim", "GET", `/api/sales/customers/${customer.id}/exposure`)).status === 200);
  check("a purchaser sees the supplier's receipts but no stock cost", (a("supplier", "receipts", "omar").rows as Row[])[0]?.unitCost == null && (a("supplier", "receipts", "omar").rows as Row[]).length === 1);
  check("the supplier's figures for an accountant: payable = the bill, net purchases = its net", a("supplier", "summary", "karim").payable === posted?.total && a("supplier", "summary", "karim").netPurchases === posted?.net, [a("supplier", "summary", "karim"), posted?.total, posted?.net]);

  section("4. CONTENT: each profile shows the run's documents, connected");
  const ct = a("customer", "timeline").rows as Row[];
  check("customer timeline: the order, the invoice and the receipt", ["order", "invoice", "receipt"].every((k) => ct.some((x) => x.kind === k)), ct.map((x) => x.kind));
  const inR = (a("customer", "invoices").rows as Row[]).find((x) => x.kind === "invoice");
  check("…the invoice links to itself and to its order", inR?.href === `/sales?tab=invoices&invoice=${inv.id}` && inR?.via?.href === `/orders/${ord.id}`, inR);
  const lines = a("customer", "products");
  check("products bought: the line (40 kg at 9, loaded 40) and the product total, linked to the product", lines.rows[0]?.qty === "40" && lines.rows[0]?.price === "9.00" && lines.rows[0]?.delivered === "40" && lines.groups[0]?.qty === "40" && lines.groups[0]?.lastPrice === "9.00" && lines.groups[0]?.entity.href === `/stock/products/${product.id}`, lines);
  const sr = a("supplier", "receipts").rows as Row[];
  check("supplier receipts: graded (good 190, Grade B 0, waste 10, rejected 0), billed, linked to the bill", sr[0]?.detail === "190|0|10|0" && sr[0]?.qty === "200" && (sr[0] as any).status === "billed" && sr[0]?.via?.href === `/purchasing?bill=${bill.id}`, sr[0]);
  const sp = a("supplier", "products").groups as Group[];
  check("products supplied: received 200, accepted 190, last bill price 5", sp[0]?.qty === "200" && (sp[0] as any).delivered === "190" && sp[0]?.lastPrice === "5.0000", sp[0]);
  const mv = a("product", "movements").rows as Row[];
  const intakeMoves = mv.filter((x) => x.kind === "intake");
  check("product movements: the receipt (190 good + 10 waste = 200, from the supplier, linked to the receipt) and the issue to the order (−40, linked to the order)", intakeMoves.reduce((t, x) => t + Number(x.qty), 0) === 200 && intakeMoves.every((x) => x.party?.href === `/purchasing/suppliers/${supplier.id}` && x.href === `/stock/entries?in_q=${encodeURIComponent(intake.receiptNumber)}`) && mv.some((x) => x.kind === "issue" && x.qty === "-40" && x.via?.href === `/orders/${ord.id}` && x.href?.startsWith("/stock/inventory?tab=documents&doc=")), mv.map((x) => [x.kind, x.qty, x.href]));
  const ps = a("product", "sales", "sara");
  check("product sales (supervisor): the customer, 40 kg, last price 9.00, linked to the customer's profile", ps.groups[0]?.qty === "40" && ps.groups[0]?.lastPrice === "9.00" && ps.groups[0]?.entity.href === `/sales/customers/${customer.id}`, ps.groups[0]);
  check("…a stock controller does not get the sales tab (no orders.view) -> 403", (await call("hossam", "GET", `/api/profiles/product/${product.id}/sales`)).status === 403);
  const pp = a("product", "purchases");
  check("product purchases: the supplier, 200 received, average cost 5.0000 (admin)", pp.groups[0]?.qty === "200" && pp.groups[0]?.avgPrice === "5.0000" && pp.groups[0]?.entity.href === `/purchasing/suppliers/${supplier.id}`, pp.groups[0]);
  check("…a purchaser gets the same rows without the cost", a("product", "purchases", "omar").groups[0]?.avgPrice === null && a("product", "purchases", "omar").groups[0]?.qty === "200");
  const open = (await call("admin", "GET", `/api/profiles/customer/${customer.id}/orders?open=1`)).body;
  check("open orders only: the dispatched order is not open", open.total === 0 && open.rows.length === 0, open);
  const ranged = (await call("admin", "GET", `/api/profiles/customer/${customer.id}/timeline?from=2000-01-01&to=2000-12-31`)).body;
  check("a date range before the run: nothing", ranged.total === 0, ranged);
  const st = (await call("karim", "GET", `/api/sales/customers/${customer.id}/statement?from=2000-01-01&to=2099-12-31`)).body;
  check("statement lines carry what they link to: the invoice row is the invoice", st.rows.some((x: any) => x.kind === "invoice" && x.id === inv.id), st.rows);

  section("5. DOCUMENTS LEFT BY EARLIER SUITES: returns, notes and payments are on their profiles");
  const custCN = await db.creditNote.findFirst({ where: { returnDocumentId: { not: null } }, orderBy: { createdAt: "desc" }, select: { customerId: true, number: true, invoiceId: true } });
  const supPay = await db.supplierPayment.findFirst({ orderBy: { createdAt: "desc" }, select: { supplierId: true, number: true } });
  const supRet = await db.inventoryDocument.findFirst({ where: { type: "supplier_return", reversalOfId: null, supplierId: { not: null } }, orderBy: { createdAt: "desc" }, select: { supplierId: true, number: true, id: true } });
  if (custCN) {
    const rows = (await call("admin", "GET", `/api/profiles/customer/${custCN.customerId}/invoices?limit=1000`)).body.rows as Row[];
    const cn = rows.find((x) => x.kind === "credit_note" && x.number === custCN.number);
    check("a credit note with returned goods is on its customer's profile, linked to its invoice", !!cn && cn.href === `/sales?tab=invoices&invoice=${custCN.invoiceId}` && Number(cn.amount) < 0, cn);
    const rets = (await call("admin", "GET", `/api/profiles/customer/${custCN.customerId}/returns?limit=1000`)).body.rows as Row[];
    check("…and the returned goods are on its returns tab, linked to the stock document and the note", rets.some((x) => x.via?.href === `/sales?tab=invoices&invoice=${custCN.invoiceId}` && x.href?.startsWith("/stock/inventory?tab=documents&doc=")), rets.slice(0, 3));
  } else check("SKIP: no credit note with returned goods in this database (run after returns-integrity for coverage)", true);
  if (supPay) {
    const rows = (await call("admin", "GET", `/api/profiles/supplier/${supPay.supplierId}/payments?limit=1000`)).body.rows as Row[];
    check("a supplier payment is on its supplier's profile, linked to the payments list", rows.some((x) => x.kind === "payment" && x.number === supPay.number && x.href === `/accounting?tab=payments&payments_q=${encodeURIComponent(supPay.number)}`), rows.slice(0, 3));
  } else check("SKIP: no supplier payment in this database", true);
  if (supRet) {
    const rows = (await call("admin", "GET", `/api/profiles/supplier/${supRet.supplierId}/returns?limit=1000`)).body.rows as Row[];
    check("a supplier return is on its supplier's profile, linked to its stock document", rows.some((x) => x.number === supRet.number && x.href === `/stock/inventory?tab=documents&doc=${supRet.id}`), rows.slice(0, 3));
  } else check("SKIP: no supplier return in this database", true);

  section("6. LINKS: every link a user is given is one they can open, and it opens");
  for (const u of users) {
    const wrong: string[] = [];
    const targets = new Map<string, string>();
    for (const [key, body] of Object.entries(data).filter(([k]) => k.startsWith(`${u}|`))) {
      const hrefs = [...(body?.rows ?? []).flatMap((x: Row) => [x.href, x.party?.href, x.product?.href, x.via?.href]), ...(body?.groups ?? []).map((g: Group) => g.entity.href)].filter((h): h is string => typeof h === "string");
      for (const h of hrefs) {
        if (!mayOpenLink(h, can(u))) wrong.push(`${key}: ${h} offered but not openable`);
        const path = new URL(h, BASE).pathname;
        if (!targets.has(path)) targets.set(path, h);
      }
    }
    for (const h of targets.values()) {
      const p = await page(u, h);
      if (p.status !== 200 || p.html.includes(DENIED_PAGE)) wrong.push(`${h} → ${p.status === 200 ? "access denied" : p.status}`);
    }
    check(`${roles[u]} (${u}): every link given opens (${targets.size} distinct pages)`, wrong.length === 0, wrong.slice(0, 10));
  }
  check("not vacuous: the administrator was given links to the order, invoice, receipt, bill and goods receipt", ["/orders/", "/sales?tab=invoices&invoice=", "/accounting?tab=receipts", "/purchasing?bill=", "/stock/entries?in_q="].every((p) => Object.entries(data).some(([k, b]) => k.startsWith("admin|") && JSON.stringify(b).includes(p))));

  section("7. PAGES: the profile pages open for who may read them, and nowhere else");
  const pages: [string, string][] = [["customer", `/sales/customers/${customer.id}`], ["supplier", `/purchasing/suppliers/${supplier.id}`], ["product", `/stock/products/${product.id}`]];
  for (const u of users) {
    const wrong: string[] = [];
    for (const [kind, path] of pages) {
      const allowed = maySeeSection(kind as ProfileKind, "summary", can(u));
      const p = await page(u, path);
      const opened = p.status === 200 && !p.html.includes(DENIED_PAGE);
      if (opened !== allowed) wrong.push(`${path} ${opened ? "opened" : "denied"}`);
    }
    // The purchasing module opens for any one of its tabs (an accounting clerk: bills and suppliers).
    const pur = await page(u, "/purchasing");
    const purAllowed = ["purchasing.orders.view", "purchasing.suppliers.view", "purchasing.bills.view"].some((x) => perms[u].has(x));
    if ((pur.status === 200 && !pur.html.includes(DENIED_PAGE)) !== purAllowed) wrong.push(`/purchasing ${purAllowed ? "denied" : "opened"}`);
    check(`${roles[u]} (${u}): profile pages and /purchasing open exactly as the permissions say`, wrong.length === 0, wrong);
  }

  await db.$disconnect();
  finish("PARTY PROFILES");
}

main().catch((e) => { console.error(e); process.exit(1); });
