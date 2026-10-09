import { describe, it, expect } from "vitest";
import { decideUpdateBanner, type BannerInput } from "./updateBanner";
import { DEFAULT_RELEASE_REPO, upgradeCommand } from "./serverVersion";

const input = (over: Partial<BannerInput> = {}): BannerInput => ({
  isAdmin: true,
  current: "0.6.0",
  needsUpgrade: false,
  status: { current: "0.6.0", latest: "0.6.1", repo: "r.example/ns/aide-knowledge", error: null },
  dismissedVersion: null,
  ...over,
});

describe("decideUpdateBanner", () => {
  it("有新版：命令里带的就是横幅上说的那个版本，仓库用服务端给的", () => {
    expect(decideUpdateBanner(input())).toEqual({
      kind: "upgrade",
      current: "0.6.0",
      latest: "0.6.1",
      required: false,
      isAdmin: true,
      command: upgradeCommand("r.example/ns/aide-knowledge", "0.6.1"),
    });
  });

  it("普通成员也提示（文案请联系管理员，由组件按 isAdmin 分）", () => {
    expect(decideUpdateBanner(input({ isAdmin: false }))).toMatchObject({ kind: "upgrade", isAdmin: false });
  });

  it("已是最新 / dev 构建 / 查不到最新版：不打扰", () => {
    const st = (latest: string | null, current = "0.6.0") => ({ current, latest, repo: null, error: null });
    expect(decideUpdateBanner(input({ status: st("0.6.0") })).kind).toBe("none");
    expect(decideUpdateBanner(input({ status: st("0.6.1", "dev") })).kind).toBe("none");
    expect(decideUpdateBanner(input({ status: st(null) })).kind).toBe("none");
  });

  it("「以后再说」按版本记：同一版不再提示，出了更新的版本照常提示", () => {
    expect(decideUpdateBanner(input({ dismissedVersion: "0.6.1" })).kind).toBe("none");
    expect(decideUpdateBanner(input({ dismissedVersion: "0.6.0" })).kind).toBe("upgrade");
  });

  it("低于客户端最低要求：忽略「以后再说」；老服务端查不到最新版时命令用 stable + 官方仓库", () => {
    expect(decideUpdateBanner(input({ needsUpgrade: true, dismissedVersion: "0.6.1" }))).toMatchObject({
      kind: "upgrade",
      required: true,
    });
    expect(decideUpdateBanner(input({ status: "unsupported", current: null, needsUpgrade: true }))).toEqual({
      kind: "upgrade",
      current: null,
      latest: null,
      required: true,
      isAdmin: true,
      command: upgradeCommand(DEFAULT_RELEASE_REPO, "stable"),
    });
  });

  it("老服务端（没有更新接口）且够用：不提示（查不到有没有新版，不猜）", () => {
    expect(decideUpdateBanner(input({ status: "unsupported" })).kind).toBe("none");
  });
});
