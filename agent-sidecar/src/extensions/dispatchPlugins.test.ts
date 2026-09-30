import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureDispatchManifest,
  buildDispatchPluginsOption,
  USER_PLUGIN_NAME,
  PROJECT_PLUGIN_NAME,
} from "./dispatchPlugins.js";

describe("ensureDispatchManifest", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aide-dispatch-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const manifestPath = (r: string) => join(r, ".claude-plugin", "plugin.json");

  it("首次写 .claude-plugin/plugin.json 含 name", () => {
    expect(ensureDispatchManifest(root, USER_PLUGIN_NAME)).toBe(true);
    const content = JSON.parse(readFileSync(manifestPath(root), "utf8"));
    expect(content).toEqual({ name: USER_PLUGIN_NAME });
  });

  it("幂等：已存在且 name 匹配时不重写（mtime 不变）", () => {
    ensureDispatchManifest(root, USER_PLUGIN_NAME);
    const file = manifestPath(root);
    const before = statSync(file).mtimeMs;
    expect(ensureDispatchManifest(root, USER_PLUGIN_NAME)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("name 不匹配时重写为新 name", () => {
    ensureDispatchManifest(root, USER_PLUGIN_NAME);
    expect(ensureDispatchManifest(root, PROJECT_PLUGIN_NAME)).toBe(true);
    const content = JSON.parse(readFileSync(manifestPath(root), "utf8"));
    expect(content).toEqual({ name: PROJECT_PLUGIN_NAME });
  });

  it("损坏 JSON 重写为正确内容", () => {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(manifestPath(root), "not json {{{");
    expect(ensureDispatchManifest(root, USER_PLUGIN_NAME)).toBe(true);
    const content = JSON.parse(readFileSync(manifestPath(root), "utf8"));
    expect(content).toEqual({ name: USER_PLUGIN_NAME });
  });

  it("pluginRoot 是文件而非目录时 mkdir 失败返回 false 不抛", () => {
    writeFileSync(join(root, "blocker"), "i am a file");
    expect(ensureDispatchManifest(join(root, "blocker"), USER_PLUGIN_NAME)).toBe(false);
  });
});

describe("buildDispatchPluginsOption", () => {
  let homeDir: string;
  let cwdDir: string;
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "aide-dispatch-home-"));
    cwdDir = mkdtempSync(join(tmpdir(), "aide-dispatch-cwd-"));
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  });

  /** 临时设 process.env.CLAUDE_CONFIG_DIR 跑 fn，结束后还原。 */
  function withConfigDir(dir: string, fn: () => void): void {
    const old = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      fn();
    } finally {
      process.env.CLAUDE_CONFIG_DIR = old;
    }
  }

  // 远程车道：用户级插件根 = 桌面用户扩展在目标机上的镜像，不是目标机自己的 claude home。
  it("userRoot 给了就用镜像，不用本机 claude home", () => {
    const mirror = mkdtempSync(join(tmpdir(), "aide-dispatch-mirror-"));
    try {
      withConfigDir(homeDir, () => {
        const res = buildDispatchPluginsOption(cwdDir, false, mirror);
        expect(res).toEqual([{ type: "local", path: mirror, skipMcpDiscovery: true }]);
      });
    } finally {
      rmSync(mirror, { recursive: true, force: true });
    }
  });

  it("!trusted 仅用户级（项目级不注入）", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    mkdirSync(join(cwdDir, ".aide", "claude", "skills", "y"), { recursive: true });
    withConfigDir(homeDir, () => {
      const res = buildDispatchPluginsOption(cwdDir, false);
      expect(res).toHaveLength(1);
      expect(res[0]).toEqual({ type: "local", path: homeDir, skipMcpDiscovery: true });
    });
  });

  it("trusted 含用户级 + 项目级两条", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    mkdirSync(join(cwdDir, ".aide", "claude", "skills", "y"), { recursive: true });
    withConfigDir(homeDir, () => {
      const res = buildDispatchPluginsOption(cwdDir, true);
      expect(res).toHaveLength(2);
      expect(res[0]).toEqual({ type: "local", path: homeDir, skipMcpDiscovery: true });
      expect(res[1]).toEqual({
        type: "local",
        path: join(cwdDir, ".aide", "claude"),
        skipMcpDiscovery: true,
      });
    });
  });

  it("用户级目录不存在 → 跳过用户级，仅项目级", () => {
    mkdirSync(join(cwdDir, ".aide", "claude", "skills", "y"), { recursive: true });
    withConfigDir(join(homeDir, "nope"), () => {
      const res = buildDispatchPluginsOption(cwdDir, true);
      expect(res).toHaveLength(1);
      expect(res[0].path).toBe(join(cwdDir, ".aide", "claude"));
    });
  });

  it("项目级目录不存在 → 跳过项目级，仅用户级", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    withConfigDir(homeDir, () => {
      const res = buildDispatchPluginsOption(cwdDir, true);
      expect(res).toHaveLength(1);
      expect(res[0].path).toBe(homeDir);
    });
  });

  it("每条都带 skipMcpDiscovery:true", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    mkdirSync(join(cwdDir, ".aide", "claude", "skills", "y"), { recursive: true });
    withConfigDir(homeDir, () => {
      const res = buildDispatchPluginsOption(cwdDir, true);
      expect(res.every((r) => r.skipMcpDiscovery === true)).toBe(true);
    });
  });

  it("注入会 ensureDispatchManifest 写清单（用户级 aide-user）", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    withConfigDir(homeDir, () => {
      buildDispatchPluginsOption(cwdDir, false);
      const m = JSON.parse(
        readFileSync(join(homeDir, ".claude-plugin", "plugin.json"), "utf8"),
      );
      expect(m).toEqual({ name: USER_PLUGIN_NAME });
    });
  });

  it("trusted 注入会写项目级清单 aide-project", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    mkdirSync(join(cwdDir, ".aide", "claude", "skills", "y"), { recursive: true });
    withConfigDir(homeDir, () => {
      buildDispatchPluginsOption(cwdDir, true);
      const m = JSON.parse(
        readFileSync(join(cwdDir, ".aide", "claude", ".claude-plugin", "plugin.json"), "utf8"),
      );
      expect(m).toEqual({ name: PROJECT_PLUGIN_NAME });
    });
  });
});
