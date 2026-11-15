/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The broker serves index.html at / and everything else under /web/ (see serveStatic in src/broker/broker.ts).
// `npm run dev:web` runs Vite on :5173 and forwards the API and WebSocket to a broker on :8787.
const broker = process.env.AICHAT_DEV_BROKER ?? "http://127.0.0.1:8787";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/web/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    proxy: {
      "/api": broker,
      "/admin/api": broker,
      "/client": broker,
      "/ws": { target: broker.replace(/^http/, "ws"), ws: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
