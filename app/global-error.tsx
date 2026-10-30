"use client";

/**
 * Last-resort boundary for errors in the root layout itself (providers, fonts). It replaces
 * the layout, so it cannot use the locale context or the app stylesheet: both languages are
 * shown and the styling is inline.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ar" dir="rtl">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#F5F7F4", color: "#1F3D24" }}>
        <main role="alert" style={{ maxWidth: 480, margin: "15vh auto", padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 20 }}>حصل خطأ غير متوقع</h1>
          <p lang="en" dir="ltr" style={{ color: "#5B6B5D" }}>Something went wrong.</p>
          {error.digest && <p dir="ltr" style={{ fontSize: 12, color: "#5B6B5D" }}>ref: {error.digest}</p>}
          <button type="button" onClick={reset} style={{ marginTop: 12, padding: "10px 20px", fontSize: 16, borderRadius: 8, border: 0, background: "#227C43", color: "#fff", cursor: "pointer" }}>
            حاول تاني · Try again
          </button>
        </main>
      </body>
    </html>
  );
}
