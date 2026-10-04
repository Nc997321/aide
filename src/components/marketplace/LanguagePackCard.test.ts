// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { LanguagePack } from "@aide/sdk/types/lspPacks";

const api = vi.hoisted(() => ({ list: vi.fn(), install: vi.fn(), uninstall: vi.fn() }));
vi.mock("@aide/sdk/api/lspPacks", () => ({ lspPacksApi: api }));

import LanguagePackCard from "./LanguagePackCard.vue";
import { __resetLanguagePacksForTest } from "../../composables/useLanguagePacks";

const pack = (over: Partial<LanguagePack> = {}): LanguagePack => ({
  id: "typescript",
  name: "TypeScript / JavaScript",
  server: "typescript-language-server",
  summary: "为 .ts 提供跳转",
  langs: ["typescript", "javascript"],
  version: "5.3.0",
  method: "从 npm 下载",
  installed: null,
  installing: false,
  ...over,
});
const installed = { version: "5.3.0", installedAt: "t", source: "npm", updateAvailable: false };

beforeEach(() => {
  __resetLanguagePacksForTest();
  api.install.mockReset();
  api.uninstall.mockReset();
});

describe("LanguagePackCard", () => {
  it("未安装：显示「未安装」和安装按钮；点安装调后端、过程中显示安装中", async () => {
    let resolve!: (v: LanguagePack) => void;
    api.install.mockReturnValue(new Promise((r) => (resolve = r)));
    const w = mount(LanguagePackCard, { props: { pack: pack() } });
    expect(w.text()).toContain("未安装");
    expect(w.text()).toContain("TypeScript · JavaScript");
    const btn = w.get("button.primary");
    expect(btn.text()).toBe("安装");
    await btn.trigger("click");
    expect(api.install).toHaveBeenCalledWith("typescript");
    expect(w.text()).toContain("安装中…");
    expect(w.get("button.primary").attributes("disabled")).toBeDefined();
    resolve(pack({ installed }));
    await flushPromises();
  });

  it("已安装：显示版本与来源、给卸载；有更新时多一个更新按钮", async () => {
    const w = mount(LanguagePackCard, { props: { pack: pack({ installed }) } });
    expect(w.text()).toContain("已安装 5.3.0 · npm");
    expect(w.find("button.danger").text()).toBe("卸载");
    expect(w.findAll("button").map((b) => b.text())).not.toContain("更新");
    await w.setProps({ pack: pack({ installed: { ...installed, version: "5.2.0", updateAvailable: true } }) });
    expect(w.findAll("button").map((b) => b.text())).toContain("更新");
  });

  it("另一个窗口正在装（后端 installing）：按钮禁用、显示安装中", () => {
    const w = mount(LanguagePackCard, { props: { pack: pack({ installing: true }) } });
    expect(w.text()).toContain("安装中…");
    expect(w.get("button.primary").attributes("disabled")).toBeDefined();
  });

  it("当前项目在用：标出来", () => {
    expect(mount(LanguagePackCard, { props: { pack: pack(), inUse: true } }).text()).toContain("当前项目在用");
    expect(mount(LanguagePackCard, { props: { pack: pack() } }).text()).not.toContain("当前项目在用");
  });

  it("安装失败：卡片上如实显示原因", async () => {
    api.install.mockRejectedValue("所有下载源都失败了（registry.npmjs.org：HTTP 403）");
    const w = mount(LanguagePackCard, { props: { pack: pack() } });
    await w.get("button.primary").trigger("click");
    await flushPromises();
    expect(w.find(".err").text()).toContain("HTTP 403");
  });
});
