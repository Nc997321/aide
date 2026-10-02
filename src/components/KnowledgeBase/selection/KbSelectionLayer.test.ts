// @vitest-environment jsdom
// 圈选层的交互逻辑（jsdom 没有排版，矩形用 mock 顶上；这里测的是「状态与流程」，不是像素）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";

vi.mock("./layoutRects", async (importOriginal) => {
  const real = await importOriginal<typeof import("./layoutRects")>();
  return { ...real, rectsInScroller: () => [{ x: 40, y: 120, w: 160, h: 22 }] };
});
vi.mock("../kbClient", () => ({
  kb: { revert: vi.fn().mockResolvedValue({ documentId: "doc-1", revisionId: "r", versionNo: 6, merged: false }) },
  KbError: class KbError extends Error {},
}));

import KbSelectionLayer from "./KbSelectionLayer.vue";
import { renderKbMarkdown } from "../markdown";
import { __resetKbSelectionsForTest, useKbSelections } from "@/composables/useKbSelections";
import { emitKbSelectionEvent } from "@aide/sdk/composables/useKbSelectionEvents";
import { kb } from "../kbClient";

const SRC = "# 回滚\n\n出现故障时先切流量到旧版本再排查。\n\n第二段不能动。\n";
let body: HTMLElement;
let scroller: HTMLElement;
let wrapper: VueWrapper | null = null;

function mountLayer(doc = { id: "doc-1", title: "发布流程", versionNo: 5, content: SRC }) {
  document.body.innerHTML = "";
  scroller = document.createElement("div");
  body = document.createElement("div");
  body.innerHTML = renderKbMarkdown(doc.content);
  scroller.appendChild(body);
  document.body.appendChild(scroller);
  wrapper = mount(KbSelectionLayer, { props: { bodyEl: body, scrollEl: scroller, doc }, attachTo: scroller });
  return wrapper;
}

/** 在渲染页里选中 needle，并触发 mouseup（与真实操作同一入口）。 */
async function selectText(needle: string): Promise<void> {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const i = t.data.indexOf(needle);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + needle.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    break;
  }
  body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}

beforeEach(() => {
  __resetKbSelectionsForTest();
  vi.mocked(kb.revert).mockClear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe("选中 → 小入口 → 浮窗", () => {
  it("选中文字只出现一枚小入口，不直接弹浮窗，也不留任何状态（不抢复制）", async () => {
    const w = mountLayer();
    await selectText("切流量到旧版本");
    expect(w.find(".ksl-cta").exists()).toBe(true);
    expect(w.find(".ksl-pop").exists()).toBe(false);
    expect(useKbSelections().all.value).toHaveLength(0);
  });

  it("点小入口 → 浮窗，范围说明写明行号与「这几个字」；此时才产生草稿", async () => {
    const w = mountLayer();
    await selectText("切流量到旧版本");
    await w.find(".ksl-cta").trigger("click");
    await nextTick();
    expect(w.find(".ksl-pop").exists()).toBe(true);
    expect(w.find(".ksl-scope").text()).toBe("第 3 行 · 这几个字");
    expect(w.find(".ksl-hint").text()).toContain("一个字都不会动");
    const [rec] = useKbSelections().all.value;
    expect(rec).toMatchObject({ status: "draft" });
    expect(rec!.ref.text).toBe("切流量到旧版本");
  });

  it("选区含格式被扩大到整块：范围说明换成「整块」并带警示样式", async () => {
    const src = "前面 **加粗的词** 后面。\n";
    const w = mountLayer({ id: "doc-1", title: "t", versionNo: 1, content: src });
    const range = document.createRange();
    range.selectNodeContents(body.querySelector("p")!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    await w.find(".ksl-cta").trigger("click");
    await nextTick();
    expect(w.find(".ksl-scope").classes()).toContain("ksl-scope--wide");
    expect(w.find(".ksl-scope").text()).toContain("整块");
    expect(w.find(".ksl-hint").text()).toContain("已扩大到整块");
  });

  it("没有可圈选的内容（折叠选区）不出入口", async () => {
    const w = mountLayer();
    window.getSelection()!.removeAllRanges();
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.find(".ksl-cta").exists()).toBe(false);
  });
});

describe("根元素不受宿主的居中规则影响（回归：高亮整体向右偏 (文章宽 − 720)/2）", () => {
  it("根元素带行内 max-width:none 与 margin:0——压过宿主 `.kb-doc > * { max-width:720px; margin:0 auto }`", () => {
    const w = mountLayer();
    // 读属性原文而不是 CSSStyleDeclaration：jsdom 的 cssstyle 不认 `max-width: none`，读回来是空串
    const style = (w.element as HTMLElement).getAttribute("style") ?? "";
    expect(style).toMatch(/max-width:\s*none/);
    expect(style).toMatch(/margin:\s*0(px)?\b/);
  });
});

describe("发出去却迟迟没发出（兜底：不让人对着不动的「待发送」发呆）", () => {
  function pendingViaStore() {
    const k = useKbSelections();
    const rec = k.begin({
      documentId: "doc-1", title: "发布流程", baseVersion: 5, baseContent: SRC,
      scope: { start: SRC.indexOf("切流量到旧版本"), end: SRC.indexOf("切流量到旧版本") + 7, text: "切流量到旧版本", lineStart: 3, lineEnd: 3, precise: true },
    });
    k.confirm(rec.ref.selectionId, "x");
    return { k, id: rec.ref.selectionId };
  }

  it("点托盘发送后 2.5 秒仍是待发送：角标改口「还没发出」，点它把聊天亮出来", async () => {
    vi.useFakeTimers();
    try {
      const w = mountLayer();
      const { k } = pendingViaStore();
      await nextTick();
      await vi.advanceTimersByTimeAsync(10);
      await w.find(".ksl-tray .ksl-btn--primary").trigger("click");
      expect(w.find(".ksl-badge").text()).toContain("待发送"); // 刚点完，还不到兜底时间
      await vi.advanceTimersByTimeAsync(2600);
      await nextTick();
      expect(w.find(".ksl-badge-act--stuck").text()).toContain("还没发出");
      const before = k.chatRequest.value?.nonce ?? 0;
      await w.find(".ksl-badge-act--stuck").trigger("click");
      expect(k.chatRequest.value!.nonce).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("发出去了（不再是待发送）就不会误报「还没发出」", async () => {
    vi.useFakeTimers();
    try {
      const w = mountLayer();
      const { k, id } = pendingViaStore();
      await nextTick();
      await vi.advanceTimersByTimeAsync(10);
      await w.find(".ksl-tray .ksl-btn--primary").trigger("click");
      k.markSent([id], "uuid-a");
      await vi.advanceTimersByTimeAsync(2600);
      await nextTick();
      expect(w.find(".ksl-badge-act--stuck").exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("选区方向与松手位置（回归：从后往前选不出入口）", () => {
  /** 用 setBaseAndExtent 造一个**反向**选区：锚点在后、焦点在前（与从右往左拖选同形）。 */
  function selectBackward(needle: string): void {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      const i = t.data.indexOf(needle);
      if (i < 0) continue;
      window.getSelection()!.setBaseAndExtent(t, i + needle.length, t, i);
      return;
    }
    throw new Error("没找到");
  }
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
  };

  it("反向选区、在正文里松手 → 出入口，范围与正向选同一段完全一样", async () => {
    const w = mountLayer();
    selectBackward("切流量到旧版本");
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle();
    expect(w.find(".ksl-cta").exists()).toBe(true);
    await w.find(".ksl-cta").trigger("click");
    await nextTick();
    expect(useKbSelections().all.value[0]!.ref).toMatchObject({ text: "切流量到旧版本", start: SRC.indexOf("切流量到旧版本") });
  });

  it("反向选区、鼠标拖出正文在页边空白处松手（mouseup 的目标在正文之外）→ 照样出入口", async () => {
    const w = mountLayer();
    selectBackward("切流量到旧版本");
    scroller.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); // 目标是滚动容器本身，不在 body 内
    await settle();
    expect(w.find(".ksl-cta").exists()).toBe(true);
  });

  it("选区落在正文之外（比如标题区）→ 不出入口，也不报错", async () => {
    const w = mountLayer();
    const outside = document.createElement("h1");
    outside.textContent = "文档标题";
    scroller.insertBefore(outside, body);
    const r = document.createRange();
    r.selectNodeContents(outside);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
    scroller.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle();
    expect(w.find(".ksl-cta").exists()).toBe(false);
  });

  it("在本层自己的零件上抬起鼠标不当作「选完了文字」（点入口时不会重复读选区）", async () => {
    const w = mountLayer();
    selectBackward("切流量到旧版本");
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle();
    await w.find(".ksl-cta").trigger("mouseup");
    await settle();
    expect(w.find(".ksl-cta").exists()).toBe(true);
  });
});

describe("提交", () => {
  async function openCompose(w: VueWrapper) {
    await selectText("切流量到旧版本");
    await w.find(".ksl-cta").trigger("click");
    await nextTick();
  }

  it("回车 = 确认并立刻发送：圈选变待发送，并向聊天输入框发出发送请求", async () => {
    const w = mountLayer();
    await openCompose(w);
    await w.find(".ksl-input").setValue("写得更具体些");
    const k = useKbSelections();
    const before = k.sendRequest.value?.nonce ?? 0;
    await w.find(".ksl-input").trigger("keydown", { key: "Enter" });
    await nextTick();
    const [rec] = k.all.value;
    expect(rec).toMatchObject({ status: "pending" });
    expect(rec!.ref.comment).toBe("写得更具体些");
    expect(k.sendRequest.value!.nonce).toBe(before + 1);
    expect(w.find(".ksl-pop").exists()).toBe(false);
  });

  it("输入法组词中的回车不提交；Shift+回车是换行", async () => {
    const w = mountLayer();
    await openCompose(w);
    await w.find(".ksl-input").trigger("keydown", { key: "Enter", isComposing: true });
    await w.find(".ksl-input").trigger("keydown", { key: "Enter", shiftKey: true });
    expect(useKbSelections().all.value[0]!.status).toBe("draft");
    expect(w.find(".ksl-pop").exists()).toBe(true);
  });

  it("「再圈一处」只确认、不发送；托盘出现并显示已圈数量", async () => {
    const w = mountLayer();
    await openCompose(w);
    const k = useKbSelections();
    const before = k.sendRequest.value?.nonce ?? 0;
    const buttons = w.findAll(".ksl-pop .ksl-btn");
    await buttons.find((b) => b.text().includes("再圈一处"))!.trigger("click");
    await nextTick();
    expect(k.all.value[0]!.status).toBe("pending");
    expect(k.sendRequest.value?.nonce ?? 0).toBe(before);
    expect(w.find(".ksl-tray").text()).toContain("1 处已圈");
    expect(w.find(".ksl-badge .ksl-pin").text()).toBe("1");
  });

  it("托盘里「一起交给 AI」带上补充说明发出请求", async () => {
    const w = mountLayer();
    await openCompose(w);
    await w.findAll(".ksl-pop .ksl-btn").find((b) => b.text().includes("再圈一处"))!.trigger("click");
    await nextTick();
    await w.find(".ksl-tray-input").setValue("语气正式一点");
    await w.find(".ksl-tray .ksl-btn--primary").trigger("click");
    expect(useKbSelections().sendRequest.value!.text).toBe("语气正式一点");
  });

  it("点常用意图把话填进输入框", async () => {
    const w = mountLayer();
    await openCompose(w);
    await w.findAll(".ksl-intent").find((b) => b.text() === "更简洁")!.trigger("click");
    expect((w.find(".ksl-input").element as HTMLTextAreaElement).value).toBe("更简洁");
  });

  it("Esc 取消：草稿被丢弃，什么都不留", async () => {
    const w = mountLayer();
    await openCompose(w);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(w.find(".ksl-pop").exists()).toBe(false);
    expect(useKbSelections().all.value).toHaveLength(0);
  });
});

describe("发出之后：状态由聊天事件推进", () => {
  async function pendingRecord(w: VueWrapper) {
    await selectText("切流量到旧版本");
    await w.find(".ksl-cta").trigger("click");
    await nextTick();
    await w.find(".ksl-input").setValue("x");
    await w.findAll(".ksl-pop .ksl-btn").find((b) => b.text().includes("再圈一处"))!.trigger("click");
    await nextTick();
    const k = useKbSelections();
    const id = k.all.value[0]!.ref.selectionId;
    k.markSent([id], "uuid-a");
    return { k, id };
  }

  it("处理中：角标显示「AI 处理中」，托盘变成忙碌态", async () => {
    const w = mountLayer();
    const { id } = await pendingRecord(w);
    emitKbSelectionEvent({ kind: "working", sid: "uuid-a", selectionId: id });
    await nextTick();
    expect(w.find(".ksl-badge").text()).toContain("AI 处理中");
    expect(w.find(".ksl-tray--busy").exists()).toBe(true);
  });

  it("改好了：请父层刷新文档；文档到新版本后新范围亮起，可撤销（撤销 = 回到圈选时的版本）", async () => {
    const w = mountLayer();
    const { k, id } = await pendingRecord(w);
    emitKbSelectionEvent({ kind: "working", sid: "uuid-a", selectionId: id });
    emitKbSelectionEvent({ kind: "result", sid: "uuid-a", selectionId: id, ok: true, versionNo: 6 });
    await nextTick();
    expect(w.emitted("refresh")).toEqual([["doc-1"]]);

    const next = SRC.replace("切流量到旧版本", "把入口流量全部切回上一个稳定版本");
    await w.setProps({ doc: { id: "doc-1", title: "发布流程", versionNo: 6, content: next } });
    await nextTick();
    expect(k.records[id]!.newRange).toBeTruthy();
    expect(next.slice(k.records[id]!.newRange!.start, k.records[id]!.newRange!.end)).toBe("把入口流量全部切回上一个稳定版本");
    expect(w.find(".ksl-badge").text()).toContain("已改 · v6");

    await w.find(".ksl-badge-act").trigger("click");
    await flushPromises();
    expect(kb.revert).toHaveBeenCalledWith("doc-1", 5);
    expect(w.emitted("reverted")).toEqual([["doc-1"]]);
  });

  it("之后又有别的改动：撤销按钮禁用（不能把别人的改动一起回掉）", async () => {
    const w = mountLayer();
    const { id } = await pendingRecord(w);
    emitKbSelectionEvent({ kind: "working", sid: "uuid-a", selectionId: id });
    emitKbSelectionEvent({ kind: "result", sid: "uuid-a", selectionId: id, ok: true, versionNo: 6 });
    await w.setProps({ doc: { id: "doc-1", title: "发布流程", versionNo: 7, content: SRC + "别人加的。\n" } });
    await nextTick();
    expect((w.find(".ksl-badge-act").element as HTMLButtonElement).disabled).toBe(true);
  });

  it("被拒绝：角标写人话原因，可以收起", async () => {
    const w = mountLayer();
    const { id } = await pendingRecord(w);
    emitKbSelectionEvent({ kind: "working", sid: "uuid-a", selectionId: id });
    emitKbSelectionEvent({ kind: "result", sid: "uuid-a", selectionId: id, ok: false, message: "Refused: the selected text is no longer where the user selected it" });
    await nextTick();
    expect(w.find(".ksl-badge--refused").text()).toContain("请重新圈选");
    await w.find(".ksl-badge-x").trigger("click");
    expect(useKbSelections().all.value).toHaveLength(0);
  });

  it("文档在圈选之后被改过（原文不在原位）：待发送的高亮不画，角标提示重新圈选", async () => {
    const w = mountLayer();
    await selectText("切流量到旧版本");
    await w.find(".ksl-cta").trigger("click");
    await nextTick();
    await w.findAll(".ksl-pop .ksl-btn").find((b) => b.text().includes("再圈一处"))!.trigger("click");
    await nextTick();
    await w.setProps({ doc: { id: "doc-1", title: "发布流程", versionNo: 6, content: "新增一行。\n\n" + SRC } });
    await nextTick();
    await nextTick();
    expect(w.find(".ksl-badge--stale").exists()).toBe(true);
    expect(w.find(".ksl-badge--stale").text()).toContain("请重新圈选");
    expect(w.findAll(".ksl-hl")).toHaveLength(0);
  });
});
