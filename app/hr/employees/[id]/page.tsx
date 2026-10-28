import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { EmployeeProfile } from "@/components/hr/EmployeeProfile";

export default async function EmployeeProfilePage({ params }: { params: { id: string } }) {
  const gate = await requirePagePermission("hr.employees.view");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} homeHref="/hr" />;
  return (
    <main className="min-h-screen">
      <Nav />
      <EmployeeProfile employeeId={params.id} />
    </main>
  );
}
