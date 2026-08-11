import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { effectScope, ref, type Ref } from "vue";
import { useTaskListCollapse } from "./useTaskListCollapse";

/** composable 依赖 watch / onUnmounted，须在 effectScope 内挂载；scope.stop 触发卸载。 */
describe("useTaskListCollapse", () => {
  let scope: ReturnType<typeof effectScope>;
  let len: Ref<number>;

  beforeEach(() => {
    vi.useFakeTimers();
    len = ref(0);
    scope = effectScope();
  });
  afterEach(() => {
    scope.stop();
    vi.useRealTimers();
  });

  function mount() {
    // scope.run 内同步调用 useTaskListCollapse，watch immediate 在此处同步跑
    return scope.run(() => useTaskListCollapse(() => len.value))!;
  }

  it("长度增长 → 展开 + STABLE_MS 后自动折叠", async () => {
    const { collapsed } = mount();
    expect(collapsed.value).toBe(false);
    len.value = 3;
    await vi.advanceTimersByTimeAsync(799);
    expect(collapsed.value).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(collapsed.value).toBe(true);
  });

  it("连续增长重置计时器——最后一次增长后 STABLE_MS 才折叠", async () => {
    const { collapsed } = mount();
    len.value = 1;
    await vi.advanceTimersByTimeAsync(500);
    len.value = 2; // 重置
    await vi.advanceTimersByTimeAsync(500);
    expect(collapsed.value).toBe(false);
    len.value = 3; // 重置
    await vi.advanceTimersByTimeAsync(799);
    expect(collapsed.value).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(collapsed.value).toBe(true);
  });

  it("状态变化（长度不变）不触发展开——折叠态下进度仍由摘要条更新", async () => {
    const { collapsed } = mount();
    len.value = 2;
    await vi.advanceTimersByTimeAsync(800);
    expect(collapsed.value).toBe(true);
    // 长度不变（模拟 pending→in_progress→completed）：watch 不触发
    len.value = 2;
    await vi.advanceTimersByTimeAsync(2000);
    expect(collapsed.value).toBe(true);
  });

  it("手动 toggle → 切换折叠态并取消待执行的自动折叠", async () => {
    const { collapsed, toggleCollapse } = mount();
    len.value = 3;
    await vi.advanceTimersByTimeAsync(400); // 距折叠还有 400ms
    toggleCollapse(); // 手动折叠 + 清计时器
    expect(collapsed.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); // 计时器已清，无副作用
    expect(collapsed.value).toBe(true);
    toggleCollapse(); // 手动展开
    expect(collapsed.value).toBe(false);
    await vi.advanceTimersByTimeAsync(5000); // 手动展开后无计时器，保持展开
    expect(collapsed.value).toBe(false);
  });

  it("手动展开后不被自动收起，直到下次长度增长重新启动自动折叠", async () => {
    const { collapsed, toggleCollapse } = mount();
    len.value = 2;
    await vi.advanceTimersByTimeAsync(800); // 自动折叠
    expect(collapsed.value).toBe(true);
    toggleCollapse(); // 手动展开
    await vi.advanceTimersByTimeAsync(5000);
    expect(collapsed.value).toBe(false); // 不被自动收起
    len.value = 3; // 新建 → 重新展开 + 计时
    expect(collapsed.value).toBe(false);
    await vi.advanceTimersByTimeAsync(800);
    expect(collapsed.value).toBe(true);
  });

  it("卸载时清理计时器——scope.stop 后推进时间无残留回调", async () => {
    const { collapsed } = mount();
    len.value = 1;
    await vi.advanceTimersByTimeAsync(400); // timer 剩 400ms
    scope.stop(); // 触发 onUnmounted → clearTimer
    await vi.advanceTimersByTimeAsync(5000);
    expect(collapsed.value).toBe(false); // 没折叠
  });
});