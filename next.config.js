/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // Don't advertise the framework to every visitor for free.
  poweredByHeader: false,
  // Baseline security headers. The Content-Security-Policy is NOT here: it needs a fresh
  // nonce per request (Next's hydration payload is an inline <script>), so middleware.ts
  // sets it (lib/security/csp.ts). Browsers intersect two CSP headers, so this file must
  // never add a second one.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Nothing in the app uses the camera, microphone, location or payment APIs; the
          // attendance device posts over HTTP, not through the browser.
          // WS6: extended to the other powerful features nothing here uses.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=(), browsing-topics=()",
          },
          // No other site's window may hold a reference to ours (tab-nabbing, XS-leaks).
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
  // `next dev` and `next build` both own .next, so running a production build while a
  // dev server is up leaves each of them with half a build directory — the symptom is
  // a route that exists in the build log but 500s at runtime with "Cannot find module".
  // NEXT_DIST_DIR lets a production smoke test build somewhere else and run alongside
  // the dev server. Unset (the normal case) it is exactly the default.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

module.exports = nextConfig;
