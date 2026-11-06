"use client";

import { SearchX } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/lib/locale";

/** Custom 404 page — friendlier than the browser's default "Not Found". */
export default function NotFound() {
  const { t } = useLocale();
  // The path asked for, in the server HTML too (no line appearing after hydration).
  const path = usePathname();

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="card p-8 w-full max-w-md flex flex-col gap-4 items-center text-center">
        <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full bg-united-subtle text-united-muted"><SearchX size={22} /></span>
        <h1 className="text-xl font-bold text-united-dark">{t("ui.not-found")}</h1>
        {path && (
          <p className="text-sm font-bold text-united-muted">
            {/* A left-to-right run of its own: in Arabic the leading slash stays in front. */}
            <code dir="ltr" className="text-xs">{path}</code>
          </p>
        )}
        <p className="text-sm text-united-muted">{t("ui.not-found-desc")}</p>
        <Link href="/" className="btn-primary px-8">{t("ui.back-home")}</Link>
      </div>
    </main>
  );
}
