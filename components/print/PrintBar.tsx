"use client";

import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { useLocale } from "@/lib/locale";

/** Screen-only toolbar (hidden on the printed page itself via .no-print) */
export function PrintBar({ backHref }: { backHref: string }) {
  const { t } = useLocale();
  return (
    <div className="no-print sticky top-0 z-10 bg-united-dark text-white px-4 py-3 flex items-center justify-between gap-3">
      <Link href={backHref} className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold hover:underline">
        <ArrowLeft size={16} className="rtl:rotate-180" aria-hidden /> {t("ui.back")}
      </Link>
      <button onClick={() => window.print()} className="btn btn-sm gap-1.5 bg-white px-5 text-united-dark hover:bg-united-subtle">
        <Printer size={16} aria-hidden /> {t("ui.print")}
      </button>
    </div>
  );
}