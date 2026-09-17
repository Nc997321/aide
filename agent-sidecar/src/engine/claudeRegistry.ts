import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { toForwardSlashes } from "./winPaths.js";

/**
 * claude.exe 的 pid 注册条目清理（$CLAUDE_CONFIG_DIR/sessions/<pid>.json）。
 *
 * 动机（2026-09-02 实锤）：claude.exe 启动时在 sessions/ 写 `<pid>.json` 注册自己
 * （sessionId/cwd/派生名 cypress-agent-XX），**只有优雅退出才自清**；btw/自动化
 * 一次性会话回合结束走 selfTeardown 强制 close → 进程被杀 → 条目残留，被
 * list_sessions 第二遍扫描（session/mod.rs「有注册条目但无 jsonl」）当成
 * 「启动过没对话的会话」列进侧栏——用户看到的幽灵会话 cypress-agent-c6。
 * persistSession:false 已保证不落转录 jsonl，条目是唯一残留面，按 sessionId
 * 匹配删除即可根治。
 *
 * 已知残余边界（ts-reviewer 2026-09-02 记录项）：本模块只挂在 selfTeardown
 * （btw/自动化回合自然结束）收口；session-manager 的 stopSession/shutdown
 * 直接 worker.stop() 不经 selfTeardown——btw/自动化在这两条路径被停时条目
 * 依旧残留，与「不做 list_sessions 兜底」同属用户决策内的残余，靠会话列表
 * 手动删除兜底。
 *
 * 匹配键用 sessionId 而非 pid：条目文件名是 claude.exe 的 pid，aide 只掌握
 * SDK 会话 id；routingKey 还是 tempId（session_init 未到）时匹配不到任何条目，
 * 自然 no-op。.key 文件不归本模块管（peer 密钥，无 UI 影响）。
 *
 * 失败静默的理由：清理失败只多留一个死条目，无任何功能影响；用户可在会话
 * 列表手动删除（已有删除按钮）。绝不因清理失败打扰会话收尾。
 *
 * 第二用途（2026-09-17 起）：**反查 pid**。SDK 不暴露 claude.exe 的 pid，而
 * subprocessReaper 要连树强杀，唯一可靠的 pid 来源就是这里的条目——按 sessionId
 * 取回 pid，验明是 claude 再动手。所以本模块是「读」与「删」两个方向都对外。
 */

type Env = Record<string, string | undefined>;

/** 一条 claude.exe 注册条目（sessions/<pid>.json）。 */
export type RegistryEntry = {
  /** 条目文件名里的 pid（= claude.exe 自己的 pid）。 */
  pid: number;
  sessionId: string;
  /** 进程启动时间指纹（Windows FILETIME 计数原样）。缺字段 → null。 */
  procStart: string | null;
  /** 条目绝对路径（正斜杠）。 */
  file: string;
};

/** 纯核心：条目内容 → 收窄后的字段。坏 JSON / 非对象 / sessionId 非法 → null。
 *  条目是外部进程写的 JSON，字段集合未知，只信任已知字段（unknown 收窄）。 */
function narrowRegistryEntry(raw: string): { sessionId: string; procStart: string | null } | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const sid = (v as { sessionId?: unknown }).sessionId;
    if (typeof sid !== "string" || !sid) return null;
    const ps = (v as { procStart?: unknown }).procStart;
    return { sessionId: sid, procStart: typeof ps === "string" && ps ? ps : null };
  } catch {
    return null;
  }
}

/** 纯核心：从条目文件内容提取 sessionId。 */
export function registryEntrySessionId(raw: string): string | null {
  return narrowRegistryEntry(raw)?.sessionId ?? null;
}

/** 纯核心：条目文件名 → pid（`<pid>.json` 之外的形态不是注册条目 → null）。 */
export function registryPidFromFileName(fileName: string): number | null {
  const m = /^(\d+)\.json$/.exec(fileName);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** 纯核心：条目内容 + 文件名 → RegistryEntry。 */
export function registryEntryFrom(raw: string, fileName: string, file: string): RegistryEntry | null {
  const pid = registryPidFromFileName(fileName);
  if (pid === null) return null;
  const fields = narrowRegistryEntry(raw);
  if (!fields) return null;
  return { pid, sessionId: fields.sessionId, procStart: fields.procStart, file };
}

/** 纯核心：同一会话残留多条（硬杀重启后旧条目没清）时取最新进程——
 *  procStart 是 FILETIME 计数，按数值比；不可数值化的退化成字符串比较。 */
export function pickRegistryEntryForSession(
  entries: RegistryEntry[],
  sessionId: string,
): RegistryEntry | null {
  let best: RegistryEntry | null = null;
  for (const entry of entries) {
    if (entry.sessionId !== sessionId) continue;
    if (!best || compareProcStart(entry.procStart, best.procStart) > 0) best = entry;
  }
  return best;
}

function compareProcStart(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb ? 0 : na > nb ? 1 : -1;
  return a === b ? 0 : a > b ? 1 : -1;
}

/** sessions 子目录（正斜杠形态，供 path.join 与 spawn 共用）。 */
function sessionsDir(configDir: string): string {
  return toForwardSlashes(path.join(toForwardSlashes(configDir), "sessions"));
}

/** 外壳：列出 configDir/sessions 下全部注册条目。目录缺失/不可读 → 空表。
 *  单条目读失败跳过（被杀进程的文件句柄短瞬占用等），不阻断其余扫描。 */
export function listSessionRegistryEntries(configDir: string): RegistryEntry[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir(configDir));
  } catch {
    return [];
  }
  const entries: RegistryEntry[] = [];
  for (const name of names) {
    const file = toForwardSlashes(path.join(sessionsDir(configDir), name));
    try {
      const entry = registryEntryFrom(readFileSync(file, "utf8"), name, file);
      if (entry) entries.push(entry);
    } catch {
      // 读失败（EISDIR / 被占用）：跳过这一条
    }
  }
  return entries;
}

/** 外壳：删除一条注册条目。失败静默——残条目无功能影响，用户可手动删。 */
export function deleteRegistryEntry(entry: RegistryEntry): void {
  try {
    unlinkSync(entry.file);
  } catch {
    // 已被删 / 被占用：留着无害
  }
}

/** 外壳：按 sessionId 删除 configDir/sessions/ 下匹配的 <pid>.json 条目（删全部匹配项）。
 *  同步轻量 IO（目录里通常 <10 个小 json，收尾路径非热路径，不违 N3）。 */
export function removeSessionRegistryEntry(configDir: string, sessionId: string): void {
  for (const entry of listSessionRegistryEntries(configDir)) {
    if (entry.sessionId === sessionId) deleteRegistryEntry(entry);
  }
}

/** 便捷入口：env 解析 + 调用，供 worker 等持有 env 的调用方一行收尾。
 *  env 未设（sidecar 必有 CLAUDE_CONFIG_DIR，防御异常部署形态）时 no-op。 */
export function removeSessionRegistryEntryFromEnv(env: Env, sessionId: string): void {
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (!configDir) return;
  removeSessionRegistryEntry(configDir, sessionId);
}