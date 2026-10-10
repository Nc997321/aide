import { describe, it, expect, vi } from "vitest";
import { sessionSectionMenuItems, automationSectionMenuItems, workspaceMenuItems, kbCreateItems } from "./contextMenus";

/** 侧栏分区导航行 ⋯ 菜单：纯构造函数（零分支），验证项内容与 action 透传。 */
describe("sidebar section menus", () => {
  it("sessionSectionMenuItems：只有传了回调（日常分区）才多一项查看日常文件", () => {
    const onSwitch = vi.fn();
    const items = sessionSectionMenuItems(() => {}, onSwitch);
    expect(items.map((i) => i.label)).toEqual(["新建会话", "在文件树中查看日常文件"]);
    items[1].action?.();
    expect(onSwitch).toHaveBeenCalledOnce();
  });

  it("sessionSectionMenuItems：新建会话带 Ctrl+N 提示，action 透传回调", () => {
    const onNew = vi.fn();
    const [item] = sessionSectionMenuItems(onNew);
    expect(sessionSectionMenuItems(onNew)).toHaveLength(1);
    expect(item?.label).toBe("新建会话");
    expect(item?.kbd).toBe("Ctrl+N");
    expect(item?.danger).toBeFalsy();
    item?.action?.();
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("automationSectionMenuItems：新建任务项，action 透传回调", () => {
    const onNew = vi.fn();
    const [item] = automationSectionMenuItems(onNew);
    expect(automationSectionMenuItems(onNew)).toHaveLength(1);
    expect(item?.label).toBe("新建自动化任务");
    item?.action?.();
    expect(onNew).toHaveBeenCalledOnce();
  });
});

describe("workspaceMenuItems", () => {
  const ws = { key: "k", name: "/p/aide", missing: false };

  it("「新增会话」排第一，action 透传回调", () => {
    const onNew = vi.fn();
    const items = workspaceMenuItems(ws, undefined, undefined, undefined, onNew);
    expect(items[0]?.label).toBe("新增会话");
    items[0]?.action?.();
    expect(onNew).toHaveBeenCalledOnce();
    expect(items[1]?.label).toBe("切换到此工作区");
  });

  it("不传回调（远程登记）或目录丢失：没有「新增会话」", () => {
    expect(workspaceMenuItems(ws).some((i) => i.label === "新增会话")).toBe(false);
    expect(
      workspaceMenuItems({ ...ws, missing: true }, undefined, undefined, undefined, vi.fn())
        .some((i) => i.label === "新增会话"),
    ).toBe(false);
  });
});

describe("kbCreateItems", () => {
  const base = { onNewFolder: vi.fn(), onNewDoc: vi.fn(), onUpload: vi.fn() };

  it("文件夹里的 +：只有往这个位置放东西的三项，没有新建空间", () => {
    const labels = kbCreateItems(base).map((i) => i.label);
    expect(labels).toEqual(["新建文件夹", "新建文档", "上传文件…"]);
  });

  it("根位置给 onNewSpace：末尾分隔线后多一项「新建空间…」，点它触发回调", () => {
    const onNewSpace = vi.fn();
    const items = kbCreateItems({ ...base, onNewSpace });
    expect(items.at(-2)?.separator).toBe(true);
    expect(items.at(-1)?.label).toBe("新建空间…");
    items.at(-1)?.action?.();
    expect(onNewSpace).toHaveBeenCalledTimes(1);
  });
});
