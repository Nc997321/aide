import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadUserMcpServers,
  loadUserHooks,
  assembleMcpServers,
  assembleHooks,
} from "./userExtensions";

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

describe("assembleMcpServers", () => {
  it("codegraph（in-process）与用户（stdio/sse/http）按 name 共存", () => {
    const codegraph = { codegraph: { type: "in-process" } };
    const user = { myServer: { command: "npx", args: ["-y", "x"] }, sse: { type: "sse", url: "http://x" } };
    expect(assembleMcpServers(codegraph, user)).toEqual({
      codegraph: { type: "in-process" },
      myServer: { command: "npx", args: ["-y", "x"] },
      sse: { type: "sse", url: "http://x" },
    });
  });
  it("codegraph 为 null 时只返回用户项", () => {
    const user = { a: { command: "x" } };
    expect(assembleMcpServers(null, user)).toEqual({ a: { command: "x" } });
  });
  it("name 冲突时用户项覆盖 codegraph", () => {
    expect(assembleMcpServers({ dup: { type: "in-process" } }, { dup: { command: "x" } })).toEqual({
      dup: { command: "x" },
    });
  });
});

describe("assembleHooks", () => {
  // 与 buildBuiltinHooks 返回同形：每事件一组 { matcher, hooks: [] }
  const builtin = {
    PreToolUse: [
      { matcher: ".*", hooks: ["policyHook"] },
      { matcher: "^Read$", hooks: ["imageGuard"] },
    ],
    Stop: [{ hooks: ["stopEffort"] }],
  };
  const user = {
    PreToolUse: [{ matcher: "^Grep$", hooks: ["userGrepHook"] }],
    PostToolUse: [{ matcher: "^Bash$", hooks: ["userPostHook"] }],
  };

  it("用户 hook 排在内建之后，policyHook 保持 PreToolUse[0]", () => {
    const out = assembleHooks(builtin, user);
    expect(out.PreToolUse).toEqual([
      { matcher: ".*", hooks: ["policyHook"] },
      { matcher: "^Read$", hooks: ["imageGuard"] },
      { matcher: "^Grep$", hooks: ["userGrepHook"] },
    ]);
    expect(out.PreToolUse?.[0].hooks[0]).toBe("policyHook");
  });
  it("内建事件组在用户事件组之前（Stop 先于用户 PostToolUse）", () => {
    const out = assembleHooks(builtin, user);
    expect(Object.keys(out)).toEqual(["PreToolUse", "Stop", "PostToolUse"]);
  });
  it("用户独有事件组透传（内建无此事件也输出）", () => {
    const out = assembleHooks(builtin, user);
    expect(out.PostToolUse).toEqual([{ matcher: "^Bash$", hooks: ["userPostHook"] }]);
  });
  it("无用户 hooks 时仅输出内建组，空事件组不输出", () => {
    const out = assembleHooks(builtin, {});
    expect(out).toEqual(builtin);
  });
  it("用户无法通过同名事件越权覆盖内建（内建恒在前）", () => {
    // 用户 PreToolUse 塞入一个伪装 policy 的条目，也必须排在内建之后
    const evil = { PreToolUse: [{ matcher: ".*", hooks: ["evilHook"] }] };
    const out = assembleHooks(builtin, evil);
    expect(out.PreToolUse?.[0].hooks[0]).toBe("policyHook");
    expect(out.PreToolUse?.[out.PreToolUse.length - 1].hooks[0]).toBe("evilHook");
  });
});
