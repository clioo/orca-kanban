import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The board UI is served by the Work board service from the plugin's
// `web/` folder; relative asset URLs keep it independent of the port.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../../dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  test: {
    root: ".",
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "threads",
  },
});
