/* The integrations call log on the admin screen (Nov 2026): a refused call is logged with the
   message the caller received (Arabic, the services' language) and stays stored that way; the
   screen reads it in the admin's language. GET /api/admin/integrations passes the request's
   locale (requestLocale) to listIntegrations. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./_db";
import { listIntegrations } from "@/lib/integrations/service";

const TAG = `ILOG${Date.now()}`;
after(async () => { await prisma.$disconnect(); });

test("integration log errors read in the screen's language; the stored text is unchanged", async () => {
  const stored = ["التكامل محتاج x-api-key", "مفتاح التكامل ده مش مسموح له بـ attendance.ingest"];
  const rows = await Promise.all(stored.map((error, i) => prisma.integrationLog.create({ data: { caller: "unknown", method: "POST", path: `/api/integrations/${TAG}/${i}`, status: i ? 403 : 401, error, durationMs: 3 } })));
  const pick = (r: Awaited<ReturnType<typeof listIntegrations>>) => rows.map((x) => r.logs.find((l) => l.id === x.id)?.error);

  assert.deepEqual(pick(await listIntegrations("en")), ["The integration needs x-api-key", "This integration key is not allowed to attendance.ingest"]);
  assert.deepEqual(pick(await listIntegrations("ar")), stored, "Arabic reads as stored");
  assert.deepEqual(pick(await listIntegrations()), stored, "the default stays Arabic, as before");
  const kept = await prisma.integrationLog.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { status: "asc" } });
  assert.deepEqual(kept.map((r) => r.error), stored, "the log itself is not rewritten");
  // A successful call has no error, and stays null.
  const okRow = await prisma.integrationLog.create({ data: { caller: "unknown", method: "GET", path: `/api/integrations/${TAG}/ok`, status: 200, durationMs: 2 } });
  assert.equal((await listIntegrations("en")).logs.find((l) => l.id === okRow.id)?.error, null);
});
