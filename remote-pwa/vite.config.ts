import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig({
  plugins: [vue()],
  // 相对路径 base：dist 可部署到任意静态托管（VPS 根路径或子路径）
  base: "./",
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    // 手机真机调试需要局域网访问
    host: true,
  },
  test: {
    environment: "jsdom",
  },
});
