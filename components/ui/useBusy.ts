"use client";

import { useCallback, useRef, useState } from "react";

/**
 * One action at a time in a section of a screen (a document's posting buttons, a form's
 * submit). `run(key, fn)` ignores a second call while one is in flight — a double tap on a
 * slow posting no longer reaches the server twice — and `busy` names the running action, so
 * that button can say what it is doing (`busy === "issue" ? t("…ing") : label`) and every
 * other button in the section can wait (`disabled={!!busy}`).
 */
export function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const run = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(key);
    try {
      await fn();
    } finally {
      running.current = false;
      setBusy(null);
    }
  }, []);
  return { busy, run };
}
