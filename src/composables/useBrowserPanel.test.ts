import { describe, it, expect, beforeEach } from "vitest";
import { useBrowserPanel } from "./useBrowserPanel";

// 模块级单例（与 useMarketplace/useKnowledgeBase 同范式）：用例间共享状态，故每个用例前复位。
// 只复位 panelOpen——`everOpened` 一旦置真就保持，那正是「挂上后常驻 = 保活」的语义。
describe("useBrowserPanel", () => {
  beforeEach(() => {
    useBrowserPanel().closePanel();
  });

  it("open / close / toggle 三个入口改同一个开关", () => {
    const { panelOpen, openPanel, closePanel, togglePanel } = useBrowserPanel();
    expect(panelOpen.value).toBe(false);
    openPanel();
    expect(panelOpen.value).toBe(true);
    closePanel();
    expect(panelOpen.value).toBe(false);
    togglePanel();
    expect(panelOpen.value).toBe(true);
    togglePanel();
    expect(panelOpen.value).toBe(false);
  });

  it("首次打开后 everOpened 恒真（懒挂载 + 挂上不卸载）", () => {
    const { everOpened, openPanel, closePanel } = useBrowserPanel();
    openPanel();
    expect(everOpened.value).toBe(true);
    closePanel();
    expect(everOpened.value).toBe(true);
  });
});
