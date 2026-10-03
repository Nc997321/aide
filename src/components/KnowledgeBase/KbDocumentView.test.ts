// @vitest-environment jsdom
//
// 文档视图：AI 圈选改写还在途时不许进编辑态（草稿基线是改之前的正文，保存是整篇覆盖且没有乐观锁，
// 会把 AI 刚写进去的修改静默盖掉）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";

const kbMock = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => ({ held: true, holder: null, expiresAt: "2999-01-01T00:00:00Z" })),
}));
vi.mock("./kbClient", () => ({
  kb: { acquireLock: kbMock.acquireLock, lockHeartbeat: vi.fn(), releaseLock: vi.fn(), previewToken: vi.fn() },
  getBaseUrl: () => "http://kb.invalid",
  KbError: class KbError extends Error {},
}));
vi.mock("@aide/sdk/api", () => ({
  api: new Proxy({ kbLinks: vi.fn(async () => ({})) }, {
    get: (t, k: string) => (k in t ? (t as Record<string, unknown>)[k] : vi.fn(async () => undefined)),
  }),
}));
vi.mock("@/composables/useKbDocLock", async () => {
  const { ref, computed } = await import("vue");
  const state = ref<{ phase: string }>({ phase: "idle" });
  return {
    useKbDocLock: () => ({
      state,
      held: computed(() => state.value.phase === "held"),
      lost: computed(() => state.value.phase === "lost"),
      enter: vi.fn(async () => {
        state.value = { phase: "held" };
        return true;
      }),
      exit: vi.fn(async () => {}),
    }),
  };
});

import KbDocumentView from "./KbDocumentView.vue";
import { useKbSelections, __resetKbSelectionsForTest } from "../../composables/useKbSelections";

enableAutoUnmount(afterEach);
beforeEach(() => __resetKbSelectionsForTest());

const DOC = {
  id: "doc-1",
  title: "发布流程",
  kind: "doc",
  mime: "text/markdown",
  versionNo: 3,
  content: "第一段。\n",
  status: "draft",
  updatedAt: "2026-10-03T00:00:00Z",
} as never;

function mountView() {
  return mount(KbDocumentView, {
    props: { doc: DOC, editable: true },
    global: { stubs: { Icon: true, KbSelectionLayer: true, KbLinkedProjects: true, KbOutline: true, KbHistory: true, KbMarkdownEditor: true } },
  });
}

function sendOne(documentId: string) {
  const k = useKbSelections();
  const id = k.begin({
    documentId,
    title: "t",
    baseVersion: 3,
    baseContent: "第一段。\n",
    scope: { start: 0, end: 4, text: "第一段。", lineStart: 1, lineEnd: 1, precise: true },
  }).ref.selectionId;
  k.confirm(id, "");
  k.markSent([id]);
  return { k, id };
}

describe("AI 改写在途时不许进编辑态", () => {
  it("没有在途改写：编辑按钮可用，点了进入编辑", async () => {
    const w = mountView();
    const btn = w.find(".kb-edit-btn");
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
    await btn.trigger("click");
    await nextTick();
    expect(w.emitted("editing")?.[0]).toEqual([true]);
  });

  it("这篇文档有圈选已发出还没收尾：按钮禁用并说明原因，点不进去", async () => {
    sendOne("doc-1");
    const w = mountView();
    const btn = w.find(".kb-edit-btn");
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
    expect(btn.text()).toContain("AI 修改中");
    expect(btn.attributes("title")).toContain("盖掉");
    await btn.trigger("click");
    expect(w.emitted("editing")).toBeFalsy();
    expect(kbMock.acquireLock).not.toHaveBeenCalled();
  });

  it("别的文档的在途改写不影响这篇", () => {
    sendOne("doc-OTHER");
    const w = mountView();
    expect((w.find(".kb-edit-btn").element as HTMLButtonElement).disabled).toBe(false);
  });

  it("AI 收尾（没改 / 改完）后恢复可编辑", async () => {
    const { k, id } = sendOne("doc-1");
    const w = mountView();
    expect((w.find(".kb-edit-btn").element as HTMLButtonElement).disabled).toBe(true);
    k.records[id]!.status = "noop";
    await nextTick();
    expect((w.find(".kb-edit-btn").element as HTMLButtonElement).disabled).toBe(false);
  });
});
