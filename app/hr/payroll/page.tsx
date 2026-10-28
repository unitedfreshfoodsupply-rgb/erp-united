import { requireAnyPagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { PayrollView } from "@/components/hr/PayrollView";

export default async function PayrollPage() {
  const gate = await requireAnyPagePermission(["hr.compensation.view", "hr.compensation.manage", "hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay", "hr.statutory.manage"]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} homeHref="/hr" />;
  return (
    <main className="min-h-screen">
      <Nav />
      <PayrollView />
    </main>
  );
}
