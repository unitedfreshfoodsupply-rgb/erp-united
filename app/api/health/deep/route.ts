import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requirePermission } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/core/settings-service";
import { backupMarker, probeDatabase, shippedMigrations } from "@/lib/security/health";

export const dynamic = "force-dynamic";

/**
 * The operator's health view. settings.manage is in no role bundle, so this is the
 * super admin (or someone explicitly granted system settings) — never public: it says
 * which migrations exist, how much work is waiting and when the last backup ran.
 *
 * 200 when the database answers and every shipped migration is applied; 503 otherwise
 * (so a monitor with credentials can alert on "deployed code ahead of the schema").
 * Never returns a connection string, a secret, or an error's text.
 */
export async function GET(req: NextRequest) {
  try {
    await requirePermission(req, "settings.manage");
    const db = await probeDatabase();
    if (!db.ok) {
      return NextResponse.json({ status: "error", database: db }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }

    const applied = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`;
    const done = new Set(applied.filter((m) => m.finished_at && !m.rolled_back_at).map((m) => m.migration_name));
    const failed = applied.filter((m) => !m.finished_at && !m.rolled_back_at).map((m) => m.migration_name).sort();
    const shipped = shippedMigrations();
    const pending = shipped ? shipped.filter((n) => !done.has(n)) : null;
    const unknown = shipped ? [...done].filter((n) => !shipped.includes(n)).sort() : null;

    const required = await getSetting("auth.mfa_required_roles");
    const [pendingApprovals, usersWithoutMfa] = await Promise.all([
      prisma.approvalRequest.count({ where: { status: "pending" } }),
      required.length ? prisma.user.count({ where: { active: true, role: { in: [...required] }, mfaEnabledAt: null } }) : Promise.resolve(0),
    ]);

    const healthy = failed.length === 0 && (pending === null || pending.length === 0);
    return NextResponse.json(
      {
        status: healthy ? "ok" : "degraded",
        checkedAt: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        database: db,
        migrations: {
          applied: done.size,
          shipped: shipped?.length ?? null,
          pending,
          failed,
          // Applied in the database but not shipped with this build (an older build running
          // against a newer schema, or a hand-applied migration).
          unknown,
        },
        approvals: { pending: pendingApprovals },
        backup: backupMarker(),
        mfa: { requiredRoles: required, activeUsersWithoutMfa: usersWithoutMfa },
      },
      { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return handleApiError(err, req);
  }
}
