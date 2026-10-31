import type { Metadata } from "next";
// IBM Plex Sans Arabic (Arabic + Latin), served from the app itself — no font CDN.
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans-arabic/700.css";
import "./globals.css";
import { cookies } from "next/headers";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "UNITED — نظام التجهيز والتحميل",
  description: "UNITED Fruits & Vegetables — Production & Dispatch System",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Layout hint only (set by components/Nav.tsx): whether this browser's last session had the
  // grouped desktop sidebar, so the page reserves its width before the session has loaded.
  const shell = cookies().get("u_shell")?.value === "grouped" ? "grouped" : "tabs";
  const rail = cookies().get("u_rail")?.value === "1" ? "1" : "0";
  return (
    <html lang="ar" dir="rtl" data-shell={shell} data-rail={rail} suppressHydrationWarning>
      <body className="font-arabic bg-united-bg text-united-dark">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
