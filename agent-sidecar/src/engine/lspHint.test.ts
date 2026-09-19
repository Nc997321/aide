import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLspHint } from "./lspHint.js";
import type { LspGate } from "../extensions/lspGate.js";

/** aide-lsp 接管（内置通道将被退役）→ 这段文本讲的是不存在的工具。 */
const TAKEN_OVER: LspGate = { env: {}, trusted: true, lspLanguages: ["rust"] };
/** 替代品不在场 → 内置通道留着 → 这段文本正是为它写的。 */
const BUILTIN_ONLY: LspGate = { env: {}, trusted: true, lspLanguages: [] };

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
    expect(await loadLspHint(configDir, BUILTIN_ONLY)).toBeNull();
  });

  it("清单损坏 / 不是数组 / 条目缺 path → 一律不注入，且不抛", async () => {
    const dir = join(configDir, "plugins");
    await mkdir(dir, { recursive: true });
    for (const bad of ["{not json", "{}", '[{"name":"x"}]']) {
      await writeFile(join(dir, "enabled-plugins.json"), bad);
      expect(await loadLspHint(configDir, BUILTIN_ONLY)).toBeNull();
    }
  });

  it("启用的插件都不带 .lsp.json → 不注入", async () => {
    await enabledPlugin("superpowers", false);

    expect(await loadLspHint(configDir, BUILTIN_ONLY)).toBeNull();
  });

  it("只要有一个启用插件带 .lsp.json 且替代品不在场 → 注入", async () => {
    await enabledPlugin("superpowers", false);
    await enabledPlugin("rust-analyzer-lsp", true);

    const text = await loadLspHint(configDir, BUILTIN_ONLY);
    expect(text).toBeTruthy();
    expect(text).toContain("LSP");
  });

  /// C3：aide-lsp 接管 = 内置工具已退役（lspRetire.ts）。这段文本整篇在讲内置工具
  /// 的坑（`workspaceSymbol` 要坐标 / `findReferences` 冷窗口返空），对不存在的工具
  /// 讲这些是纯噪音，那套语义已由 aide-lsp 的 server instructions 承担。
  it("aide-lsp 接管时**不注入**——内置工具已退役，这段文本作废（顺带省掉每轮开销）", async () => {
    await enabledPlugin("rust-analyzer-lsp", true);

    expect(await loadLspHint(configDir, TAKEN_OVER)).toBeNull();
  });

  /// 闸门不满足 = 内置通道**留着**（退了就是能力缺口）→ 提示必须跟着留在场。
  it("替代品不在场时，闸门各条都保留提示（未信任 / 逃生舱）", async () => {
    await enabledPlugin("rust-analyzer-lsp", true);

    for (const gate of [
      { ...BUILTIN_ONLY, trusted: false },
      { ...BUILTIN_ONLY, env: { AIDE_LSP_TOOLS: "off" } },
    ]) {
      expect(await loadLspHint(configDir, gate)).toBeTruthy();
    }
  });

  it("提示文本覆盖四条被判据（缺一条就是白花 token）", async () => {
    await enabledPlugin("rust-analyzer-lsp", true);
    const text = (await loadLspHint(configDir, BUILTIN_ONLY)) ?? "";

    expect(text).toContain("workspaceSymbol");
    expect(text).toContain("line"); // 名字查询仍强制要坐标
    expect(text).toContain("Empty"); // 空 ≠ 没有引用
    expect(text).toContain("documentSymbol"); // 预热
    expect(text).toContain(".vue"); // .vue 失明 → Grep 兜底
  });

  it("文本足够短：注入了就得每轮重发，预算 1600 字符（保守 <400 token）", async () => {
    await enabledPlugin("rust-analyzer-lsp", true);
    const text = (await loadLspHint(configDir, BUILTIN_ONLY)) ?? "";

    expect(text.length).toBeLessThan(1600);
  });
});
