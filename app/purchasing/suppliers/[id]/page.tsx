import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { SupplierProfile } from "@/components/profiles/SupplierProfile";

export default async function SupplierProfilePage({ params }: { params: { id: string } }) {
  const gate = await requirePagePermission("purchasing.suppliers.view");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} homeHref="/purchasing" />;
  return (
    <main className="min-h-screen">
      <Nav />
      <SupplierProfile supplierId={params.id} />
    </main>
  );
}
