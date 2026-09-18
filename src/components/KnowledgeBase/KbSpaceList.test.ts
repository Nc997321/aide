// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import KbSpaceList from "./KbSpaceList.vue";
// 相对导入而非 `@/`：测试文件被 tsconfig exclude，编辑器会为它们建推断项目，
// 那里不套 tsconfig 的 paths——用 `@/` 会满屏 "Cannot find module"（假的）。
import { useContextMenu } from "../../composables/useContextMenu";
import type { KbSpace } from "./kbClient";

// 内存备忘：带全局监听的组件测试必须 enableAutoUnmount，否则残留监听器吞后续事件
enableAutoUnmount(afterEach);

// 新建空间走应用统一的对话框。这里只验**接线**（确实交给 modal.custom、载荷取回后
// emit create），表单本身的校验另有 KbSpaceForm.test.ts 覆盖。
const customFn = vi.hoisted(() => vi.fn());
vi.mock("../../composables/useModal", () => ({ useModal: () => ({ custom: customFn }) }));

const SPACES: KbSpace[] = [
  { id: "s1", key: "eng", name: "工程手册", description: null, visibility: "internal", role: "owner" },
  { id: "s2", key: "prod", name: "产品档案", description: null, visibility: "private", role: "editor" },
];

function mountList() {
  return mount(KbSpaceList, {
    props: { spaces: SPACES, activeId: "s1", busy: false },
    global: { stubs: { Icon: true } },
  });
}

// ⋯ 菜单走 ContextMenu 单例（Teleport 到 body + fixed），不是组件 DOM 的一部分
const { items: menuItems, hide: hideMenu } = useContextMenu();

beforeEach(() => {
  customFn.mockReset();
});
afterEach(() => hideMenu());

/** 点开某行的 ⋯，再执行菜单里那一项——走的都是真事件处理。 */
async function useMenuItem(w: ReturnType<typeof mountList>, spaceId: string, label: string) {
  await w.find(`[data-space='${spaceId}'] [data-kb-more]`).trigger("click");
  const hit = menuItems.value.find((i) => i.label === label);
  if (!hit) throw new Error(`菜单里没有「${label}」`);
  hit.action?.();
  await w.vm.$nextTick();
}

describe("KbSpaceList", () => {
  it("每行显示名称与角色", () => {
    const w = mountList();
    expect(w.text()).toContain("工程手册");
    expect(w.text()).toContain("owner");
    expect(w.text()).toContain("产品档案");
    expect(w.text()).toContain("editor");
  });

  it("点行发 select", async () => {
    const w = mountList();
    await w.find("[data-space='s2'] [data-space-label]").trigger("click");
    expect(w.emitted("select")?.[0]).toEqual(["s2"]);
  });

  it("⋯ 只给一个「重命名」（评审只勾了这一项）", async () => {
    const w = mountList();
    await w.find("[data-space='s1'] [data-kb-more]").trigger("click");
    expect(menuItems.value.filter((i) => !i.separator).map((i) => i.label)).toEqual(["重命名"]);
  });

  it("重命名走内联输入：Enter 提交并发 rename", async () => {
    const w = mountList();
    await useMenuItem(w, "s1", "重命名");
    await w.find("[data-space-rename]").setValue("工程手册（新）");
    await w.find("[data-space-rename]").trigger("keydown.enter");
    expect(w.emitted("rename")?.[0]).toEqual(["s1", "工程手册（新）"]);
  });

  it("重命名 Esc 取消，不发 rename", async () => {
    const w = mountList();
    await useMenuItem(w, "s1", "重命名");
    await w.find("[data-space-rename]").trigger("keydown.esc");
    expect(w.emitted("rename")).toBeFalsy();
    expect(w.find("[data-space-rename]").exists()).toBe(false);
  });
});

describe("KbSpaceList 的新建接线", () => {
  it("＋ 交给应用统一的对话框（不是侧栏里的浮层）", async () => {
    customFn.mockResolvedValue(null); // 用户取消
    const w = mountList();
    await (w.vm as unknown as { startCreate: () => Promise<void> }).startCreate();

    expect(customFn).toHaveBeenCalledTimes(1);
    const req = customFn.mock.calls[0]![0] as { title: string; width: string; component: unknown };
    expect(req.title).toBe("新建空间");
    expect(req.width).toBe("sm");
    expect(req.component).toBeTruthy();
    expect(w.emitted("create")).toBeFalsy();
  });

  it("对话框返回载荷后发 create", async () => {
    customFn.mockResolvedValue({ key: "eng2", name: "工程手册二", visibility: "internal" });
    const w = mountList();
    await (w.vm as unknown as { startCreate: () => Promise<void> }).startCreate();
    expect(w.emitted("create")?.[0]).toEqual(["eng2", "工程手册二", "internal"]);
  });

  it("对话框取消（null）不发 create", async () => {
    customFn.mockResolvedValue(null);
    const w = mountList();
    await (w.vm as unknown as { startCreate: () => Promise<void> }).startCreate();
    expect(w.emitted("create")).toBeFalsy();
  });
});
