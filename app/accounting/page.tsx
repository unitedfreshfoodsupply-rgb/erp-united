import { requireAnyPagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { Nav } from "@/components/Nav";
import { AccountingView } from "@/components/accounting/AccountingView";

export default async function AccountingPage() {
  // Full visibility, or one of the workflows a clerk is given (the view shows only those tabs).
  const gate = await requireAnyPagePermission(["accounting.view", "accounting.receipts.manage", "accounting.payments.manage"]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  return (
    <main className="min-h-screen">
      <Nav />
      <AccountingView />
    </main>
  );
}
