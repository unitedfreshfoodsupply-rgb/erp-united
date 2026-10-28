import { requireAnyPagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { AttendanceView } from "@/components/hr/AttendanceView";

export default async function AttendancePage() {
  const gate = await requireAnyPagePermission(["hr.attendance.record", "hr.attendance.approve", "hr.employees.manage"]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} homeHref="/hr" />;
  return (
    <main className="min-h-screen">
      <Nav />
      <AttendanceView />
    </main>
  );
}
