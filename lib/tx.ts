import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type Tx = Prisma.TransactionClient;

const open = new AsyncLocalStorage<Tx>();

/** The inTx transaction the calling code runs in, if any (settings reads go through it). */
export function currentTx(): Tx | undefined {
  return open.getStore();
}

// Work a transaction owes before it commits (Nov 2026): the stock-availability check of orders
// waiting for stock runs once, for everything the transaction changed, as its last step.
const pending = new WeakMap<object, Map<string, () => Promise<void>>>();
// …and once it has committed: a re-check that sees what other transactions committed meanwhile.
const committed = new WeakMap<object, Map<string, () => Promise<void>>>();

/**
 * Runs `fn` once, at the end of an inTx transaction, still inside it (its writes commit or
 * roll back with the rest). The first registration of a key wins until it has run. Returns
 * false when `tx` was not opened by inTx — the caller must then do the work itself, now.
 */
export function beforeCommit(tx: Tx, key: string, fn: () => Promise<void>): boolean {
  const hooks = pending.get(tx);
  if (!hooks) return false;
  if (!hooks.has(key)) hooks.set(key, fn);
  return true;
}

/**
 * Runs `fn` once after an inTx transaction has committed, before inTx returns (never if it rolls
 * back). It must open its own transaction for any work. A failure is logged, not thrown: the
 * business action itself has committed. Returns false when `tx` was not opened by inTx.
 */
export function afterCommit(tx: Tx, key: string, fn: () => Promise<void>): boolean {
  const hooks = committed.get(tx);
  if (!hooks) return false;
  if (!hooks.has(key)) hooks.set(key, fn);
  return true;
}

/**
 * One business action, one transaction: the state change, its ledger rows and its
 * audit rows commit together or not at all.
 *
 * The limits are wider than Prisma's 2s/5s defaults because writers that take an
 * advisory lock (order numbers, receipts, stock balance checks) legitimately queue
 * behind each other under load; giving up after 2s would turn a short queue into a
 * failed request on a busy morning.
 */
export async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const after = new Map<string, () => Promise<void>>();
  const result = await prisma.$transaction(
    (tx) => open.run(tx, async () => {
      const hooks = new Map<string, () => Promise<void>>();
      pending.set(tx, hooks);
      committed.set(tx, after);
      const result = await fn(tx);
      // A hook may register another one: drain until none is left.
      for (let next = hooks.entries().next(); !next.done; next = hooks.entries().next()) {
        const [key, hook] = next.value;
        hooks.delete(key);
        await hook();
      }
      // Deferred constraints (journal balance, allocation caps) are checked at COMMIT —
      // and Prisma resolves an interactive transaction whose COMMIT fails as if it had
      // succeeded (the data is rolled back, the caller is told nothing). Running them
      // here, still inside the transaction, turns a violation into a thrown error.
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      return result;
    }),
    { maxWait: 15_000, timeout: 20_000 }
  );
  for (const [key, hook] of after) {
    try {
      await hook();
    } catch (err) {
      console.error(`[tx] after-commit ${key} failed`, err);
    }
  }
  return result;
}
