import type { Metadata } from "next";
// IBM Plex Sans Arabic (Arabic + Latin), served from the app itself — no font CDN.
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans-arabic/700.css";
import "./globals.css";
import { cookies, headers } from "next/headers";
import { Providers } from "./providers";
import { DICTIONARY } from "@/lib/locale/dictionary";
import { LOCALE_COOKIE, initialLocale } from "@/lib/locale/cookie";

/** The language this page is rendered in: the reader's choice (cookie), else their browser's. */
function pageLocale() {
  return initialLocale(cookies().get(LOCALE_COOKIE)?.value, headers().get("accept-language"));
}

export function generateMetadata(): Metadata {
  return {
    title: DICTIONARY["app.title"][pageLocale()],
    description: "UNITED Fruits & Vegetables — Production & Dispatch System",
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Layout hint only (set by components/Nav.tsx): whether this browser's last session had the
  // grouped desktop sidebar, so the page reserves its width before the session has loaded.
  const shell = cookies().get("u_shell")?.value === "grouped" ? "grouped" : "tabs";
  const rail = cookies().get("u_rail")?.value === "1" ? "1" : "0";
  // Rendered in the reader's language from the first byte (lib/locale/cookie.ts), so the page
  // is visible as soon as it arrives, in the right direction and font.
  const locale = pageLocale();
  return (
    <html lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} data-shell={shell} data-rail={rail} suppressHydrationWarning>
      <body className={`${locale === "ar" ? "font-arabic" : "font-english"} bg-united-bg text-united-dark`}>
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
