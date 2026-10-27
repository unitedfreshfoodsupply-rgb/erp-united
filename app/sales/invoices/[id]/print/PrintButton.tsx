"use client";

/** Labelled in the invoice's own language (the page's `?lang=`), not the app's. */
export function PrintButton({ lang = "ar" }: { lang?: "ar" | "en" }) {
  return (
    <button type="button" className="btn-primary mt-6 print:hidden" onClick={() => window.print()}>
      {lang === "en" ? "Print" : "طباعة"}
    </button>
  );
}
