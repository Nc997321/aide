// 退役规则的判据测试。夹具是**真的插件目录**（不是假设的形状）——踩过的坑：
// 夹具照假设写 = 测试只验证了假设（见 lspFormat 的 `undefined:undefined:1` 旧事故）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { retireBuiltinLspPlugins } from "./lspRetire.js";
import type { SdkPluginConfig } from "./dispatchPlugins.js";
import type { LspGate } from "./lspGate.js";

const MOUNTED: LspGate = { env: {}, trusted: true, lspLanguages: ["rust"] };

/** 本机真实安装的官方 LSP 插件目录；这台机器没装 → 空数组 → 最后一个用例跳过。
 *  判据的地基是这两个插件的**真实形状**（不是我们以为的形状），所以对着真目录再跑一遍：
 *  哪天允许表改错、把官方插件判成「不纯」，这里会立刻红。 */
const REAL_LSP_DIRS = (() => {
  const cached = join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".aide", "claude"),
    "plugins",
    "cache",
    "claude-plugins-official",
  );
  const out: string[] = [];
  for (const name of ["rust-analyzer-lsp", "typescript-lsp"]) {
    let versions: string[];
    try {
      versions = readdirSync(join(cached, name));
    } catch {
      continue;
    }
    for (const v of versions) {
      const dir = join(cached, name, v);
      try {
        if (readdirSync(dir).includes(".lsp.json")) out.push(dir);
      } catch {
        // 读不了这个版本目录 → 跳过它
      }
    }
  }
  return out;
})();

describe("retireBuiltinLspPlugins", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aide-lsp-retire-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 造一个真插件目录。`lsp` 决定带不带 .lsp.json，`others` 是要额外创建的条目。 */
  async function plugin(name: string, lsp: boolean, others: string[] = []): Promise<SdkPluginConfig> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    if (lsp) await writeFile(join(dir, ".lsp.json"), '{"rust-analyzer":{"command":"rust-analyzer"}}');
    for (const o of others) await mkdir(join(dir, o), { recursive: true });
    return { type: "local", path: dir };
  }

  /** 不带顶层 .lsp.json，只在 manifest 里声明 lspServers 的插件（CLI 认的第二条路）。 */
  async function manifestPlugin(name: string, lspServers: unknown): Promise<SdkPluginConfig> {
    const dir = join(root, name);
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name, lspServers }),
    );
    return { type: "local", path: dir };
  }

  const names = (out: SdkPluginConfig[]) => out.map((p) => p.path.split(/[\\/]/).pop());

  describe("闸门不满足 → 内置通道原样留着（退了就是能力缺口）", () => {
    const cases: Array<[string, LspGate]> = [
      ["工作区未信任", { ...MOUNTED, trusted: false }],
      ["该工作区没有配得上 LSP 的语言", { ...MOUNTED, lspLanguages: [] }],
      ["逃生舱 AIDE_LSP_TOOLS=off", { ...MOUNTED, env: { AIDE_LSP_TOOLS: "off" } }],
    ];
    for (const [why, gate] of cases) {
      it(why, async () => {
        const lsp = await plugin("rust-analyzer-lsp", true);
        expect(retireBuiltinLspPlugins([lsp], gate)).toEqual([lsp]);
      });
    }
  });

  describe("闸门满足 → 选择性退役", () => {
    it("纯 LSP 插件被剔掉（官方那两个的实际形状）", async () => {
      const lsp = await plugin("rust-analyzer-lsp", true, [".claude-plugin", ".in_use"]);
      await writeFile(join(lsp.path, "LICENSE"), "");
      await writeFile(join(lsp.path, "README.md"), "");

      expect(retireBuiltinLspPlugins([lsp], MOUNTED)).toEqual([]);
    });

    it("不带 LSP 的插件不受影响", async () => {
      const sp = await plugin("superpowers", false, ["skills"]);
      expect(names(retireBuiltinLspPlugins([sp], MOUNTED))).toEqual(["superpowers"]);
    });

    /// 允许表的意义：不必枚举 SDK 认的全部组件名，凡是没见过的条目一律当「它有别的东西」。
    /// `themes` 是故意挑的路人组件（不在任何禁止表里，但确实会被 SDK 加载）。
    it("声明了 LSP 但还带别的东西的插件**不退**——整目录剔除会连那些一起丢", async () => {
      for (const other of ["skills", "agents", "hooks", "themes", "workflows", "monitors"]) {
        const mixed = await plugin(`mixed-${other}`, true, [".claude-plugin", other]);
        expect(names(retireBuiltinLspPlugins([mixed], MOUNTED))).toEqual([`mixed-${other}`]);
      }
    });

    it("混合清单里只剔该剔的", async () => {
      const rust = await plugin("rust-analyzer-lsp", true, [".claude-plugin"]);
      const ts = await plugin("typescript-lsp", true, [".claude-plugin"]);
      const sp = await plugin("superpowers", false, ["skills"]);

      expect(names(retireBuiltinLspPlugins([rust, ts, sp], MOUNTED))).toEqual(["superpowers"]);
    });

    /// CLI 认两条声明路径，只认一条会让走另一条的插件**静默**逃过退役。
    it("manifest 的 lspServers 也算声明（路径 / 内联对象 / 数组三种形状）", async () => {
      const forms = ["servers/my.lsp.json", { rust: { command: "rust-analyzer" } }, ["a.json"]];
      for (const form of forms) {
        const p = await manifestPlugin(`manifest-lsp-${forms.indexOf(form)}`, form);
        expect(retireBuiltinLspPlugins([p], MOUNTED)).toEqual([]);
      }
    });

    it("manifest 的 lspServers 为空 / 缺席 / 形状不认识 → 不算声明，保留", async () => {
      for (const form of ["", [], {}, null, 42]) {
        const p = await manifestPlugin(`empty-${String(form)}`, form);
        expect(names(retireBuiltinLspPlugins([p], MOUNTED))).toEqual([`empty-${String(form)}`]);
      }
    });

    it("LSP 声明藏在非标准文件名里、又没有 manifest 指认 → 保留，不冒险", async () => {
      const dir = join(root, "custom-name");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "servers.lsp.json"), "{}");

      expect(names(retireBuiltinLspPlugins([{ type: "local", path: dir }], MOUNTED))).toEqual([
        "custom-name",
      ]);
    });

    it("路径不存在 → 保留，不抛（散装注入的根可能是写失败降级过的）", () => {
      const ghost: SdkPluginConfig = { type: "local", path: join(root, "nope"), skipMcpDiscovery: true };
      expect(retireBuiltinLspPlugins([ghost], MOUNTED)).toEqual([ghost]);
    });

    it("空清单 → 空（不因空而抛）", () => {
      expect(retireBuiltinLspPlugins([], MOUNTED)).toEqual([]);
    });
  });

  it.runIf(REAL_LSP_DIRS.length > 0)("对着真实安装的官方 LSP 插件目录，判定为纯 LSP", () => {
    for (const dir of REAL_LSP_DIRS) {
      expect(retireBuiltinLspPlugins([{ type: "local", path: dir }], MOUNTED)).toEqual([]);
    }
  });
});
