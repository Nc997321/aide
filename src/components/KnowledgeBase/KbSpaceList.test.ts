// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import KbSpaceList from "./KbSpaceList.vue";
import type { KbSpace } from "./kbClient";

// 内存备忘：带全局监听的组件测试必须 enableAutoUnmount，否则残留监听器吞后续事件
enableAutoUnmount(afterEach);

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

/**
 * 打开新建浮层。**走的是父层真实调用路径**：`+` 按钮在分组标题旁（属于
 * KnowledgeBase.vue），它调的就是这个 expose 出来的方法。
 */
async function openCreateForm(w: ReturnType<typeof mountList>): Promise<void> {
  (w.vm as unknown as { startCreate: () => void }).startCreate();
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
    expect(w.findAll("[data-kb-menu] button").map((b) => b.text())).toEqual(["重命名"]);
  });

  it("重命名走内联输入：Enter 提交并发 rename", async () => {
    const w = mountList();
    await w.find("[data-space='s1'] [data-kb-more]").trigger("click");
    await w.find("[data-kb-menu] button").trigger("click");
    await w.find("[data-space-rename]").setValue("工程手册（新）");
    await w.find("[data-space-rename]").trigger("keydown.enter");
    expect(w.emitted("rename")?.[0]).toEqual(["s1", "工程手册（新）"]);
  });

  it("重命名 Esc 取消，不发 rename", async () => {
    const w = mountList();
    await w.find("[data-space='s1'] [data-kb-more]").trigger("click");
    await w.find("[data-kb-menu] button").trigger("click");
    await w.find("[data-space-rename]").trigger("keydown.esc");
    expect(w.emitted("rename")).toBeFalsy();
    expect(w.find("[data-space-rename]").exists()).toBe(false);
  });

  it("＋ 开浮层，填标识与名称后发 create", async () => {
    const w = mountList();
    await openCreateForm(w);
    const inputs = w.findAll("[data-space-form] input");
    await inputs[0]!.setValue("eng2");
    await inputs[1]!.setValue("工程手册二");
    await w.find("[data-space-form] [data-space-submit]").trigger("click");
    expect(w.emitted("create")?.[0]).toEqual(["eng2", "工程手册二", "internal"]);
  });

  it("标识不合法时创建按钮禁用（只为省一次往返，服务端仍是唯一权威）", async () => {
    const w = mountList();
    await openCreateForm(w);
    const inputs = w.findAll("[data-space-form] input");

    // 空标识
    expect(w.find("[data-space-submit]").attributes("disabled")).toBeDefined();

    // 大写 + 空格：后端 validate_key 会 400，前端先挡下来
    await inputs[0]!.setValue("Bad Key!");
    await inputs[1]!.setValue("名字");
    expect(w.find("[data-space-submit]").attributes("disabled")).toBeDefined();

    // 合法
    await inputs[0]!.setValue("eng-2");
    expect(w.find("[data-space-submit]").attributes("disabled")).toBeUndefined();
  });

  it("名字为空时创建按钮也禁用", async () => {
    const w = mountList();
    await openCreateForm(w);
    const inputs = w.findAll("[data-space-form] input");
    await inputs[0]!.setValue("eng2");
    expect(w.find("[data-space-submit]").attributes("disabled")).toBeDefined();
  });
});
