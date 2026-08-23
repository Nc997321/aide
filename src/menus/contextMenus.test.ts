import { describe, it, expect, vi } from "vitest";
import { sessionSectionMenuItems, automationSectionMenuItems } from "./contextMenus";

/** 侧栏分区导航行 ⋯ 菜单：纯构造函数（零分支），验证项内容与 action 透传。 */
describe("sidebar section menus", () => {
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
