// 用户 command 型 hook 的编译器 + 执行器（F4 修复）。
//
// 背景：settings.json 的用户 hook 是 `{type:"command", command:"..."}` 纯数据
//（Rust customizations/hooks.rs 写入、桌面 HookEditor 可建），而 SDK 的
// options.hooks 通道只认 HookCallback **函数**——SDK initialize 会把条目原样
// 注册进 hookCallbacks（零校验），hook 触发时按函数调用：非函数 → TypeError →
// hook_callback 控制请求以 error 收场 → CLI 工具管线断流（tool_use_start 之后
// 零 tool_result、零 permission_request，2026-09-11 headless 验收 F4 实锤）。
// 本模块把 command 条目编译成真 HookCallback：spawn 子进程，按 Claude Code
// hook 协议对接——stdin 喂 HookInput JSON、stdout 读 JSON 输出、exit code
// 裁决（0=成功、2=阻断、其它=非阻断错误），timeout 兜底杀进程（N4 孤儿红线）。
//
// 安全边界：子进程 env = sidecar 的 process.env——会话 metadata / mcp_headers
// 永不进 env（cliEnv 同款红线），shell hook 天然读不到凭据（C6 语义）。
// 日志纪律（N5）：命令原文不回显（用户可能在命令里内联 token），只报
// event/exit code/截断的 stderr。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { HookCallback, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

/** 编译上下文：event 决定 exit-2 阻断输出的形状；cwd 是子进程工作目录。 */
export interface CommandHookContext {
  readonly event: string;
  readonly cwd: string | undefined;
}

/** 编译期环境注入（测试缝；生产省略用真值）：平台 / env / 文件存在探针。 */
export interface CommandHookDeps {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (p: string) => boolean;
}

/** shell 形式（经 -c 包装）与 exec 形式（args 直spawn，无 shell）二选一——
 *  判别联合封闭，「无 args 又无 executor」的非法组合造不出来（M5）。 */
type CommandHookPlan =
  | { readonly kind: "shell"; readonly command: string; readonly timeoutMs: number; readonly executor: ShellExecutor }
  | { readonly kind: "exec"; readonly command: string; readonly timeoutMs: number; readonly args: readonly string[] };

/** 已解析的 shell 执行器（resolveShellExecutor 产物；导出仅因公共签名引用）。 */
export interface ShellExecutor {
  readonly file: string;
  /** 把用户命令包装成 shell argv（-c / -Command 形式）。 */
  wrap(command: string): string[];
}

type ShellKind = "bash" | "powershell";

/** Claude Code hook 协议的缺省超时（秒）。 */
const DEFAULT_TIMEOUT_SEC = 60;
/** stdout/stderr 各自读取上限（N1：防失控 hook 撑爆内存；超限截断）。 */
const MAX_OUTPUT_BYTES = 256 * 1024;

const describeErr = (e: unknown): string => String((e as Error)?.message ?? e);

/**
 * 把一条 settings.json hook 条目编译成 SDK HookCallback。
 * 形状非法 / 依赖的 shell 缺失 → 返回 null（调用方丢弃；内部已 console.error，
 * 绝不把非函数喂给 SDK——F4 根因红线）。
 */
export function compileCommandHook(
  entry: unknown,
  ctx: CommandHookContext,
  deps: CommandHookDeps = {},
): HookCallback | null {
  const fields = parseSpecFields(entry);
  if (!fields) {
    console.error(`[hooks] ${ctx.event} 用户 hook 条目形状非法，已忽略（非函数条目绝不进 SDK hooks；内容不回显，N5）`);
    return null;
  }
  if (fields.degraded.length > 0) {
    console.warn(`[hooks] ${ctx.event} 用户 hook 字段 ${fields.degraded.join("/")} 暂不支持，已降级为同步无条件执行`);
  }
  const plan = buildPlan(fields, {
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    exists: deps.exists ?? existsSync,
  });
  if (!plan) {
    console.error(`[hooks] ${ctx.event} 用户 hook 指定 bash 但本机未找到可用的 bash，已忽略该条`);
    return null;
  }
  return (input, toolUseID, options) =>
    runCommandHook(plan, ctx, { input, toolUseID, signal: options?.signal });
}

// ---- 纯核心：条目解析 / exit code 协议（无 IO，可直测） ----

interface SpecFields {
  readonly command: string;
  readonly args: readonly string[] | null;
  readonly timeoutMs: number;
  readonly shell: ShellKind | null;
  /** 暂不支持、已降级的字段名（if / asyncRewake——告警用）。 */
  readonly degraded: readonly string[];
}

/** settings.json 条目是自由 JSON（X1 边界例外）：逐字段收窄，任何形状违规
 *  整体拒绝（fail-closed，与 sessionMetadata.parseMcpHeaders 同纪律）。 */
function parseSpecFields(entry: unknown): SpecFields | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  if (e.type !== "command") return null;
  if (typeof e.command !== "string" || !e.command.trim()) return null;
  if (e.args !== undefined && (!Array.isArray(e.args) || !e.args.every((a) => typeof a === "string"))) return null;
  if (e.shell !== undefined && e.shell !== "bash" && e.shell !== "powershell") return null;
  const timeoutSec =
    typeof e.timeout === "number" && Number.isFinite(e.timeout) && e.timeout > 0
      ? e.timeout
      : DEFAULT_TIMEOUT_SEC;
  const degraded: string[] = [];
  if (e.if !== undefined) degraded.push("if");
  if (e.asyncRewake !== undefined) degraded.push("asyncRewake");
  // args 元素类型已在上方 every 校验（string[]），断言只表达「校验后必然成立」
  const args = Array.isArray(e.args) ? (e.args as readonly string[]) : null;
  return { command: e.command, args, timeoutMs: timeoutSec * 1000, shell: e.shell ?? null, degraded };
}

function buildPlan(fields: SpecFields, host: Required<CommandHookDeps>): CommandHookPlan | null {
  if (fields.args) {
    return { kind: "exec", command: fields.command, timeoutMs: fields.timeoutMs, args: fields.args };
  }
  const executor = resolveShellExecutor({ shell: fields.shell, ...host });
  if (!executor) return null;
  return { kind: "shell", command: fields.command, timeoutMs: fields.timeoutMs, executor };
}

/**
 * exit code → HookJSONOutput（Claude Code hook 协议）：
 * 0 = 成功（stdout 若是 JSON 对象则透传，否则无结构化输出）；
 * 2 = 阻断（stderr 作理由：PreToolUse 走 permissionDecision deny——与
 *     policy/sessionHook.ts 的 deny 形状逐字段一致；其它事件走 decision block）；
 * 其它 = 非阻断错误（记日志放行，与 CLI 对 settings hook 的处置对齐）。
 */
export function hookExitOutput(
  event: string,
  exit: { code: number | null; stdout: string; stderr: string },
): HookJSONOutput {
  if (exit.code === 0) return parseHookJson(exit.stdout);
  if (exit.code === 2) {
    const reason = exit.stderr.trim() || "command hook 阻断了本次操作（exit 2，未给理由）";
    return event === "PreToolUse"
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: reason,
          },
        }
      : { decision: "block", reason };
  }
  const tail = exit.stderr.trim() ? `: ${exit.stderr.trim().slice(0, 200)}` : "";
  console.error(`[hooks] ${event} command hook 退出码 ${exit.code}（非阻断，放行）${tail}`);
  return {};
}

/** stdout 的 JSON 输出 → hook 结果。非 JSON / 非纯对象 → {}（协议上 exit 0 的
 *  纯文本 stdout 只是给人看的转录信息，不产生结构化输出）。 */
function parseHookJson(stdout: string): HookJSONOutput {
  const text = stdout.trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // JSON 边界（X1 例外）：hook stdout 是自由 JSON，无法逐字段深校验——
      // 只守「是纯对象」这道门，其余按 HookJSONOutput 契约由 CLI 消费。
      return parsed as HookJSONOutput;
    }
  } catch {
    // 非 JSON stdout：协议内合法形态（纯文本输出），不是错误——按无结构化输出处理
  }
  return {};
}

// ---- 平台笼子（L3/N6）：shell 解析只在本节出现平台分支 ----

/** shell 解析入参（导出仅因 resolveShellExecutor 公共签名引用）。 */
export interface ShellResolveOpts {
  shell: ShellKind | null;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
}

/** 解析 shell 执行器（纯函数，导出供直测）。返回 null 仅在「显式要 bash 但
 *  Windows 上找不到」——缺省语义对齐 CLI 文档：Windows 优先 Git Bash、缺失退
 *  PowerShell；POSIX 走 $SHELL（缺省 /bin/sh）。 */
export function resolveShellExecutor(o: ShellResolveOpts): ShellExecutor | null {
  const powershell: ShellExecutor = {
    // 文档口径 'powershell' 用 pwsh，但 Windows PowerShell（powershell.exe）
    // 全机必在、pwsh 要单独装——可靠性优先取 powershell.exe；POSIX 上才用 pwsh。
    file: o.platform === "win32" ? "powershell.exe" : "pwsh",
    wrap: (c) => ["-NoProfile", "-Command", c],
  };
  const posix: ShellExecutor = { file: o.env.SHELL || "/bin/sh", wrap: (c) => ["-c", c] };
  if (o.platform !== "win32") {
    return o.shell === "powershell" ? powershell : posix;
  }
  const bashPath = findWindowsBash(o.env, o.platform, o.exists);
  const bash: ShellExecutor | null = bashPath ? { file: bashPath, wrap: (c) => ["-c", c] } : null;
  if (o.shell === "powershell") return powershell;
  if (o.shell === "bash") return bash;
  return bash ?? powershell;
}

/**
 * Windows 上找 Git Bash：PATH 扫描 + 标准安装位兜底。
 * 排除 System32\bash.exe——那是 WSL 入口，Windows 路径语义不通（`node "C:/…"`
 * 会按 Linux 视角解析），不是 Git Bash。exists 可注入供测试。
 */
export function findWindowsBash(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (platform !== "win32") return null;
  // 显式 path.win32：platform 可注入，宿主为 Linux/macOS 时 node:path 是 posix 语义
  const system32 = env.SystemRoot ? path.win32.join(env.SystemRoot, "System32").toLowerCase() : null;
  const candidates: string[] = [];
  for (const dir of (env.Path ?? env.PATH ?? "").split(";")) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = path.win32.join(trimmed, "bash.exe");
    if (system32 && candidate.toLowerCase().startsWith(system32)) continue; // WSL bash，跳过
    candidates.push(candidate);
  }
  const drive = env.SystemDrive ?? "C:";
  candidates.push(
    path.win32.join(drive, "Program Files", "Git", "bin", "bash.exe"),
    path.win32.join(drive, "Program Files", "Git", "usr", "bin", "bash.exe"),
  );
  if (env.LOCALAPPDATA) {
    candidates.push(path.win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  for (const c of candidates) {
    try {
      if (exists(c)) return c;
    } catch {
      // 注入的 exists 探针对非法路径可能抛——按「不存在」跳过，继续下一候选
    }
  }
  return null;
}

// ---- 执行器（薄外壳：spawn + 协议对接 + 生命周期兜底） ----

interface HookInvocation {
  input: HookInput;
  toolUseID: string | undefined;
  signal?: AbortSignal;
}

function runCommandHook(
  plan: CommandHookPlan,
  ctx: CommandHookContext,
  call: HookInvocation,
): Promise<HookJSONOutput> {
  if (call.signal?.aborted) return Promise.resolve({});
  let child: ChildProcessWithoutNullStreams;
  try {
    const opts = { cwd: ctx.cwd || process.cwd(), env: process.env, windowsHide: true };
    child = plan.kind === "shell"
      ? spawn(plan.executor.file, plan.executor.wrap(plan.command), opts)
      : spawn(plan.command, [...plan.args], opts);
  } catch (e) {
    // spawn 同步抛（cwd 不存在等）：非阻断放行，日志可查（X5）
    console.error(`[hooks] ${ctx.event} command hook spawn 失败（非阻断，放行）：${describeErr(e)}`);
    return Promise.resolve({});
  }
  return new Promise<HookJSONOutput>((resolve) => {
    let settled = false;
    const finish = (out: HookJSONOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      call.signal?.removeEventListener("abort", onAbort);
      resolve(out);
    };
    let stdout = "";
    let stderr = "";
    const appendCapped = (current: string, chunk: Buffer): string =>
      current.length >= MAX_OUTPUT_BYTES ? current : current + String(chunk);
    child.stdout.on("data", (d: Buffer) => { stdout = appendCapped(stdout, d); });
    child.stderr.on("data", (d: Buffer) => { stderr = appendCapped(stderr, d); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL"); // N4：超时必杀，不留孤儿
      console.error(`[hooks] ${ctx.event} command hook 超时（${plan.timeoutMs}ms），已杀进程并按非阻断放行`);
      finish({});
    }, plan.timeoutMs);
    function onAbort(): void {
      child.kill("SIGKILL"); // SDK 撤信号（interrupt/关会话）：hook 子进程一并回收
      finish({});
    }
    call.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      // spawn 异步失败（shell 可执行文件缺失等）：非阻断放行
      console.error(`[hooks] ${ctx.event} command hook 启动失败（非阻断，放行）：${describeErr(e)}`);
      finish({});
    });
    child.on("close", (code) => {
      finish(hookExitOutput(ctx.event, { code, stdout, stderr }));
    });
    // stdin 喂协议 JSON（tool_use_id 对齐 CLI 对 settings hook 的注入）。子进程
    // 提前退出时写入吃 EPIPE——不是错误路径，挂空 handler 防 unhandled emit（X5
    // 注释义务：静默的理由成立=对端已退出，结果由 close 事件收敛）。
    child.stdin.on("error", () => { /* 子进程先退出，stdin 未写完——由 close 收口 */ });
    const payload = call.toolUseID !== undefined
      ? { ...call.input, tool_use_id: call.toolUseID }
      : call.input;
    child.stdin.end(JSON.stringify(payload));
  });
}
