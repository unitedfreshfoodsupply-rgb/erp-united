import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/authz";
import { ProfileView } from "@/components/profile/ProfileView";

/**
 * Read-only profile page — visible to every authenticated user.
 *
 * Policy: the profile is for viewing only. Users cannot edit their name, username,
 * role, permissions, status, or password here or anywhere else; all user
 * administration (including password resets) happens through the administrator's
 * user-management screens and is enforced server-side.
 *
 * The data comes from the request's own auth context — there is no way to view
 * another user's profile through this page, and nothing sensitive is passed down.
 */
export default async function ProfilePage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  return (
    <ProfileView
      user={{
        id: ctx.id,
        name: ctx.name,
        username: ctx.username,
        role: ctx.role,
        active: ctx.active,
        mustChangePassword: ctx.mustChangePassword,
        permissions: [...ctx.permissions].sort(),
      }}
    />
  );
}
