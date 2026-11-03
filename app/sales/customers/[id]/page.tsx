import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { CustomerProfile } from "@/components/profiles/CustomerProfile";

export default async function CustomerProfilePage({ params }: { params: { id: string } }) {
  const gate = await requirePagePermission("sales.customers.view");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} homeHref="/sales" />;
  return (
    <main className="min-h-screen">
      <Nav />
      <CustomerProfile customerId={params.id} />
    </main>
  );
}
