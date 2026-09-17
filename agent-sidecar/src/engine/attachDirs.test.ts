import { describe, it, expect, vi } from "vitest";
import { applyAttachExtension, decideAttach } from "./attachDirs.js";
import type { ChatEvent } from "./types.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("decideAttach", () => {
  it("并集合并：新条目追加、保序", () => {
    expect(decideAttach(["C:\\a"], ["C:\\b", "C:\\c"])).toEqual({
      dirs: ["C:\\a", "C:\\b", "C:\\c"],
      rejected: [],
      active: true,
    });
  });

  it("已入账的目录不产生变化（大小写 / 分隔符 / 尾分隔符归一后判等）", () => {
    const d = decideAttach(["C:\\Repo"], ["c:/repo/", "C:\\Repo"]);
    expect(d.dirs).toEqual(["C:\\Repo"]);
    expect(d.active).toBe(false);
  });

  it("空串与纯空白条目丢弃", () => {
    expect(decideAttach([], ["", "   "]).active).toBe(false);
  });

  it("Unix 路径大小写敏感（只有 Windows 形态才折大小写）", () => {
    expect(decideAttach(["/Repo"], ["/repo"]).dirs).toEqual(["/Repo", "/repo"]);
  });

  it("只有 rejected 也算有事要报——否则拒绝就静默了", () => {
    const d = decideAttach(["C:\\a"], [], ["C:\\Windows"]);
    expect(d.dirs).toEqual(["C:\\a"]);
    expect(d.active).toBe(true);
  });
});

describe("applyAttachExtension", () => {
  function harness() {
    return { emit: vi.fn<(e: ChatEvent) => void>(), commit: vi.fn<(dirs: string[]) => void>() };
  }

  it("无变化且无回声 = 整条 no-op（不坐实、不广播）", () => {
    const h = harness();
    applyAttachExtension({ applyFlagSettings: vi.fn() }, decideAttach(["C:\\a"], ["C:\\a"]), h);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("query 未起：只落账 + 回声，等下次 spawn 落地", () => {
    const h = harness();
    applyAttachExtension(null, decideAttach([], ["C:\\b"]), h);
    expect(h.commit).toHaveBeenCalledWith(["C:\\b"]);
    expect(h.emit).toHaveBeenCalledWith({ type: "workspace_attached", dirs: ["C:\\b"] });
  });

  it("query 在跑：成功 → commit + 广播**全量**账本", async () => {
    const h = harness();
    const applyFlagSettings = vi.fn().mockResolvedValue(undefined);
    applyAttachExtension({ applyFlagSettings }, decideAttach(["C:\\a"], ["C:\\b"]), h);
    await tick();
    expect(applyFlagSettings).toHaveBeenCalledWith({
      permissions: { additionalDirectories: ["C:\\a", "C:\\b"] },
    });
    expect(h.commit).toHaveBeenCalledWith(["C:\\a", "C:\\b"]);
    expect(h.emit).toHaveBeenLastCalledWith({
      type: "workspace_attached",
      dirs: ["C:\\a", "C:\\b"],
    });
  });

  it("query 在跑：失败 → 账本不回滚 + error 回声", async () => {
    const h = harness();
    const applyFlagSettings = vi.fn().mockRejectedValue(new Error("CLI 驳回"));
    applyAttachExtension({ applyFlagSettings }, decideAttach([], ["C:\\b"]), h);
    await tick();
    expect(h.commit).toHaveBeenCalledWith(["C:\\b"]);
    expect(h.emit).toHaveBeenLastCalledWith({
      type: "workspace_attached",
      dirs: ["C:\\b"],
      error: "CLI 驳回",
    });
  });

  it("rejected 随事件回灌（fail-closed 也不许静默）", async () => {
    const h = harness();
    applyAttachExtension(
      { applyFlagSettings: vi.fn().mockResolvedValue(undefined) },
      decideAttach([], ["C:\\b"], ["C:\\Windows"]),
      h,
    );
    await tick();
    expect(h.emit).toHaveBeenLastCalledWith({
      type: "workspace_attached",
      dirs: ["C:\\b"],
      rejected: ["C:\\Windows"],
    });
  });
});
