import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LanguagePack } from "@aide/sdk/types/lspPacks";

const api = vi.hoisted(() => ({ list: vi.fn(), install: vi.fn(), uninstall: vi.fn() }));
vi.mock("@aide/sdk/api/lspPacks", () => ({ lspPacksApi: api }));

import { __resetLanguagePacksForTest, useLanguagePacks } from "./useLanguagePacks";

const pack = (over: Partial<LanguagePack> = {}): LanguagePack => ({
  id: "typescript",
  name: "TypeScript / JavaScript",
  server: "typescript-language-server",
  summary: "s",
  langs: ["typescript", "javascript"],
  version: "5.3.0",
  method: "m",
  installed: null,
  installing: false,
  ...over,
});
const installed = { version: "5.3.0", installedAt: "t", source: "npm", updateAvailable: false };

beforeEach(() => {
  __resetLanguagePacksForTest();
  api.list.mockReset();
  api.install.mockReset();
  api.uninstall.mockReset();
});

describe("useLanguagePacks", () => {
  it("refresh 拉列表；packForLang 按服务的语言找（javascript 也归 TypeScript 包）", async () => {
    api.list.mockResolvedValue([pack(), pack({ id: "python", langs: ["python"] })]);
    const lp = useLanguagePacks();
    await lp.refresh();
    expect(lp.packs.value).toHaveLength(2);
    expect(lp.packForLang("javascript")?.id).toBe("typescript");
    expect(lp.packForLang("go")).toBeUndefined();
  });

  it("并发 refresh 只发一次请求", async () => {
    api.list.mockResolvedValue([pack()]);
    const lp = useLanguagePacks();
    await Promise.all([lp.refresh(), lp.refresh()]);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("旧 Host 没有这条命令：列表为空、不抛", async () => {
    api.list.mockRejectedValue("unknown command: lsp_packs");
    const lp = useLanguagePacks();
    await expect(lp.refresh()).resolves.toBeUndefined();
    expect(lp.packs.value).toEqual([]);
  });

  it("安装成功：替换成装好的状态、revision +1（面板据此重探）、busy 清掉", async () => {
    api.list.mockResolvedValue([pack()]);
    api.install.mockResolvedValue(pack({ installed }));
    const lp = useLanguagePacks();
    await lp.refresh();
    const p = lp.install("typescript");
    expect(lp.busy.value.typescript).toBe("install");
    expect(await p).toBe(true);
    expect(lp.packs.value[0]!.installed?.source).toBe("npm");
    expect(lp.revision.value).toBe(1);
    expect(lp.busy.value.typescript).toBeUndefined();
  });

  it("安装失败：错误按语言包记下、revision 不变；再点一次会清掉旧错误", async () => {
    api.list.mockResolvedValue([pack()]);
    api.install.mockRejectedValueOnce("所有下载源都失败了").mockResolvedValueOnce(pack({ installed }));
    const lp = useLanguagePacks();
    await lp.refresh();
    expect(await lp.install("typescript")).toBe(false);
    expect(lp.errors.value.typescript).toContain("下载源");
    expect(lp.revision.value).toBe(0);
    expect(await lp.install("typescript")).toBe(true);
    expect(lp.errors.value.typescript).toBeUndefined();
  });

  it("安装中重复点击不会再发请求", async () => {
    api.list.mockResolvedValue([pack()]);
    let resolve!: (v: LanguagePack) => void;
    api.install.mockReturnValue(new Promise((r) => (resolve = r)));
    const lp = useLanguagePacks();
    await lp.refresh();
    const first = lp.install("typescript");
    expect(await lp.install("typescript")).toBe(false);
    resolve(pack({ installed }));
    await first;
    expect(api.install).toHaveBeenCalledTimes(1);
  });

  it("卸载：装好的状态换回未安装", async () => {
    api.list.mockResolvedValue([pack({ installed })]);
    api.uninstall.mockResolvedValue(pack());
    const lp = useLanguagePacks();
    await lp.refresh();
    expect(await lp.uninstall("typescript")).toBe(true);
    expect(lp.packs.value[0]!.installed).toBeNull();
  });
});
