import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { PurchaseRequestsView } from "@/components/purchasing/PurchaseRequestsView";

export default async function PurchaseRequestsPage() {
  const gate = await requirePagePermission(["purchasing.requests.view"]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  return (
    <main className="min-h-screen">
      <Nav />
      <PurchaseRequestsView />
    </main>
  );
}
