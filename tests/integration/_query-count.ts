/**
 * Counting database statements in an integration test (Nov 2026).
 *
 * Production runs ~37 ms per round trip on one pooled connection, so a path whose statement
 * count grows with the number of lines eventually crosses the 20 s transaction limit and fails.
 * Tests that guard a batched path assert its statement count with this helper.
 *
 * Import this module FIRST in the test file (before ./_db or anything that loads lib/prisma):
 * it turns on Prisma's query events (lib/prisma.ts reads PRISMA_LOG_QUERIES when the client is
 * created). node --test runs each file in its own process, so this affects only that file.
 */
process.env.PRISMA_LOG_QUERIES = "1";

let seen = 0;
let hooked = false;

export async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queries: number }> {
  const { prisma } = await import("@/lib/prisma");
  if (!hooked) {
    (prisma as unknown as { $on: (e: "query", cb: () => void) => void }).$on("query", () => { seen++; });
    hooked = true;
  }
  const start = seen;
  const result = await fn();
  return { result, queries: seen - start };
}
