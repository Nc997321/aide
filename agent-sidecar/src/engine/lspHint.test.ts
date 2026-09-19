import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLspHint } from "./lspHint.js";

describe("loadLspHint", () => {
  let root: string;
  let configDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aide-lsp-hint-"));
    configDir = join(root, "claude");
    await mkdir(configDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 造一个启用中的插件目录；`lsp` 决定它带不带 `.lsp.json`。 */
  async function enabledPlugin(name: string, lsp: boolean) {
    const dir = join(root, "plugins", name);
    await mkdir(dir, { recursive: true });
    if (lsp) await writeFile(join(dir, ".lsp.json"), '{"rust-analyzer":{"command":"rust-analyzer"}}');
    await registerPlugins([{ name, path: dir }]);
  }

  async function registerPlugins(entries: Array<{ name: string; path: string }>) {
    const dir = join(configDir, "plugins");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "enabled-plugins.json"), JSON.stringify(entries));
  }

  it("无插件清单 → 不注入（没装 LSP 的用户一个 token 都不花）", async () => {
    expect(await loadLspHint(configDir)).toBeNull();
  });

  it("清单损坏 / 不是数组 / 条目缺 path → 一律不注入，且不抛", async () => {
    const dir = join(configDir, "plugins");
    await mkdir(dir, { recursive: true });
    for (const bad of ["{not json", "{}", '[{"name":"x"}]']) {
      await writeFile(join(dir, "enabled-plugins.json"), bad);
      expect(await loadLspHint(configDir)).toBeNull();
    }
  });

  it("启用的插件都不带 .lsp.json → 不注入", async () => {
    await enabledPlugin("superpowers", false);

    expect(await loadLspHint(configDir)).toBeNull();
  });

  it("只要有一个启用插件带 .lsp.json → 注入", async () => {
    await enabledPlugin("superpowers", false);
    await enabledPlugin("rust-analyzer-lsp", true);

    const text = await loadLspHint(configDir);
    expect(text).toBeTruthy();
    expect(text).toContain("LSP");
  });

  it("提示文本覆盖四条被判据（缺一条就是白花 token）", async () => {
    await enabledPlugin("rust-analyzer-lsp", true);
    const text = (await loadLspHint(configDir)) ?? "";

    expect(text).toContain("workspaceSymbol");
    expect(text).toContain("line"); // 名字查询仍强制要坐标
    expect(text).toContain("Empty"); // 空 ≠ 没有引用
    expect(text).toContain("documentSymbol"); // 预热
    expect(text).toContain(".vue"); // .vue 失明 → Grep 兜底
  });

  it("文本足够短：注入了就得每轮重发，预算 1600 字符（保守 <400 token）", async () => {
    await enabledPlugin("rust-analyzer-lsp", true);
    const text = (await loadLspHint(configDir)) ?? "";

    expect(text.length).toBeLessThan(1600);
  });
});
