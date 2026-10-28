/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // Don't advertise the framework to every visitor for free.
  poweredByHeader: false,
  // Baseline security headers the app had none of. Deliberately NOT a Content-Security-
  // Policy: Next's own hydration payload is an inline <script>, so a CSP tight enough to
  // matter needs per-request nonces wired through the App Router — a real change, not a
  // one-line header, and one that's easy to get subtly wrong (silently breaking the app)
  // without a way to verify it against the actual production origin from here. These
  // four are safe, well-understood, and cannot break the app.
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
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
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
