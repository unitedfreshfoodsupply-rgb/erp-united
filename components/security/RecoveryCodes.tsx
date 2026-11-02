"use client";

import { useState } from "react";
import { useLocale } from "@/lib/locale";

/** Recovery codes, shown once: a list to write down, a copy button, and nothing stored
 * anywhere on this device (no storage, no cache — the server sent them no-store). */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="rounded-lg border border-[#F3D9AE] bg-[#FFFBF3] p-3 text-sm font-medium text-united-warn">{t("mfa.recovery.warning")}</p>
      <ol className="grid grid-cols-2 gap-2 rounded-lg bg-united-subtle p-3 font-mono text-sm" dir="ltr">
        {codes.map((c) => (
          <li key={c} className="tabular-nums">{c}</li>
        ))}
      </ol>
      <button type="button" className="btn-secondary btn-sm self-start" onClick={copy}>
        {copied ? t("mfa.recovery.copied") : t("mfa.recovery.copy")}
      </button>
    </div>
  );
}
