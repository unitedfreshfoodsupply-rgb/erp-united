"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePermissions } from "@/lib/use-session";
import { PROFILE_PAGE } from "@/lib/profiles/access";
import { href, linkFor } from "@/lib/profiles/links";

/**
 * A customer, supplier or product name that opens its profile — for viewers whose
 * permissions open the profile; everyone else sees the name as text. Documents the same:
 * a number links only when the viewer can open where it points.
 */
export function PartyLink({ kind, id, name, className }: { kind: "customer" | "supplier" | "product"; id: string | null | undefined; name: ReactNode; className?: string }) {
  const { can } = usePermissions();
  if (!id || !can(PROFILE_PAGE[kind])) return <span className={className}>{name}</span>;
  return <Link href={href[kind](id)} className={`font-bold text-united-green hover:underline ${className ?? ""}`}>{name}</Link>;
}

export function DocLink({ href: url, children, className }: { href: string | null | undefined; children: ReactNode; className?: string }) {
  const { can } = usePermissions();
  const target = linkFor(can, url ?? null);
  if (!target) return <span dir="ltr" className={`whitespace-nowrap ${className ?? ""}`}>{children}</span>;
  return <Link href={target} dir="ltr" className={`whitespace-nowrap font-bold text-united-green hover:underline ${className ?? ""}`}>{children}</Link>;
}
