import { Nav } from "@/components/Nav";
import { AccessDenied } from "@/components/AccessDenied";
import { getAuthContext } from "@/lib/authz";
import { signInPath } from "@/lib/session-guard";
import { redirect } from "next/navigation";

/** Landing place for a signed-in account that holds no module permission at all —
 * e.g. every permission revoked by override. Better than an infinite redirect loop. */
export default async function NoAccessPage() {
  const user = await getAuthContext();
  if (!user) redirect(await signInPath());
  return (
    <main className="min-h-screen">
      <Nav />
      <AccessDenied role={user.role} homeHref="/no-access" />
    </main>
  );
}
