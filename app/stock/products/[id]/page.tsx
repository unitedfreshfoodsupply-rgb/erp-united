import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { ProductProfile } from "@/components/profiles/ProductProfile";

export default async function ProductProfilePage({ params }: { params: { id: string } }) {
  const gate = await requirePagePermission("stock.view");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} homeHref="/stock/inventory" />;
  return (
    <main className="min-h-screen">
      <Nav />
      <ProductProfile productId={params.id} />
    </main>
  );
}
