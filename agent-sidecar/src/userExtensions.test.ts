import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserMcpServers, loadUserHooks } from "./userExtensions";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aide-ext-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.CLAUDE_CONFIG_DIR; });

function writeSettings(obj: any) { writeFileSync(join(dir, "settings.json"), JSON.stringify(obj)); }

describe("loadUserMcpServers", () => {
  it("文件不存在返回空对象", () => { expect(loadUserMcpServers()).toEqual({}); });
  it("损坏 JSON 返回空对象不抛", () => {
    writeFileSync(join(dir, "settings.json"), "{not json");
    expect(loadUserMcpServers()).toEqual({});
  });
  it("过滤 disabled:true", () => {
    writeSettings({ mcpServers: { a: { command: "x" }, b: { command: "y", disabled: true } } });
    expect(loadUserMcpServers()).toEqual({ a: { command: "x" } });
  });
  it("原样保留 sse/http 格式", () => {
    writeSettings({ mcpServers: { s: { type: "sse", url: "http://x" } } });
    expect(loadUserMcpServers()).toEqual({ s: { type: "sse", url: "http://x" } });
  });
  it("无 mcpServers 键返回空", () => { writeSettings({}); expect(loadUserMcpServers()).toEqual({}); });
});

describe("loadUserHooks", () => {
  it("过滤 disabled 的 hook 条目", () => {
    writeSettings({ hooks: { PostToolUse: [
      { matcher: "^Bash$", hooks: [{ type: "command", command: "x" }] },
      { matcher: "^Read$", hooks: [{ type: "command", command: "y" }], disabled: true },
    ] } });
    const h = loadUserHooks();
    expect(h.PostToolUse?.length).toBe(1);
    expect(h.PostToolUse?.[0].matcher).toBe("^Bash$");
  });
  it("无 hooks 键返回空对象", () => { writeSettings({}); expect(loadUserHooks()).toEqual({}); });
});
