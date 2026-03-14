import cybergridPreset from "@nil-store/cybergrid-theme/tailwind-preset";

/** @type {import('tailwindcss').Config} */
export default {
  presets: [cybergridPreset],
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
    },
  },
  plugins: [],
}
