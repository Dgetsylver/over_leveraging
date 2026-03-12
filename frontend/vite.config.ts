import { defineConfig } from "vite";

export default defineConfig({
  base: "/over_leveraging/",
  define: {
    // Some Stellar SDK internals check for global
    global: "globalThis",
  },
  build: {
    target: "es2020",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "es2020",
    },
  },
});
