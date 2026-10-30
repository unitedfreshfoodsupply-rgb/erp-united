import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { OverviewView } from "@/components/management/OverviewView";

export default async function ManagementOverviewPage() {
  const gate = await requirePagePermission("reports.finance");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  return (
    <main className="min-h-screen">
      <Nav />
      <OverviewView />
    </main>
  );
}
