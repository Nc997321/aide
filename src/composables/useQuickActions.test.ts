import { describe, it, expect } from "vitest";
import { useQuickActions } from "./useQuickActions";

describe("useQuickActions", () => {
  it("默认注册表包含 btw / compact / clear，形状稳定（/... 命令的唯一事实源）", () => {
    const { actions } = useQuickActions();
    expect(actions).toEqual([
      { id: "btw", command: "btw", label: "顺便问一下", kind: "btw", icon: "↳" },
      { id: "compact", command: "compact", label: "压缩上下文", kind: "prompt", icon: "✦" },
      { id: "clear", command: "clear", label: "清空上下文", kind: "prompt", icon: "⌫", confirm: true },
    ]);
  });

  it("register 可以新增条目，unregister 可以移除——为未来自定义工具栏留的扩展点", () => {
    const { actions, register, unregister } = useQuickActions();
    register({ id: "custom", command: "custom", label: "自定义", kind: "prompt" });
    expect(actions.find((a) => a.id === "custom")).toEqual({ id: "custom", command: "custom", label: "自定义", kind: "prompt" });

    unregister("custom");
    expect(actions.find((a) => a.id === "custom")).toBeUndefined();
  });

  it("register 用同 id 调用会替换而不是重复追加", () => {
    const { actions, register, unregister } = useQuickActions();
    register({ id: "custom", command: "custom", label: "第一版", kind: "prompt" });
    register({ id: "custom", command: "custom", label: "第二版", kind: "prompt" });
    expect(actions.filter((a) => a.id === "custom")).toEqual([
      { id: "custom", command: "custom", label: "第二版", kind: "prompt" },
    ]);
    unregister("custom");
  });
});
