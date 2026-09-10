import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { toForwardSlashes, safeDirname } from "../../winPaths.js";

/**
 * memoryEvents 内建 hook：记忆观测台的事件台账埋点（spec §4.2）。
 *
 * Claude Code 没有独立 "Memory Tool"——记忆操作就是 Read/Write/Edit 落在
 * `~/.aide/claude/projects/<key>/memory/` 上的普通文件调用。本 hook 在
 * PostToolUse 匹配这四个工具，file_path 命中当前工作区 memory 目录时往
 * `~/.aide/observatory/events.jsonl` append 一行：
 *   {ts, session_id, workspace_key, op, memory_id}
 *
 * op 分类：Read→read；Edit/MultiEdit→updated；Write→文件 birthtime≈mtime
 * 判 created（刚创建），否则 updated；deleted 由观测台删除命令在 Rust 侧写入。
 * 不区分「agent 主动写」还是后台整理写——只记文件行为，不做归因（定案）。
 *
 * 写盘失败静默跳过，永不阻塞/影响工具调用。
 */

const WATCHED_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);

/** 与 Rust 侧 workspace::path_to_key 同规则：`: \ /` → `-`。 */
export function pathToKey(p: string): string {
  return p.replace(/[:\\/]/g, "-");
}

/** memory 目录解析：dot 归一匹配（对齐 Rust resolve_project_dirs 的分裂目录合并语义）。 */
export function memoryDirs(configDir: string, cwd: string): string[] {
  const projects = path.join(configDir, "projects");
  const key = pathToKey(cwd).replace(/\./g, "-");
  let entries: string[] = [];
  try {
    entries = readdirSync(projects);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.replace(/\./g, "-") === key)
    .map((e) => path.join(projects, e, "memory"))
    .filter((d) => existsSync(d));
}

/** file_path 是否落在任一 memory 目录内；命中返回 memory_id（文件名）。 */
export function matchMemoryFile(dirs: string[], filePath: string): string | null {
  const fp = toForwardSlashes(filePath);
  for (const d of dirs) {
    const prefix = toForwardSlashes(d) + "/";
    if (fp.startsWith(prefix)) {
      const rest = fp.slice(prefix.length);
      // 只收顶层 .md（topic / MEMORY.md 本体；子目录不属于记忆面）
      if (!rest.includes("/") && rest.endsWith(".md")) return rest;
    }
  }
  return null;
}

/** op 分类。Write 用 birthtime/mtime 近似判新建；stat 失败保守归 updated。 */
export function classifyOp(tool: string, filePath: string): string {
  if (tool === "Read") return "read";
  if (tool === "Edit" || tool === "MultiEdit") return "updated";
  // Write
  try {
    const st = statSync(filePath);
    return Math.abs(st.birthtimeMs - st.mtimeMs) < 2000 ? "created" : "updated";
  } catch {
    return "updated";
  }
}

export function eventsLogPath(configDir: string): string {
  // observatory 目录与 claude/ 同级（~/.aide/observatory/）
  return path.join(path.dirname(configDir), "observatory", "events.jsonl");
}

export function makeMemoryEventsHook(env: NodeJS.ProcessEnv, cwd: string | undefined): HookCallback {
  return async (input: HookInput) => {
    try {
      if (input.hook_event_name !== "PostToolUse") return {};
      const tool = input.tool_name;
      if (!tool || !WATCHED_TOOLS.has(tool)) return {};
      const filePath = (input.tool_input as Record<string, unknown> | undefined)?.file_path;
      if (typeof filePath !== "string") return {};
      const configDir = env.CLAUDE_CONFIG_DIR;
      const workDir = (input as { cwd?: string }).cwd ?? cwd;
      if (!configDir || !workDir) return {};
      const dirs = memoryDirs(configDir, workDir);
      if (dirs.length === 0) return {};
      const memoryId = matchMemoryFile(dirs, filePath);
      if (!memoryId) return {};

      const record = {
        ts: Date.now(),
        session_id: (input as { session_id?: string }).session_id ?? "",
        workspace_key: pathToKey(workDir),
        op: classifyOp(tool, filePath),
        memory_id: memoryId,
      };
      const log = toForwardSlashes(eventsLogPath(configDir));
      // mkdir 独立 try：bun 的 recursive mkdir 对已存在目录抛 EEXIST（见
      // codegraphSkill.ts 同款防御），不能让它吃掉后面的 append。
      try {
        mkdirSync(safeDirname(log), { recursive: true });
      } catch {
        /* 已存在或不可创建，append 自行成败 */
      }
      appendFileSync(log, JSON.stringify(record) + "\n", "utf8");
    } catch {
      /* 埋点永不影响工具调用 */
    }
    return {};
  };
}
