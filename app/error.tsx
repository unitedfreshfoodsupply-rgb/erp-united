"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/locale";

/**
 * Route-level error boundary. A render error in any page used to replace the whole screen
 * with the bare Next.js error; this keeps the operator inside the app with a way back:
 * retry the same screen (most failures are a dropped connection) or go home. The digest
 * is the server log reference, so a screenshot is enough to find the error.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useLocale();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 p-6 text-center" role="alert">
      <h1 className="text-xl font-bold">{t("error.page.title")}</h1>
      <p className="text-united-muted">{t("error.page.body")}</p>
      {error.digest && <p className="text-xs text-united-muted" dir="ltr">{t("error.page.ref")}: {error.digest}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={reset}>{t("error.page.retry")}</button>
        <Link href="/" className="btn-ghost">{t("error.page.home")}</Link>
      </div>
    </main>
  );
}
