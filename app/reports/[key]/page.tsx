import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { ReportViewer } from "@/components/reports/ReportViewer";
import { REPORT_PAGE_PERMISSIONS } from "@/lib/nav";

/** One report (the API checks the report's own permissions). */
export default async function ReportPage({ params }: { params: { key: string } }) {
  const gate = await requirePagePermission([...REPORT_PAGE_PERMISSIONS]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  return (
    <main className="min-h-screen">
      <Nav />
      <ReportViewer reportKey={params.key} />
    </main>
  );
}
