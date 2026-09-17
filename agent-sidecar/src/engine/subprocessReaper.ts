import { spawnSync } from "node:child_process";
import {
  deleteRegistryEntry,
  listSessionRegistryEntries,
  pickRegistryEntryForSession,
  type RegistryEntry,
} from "./claudeRegistry.js";

/**
 * 会话子进程的**强杀兜底**——N4 孤儿红线的唯一出口。
 *
 * 为什么需要（2026-09-17 实锤）：claude.exe 是常驻进程（streaming-input，回合结束
 * 不退），而释放路径只有 `query.close()` 一条，且它没有兜底——`currentQuery` 为 null
 * 时（错误终态已置空 / 换代窗口 / 循环已退）stop() 只置标志位啥也不杀；CLI 卡在等
 * 权限或长工具调用里时 close 也可能久久不退。于是"关标签"关得掉 UI，进程与它名下的
 * rust-analyzer / typescript-language-server 却一直活着：当天三个会话各挂一个
 * rust-analyzer（合计 ~7.9GB），其中一个会话的标签早已不在布局里。
 *
 * 职责分三层：
 *   纯核心  —— 探针结果 → 该不该杀（pid 会被复用，只认"活着且确实是 claude"）
 *   外壳    —— 探针 / 杀树 / 条目反查（SDK 不暴露 pid，唯一来源是 claude.exe 自己
 *              写的 sessions/<pid>.json）
 *   退出钩子 —— exit / SIGINT / SIGTERM / uncaughtException 四路都走同一次同步强杀
 *
 * 边界（刻意不做）：不扫全局杀"看起来没人要"的 claude.exe——dev 与安装版可能同跑，
 * 误杀别人的会话比漏杀更糟。真正"父进程没了也得死"的保证在 Rust 侧 Job Object
 * （KILL_ON_JOB_CLOSE），这一层只管"本 sidecar 起过的会话"。
 */

/** 停止后留给优雅退出的窗口；到点还活着就强杀。 */
const REAP_GRACE_MS = 1500;

// ---- 纯核心：探针结果 → 决策 ----

/** 目标 pid 现状：不存在 / 活着但不是 claude（pid 复用）/ 活着且是 claude。 */
export type ProcessProbe =
  | { kind: "gone" }
  | { kind: "other"; image: string }
  | { kind: "claude"; image: string };

/** 纯核心：镜像名是否 claude（`claude` / `claude.exe`，大小写与路径均无关）。 */
export function isClaudeImage(image: string): boolean {
  const base = image.trim().toLowerCase().split(/[\\/]/).pop() ?? "";
  return base === "claude" || base === "claude.exe";
}

/** 纯核心：要不要动手。只有"活着且确实是 claude"才杀——拿一条旧 pid 直接 taskkill
 *  是误杀别人的进程（pid 复用是常态，不是边角）。 */
export function shouldKill(probe: ProcessProbe): boolean {
  return probe.kind === "claude";
}

/** 纯核心：解析 `tasklist /FI "PID eq N" /FO CSV /NH` 输出。
 *  匹配不到时 tasklist 打的是本地化的提示句而非 CSV，故"首个引号字段"判据即可。 */
export function probeFromTasklistCsv(out: string): ProcessProbe {
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]*)"/.exec(line.trim());
    if (!m) continue;
    const image = m[1];
    return isClaudeImage(image) ? { kind: "claude", image } : { kind: "other", image };
  }
  return { kind: "gone" };
}

/** 纯核心：解析 `ps -o comm= -p <pid>` 输出（空 = 进程不在）。 */
export function probeFromPsComm(out: string): ProcessProbe {
  const image = out.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!image) return { kind: "gone" };
  return isClaudeImage(image) ? { kind: "claude", image } : { kind: "other", image };
}

// ---- 外壳：探针 / 杀树 ----

/** 探针：这个 pid 现在是什么。探针本身失败时按"不存在"处理——宁可漏杀（还有 Job
 *  Object 兜底）也不误杀。 */
export function probeProcess(pid: number): ProcessProbe {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
      });
      return probeFromTasklistCsv(r.stdout ?? "");
    }
    const r = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" });
    return probeFromPsComm(r.stdout ?? "");
  } catch {
    return { kind: "gone" };
  }
}

/** 强杀一整棵进程树。`/T` 是关键：claude.exe 名下的 rust-analyzer /
 *  typescript-language-server 是孙子进程，Windows 不连带杀子进程。
 *  `windowsHide` 对应 Rust 侧的 CREATE_NO_WINDOW（Windows 红线：不许弹控制台）。 */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    }
    spawnSync("pkill", ["-P", String(pid)], { stdio: "ignore" }); // 先孩子，后自己
    process.kill(pid, "SIGKILL");
  } catch {
    // 进程已退出 / 权限不足：强杀是尽力而为，异常不该打断收尾流程
  }
}

// ---- 外壳：本进程登记过的会话子进程 ----

type TrackedSession = { configDir: string | undefined };

const tracked = new Map<string, TrackedSession>();

/** 登记一个会话（新建 worker 时调用）。configDir 决定去哪个 sessions/ 反查 pid。 */
export function trackSessionSubprocess(sessionId: string, configDir: string | undefined): void {
  tracked.set(sessionId, { configDir });
}

/** re-key 跟随：session_init 后 routingKey 换成 SDK 真实 id，登记表跟着过户。 */
export function rekeySessionSubprocess(oldSessionId: string, newSessionId: string): void {
  const t = tracked.get(oldSessionId);
  if (!t) return;
  tracked.delete(oldSessionId);
  tracked.set(newSessionId, t);
}

/** 停止一个会话后的兜底强杀：先给优雅退出留 REAP_GRACE_MS，到点还活着就连树杀。
 *  反查不到条目 = claude.exe 已优雅退出并自清条目 → 无事可做，直接摘登记。
 *  pid 在**调用时**就定住：后续收尾流程（btw/自动化 selfTeardown 删条目）不该让它失去靶子。
 *  非热路径（每次关会话一次），同步 IO + 两次探针可接受。 */
export function reapSessionSubprocess(sessionId: string, graceMs: number = REAP_GRACE_MS): void {
  const t = tracked.get(sessionId);
  if (!t) return;
  const entry = resolveEntry(t, sessionId);
  if (!entry) {
    tracked.delete(sessionId);
    return;
  }
  const timer = setTimeout(() => {
    killVerified(entry, resolveEntry(t, sessionId));
    tracked.delete(sessionId);
  }, graceMs);
  timer.unref?.();
}

/** 同步强杀全部登记（**只给退出路径用**：'exit' 钩子里异步代码不会被执行）。
 *  返回真正动手的条数。 */
export function reapAllSync(): number {
  let killed = 0;
  for (const [sessionId, t] of tracked) {
    const entry = resolveEntry(t, sessionId);
    if (entry && killVerified(entry, entry)) killed += 1;
  }
  tracked.clear();
  return killed;
}

/** 启动清扫：删掉 pid 已不存在的残条目（claude.exe 被强杀留下的，会被 list_sessions
 *  扫成侧栏"幽灵会话"）。活着的条目一律不动——那是另一个实例（或本进程还没收口的
 *  会话）的进程。返回清理条数。 */
export function sweepStaleRegistryEntries(configDir: string | undefined): number {
  if (!configDir) return 0;
  let swept = 0;
  for (const entry of listSessionRegistryEntries(configDir)) {
    if (probeProcess(entry.pid).kind !== "gone") continue;
    deleteRegistryEntry(entry);
    swept += 1;
  }
  return swept;
}

/** 按 sessionId 反查 claude.exe 的 pid（条目跟着会话实际生效的配置根走）。 */
function resolveEntry(t: TrackedSession, sessionId: string): RegistryEntry | null {
  if (!t.configDir) return null;
  return pickRegistryEntryForSession(listSessionRegistryEntries(t.configDir), sessionId);
}

/** 验明正身再杀，杀完复验。两道闸：
 *  ① pid 复用——第二次反查的条目（current）与定住的那条不一致就收手；条目已被删
 *     （btw/自动化收尾清条目）时无复验材料，只剩闸②。
 *  ② 镜像名——探针说不是 claude 就不动手。
 *  确实没了才删条目；没死就留着，交给启动清扫。 */
function killVerified(entry: RegistryEntry, current: RegistryEntry | null): boolean {
  if (current && (current.pid !== entry.pid || current.procStart !== entry.procStart)) return false;
  if (!shouldKill(probeProcess(entry.pid))) return false;
  killProcessTree(entry.pid);
  if (probeProcess(entry.pid).kind === "gone") deleteRegistryEntry(entry);
  return true;
}

// ---- 退出钩子 ----

let exitHooksInstalled = false;

/** 装退出钩子：正常退出 / SIGINT / SIGTERM / 未捕获异常，四条路径共用同一次同步强杀。
 *  没有它，sidecar 一死（含被打字机式收尾漏掉的路径）常驻的 claude.exe 就永远留着。
 *  桌面宿主专用——headless 有自己的收尾（见 index.ts）。幂等。 */
export function installExitReaper(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.on("exit", () => {
    reapAllSync();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      reapAllSync();
      process.exit(0);
    });
  }
  process.on("uncaughtException", (e: unknown) => {
    console.error("[reaper] uncaughtException:", e);
    reapAllSync();
    process.exit(1);
  });
}

/** 测试用：清空登记（生产代码不调用）。 */
export function _testResetReaper(): void {
  tracked.clear();
}

/** 测试用：当前登记的会话键。 */
export function _testTrackedSids(): string[] {
  return [...tracked.keys()];
}
