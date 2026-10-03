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

// 卡片对话的会话层（发送 / 线程 / 权限）由 useKbCardSession.test.ts 单独覆盖；这里只测圈选层怎么用它。
vi.mock("@/composables/useKbCardSession", async () => {
  const { ref } = await import("vue");
  const fake = {
    sid: ref<string | null>(null),
    thread: ref<{ id: string; role: "user" | "ai"; text: string; refs: number; streaming: boolean }[]>([]),
    permission: ref<{ id: string; name: string; input: unknown } | null>(null),
    editRequest: ref<{ selectionId: string; newText: string } | null>(null),
    busy: ref(false),
    sendError: ref<string | null>(null),
    send: vi.fn<(refs: unknown[], note: string) => Promise<string | undefined>>(),
    respond: vi.fn(async () => {}),
    forget: vi.fn(),
  };
  return { useKbCardSession: () => fake, __fake: fake };
});

import KbSelectionLayer from "./KbSelectionLayer.vue";
import { renderKbMarkdown } from "../markdown";
import { __resetKbSelectionsForTest, useKbSelections } from "@/composables/useKbSelections";
import { emitKbSelectionEvent } from "@aide/sdk/composables/useKbSelectionEvents";
import { kb } from "../kbClient";
import * as cardModule from "@/composables/useKbCardSession";

const fakeCard = (cardModule as unknown as { __fake: {
  sid: { value: string | null };
  thread: { value: { id: string; role: "user" | "ai"; text: string; refs: number; streaming: boolean }[] };
  permission: { value: { id: string; name: string; input: unknown } | null };
  editRequest: { value: { selectionId: string; newText: string } | null };
  sendError: { value: string | null };
  send: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
} }).__fake;

const SRC = "# 回滚\n\n出现故障时先切流量到旧版本再排查。\n\n第二段不能动。\n";
let body: HTMLElement;
let scroller: HTMLElement;
let wrapper: VueWrapper | null = null;

function mountLayer(doc = { id: "doc-1", title: "发布流程", versionNo: 5, content: SRC }, extra: { linkedRoots?: string[] } = {}) {
  document.body.innerHTML = "";
  scroller = document.createElement("div");
  body = document.createElement("div");
  body.innerHTML = renderKbMarkdown(doc.content);
  scroller.appendChild(body);
  document.body.appendChild(scroller);
  wrapper = mount(KbSelectionLayer, { props: { bodyEl: body, scrollEl: scroller, doc, ...extra }, attachTo: scroller });
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
  fakeCard.send.mockReset().mockResolvedValue("uuid-card");
  fakeCard.respond.mockClear();
  fakeCard.thread.value = [];
  fakeCard.permission.value = null;
  fakeCard.editRequest.value = null;
  fakeCard.sendError.value = null;
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

  it("回车 = 确认并直接发给这篇文档的会话：卡片不关，对话就在卡片里继续", async () => {
    const w = mountLayer();
    await openCompose(w);
    await w.find(".ksl-input").setValue("写得更具体些");
    await w.find(".ksl-input").trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(fakeCard.send).toHaveBeenCalledTimes(1);
    const [refs, note] = fakeCard.send.mock.calls[0] as [{ comment: string; text: string }[], string];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ comment: "写得更具体些", text: "切流量到旧版本" });
    expect(note).toBe("");
    expect(useKbSelections().all.value[0]).toMatchObject({ status: "sent", sid: "uuid-card" });
    expect(w.find(".ksl-pop").exists()).toBe(true);
  });

  it("发不出去（比如没有日常目录）：圈选留在待发送，并把原因告诉用户", async () => {
    fakeCard.send.mockResolvedValue(undefined);
    fakeCard.sendError.value = "这台 Host 上没有可用的日常目录，没法开启卡片对话";
    const w = mountLayer();
    await openCompose(w);
    await w.find(".ksl-input").trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(useKbSelections().all.value[0]!.status).toBe("pending");
    expect(w.find(".ksl-toast").text()).toContain("日常目录");
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
    await w.findAll(".ksl-pop .ksl-btn").find((b) => b.text().includes("再圈一处"))!.trigger("click");
    await nextTick();
    expect(useKbSelections().all.value[0]!.status).toBe("pending");
    expect(fakeCard.send).not.toHaveBeenCalled();
    expect(w.find(".ksl-tray").text()).toContain("1 处已圈");
    expect(w.find(".ksl-badge .ksl-pin").text()).toBe("1");
  });

  it("托盘里「一起交给 AI」带上补充说明，发给这篇文档的会话", async () => {
    const w = mountLayer();
    await openCompose(w);
    await w.findAll(".ksl-pop .ksl-btn").find((b) => b.text().includes("再圈一处"))!.trigger("click");
    await nextTick();
    await w.find(".ksl-tray-input").setValue("语气正式一点");
    await w.find(".ksl-tray .ksl-btn--primary").trigger("click");
    await flushPromises();
    expect(fakeCard.send).toHaveBeenCalledTimes(1);
    expect(fakeCard.send.mock.calls[0]![1]).toBe("语气正式一点");
    expect(useKbSelections().all.value[0]!.status).toBe("sent");
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


describe("卡片里的对话（线程 / 确认 / 追问）", () => {
  async function sentCard(w: VueWrapper) {
    await selectText("切流量到旧版本");
    await w.find(".ksl-cta").trigger("click");
    await nextTick();
    await w.find(".ksl-input").setValue("写具体些");
    await w.find(".ksl-input").trigger("keydown", { key: "Enter" });
    await flushPromises();
    const k = useKbSelections();
    return { k, id: k.all.value[0]!.ref.selectionId };
  }

  it("发出后卡片显示线程：用户的话与 AI 的回复；处理中输入框锁住", async () => {
    const w = mountLayer();
    const { id } = await sentCard(w);
    fakeCard.thread.value = [
      { id: "m1", role: "user", text: "写具体些", refs: 1, streaming: false },
      { id: "m2", role: "ai", text: "好的，我来改。", refs: 0, streaming: true },
    ];
    emitKbSelectionEvent({ kind: "working", sid: "uuid-card", selectionId: id });
    await nextTick();
    expect(w.findAll(".ksl-turn")).toHaveLength(3); // 两条 + 「正在改这一段」
    expect(w.find(".ksl-turn--user").text()).toBe("写具体些");
    expect(w.find(".ksl-bubble--busy").text()).toContain("正在改这一段");
    expect((w.find(".ksl-input").element as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("AI 要改这一段、等你点头：卡片里画原文↔新文对照，应用 / 不要直接回复它", async () => {
    const w = mountLayer();
    const { id } = await sentCard(w);
    emitKbSelectionEvent({ kind: "working", sid: "uuid-card", selectionId: id });
    fakeCard.permission.value = { id: "perm-1", name: "mcp__aide-knowledge__edit_selection", input: { selectionId: id, newText: "切流量到上一个稳定版本" } };
    fakeCard.editRequest.value = { selectionId: id, newText: "切流量到上一个稳定版本" };
    await nextTick();
    const ask = w.find(".ksl-ask");
    expect(ask.exists()).toBe(true);
    expect(ask.find("del").text()).toBe("旧");
    expect(ask.find("ins").text()).toBe("上一个稳定");
    await ask.findAll(".ksl-btn").find((b) => b.text().includes("应用"))!.trigger("click");
    expect(fakeCard.respond).toHaveBeenCalledWith(true, undefined);
    await ask.findAll(".ksl-btn").find((b) => b.text() === "不要")!.trigger("click");
    expect(fakeCard.respond).toHaveBeenLastCalledWith(false, expect.stringContaining("拒绝"));
  });

  it("别的权限请求：卡片不替用户批，说清楚需要确认并给去聊天的入口", async () => {
    const w = mountLayer();
    const { id } = await sentCard(w);
    emitKbSelectionEvent({ kind: "working", sid: "uuid-card", selectionId: id });
    fakeCard.permission.value = { id: "perm-2", name: "Bash", input: { command: "ls" } };
    await nextTick();
    expect(w.find(".ksl-ask--other").text()).toContain("Bash");
    expect(fakeCard.respond).not.toHaveBeenCalled();
  });

  it("改好后追问：按新范围重新圈出同一处，带着新的圈选发给同一个会话", async () => {
    const w = mountLayer();
    const { k, id } = await sentCard(w);
    emitKbSelectionEvent({ kind: "working", sid: "uuid-card", selectionId: id });
    emitKbSelectionEvent({ kind: "result", sid: "uuid-card", selectionId: id, ok: true, versionNo: 6 });
    const next = SRC.replace("切流量到旧版本", "把入口流量全部切回上一个稳定版本");
    await w.setProps({ doc: { id: "doc-1", title: "发布流程", versionNo: 6, content: next } });
    await nextTick();
    fakeCard.send.mockClear();

    await w.find(".ksl-input").setValue("再短一点");
    await w.find(".ksl-input").trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(fakeCard.send).toHaveBeenCalledTimes(1);
    const [refs] = fakeCard.send.mock.calls[0] as [{ text: string; baseVersion: number; comment: string; start: number }[]];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ text: "把入口流量全部切回上一个稳定版本", baseVersion: 6, comment: "再短一点" });
    expect(refs[0]!.start).toBe(next.indexOf("把入口流量"));
    // 上一轮的记录让位，只剩新的一轮
    expect(k.records[id]).toBeUndefined();
    expect(k.all.value).toHaveLength(1);
  });

  it("文档还没刷新到新版本就追问：不发，提示稍等", async () => {
    const w = mountLayer();
    const { id } = await sentCard(w);
    emitKbSelectionEvent({ kind: "working", sid: "uuid-card", selectionId: id });
    emitKbSelectionEvent({ kind: "result", sid: "uuid-card", selectionId: id, ok: true, versionNo: 6 });
    await nextTick();
    fakeCard.send.mockClear();
    await w.find(".ksl-input").setValue("再短一点");
    await w.find(".ksl-input").trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(fakeCard.send).not.toHaveBeenCalled();
    expect(w.find(".ksl-toast").text()).toContain("刷新");
  });

  it("收起卡片只丢草稿：已发出的记录和角标还在，点角标重新打开对话", async () => {
    const w = mountLayer();
    const { id } = await sentCard(w);
    emitKbSelectionEvent({ kind: "working", sid: "uuid-card", selectionId: id });
    emitKbSelectionEvent({ kind: "result", sid: "uuid-card", selectionId: id, ok: false, message: "locked" });
    await nextTick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(w.find(".ksl-pop").exists()).toBe(false);
    expect(useKbSelections().records[id]).toBeTruthy();
    await w.find(".ksl-badge-text--link").trigger("click");
    await nextTick();
    expect(w.find(".ksl-pop").exists()).toBe(true);
  });
});


describe("关联项目：AI 这次参考哪些记忆", () => {
  async function circle(w: VueWrapper) {
    await selectText("切流量到旧版本");
    await w.find(".ksl-cta").trigger("click");
    await nextTick();
  }

  it("没有关联项目：卡片只写「日常记忆」，圈选里没有 linked 字段（与此前一致）", async () => {
    const w = mountLayer();
    await circle(w);
    expect(w.find(".ksl-memory").text()).toBe("参考：日常记忆");
    await w.find(".ksl-input").trigger("keydown", { key: "Enter" });
    await flushPromises();
    const [refs] = fakeCard.send.mock.calls[0] as [Record<string, unknown>[]];
    expect("linked" in refs[0]!).toBe(false);
  });

  it("文档关联了项目：卡片写明参考了哪些，并随圈选带给 AI（首发与追问都带）", async () => {
    const w = mountLayer(undefined, { linkedRoots: ["/home/u/proj-a", "/home/u/proj-b"] });
    await circle(w);
    expect(w.find(".ksl-memory").text()).toBe("参考：日常记忆 + proj-a、proj-b");
    await w.find(".ksl-input").trigger("keydown", { key: "Enter" });
    await flushPromises();
    const [refs] = fakeCard.send.mock.calls[0] as [{ linked?: string[] }[]];
    expect(refs[0]!.linked).toEqual(["/home/u/proj-a", "/home/u/proj-b"]);

    // 改好后追问：新一轮的圈选同样带着关联项目（授权与参考范围都按最新一条消息算）
    const id = useKbSelections().all.value[0]!.ref.selectionId;
    emitKbSelectionEvent({ kind: "working", sid: "uuid-card", selectionId: id });
    emitKbSelectionEvent({ kind: "result", sid: "uuid-card", selectionId: id, ok: true, versionNo: 6 });
    const next = SRC.replace("切流量到旧版本", "把入口流量全部切回上一个稳定版本");
    await w.setProps({ doc: { id: "doc-1", title: "发布流程", versionNo: 6, content: next } });
    await nextTick();
    fakeCard.send.mockClear();
    await w.find(".ksl-input").setValue("再短一点");
    await w.find(".ksl-input").trigger("keydown", { key: "Enter" });
    await flushPromises();
    const [again] = fakeCard.send.mock.calls[0] as [{ linked?: string[] }[]];
    expect(again[0]!.linked).toEqual(["/home/u/proj-a", "/home/u/proj-b"]);
  });
});
