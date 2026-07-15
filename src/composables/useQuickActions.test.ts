import { describe, it, expect } from "vitest";
import { useQuickActions } from "./useQuickActions";

describe("useQuickActions", () => {
  it("默认注册表包含 compact 和 clear，形状稳定", () => {
    const { actions } = useQuickActions();
    expect(actions).toEqual([
      { id: "compact", label: "压缩上下文", prompt: "/compact", icon: "✦" },
      { id: "clear", label: "清空上下文", prompt: "/clear", icon: "⌫", confirm: true },
    ]);
  });

  it("register 可以新增条目，unregister 可以移除——为未来自定义工具栏留的扩展点", () => {
    const { actions, register, unregister } = useQuickActions();
    register({ id: "custom", label: "自定义", prompt: "/custom" });
    expect(actions.find((a) => a.id === "custom")).toEqual({ id: "custom", label: "自定义", prompt: "/custom" });

    unregister("custom");
    expect(actions.find((a) => a.id === "custom")).toBeUndefined();
  });

  it("register 用同 id 调用会替换而不是重复追加", () => {
    const { actions, register, unregister } = useQuickActions();
    register({ id: "custom", label: "第一版", prompt: "/custom" });
    register({ id: "custom", label: "第二版", prompt: "/custom2" });
    expect(actions.filter((a) => a.id === "custom")).toEqual([
      { id: "custom", label: "第二版", prompt: "/custom2" },
    ]);
    unregister("custom");
  });
});
