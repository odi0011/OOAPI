import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { publicProviders } from "../ooapi-server/src/services/channel-types.js";

// 公共静态元信息也随前端构建，兼容后端尚未更新 /catalog 的滚动升级窗口。
// 只取公开展示字段，绝不把渠道账号、URL 或凭据形态打进客户端。
const catalog = publicProviders().filter((p) => p.key !== "custom").map((p) => ({
  key: p.key, name: p.name, icon: p.icon, methods: p.methods.map((m) => m.label),
}));

export default defineConfig({
  plugins: [react()],
  define: { __OOAPI_PUBLIC_CATALOG__: JSON.stringify(catalog) },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:3001", changeOrigin: true },
      "/logo.jpg": { target: "http://127.0.0.1:3001", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1600,
  },
});
