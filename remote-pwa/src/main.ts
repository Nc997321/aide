import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";

createApp(App).mount("#app");

// PWA 离线壳：注册 service worker（相对路径，子路径部署也生效）
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // 注册失败不阻塞使用（如非 HTTPS 环境）
    });
  });
}
