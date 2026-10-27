/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        united: {
          dark: "#1f3d24",
          green: "#3f8f3f",
          light: "#8fd15a",
          bg: "#f4f8f2",
          warn: "#c8811a",
          danger: "#c23b3b",
          info: "#2f6fa8",
          border: "rgba(31,61,36,0.08)",
          muted: "rgba(31,61,36,0.55)",
        },
      },
      fontFamily: {
        arabic: ["Tajawal", "Cairo", "Arial", "system-ui", "sans-serif"],
        // Applied by lib/locale/context.tsx in English; without it the body lost its
        // font family entirely and fell back to the browser's serif default.
        english: ["Inter", "Segoe UI", "Arial", "system-ui", "sans-serif"],
        english: ["Inter", "system-ui", "Segoe UI", "Roboto", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(31,61,36,0.04), 0 1px 12px rgba(31,61,36,0.05)",
        "card-hover": "0 4px 20px rgba(31,61,36,0.10)",
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
