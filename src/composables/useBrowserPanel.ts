// 内嵌浏览器主区面板开关（模块级单例，与 useKnowledgeBase / useMarketplace 同范式）。
//
// 形态：浏览器是**主区一级视图**（跟「插件」「知识库」一样，不占会话 tab、不碰 pane 布局），
// 面板自带标签条。
//
// 本模块只管「面板开没开 / 组件挂没挂」；标签页与原生视图的生命周期在 BrowserPanel.vue
// （它才量得到占位洞的坐标）。**浏览器视图的 id 由 Rust 注册表发**，前端不造——见 facade.rs。
import { ref } from "vue";

const panelOpen = ref(false);

/**
 * 首次打开后置真：面板组件懒挂载（异步 chunk 不在启动时拉），挂上后常驻（v-show 切换）。
 *
 * 常驻的意义 = **保活**：关面板 / 切到别的面板只把原生视图 `setVisible(false)`，视图还在 Rust
 * 注册表里——切回来时同一页面、同一滚动位置、前进后退历史都在（不重新加载）。
 */
const everOpened = ref(false);

function openPanel() {
  everOpened.value = true;
  panelOpen.value = true;
}
function closePanel() {
  panelOpen.value = false;
}
function togglePanel() {
  if (panelOpen.value) closePanel();
  else openPanel();
}

export function useBrowserPanel() {
  return { panelOpen, everOpened, openPanel, closePanel, togglePanel };
}
