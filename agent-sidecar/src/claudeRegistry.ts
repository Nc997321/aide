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
 */

type Env = Record<string, string | undefined>;

/** 纯核心：从条目文件内容提取 sessionId。坏 JSON / 无字段 / 非字符串 → null。
 *  条目是外部进程写的 JSON，字段集合未知，只信任 sessionId 字段（unknown 收窄）。 */
export function registryEntrySessionId(raw: string): string | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const sid = (v as { sessionId?: unknown }).sessionId;
    return typeof sid === "string" && sid ? sid : null;
  } catch {
    return null;
  }
}

/** 外壳：按 sessionId 删除 configDir/sessions/ 下匹配的 <pid>.json 条目。
 *  同步轻量 IO（目录里通常 <10 个小 json，btw 收尾路径非热路径，不违 N3）。
 *  单文件读写失败跳过（被杀进程的文件句柄短瞬占用等），不影响其他条目。 */
export function removeSessionRegistryEntry(configDir: string, sessionId: string): void {
  try {
    const dir = toForwardSlashes(path.join(toForwardSlashes(configDir), "sessions"));
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue; // .key 及其他文件不动
      const file = toForwardSlashes(path.join(dir, name));
      try {
        if (registryEntrySessionId(readFileSync(file, "utf8")) === sessionId) {
          unlinkSync(file);
        }
      } catch {
        // 单条目读/删失败（Windows 文件被 claude.exe 退出过程短瞬锁住等）：
        // 留死条目交给用户手动删，不重试不扩散。
      }
    }
  } catch {
    // 目录缺失/不可读（会话从未起过 claude.exe 等）：无条目可删，静默。
  }
}

/** 便捷入口：env 解析 + 调用，供 worker 等持有 env 的调用方一行收尾。
 *  env 未设（sidecar 必有 CLAUDE_CONFIG_DIR，防御异常部署形态）时 no-op。 */
export function removeSessionRegistryEntryFromEnv(env: Env, sessionId: string): void {
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (!configDir) return;
  removeSessionRegistryEntry(configDir, sessionId);
}