import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/authz";
import { signInPath } from "@/lib/session-guard";
import { Nav } from "@/components/Nav";
import { ApprovalsInbox } from "@/components/approvals/ApprovalsInbox";

/** Any signed-in user may open this: it lists the requests they can decide and the
 * ones they raised. What they may DECIDE is checked per request on the server. */
export default async function ApprovalsPage() {
  const user = await getAuthContext();
  if (!user) redirect(await signInPath());
  return (
    <main className="min-h-screen">
      <Nav />
      <ApprovalsInbox />
    </main>
  );
}
