import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { HrView } from "@/components/hr/HrView";

export default async function HrPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const gate = await requirePagePermission("hr.expenses.submit");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  return (
    <main className="min-h-screen">
      <Nav />
      <HrView initialTab={typeof searchParams?.tab === "string" ? searchParams.tab : undefined} />
    </main>
  );
}
