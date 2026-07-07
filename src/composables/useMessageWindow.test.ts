import { describe, it, expect } from "vitest";
import { ref, nextTick } from "vue";
import { useMessageWindow } from "./useMessageWindow";

function makeList(n: number, prefix = "m"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

describe("useMessageWindow", () => {
  it("整表不超初始窗口时全部可见,且透传原数组引用", () => {
    const list = ref(makeList(10));
    const sid = ref<string | null>("s1");
    const { visible, hiddenCount } = useMessageWindow(() => list.value, () => sid.value, {
      initialSize: 30,
    });
    expect(visible.value).toBe(list.value);
    expect(hiddenCount.value).toBe(0);
  });

  it("超窗时只渲染尾部 N 条,hiddenCount 是窗口上方的条数", () => {
    const list = ref(makeList(100));
    const sid = ref<string | null>("s1");
    const { visible, hiddenCount } = useMessageWindow(() => list.value, () => sid.value, {
      initialSize: 30,
    });
    expect(visible.value.length).toBe(30);
    expect(visible.value[0]).toBe("m70");
    expect(visible.value[29]).toBe("m99");
    expect(hiddenCount.value).toBe(70);
  });

  it("expandOlder 按 step 向上扩窗", () => {
    const list = ref(makeList(100));
    const sid = ref<string | null>("s1");
    const { visible, hiddenCount, expandOlder } = useMessageWindow(
      () => list.value,
      () => sid.value,
      { initialSize: 30, step: 20 },
    );
    expandOlder();
    expect(visible.value.length).toBe(50);
    expect(visible.value[0]).toBe("m50");
    expect(hiddenCount.value).toBe(50);
  });

  it("扩窗到头后 hiddenCount 归零,再扩是空操作", () => {
    const list = ref(makeList(40));
    const sid = ref<string | null>("s1");
    const { visible, hiddenCount, expandOlder } = useMessageWindow(
      () => list.value,
      () => sid.value,
      { initialSize: 30, step: 30 },
    );
    expandOlder(); // 30 → 60,盖过全表
    expect(visible.value.length).toBe(40);
    expect(hiddenCount.value).toBe(0);
    expandOlder(); // 已全可见:不再增长窗口
    expect(visible.value.length).toBe(40);
  });

  it("流式追加新消息时窗口滑动,最新内容始终在窗内", () => {
    const list = ref(makeList(100));
    const sid = ref<string | null>("s1");
    const { visible } = useMessageWindow(() => list.value, () => sid.value, {
      initialSize: 30,
    });
    list.value.push("new-tail");
    expect(visible.value.length).toBe(30);
    expect(visible.value[29]).toBe("new-tail");
  });

  it("会话 key 变化时窗口重置回初始大小", async () => {
    const list = ref(makeList(100));
    const sid = ref<string | null>("s1");
    const { visible, expandOlder } = useMessageWindow(() => list.value, () => sid.value, {
      initialSize: 30,
      step: 30,
    });
    expandOlder();
    expect(visible.value.length).toBe(60);
    sid.value = "s2";
    await nextTick(); // watch 是异步回调
    expect(visible.value.length).toBe(30);
  });
});
