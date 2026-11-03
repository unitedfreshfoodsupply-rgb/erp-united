import { requireAnyPagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { CommandCenter } from "@/components/management/CommandCenter";

export default async function CommandCenterPage() {
  const gate = await requireAnyPagePermission(["reports.finance", "reports.view"]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  return (
    <main className="min-h-screen">
      <Nav />
      <CommandCenter />
    </main>
  );
}
