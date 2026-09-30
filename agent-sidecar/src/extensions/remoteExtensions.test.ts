import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { commandHead, parseSendExtensions, preflightExtensions, resolvable } from "./remoteExtensions.js";

describe("parseSendExtensions", () => {
  it("缺席 / 形状不对 → undefined（本地车道）", () => {
    expect(parseSendExtensions(undefined)).toBeUndefined();
    expect(parseSendExtensions("x")).toBeUndefined();
  });
  it("坏字段按缺席处理，不丢整份投影", () => {
    const e = parseSendExtensions({ plugins: [{ path: "/a" }, { nope: 1 }], user_dir: "", settings: 3, unavailable: ["u", 2] })!;
    expect(e).toEqual({ plugins: [{ path: "/a" }], userDir: null, settings: {}, unavailable: ["u"] });
  });
});

describe("preflightExtensions", () => {
  let root: string;
  let bin: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aide-remote-ext-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "npx"), "");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const env = () => ({ PATH: bin });

  function plugin(name: string, hooks: unknown, mcp?: unknown): string {
    const dir = join(root, name);
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks }));
    writeFileSync(join(dir, "hooks", "run.sh"), "#!/bin/sh\n");
    if (mcp) writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp));
    return dir;
  }

  it("插件里的命令：${CLAUDE_PLUGIN_ROOT} 展开后存在 = 可用；缺 shell / 缺命令 = 如实报", () => {
    const ok = plugin("ok", { SessionStart: [{ hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" start' }] }] });
    const py = plugin("py", { Stop: [{ hooks: [{ type: "command", command: "python3 x.py" }] }] }, { mcpServers: { s: { command: "npx", args: [] } } });
    const sh = plugin("sh", { Stop: [{ hooks: [{ type: "command", command: "echo", shell: "zsh" }] }] });
    const out = preflightExtensions(
      { plugins: [{ path: ok }, { path: py }, { path: sh }, { path: join(root, "gone") }], userDir: null, settings: {}, unavailable: ["desk said so"] },
      env(),
    );
    expect(new Set(out)).toEqual(
      new Set([
        "desk said so",
        "plugin `py` Stop hook: `python3` was not found on this machine",
        "plugin `sh` Stop hook: needs `zsh`, which is not installed on this machine",
        `plugin at ${join(root, "gone")}: its copy on this machine is missing (it is re-copied when Aide restarts)`,
      ]),
    );
  });

  it("settings 里的 MCP / hook 同样检查", () => {
    const out = preflightExtensions(
      {
        plugins: [],
        userDir: null,
        settings: { mcpServers: { fs: { command: "npx" }, uv: { command: "uvx" } }, hooks: {} },
        unavailable: [],
      },
      env(),
    );
    expect(out).toEqual(["your MCP server `uv`: `uvx` was not found on this machine"]);
  });

  it("commandHead / resolvable", () => {
    expect(commandHead('"${CLAUDE_PLUGIN_ROOT}/a b/x" y', "/p")).toBe("/p/a b/x");
    expect(commandHead("npx -y foo")).toBe("npx");
    expect(resolvable("npx", { PATH: ["", bin].join(delimiter) })).toBe(true);
    expect(resolvable("nope", { PATH: bin })).toBe(false);
  });
});
