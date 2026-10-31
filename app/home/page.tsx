import { requireAnyPagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { HomeView } from "@/components/home/HomeView";
import { HOME_PERMISSIONS } from "@/lib/home/summary";
import type { Permission } from "@/lib/permissions";

export default async function HomePage() {
  const gate = await requireAnyPagePermission([...HOME_PERMISSIONS] as Permission[]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  return (
    <main className="min-h-screen">
      <Nav />
      <HomeView name={gate.user.name} />
    </main>
  );
}
