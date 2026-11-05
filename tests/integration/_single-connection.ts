/**
 * One pooled connection, like production (Nov 2026): Supavisor runs UNITED with
 * connection_limit=1, so any query a transaction sends through the global client instead of
 * through itself waits for a second connection that never comes, until the pool times out.
 *
 * Import this module FIRST in the test file (before ./_db or anything that loads lib/prisma):
 * the Prisma client reads DATABASE_URL when it is created. A short pool timeout makes such a
 * wait fail the test in seconds. node --test runs each file in its own process, so this
 * affects only that file.
 */
const url = new URL(process.env.DATABASE_URL ?? "");
url.searchParams.set("connection_limit", "1");
url.searchParams.set("pool_timeout", "3");
process.env.DATABASE_URL = url.toString();
