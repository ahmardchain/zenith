import { defineConfig } from "vite";

export default defineConfig({
  define: { "process.env": {}, global: "globalThis" },
  server: { fs: { allow: [".."] } },
  build: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
