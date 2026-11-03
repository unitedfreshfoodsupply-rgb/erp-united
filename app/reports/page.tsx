import { requireAnyPagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { ReportsCentre } from "@/components/reports/ReportsCentre";
import { REPORT_PAGE_PERMISSIONS } from "@/lib/nav";

/** The Reports centre: every report this user may open, by category (maturity 2026-11). */
export default async function ReportsPage() {
  const gate = await requireAnyPagePermission([...REPORT_PAGE_PERMISSIONS]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  return (
    <main className="min-h-screen">
      <Nav />
      <ReportsCentre />
    </main>
  );
}
