import { requireAnyPagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { PurchasingView } from "@/components/purchasing/PurchasingView";

export default async function PurchasingPage() {
  // Any of the module's tabs opens it (an accounting clerk has bills and suppliers, not orders).
  const gate = await requireAnyPagePermission(["purchasing.orders.view", "purchasing.suppliers.view", "purchasing.bills.view"]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  return (
    <main className="min-h-screen">
      <Nav />
      <PurchasingView />
    </main>
  );
}
