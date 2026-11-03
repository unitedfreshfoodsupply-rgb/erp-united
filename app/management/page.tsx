import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { ManagementView } from "@/components/management/ManagementView";

export default async function ManagementPage({ searchParams }: { searchParams?: { from?: string; to?: string } }) {
  const gate = await requirePagePermission("reports.finance");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  return (
    <main className="min-h-screen">
      <Nav />
      <ManagementView kind="finance" period={{ from: searchParams?.from, to: searchParams?.to }} />
    </main>
  );
}
