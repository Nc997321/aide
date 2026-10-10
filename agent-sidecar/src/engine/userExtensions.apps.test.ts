import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppMcp, loadAppMcpServers } from "./userExtensions";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aide-apps-"));
  // CLAUDE_CONFIG_DIR = <aide home>/claude；应用的派生文件在 <aide home>/app-data 下
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  mkdirSync(join(home, "app-data"), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.CLAUDE_CONFIG_DIR; });

const write = (text: string) => writeFileSync(join(home, "app-data", "mcp-servers.json"), text);
const entry = (name: string, workspace: string | null) => ({
  name,
  workspace,
  config: { type: "stdio", command: "/opt/node", args: [`/apps/${name}/server/main.mjs`], env: { AIDE_APP_ID: name } },
});

describe("loadAppMcpServers", () => {
  it("文件不存在 / 损坏 / 不是数组 → 空，不抛", () => {
    expect(loadAppMcpServers("/ws")).toEqual({});
    write("{not json");
    expect(loadAppMcpServers("/ws")).toEqual({});
    write('{"a":1}');
    expect(loadAppMcpServers("/ws")).toEqual({});
  });

  it("安装版应用挂给所有会话，配置原样透传", () => {
    write(JSON.stringify([entry("app-db", null)]));
    expect(loadAppMcpServers("/anywhere")).toEqual({ "app-db": entry("app-db", null).config });
    expect(loadAppMcpServers(undefined)).toEqual({ "app-db": entry("app-db", null).config });
  });

  it("开发态应用只挂给它那个工作区的会话", () => {
    write(JSON.stringify([entry("app-dev", "/work/proj"), entry("app-db", null)]));
    expect(Object.keys(loadAppMcpServers("/work/proj")).sort()).toEqual(["app-db", "app-dev"]);
    expect(Object.keys(loadAppMcpServers("/work/proj/"))).toContain("app-dev");
    expect(Object.keys(loadAppMcpServers("/work/other"))).toEqual(["app-db"]);
    expect(Object.keys(loadAppMcpServers(undefined))).toEqual(["app-db"]);
  });

  it("只读工具变成工具级放行规则；名字不规矩的不进规则", () => {
    write(JSON.stringify([
      { ...entry("app-db", null), readOnlyTools: ["list_history", "bad name", "x__y)", 3] },
      { ...entry("app-dev", "/work/proj"), readOnlyTools: [] },
      { ...entry("app-other", "/work/elsewhere"), readOnlyTools: ["peek"] },
    ]));
    const got = loadAppMcp("/work/proj");
    expect(Object.keys(got.servers).sort()).toEqual(["app-db", "app-dev"]);
    // 没挂上的应用（别的工作区的开发态）不贡献规则
    expect(got.allowRules).toEqual(["mcp__app-db__list_history"]);
    expect(loadAppMcp("/work/proj").allowRules.some((r) => r.includes("app-dev"))).toBe(false);
  });

  it("形状不对的条目跳过，不连累别的", () => {
    write(JSON.stringify([null, { name: 1 }, { name: "x" }, entry("app-db", null)]));
    expect(Object.keys(loadAppMcpServers("/ws"))).toEqual(["app-db"]);
  });
});
