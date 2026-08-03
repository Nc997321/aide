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
