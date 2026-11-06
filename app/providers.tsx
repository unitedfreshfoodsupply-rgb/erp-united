"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ToastProvider } from "@/components/ui/Toast";
import { DialogProvider } from "@/components/ui/Dialog";
import { LocaleProvider, type Locale } from "@/lib/locale";
import { unlockAudio } from "@/lib/sound";
import { isRefusal } from "@/lib/hooks/refusal";

export function Providers({ children, locale = "ar" }: { children: React.ReactNode; locale?: Locale }) {
  // Browsers won't play audio until a real user gesture happens — catch the
  // very first tap/click anywhere on the app and use it to unlock notification sounds.
  useEffect(() => {
    const unlock = () => {
      unlockAudio();
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);

  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: true,
            // Polling (`refetchInterval`) runs while the page is visible, focused or not — a
            // tablet or a second monitor showing a board keeps updating — and pauses only in a
            // hidden tab (React Query checks document.visibilityState), which catches up the
            // moment it is shown again (refetchOnWindowFocus). The wall-screen boards that chime
            // (prep, load, supervisor, exceptions) keep polling even hidden: they say so on
            // their own query with refetchIntervalInBackground.
            // One more try for a failure that may pass (network, server fault, timeout, rate
            // limit); none for a refusal — a permission, a missing record, a refused filter
            // answer the same the second time, and the retry only delayed the message.
            retry: (failures, error) => !isRefusal(error) && failures < 1,
          },
        },
      })
  );
  return (
    <QueryClientProvider client={client}>
      <LocaleProvider initialLocale={locale}>
        <ToastProvider>
          <DialogProvider>{children}</DialogProvider>
        </ToastProvider>
      </LocaleProvider>
    </QueryClientProvider>
  );
}
