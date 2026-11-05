import type { Prisma } from "@prisma/client";

/** Anything that can run a raw query — the Prisma client or a transaction client. */
export type LockableTx = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Take a Postgres transaction-scoped advisory lock on an arbitrary string key.
 *
 * Used to make read-then-insert sequences atomic (next order number, external_id
 * de-duplication) without adding table locks or new unique constraints. The lock is
 * released automatically when the surrounding transaction commits or rolls back, so
 * it is safe through the PgBouncer transaction pooler — unlike a session-level lock,
 * which could outlive the checkout and leak onto another request's connection.
 *
 * Callers that need more than one lock in the same transaction must always take them
 * in the same order (external_id before order-number day) so two concurrent creates
 * can never deadlock against each other.
 */
export async function advisoryXactLock(tx: LockableTx, key: string) {
  // pg_advisory_xact_lock() returns void, which $queryRaw cannot deserialize —
  // the IS NULL test turns it into a plain boolean column.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key})) IS NULL AS locked`;
}

/**
 * Take several transaction-scoped advisory locks in ONE round trip.
 *
 * Every lock taken one statement at a time costs a full database round trip (~37 ms in
 * production), and stock paths lock once per product or bucket — 20 products meant 20 round
 * trips before any work started. This takes them all in one statement. The keys are
 * de-duplicated and sorted here, and `unnest … WITH ORDINALITY` + ORDER BY keeps that order
 * inside the statement, so the global lock order (sorted keys) still holds and two writers can
 * never deadlock against each other. Locking a key the transaction already holds is a no-op.
 */
export async function advisoryXactLocks(tx: LockableTx, keys: Iterable<string>) {
  const sorted = [...new Set(keys)].sort();
  if (sorted.length === 0) return;
  if (sorted.length === 1) return advisoryXactLock(tx, sorted[0]);
  await tx.$queryRaw`SELECT count(pg_advisory_xact_lock(hashtext(k.key)))::int AS locked
    FROM (SELECT key FROM unnest(${sorted}::text[]) WITH ORDINALITY AS u(key, ord) ORDER BY ord) k`;
}

/**
 * Several transaction-scoped advisory locks in ONE round trip, in the order given (not sorted).
 *
 * For a caller whose lock sequence is already fixed by the rest of the code — e.g. releasing a
 * PO's requests takes each request's lock, then its order's suggestion lock, the same sequence
 * other writers of those rows follow. `WITH ORDINALITY` + ORDER BY keeps the given order inside
 * the statement. Repeated keys are taken where they first appear (re-locking a held key is a
 * no-op). Everything else should use advisoryXactLocks, whose sorted order is the global one.
 */
export async function advisoryXactLocksInOrder(tx: LockableTx, keys: Iterable<string>) {
  const ordered = [...new Set(keys)];
  if (ordered.length === 0) return;
  if (ordered.length === 1) return advisoryXactLock(tx, ordered[0]);
  await tx.$queryRaw`SELECT count(pg_advisory_xact_lock(hashtext(k.key)))::int AS locked
    FROM (SELECT key FROM unnest(${ordered}::text[]) WITH ORDINALITY AS u(key, ord) ORDER BY ord) k`;
}
