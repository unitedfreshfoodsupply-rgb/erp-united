import { NAV_GROUPS, visibleNavLinks } from "@/lib/nav";

/**
 * Which shell a set of permissions gets (components/Nav.tsx): roles that span several
 * departments get the grouped sidebar, roles with a handful of screens a row of tabs.
 */
export type ShellShape = "grouped" | "tabs";

export function shellShapeFor(permissions: Iterable<string>): ShellShape {
  const links = visibleNavLinks(permissions);
  const groups = NAV_GROUPS.filter((g) => links.some((l) => l.group === g.key));
  return links.length > 7 && groups.length > 1 ? "grouped" : "tabs";
}

/**
 * Remembers the shell shape as a layout hint: the u_shell cookie that app/layout.tsx reads as
 * <html data-shell> on the next page load, and the attribute itself for the pages this tab
 * opens without a reload (the root layout is not rendered again on a client navigation).
 * Called by Nav once the session is known, and by the sign-in form as soon as it is, so the
 * first page after signing in already holds the right shell while its session loads.
 */
export function rememberShellShape(shape: ShellShape) {
  if (typeof document === "undefined") return;
  if (document.documentElement.dataset.shell !== shape) document.documentElement.dataset.shell = shape;
  if (!document.cookie.split("; ").includes(`u_shell=${shape}`)) {
    document.cookie = `u_shell=${shape}; path=/; max-age=31536000; samesite=lax`;
  }
}
