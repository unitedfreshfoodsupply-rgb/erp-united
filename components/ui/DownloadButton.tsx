"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { apiDownload, errorMessage } from "@/lib/api-client";
import { useLocale } from "@/lib/locale";
import { useToast } from "@/components/ui/Toast";

/**
 * A file download (a CSV, a register, an export) as a button. A plain <a href download> hands a
 * refusal or a server fault to the browser, which saves the error body as the file or shows its
 * own "download failed"; this fetches it through apiDownload, so a failure is an error toast with
 * the server's message and its reference. Busy (a spinner, announced) while the file is fetched;
 * never sent twice.
 */
export function DownloadButton({ href, fileName, className, children }: { href: string; fileName: string; className?: string; children: ReactNode }) {
  const { t } = useLocale();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // aria-disabled, not disabled: a disabled button drops the keyboard focus to <body>. The
  // guard below keeps a second press from sending it twice; the live region says it is under way.
  return (
    <>
      <button
        type="button"
        className={`${className ?? ""}${busy ? " cursor-wait opacity-70" : ""}`}
        aria-disabled={busy}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          try {
            await apiDownload(href, fileName);
          } catch (err) {
            toast.show(errorMessage(err) ?? t("ui.error.generic"), "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
        {busy && <Loader2 aria-hidden className="inline-block ms-1 h-3.5 w-3.5 animate-spin align-[-2px]" />}
      </button>
      <span role="status" aria-live="polite" className="sr-only">{busy ? t("ui.downloading") : ""}</span>
    </>
  );
}
