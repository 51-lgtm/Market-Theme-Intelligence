import { defineConfig } from "vite";
export default defineConfig({
  base: "/astra/",
  server: {
    port: 5173,
    proxy: {
      "/api/astra": { target: "http://127.0.0.1:8000", changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
