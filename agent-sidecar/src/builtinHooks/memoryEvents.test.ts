import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  pathToKey,
  memoryDirs,
  matchMemoryFile,
  classifyOp,
  makeMemoryEventsHook,
} from "./memoryEvents";

let root: string;
let configDir: string;
const cwd = "C:\\document\\owner\\cypress-agent";
const key = "C--document-owner-cypress-agent";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "aide-me-"));
  configDir = path.join(root, "claude");
  mkdirSync(path.join(configDir, "projects", key, "memory"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function invoke(hook: any, input: Record<string, unknown>) {
  return hook(
    { hook_event_name: "PostToolUse", session_id: "s1", cwd, ...input },
    "tu1",
    { signal: new AbortController().signal },
  );
}

function readEvents(): any[] {
  const log = path.join(root, "observatory", "events.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("pathToKey / memoryDirs / matchMemoryFile", () => {
  it("pathToKey 与 Rust 同规则", () => {
    expect(pathToKey(cwd)).toBe(key);
    expect(pathToKey("/a/b/c")).toBe("-a-b-c");
  });

  it("memoryDirs dot 归一匹配分裂目录", () => {
    // 新版编码把 . 也替换为 -（chennong4.0 → chennong4-0 两目录共存场景）
    mkdirSync(path.join(configDir, "projects", key, "memory2"), { recursive: true });
    const dirs = memoryDirs(configDir, cwd);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].endsWith("memory")).toBe(true);
    expect(memoryDirs(configDir, "D:\\nonexistent")).toHaveLength(0);
  });

  it("matchMemoryFile 只收顶层 .md", () => {
    const dirs = memoryDirs(configDir, cwd);
    const memDir = toForward(path.join(configDir, "projects", key, "memory"));
    expect(matchMemoryFile(dirs, `${memDir}/note.md`)).toBe("note.md");
    expect(matchMemoryFile(dirs, `${memDir}/MEMORY.md`)).toBe("MEMORY.md");
    expect(matchMemoryFile(dirs, `${memDir}/sub/x.md`)).toBeNull();
    expect(matchMemoryFile(dirs, `${memDir}/note.txt`)).toBeNull();
    expect(matchMemoryFile(dirs, "C:/other/place/note.md")).toBeNull();
    // 反斜杠路径（Windows 常态）也命中
    expect(matchMemoryFile(dirs, path.join(configDir, "projects", key, "memory", "win.md"))).toBe("win.md");
  });
});

function toForward(p: string) {
  return p.replace(/\\/g, "/");
}

describe("classifyOp", () => {
  it("Read→read / Edit→updated / MultiEdit→updated", () => {
    expect(classifyOp("Read", "x.md")).toBe("read");
    expect(classifyOp("Edit", "x.md")).toBe("updated");
    expect(classifyOp("MultiEdit", "x.md")).toBe("updated");
  });

  it("Write：birthtime≈mtime 判 created，mtime 被改旧判 updated，stat 失败保守 updated", () => {
    const f = path.join(configDir, "projects", key, "memory", "w.md");
    writeFileSync(f, "x");
    expect(classifyOp("Write", f)).toBe("created");
    utimesSync(f, new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect(classifyOp("Write", f)).toBe("updated");
    expect(classifyOp("Write", path.join(root, "nope.md"))).toBe("updated");
  });
});

describe("memoryEvents hook", () => {
  it("命中 memory 目录的 Read 落一条 read 事件", async () => {
    const hook = makeMemoryEventsHook({ CLAUDE_CONFIG_DIR: configDir }, cwd);
    const fp = path.join(configDir, "projects", key, "memory", "note.md");
    writeFileSync(fp, "x");
    await invoke(hook, { tool_name: "Read", tool_input: { file_path: fp } });
    const ev = readEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ session_id: "s1", workspace_key: key, op: "read", memory_id: "note.md" });
  });

  it("Write 新文件落 created；Edit 落 updated", async () => {
    const hook = makeMemoryEventsHook({ CLAUDE_CONFIG_DIR: configDir }, cwd);
    const fp = path.join(configDir, "projects", key, "memory", "n.md");
    writeFileSync(fp, "x"); // PostToolUse：工具已写完，hook 只看到结果
    await invoke(hook, { tool_name: "Write", tool_input: { file_path: fp } });
    await invoke(hook, { tool_name: "Edit", tool_input: { file_path: fp } });
    expect(readEvents().map((e) => e.op)).toEqual(["created", "updated"]);
  });

  it("不命中不落事件：别的工具 / 别的路径 / 非 PostToolUse / 缺 file_path", async () => {
    const hook = makeMemoryEventsHook({ CLAUDE_CONFIG_DIR: configDir }, cwd);
    const fp = path.join(configDir, "projects", key, "memory", "note.md");
    writeFileSync(fp, "x");
    await invoke(hook, { tool_name: "Bash", tool_input: { command: "ls" } });
    await invoke(hook, { tool_name: "Read", tool_input: { file_path: "C:/other/x.md" } });
    await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: fp } }, "tu1", {} as any);
    await invoke(hook, { tool_name: "Read", tool_input: {} });
    expect(readEvents()).toHaveLength(0);
  });

  it("无 CLAUDE_CONFIG_DIR / 写盘失败都静默返回 {}", async () => {
    const hook = makeMemoryEventsHook({}, cwd);
    const out = await invoke(hook, { tool_name: "Read", tool_input: { file_path: "C:/x.md" } });
    expect(out).toEqual({});
  });
});
