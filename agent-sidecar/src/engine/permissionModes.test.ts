import { describe, it, expect, vi } from "vitest";
import {
  PERMISSION_MODES,
  PermissionModeController,
  resolveApprovedTransition,
} from "./permissionModes.js";
import type { ChatEvent } from "./types.js";

describe("resolveApprovedTransition", () => {
  it("ExitPlanMode：nextMode 钉死；缺席回落 auto", () => {
    expect(resolveApprovedTransition("ExitPlanMode", "manual")).toEqual({ mode: "manual", approveEdits: false });
    expect(resolveApprovedTransition("ExitPlanMode", undefined)).toEqual({ mode: "auto", approveEdits: false });
  });

  it("EnterPlanMode：恒 plan（模型主动进入，非用户预选）", () => {
    expect(resolveApprovedTransition("EnterPlanMode", "auto")).toEqual({ mode: "plan", approveEdits: false });
  });

  it("仅 nextMode：auto/bypassPermissions 连带放行编辑；manual 不连带", () => {
    expect(resolveApprovedTransition("Bash", "auto")).toEqual({ mode: "auto", approveEdits: true });
    expect(resolveApprovedTransition(undefined, "bypassPermissions")).toEqual({ mode: "bypassPermissions", approveEdits: true });
    expect(resolveApprovedTransition(undefined, "manual")).toEqual({ mode: "manual", approveEdits: false });
  });

  it("无 tool 无 nextMode → null（无迁移动作）", () => {
    expect(resolveApprovedTransition(undefined, undefined)).toBeNull();
    expect(resolveApprovedTransition("Read", undefined)).toBeNull();
  });
});

describe("PermissionModeController", () => {
  function setup() {
    const events: ChatEvent[] = [];
    const ctl = new PermissionModeController((e) => events.push(e));
    return { ctl, events };
  }

  it("初始 auto；query 未起时 apply 只落本地账并广播", () => {
    const { ctl, events } = setup();
    expect(ctl.current).toBe("auto");
    ctl.apply("plan", null);
    expect(ctl.current).toBe("plan");
    expect(events[0]).toMatchObject({ type: "permission_modes_available", current: "plan" });
  });

  it("非法模式静默忽略（不写账不广播）；同值幂等", () => {
    const { ctl, events } = setup();
    ctl.apply("nope", null);
    expect(ctl.current).toBe("auto");
    expect(events).toHaveLength(0);
    ctl.apply("auto", null); // 同值
    expect(events).toHaveLength(0);
  });

  it("EXTRA_MODE（dontAsk）可 apply，广播清单附加带标签条目", () => {
    const { ctl, events } = setup();
    ctl.apply("dontAsk", null);
    expect(ctl.current).toBe("dontAsk");
    const ev = events[0] as { modes: { value: string; displayName: string }[] };
    expect(ev.modes.length).toBe(PERMISSION_MODES.length + 1);
    expect(ev.modes.at(-1)).toEqual({ value: "dontAsk", displayName: "本次会话不再询问" });
  });

  it("emitModes：未知模式值标签回退原文（防御臂——apply 门控外的异常账面）", () => {
    const { ctl, events } = setup();
    ctl.current = "weird-mode"; // 公共账面字段：模拟 provider 侧异常值
    ctl.emitModes();
    const ev = events[0] as { modes: { value: string; displayName: string }[] };
    expect(ev.modes.at(-1)).toEqual({ value: "weird-mode", displayName: "weird-mode" });
  });

  it("setPermissionMode 以非 Error 拒绝 → error 消息回退 String(e)（?? 臂）", async () => {
    const { ctl, events } = setup();
    ctl.apply("plan", {
      setPermissionMode: vi.fn(async () => {
        throw "raw-string-failure";
      }),
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect((events[0] as { error?: string }).error).toContain("raw-string-failure");
  });

  it("query 在跑：setPermissionMode 坐实后才更新账面；失败回滚广播带 error", async () => {
    const { ctl, events } = setup();
    const ok = { setPermissionMode: vi.fn(async () => {}) };
    ctl.apply("plan", ok);
    expect(ctl.current).toBe("auto"); // 未坐实前不落账
    await vi.waitFor(() => expect(ctl.current).toBe("plan"));
    expect(ok.setPermissionMode).toHaveBeenCalledWith("plan");

    const { ctl: ctl2, events: events2 } = setup();
    const bad = { setPermissionMode: vi.fn(async () => { throw new Error("cli-refused"); }) };
    ctl2.apply("plan", bad);
    await vi.waitFor(() => expect(events2).toHaveLength(1));
    expect(ctl2.current).toBe("auto"); // 失败不落账
    expect(events2[0]).toMatchObject({ type: "permission_modes_available", current: "auto" });
    expect((events2[0] as { error?: string }).error).toContain("cli-refused");
  });
});
