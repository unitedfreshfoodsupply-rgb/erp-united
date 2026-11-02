import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";

/**
 * Health probes (WS6).
 *
 *  - shallow: one `SELECT 1` raced against a 2-second timeout. A database that hangs
 *    (pooler exhausted, network partition) must read as DOWN to the uptime monitor, not
 *    as a request that never answers.
 *  - deep: the operator's view — migrations applied vs shipped, pending approvals, the
 *    last backup marker, MFA coverage. Authenticated; never public.
 */

export const DB_PROBE_TIMEOUT_MS = 2_000;

export class ProbeTimeout extends Error {
  constructor() {
    super("timeout");
  }
}

/** Resolves with `p`, or rejects with ProbeTimeout after `ms`. The timer never keeps the process alive. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function probeDatabase(timeoutMs = DB_PROBE_TIMEOUT_MS): Promise<{ ok: true; latencyMs: number } | { ok: false; reason: "timeout" | "error" }> {
  const started = Date.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, reason: err instanceof ProbeTimeout ? "timeout" : "error" };
  }
}

/** Migration folder names shipped with this build (prisma/migrations/<name>/migration.sql). */
export function shippedMigrations(root = process.cwd()): string[] | null {
  const dir = join(root, "prisma", "migrations");
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "migration.sql")))
    .sort();
}

/**
 * The backup marker: a small file the backup job (scripts/ops/backup-pg-dump.sh)
 * rewrites after every SUCCESSFUL dump — its path in BACKUP_MARKER_FILE. Only the
 * marker's own text (an ISO timestamp + file name, no secrets) and its age are read.
 */
export function backupMarker(): { configured: false } | { configured: true; present: boolean; at?: string; ageHours?: number; detail?: string } {
  const path = process.env.BACKUP_MARKER_FILE?.trim();
  if (!path) return { configured: false };
  try {
    if (!existsSync(path)) return { configured: true, present: false };
    const st = statSync(path);
    const detail = readFileSync(path, "utf8").slice(0, 300).trim();
    return { configured: true, present: true, at: st.mtime.toISOString(), ageHours: Math.round(((Date.now() - st.mtimeMs) / 3_600_000) * 10) / 10, detail };
  } catch {
    return { configured: true, present: false };
  }
}
