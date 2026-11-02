/** @type {import('tailwindcss').Config} */
// UNITED design tokens — see docs/erp/DESIGN_SYSTEM.md for the palette and its rationale.
// Brand colours are sampled from public/logo-united.png (deep green #227C43 at the base of
// the U, lime #9FCE5C at its tips, ink #1F3D24 darker than the wordmark for text contrast).
// Every text colour here meets WCAG AA (4.5:1) on white; the lime is decorative only.
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Touch pointers (tablets on the floor, phones): controls grow to the 44px target there
      // without making desk screens sparse. Use as `coarse:min-h-[44px]`.
      screens: { coarse: { raw: "(pointer: coarse)" } },
      colors: {
        // Read from the CSS variables in app/globals.css (RGB channels, so `/opacity` works):
        // the palette has one source of truth. Values are the audited ones listed there.
        united: {
          dark: "rgb(var(--u-ink-rgb) / <alpha-value>)", // ink — headings, primary text (12.0:1 on white)
          green: "rgb(var(--u-primary-rgb) / <alpha-value>)", // primary — actions, active, success
          light: "rgb(var(--u-accent-rgb) / <alpha-value>)", // logo lime — accents only, never text
          bg: "rgb(var(--u-bg-rgb) / <alpha-value>)", // page
          surface: "rgb(var(--u-surface-rgb) / <alpha-value>)",
          subtle: "rgb(var(--u-subtle-rgb) / <alpha-value>)", // quiet fills: table heads, secondary buttons
          warn: "rgb(var(--u-warn-rgb) / <alpha-value>)", // 5.0:1 on white
          danger: "rgb(var(--u-danger-rgb) / <alpha-value>)", // 6.6:1
          info: "rgb(var(--u-info-rgb) / <alpha-value>)", // 6.6:1
          border: "rgb(var(--u-border-rgb) / <alpha-value>)",
          "border-strong": "rgb(var(--u-border-strong-rgb) / <alpha-value>)",
          field: "rgb(var(--u-field-rgb) / <alpha-value>)", // form-control outline (3.1:1, WCAG 1.4.11)
          muted: "rgb(var(--u-muted-rgb) / <alpha-value>)", // secondary text (5.7:1)
        },
      },
      fontFamily: {
        // One family for both scripts: IBM Plex Sans Arabic carries Arabic and Latin with
        // matching metrics, loaded locally from @fontsource (no network at build or runtime).
        sans: ["'IBM Plex Sans Arabic'", "system-ui", "'Segoe UI'", "Arial", "sans-serif"],
        arabic: ["'IBM Plex Sans Arabic'", "Tajawal", "Arial", "system-ui", "sans-serif"],
        english: ["'IBM Plex Sans Arabic'", "system-ui", "'Segoe UI'", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      // The screens were written with font-bold / font-extrabold everywhere; mapping them one
      // step lighter restores hierarchy without touching every component.
      fontWeight: {
        bold: "600",
        extrabold: "700",
        black: "700",
      },
      borderRadius: {
        xl: "0.625rem",
        "2xl": "0.75rem",
      },
      boxShadow: {
        card: "0 1px 2px rgba(31,61,36,0.05)",
        "card-hover": "0 2px 8px rgba(31,61,36,0.08)",
        pop: "0 8px 28px rgba(31,61,36,0.16)",
      },
      keyframes: {
        "toast-in": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        "pulse-dot": "pulse-dot 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
