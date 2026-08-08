import { describe, it, expect } from "vitest";
import { nextPermissionMode } from "./permissionModeCycle";

const MODES = [
  { value: "default", displayName: "默认权限" },
  { value: "acceptEdits", displayName: "编辑模式" },
  { value: "plan", displayName: "计划模式" },
  { value: "auto", displayName: "自动模式" },
  { value: "bypassPermissions", displayName: "最高权限" },
];

describe("nextPermissionMode", () => {
  it("按清单顺序循环并在末尾绕回", () => {
    expect(nextPermissionMode("default", MODES)).toBe("acceptEdits");
    expect(nextPermissionMode("acceptEdits", MODES)).toBe("plan");
    expect(nextPermissionMode("plan", MODES)).toBe("auto");
    expect(nextPermissionMode("auto", MODES)).toBe("default");
  });

  it("循环永不停在 bypassPermissions", () => {
    // auto 之后应跳过 bypass 绕回 default
    expect(nextPermissionMode("auto", MODES)).toBe("default");
    // 当前已是 bypass（下拉显式选的）→ 回首项而不是留在 bypass
    expect(nextPermissionMode("bypassPermissions", MODES)).toBe("default");
  });

  it("未知 current（provider 扩展项）→ 序列首项", () => {
    expect(nextPermissionMode("dontAsk", MODES)).toBe("default");
  });

  it("空清单 / 剔除后不足两项 → null", () => {
    expect(nextPermissionMode("default", [])).toBeNull();
    expect(nextPermissionMode("default", MODES.slice(0, 1))).toBeNull();
    expect(nextPermissionMode("bypassPermissions", [MODES[4]])).toBeNull();
  });
});
