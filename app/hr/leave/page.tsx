import { requireAnyPagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { LeaveView } from "@/components/hr/LeaveView";

export default async function LeavePage() {
  const gate = await requireAnyPagePermission(["hr.leave.request", "hr.leave.approve", "hr.leave.configure"]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} homeHref="/hr" />;
  return (
    <main className="min-h-screen">
      <Nav />
      <LeaveView />
    </main>
  );
}
