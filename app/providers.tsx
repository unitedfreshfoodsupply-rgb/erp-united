"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ToastProvider } from "@/components/ui/Toast";
import { DialogProvider } from "@/components/ui/Dialog";
import { LocaleProvider } from "@/lib/locale";
import { unlockAudio } from "@/lib/sound";

export function Providers({ children }: { children: React.ReactNode }) {
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
            // This app runs as dedicated always-on tablet screens, not a tab a human
            // actively clicks between — React Query's default pauses `refetchInterval`
            // whenever the page isn't the focused tab, which silently stalls live
            // updates on a second monitor/tablet exactly when it matters most.
            refetchIntervalInBackground: true,
            retry: 1,
          },
        },
      })
  );
  return (
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <ToastProvider>
          <DialogProvider>{children}</DialogProvider>
        </ToastProvider>
      </LocaleProvider>
    </QueryClientProvider>
  );
}
