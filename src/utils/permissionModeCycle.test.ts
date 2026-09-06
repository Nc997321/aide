import { describe, it, expect } from "vitest";
import { nextPermissionMode } from "./permissionModeCycle";

const MODES = [
  { value: "auto", displayName: "自动模式" },
  { value: "manual", displayName: "手动模式" },
  { value: "plan", displayName: "计划模式" },
  { value: "bypassPermissions", displayName: "最高权限" },
];

describe("nextPermissionMode", () => {
  it("按清单顺序循环并在末尾绕回", () => {
    expect(nextPermissionMode("auto", MODES)).toBe("manual");
    expect(nextPermissionMode("manual", MODES)).toBe("plan");
    expect(nextPermissionMode("plan", MODES)).toBe("auto");
  });

  it("循环永不停在 bypassPermissions", () => {
    // plan 之后应跳过 bypass 绕回首项（清单首项 = 默认模式 auto）
    expect(nextPermissionMode("plan", MODES)).toBe("auto");
    // 当前已是 bypass（下拉显式选的）→ 回首项而不是留在 bypass
    expect(nextPermissionMode("bypassPermissions", MODES)).toBe("auto");
  });

  it("未知 current（provider 扩展项）→ 序列首项", () => {
    expect(nextPermissionMode("dontAsk", MODES)).toBe("auto");
  });

  it("空清单 / 剔除后不足两项 → null", () => {
    expect(nextPermissionMode("auto", [])).toBeNull();
    expect(nextPermissionMode("auto", MODES.slice(0, 1))).toBeNull();
    expect(nextPermissionMode("bypassPermissions", [MODES[3]])).toBeNull();
  });
});
