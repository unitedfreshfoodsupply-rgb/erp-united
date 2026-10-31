import { requireAnyPagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { AssetsView } from "@/components/assets/AssetsView";

export default async function AssetsPage() {
  const gate = await requireAnyPagePermission(["accounting.assets.view"]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  return (
    <main className="min-h-screen">
      <Nav />
      <AssetsView />
    </main>
  );
}
