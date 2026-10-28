import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

/**
 * Every page opens the same way: an optional back link, the title (one h1), a short line
 * saying what the page is for, and the page's own actions at the inline end. Live status
 * (LiveIndicator) sits with the actions so it never pushes the title around.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="flex flex-col gap-1">
      {back && (
        <Link href={back.href} className="-ms-1 mb-1 inline-flex min-h-[44px] w-fit items-center gap-1.5 px-1 text-sm font-medium text-united-muted hover:text-united-dark">
          <ArrowLeft size={16} className="rtl:rotate-180" aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="page-title">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-united-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
