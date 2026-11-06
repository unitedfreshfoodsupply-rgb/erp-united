import { AccessDenied } from "@/components/AccessDenied";
import { getAuthContext } from "@/lib/authz";
import { redirect } from "next/navigation";

/** Landing place for a signed-in account that holds no module permission at all —
 * e.g. every permission revoked by override. Better than an infinite redirect loop. */
export default async function NoAccessPage() {
  const user = await getAuthContext();
  if (!user) redirect("/login");
  // The card brings the shell (header, sign-out) with it.
  return <AccessDenied role={user.role} homeHref="/no-access" />;
}
