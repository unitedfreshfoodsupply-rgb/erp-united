import type { Metadata } from "next";
// IBM Plex Sans Arabic (Arabic + Latin), served from the app itself — no font CDN.
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans-arabic/700.css";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "UNITED — نظام التجهيز والتحميل",
  description: "UNITED Fruits & Vegetables — Production & Dispatch System",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className="font-arabic bg-united-bg text-united-dark">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
