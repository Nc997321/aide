// commandHooks 直测：F4 修复（settings.json command 型 hook → SDK HookCallback）。
// 纯核心（hookExitOutput/resolveShellExecutor/findWindowsBash/编译判别）+ 真实
// 子进程执行臂（exec 形式用 process.execPath 起 node，确定性、不依赖 shell 解析）。
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  compileCommandHook,
  hookExitOutput,
  findWindowsBash,
  resolveShellExecutor,
  type CommandHookContext,
} from "./commandHooks";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";

const CTX_PRE: CommandHookContext = { event: "PreToolUse", cwd: undefined };
const CTX_STOP: CommandHookContext = { event: "Stop", cwd: undefined };

/** PreToolUse 的最小 HookInput（执行臂喂给子进程 stdin）。 */
const preInput = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "env" },
} as unknown as HookInput;

/** exec 形式条目：node -e <script>（确定性，绕开 shell 解析）。 */
function nodeEntry(script: string, extra: Record<string, unknown> = {}) {
  return { type: "command", command: process.execPath, args: ["-e", script], ...extra };
}

const invoke = (fn: NonNullable<ReturnType<typeof compileCommandHook>>, toolUseID?: string) =>
  fn(preInput, toolUseID, { signal: new AbortController().signal });

afterEach(() => { vi.restoreAllMocks(); });

// ---- 编译判别（parseSpecFields / buildPlan 臂） ----

describe("compileCommandHook — 编译判别", () => {
  it("合法 command 条目编译成函数（F4 根因：绝不产出非函数）", () => {
    expect(typeof compileCommandHook(nodeEntry("0"), CTX_PRE)).toBe("function");
  });
  it("shell 形式条目同样编译成函数", () => {
    expect(typeof compileCommandHook({ type: "command", command: "echo hi" }, CTX_PRE)).toBe("function");
  });
  it("形状非法 → null + console.error（内容不回显，N5）", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of [
      null,
      "command",
      [1, 2],
      { command: "x" },                          // 缺 type
      { type: "prompt", command: "x" },           // type 不是 command
      { type: "command" },                        // 缺 command
      { type: "command", command: "  " },         // 空白 command
      { type: "command", command: "x", args: "not-array" },
      { type: "command", command: "x", args: [1, 2] },
      { type: "command", command: "x", shell: "fish" },
    ]) {
      expect(compileCommandHook(bad, CTX_PRE), JSON.stringify(bad)).toBeNull();
    }
    expect(err).toHaveBeenCalled();
    for (const call of err.mock.calls) {
      expect(String(call[0])).not.toContain("not-array"); // 条目内容不落日志
    }
  });
  it("显式 shell:bash 但本机无 bash → null + console.error", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = compileCommandHook(
      { type: "command", command: "echo hi", shell: "bash" },
      CTX_PRE,
      { platform: "win32", env: { Path: "" }, exists: () => false },
    );
    expect(out).toBeNull();
    expect(err).toHaveBeenCalled();
  });
  it("暂不支持字段（if/asyncRewake）→ console.warn 降级但照常编译", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = compileCommandHook(nodeEntry("0", { if: "Bash(git *)", asyncRewake: true }), CTX_PRE);
    expect(typeof fn).toBe("function");
    expect(warn.mock.calls.map((c) => String(c[0])).join()).toContain("if/asyncRewake");
  });
  it("timeout 合法值换算 ms；非法值（0/负数/NaN/非数）回落默认 60s", async () => {
    // 经由执行臂观测：timeout 0.3s 的睡眠脚本应在 ~300ms 被杀并放行
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t0 = Date.now();
    const fn = compileCommandHook(nodeEntry("setTimeout(()=>{},10000)", { timeout: 0.3 }), CTX_PRE);
    expect(await invoke(fn!)).toEqual({});
    expect(Date.now() - t0).toBeLessThan(5000);
    // 非法 timeout（0）→ 回落默认 60s：编译成功即可（默认值臂由纯解析覆盖）
    expect(typeof compileCommandHook(nodeEntry("0", { timeout: 0 }), CTX_PRE)).toBe("function");
  });
});

// ---- 纯核心：exit code 协议 ----

describe("hookExitOutput — exit code 协议", () => {
  it("exit 0 + JSON 对象 stdout → 原样透传", () => {
    const json = { continue: true, systemMessage: "hi" };
    expect(hookExitOutput("PreToolUse", { code: 0, stdout: JSON.stringify(json), stderr: "" })).toEqual(json);
  });
  it("exit 0 + 非 JSON / 空 / JSON 数组 → {}（纯文本不产生结构化输出）", () => {
    expect(hookExitOutput("PreToolUse", { code: 0, stdout: "hello world", stderr: "" })).toEqual({});
    expect(hookExitOutput("PreToolUse", { code: 0, stdout: "  ", stderr: "" })).toEqual({});
    expect(hookExitOutput("PreToolUse", { code: 0, stdout: "[1,2]", stderr: "" })).toEqual({});
    expect(hookExitOutput("PreToolUse", { code: 0, stdout: "null", stderr: "" })).toEqual({});
  });
  it("exit 2 + PreToolUse → permissionDecision deny（与 policy/sessionHook 同形状），stderr 作理由", () => {
    expect(hookExitOutput("PreToolUse", { code: 2, stdout: "", stderr: " 外部审计拒绝 " })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "外部审计拒绝",
      },
    });
  });
  it("exit 2 + 非 PreToolUse 事件 → decision block", () => {
    expect(hookExitOutput("Stop", { code: 2, stdout: "", stderr: "不许停" })).toEqual({
      decision: "block",
      reason: "不许停",
    });
  });
  it("exit 2 + 空 stderr → 兜底理由", () => {
    const out = hookExitOutput("PreToolUse", { code: 2, stdout: "", stderr: "  " });
    expect(out).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("exit 2") },
    });
  });
  it("其它非零 exit / 被信号杀（code null）→ {} 非阻断 + console.error", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(hookExitOutput("PreToolUse", { code: 1, stdout: "", stderr: "炸了" })).toEqual({});
    expect(err.mock.calls[0]?.[0]).toContain("炸了");
    expect(hookExitOutput("Stop", { code: null, stdout: "", stderr: "" })).toEqual({});
  });
});

// ---- 纯核心：平台 shell 解析 ----

describe("resolveShellExecutor / findWindowsBash — 平台笼子", () => {
  const noExists = () => false;
  it("win32 缺省：找到 Git Bash 用 bash -c；找不到退 PowerShell", () => {
    const env = { Path: "C:\\git\\bin" } as NodeJS.ProcessEnv;
    const withBash = resolveShellExecutor({ shell: null, platform: "win32", env, exists: () => true });
    expect(withBash?.file).toBe("C:\\git\\bin\\bash.exe");
    expect(withBash?.wrap("cmd")).toEqual(["-c", "cmd"]);
    const noBash = resolveShellExecutor({ shell: null, platform: "win32", env, exists: noExists });
    expect(noBash?.file).toBe("powershell.exe");
    expect(noBash?.wrap("cmd")).toEqual(["-NoProfile", "-Command", "cmd"]);
  });
  it("win32 显式 shell 选择：powershell 直选；bash 缺失 → null", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveShellExecutor({ shell: "powershell", platform: "win32", env, exists: noExists })?.file)
      .toBe("powershell.exe");
    expect(resolveShellExecutor({ shell: "bash", platform: "win32", env, exists: noExists })).toBeNull();
  });
  it("POSIX：$SHELL 优先、缺省 /bin/sh；显式 powershell → pwsh", () => {
    const zsh = resolveShellExecutor({ shell: null, platform: "darwin", env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv, exists: noExists });
    expect(zsh?.file).toBe("/bin/zsh");
    expect(zsh?.wrap("c")).toEqual(["-c", "c"]);
    const def = resolveShellExecutor({ shell: "bash", platform: "linux", env: {} as NodeJS.ProcessEnv, exists: noExists });
    expect(def?.file).toBe("/bin/sh");
    expect(resolveShellExecutor({ shell: "powershell", platform: "linux", env: {}, exists: noExists })?.file).toBe("pwsh");
  });
  it("findWindowsBash：非 win32 → null；PATH 命中优先；System32 的 WSL bash 被排除", () => {
    expect(findWindowsBash({}, "linux", () => true)).toBeNull();
    const hit = findWindowsBash({ Path: "C:\\a;C:\\b" } as NodeJS.ProcessEnv, "win32", (p) => p.endsWith("b\\bash.exe"));
    expect(hit).toBe("C:\\b\\bash.exe");
    // 只有 System32\\bash.exe 存在（WSL）→ 必须视而不见，退标准安装位（也不存在）→ null
    const wslOnly = findWindowsBash(
      { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" } as NodeJS.ProcessEnv,
      "win32",
      (p) => p.toLowerCase().includes("system32"),
    );
    expect(wslOnly).toBeNull();
  });
  it("findWindowsBash：标准安装位与 LOCALAPPDATA 兜底；exists 抛错按不存在跳过", () => {
    const pf = findWindowsBash({ SystemDrive: "D:" } as NodeJS.ProcessEnv, "win32", (p) => p === "D:\\Program Files\\Git\\usr\\bin\\bash.exe");
    expect(pf).toBe("D:\\Program Files\\Git\\usr\\bin\\bash.exe");
    const la = findWindowsBash({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } as NodeJS.ProcessEnv, "win32", (p) => p.includes("AppData"));
    expect(la).toBe("C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
    let calls = 0;
    expect(findWindowsBash({ Path: "C:\\x" } as NodeJS.ProcessEnv, "win32", () => { calls++; throw new Error("boom"); })).toBeNull();
    expect(calls).toBeGreaterThan(0);
  });
});

// ---- 执行臂（真实子进程，exec 形式 = node 直 spawn，确定性） ----

describe("compileCommandHook — 执行协议（真实子进程）", () => {
  it("stdin 收到 HookInput JSON + tool_use_id 注入；stdout JSON 原样返回", async () => {
    const fn = compileCommandHook(
      nodeEntry(
        "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
        "const i=JSON.parse(d);" +
        "console.log(JSON.stringify({continue:true,systemMessage:i.hook_event_name+':'+i.tool_name+':'+i.tool_use_id}))})",
      ),
      CTX_PRE,
    )!;
    const out = await invoke(fn, "tu-42");
    expect(out).toEqual({ continue: true, systemMessage: "PreToolUse:Bash:tu-42" });
  }, 15_000);
  it("exit 2 端到端：stderr → PreToolUse deny", async () => {
    const fn = compileCommandHook(nodeEntry("process.stderr.write('审计拦截');process.exit(2)"), CTX_PRE)!;
    expect(await invoke(fn)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "审计拦截",
      },
    });
  }, 15_000);
  it("exit 2 端到端：非 PreToolUse 事件 → decision block", async () => {
    const fn = compileCommandHook(nodeEntry("process.stderr.write('r');process.exit(2)"), CTX_STOP)!;
    expect(await invoke(fn)).toEqual({ decision: "block", reason: "r" });
  }, 15_000);
  it("其它非零 exit → {} 非阻断放行", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fn = compileCommandHook(nodeEntry("process.exit(3)"), CTX_PRE)!;
    expect(await invoke(fn)).toEqual({});
  }, 15_000);
  it("spawn 失败（可执行文件不存在）→ {} 非阻断 + console.error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fn = compileCommandHook(
      { type: "command", command: "definitely-not-a-real-exe-9f3", args: ["x"] },
      CTX_PRE,
    )!;
    expect(typeof fn).toBe("function");
    expect(await invoke(fn)).toEqual({});
    expect(err).toHaveBeenCalled();
  }, 15_000);
  it("spawn 同步抛（args 含空字节 → ERR_INVALID_ARG_VALUE）→ {} 非阻断 + console.error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fn = compileCommandHook(
      { type: "command", command: process.execPath, args: ["\u0000"] },
      CTX_PRE,
    )!;
    expect(await invoke(fn)).toEqual({});
    expect(err.mock.calls.map((c) => String(c[0])).join()).toContain("spawn 失败");
  }, 15_000);
  it("cwd 不存在（spawn 异步 error 臂）→ {} 非阻断 + console.error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fn = compileCommandHook(nodeEntry("0"), { event: "PreToolUse", cwd: "Z:/definitely-not-exist-dir-9f3" })!;
    expect(await invoke(fn)).toEqual({});
    expect(err.mock.calls.map((c) => String(c[0])).join()).toContain("启动失败");
  }, 15_000);
  it("shell 形式端到端：默认 shell 执行 echo（覆盖 shell spawn 臂）", async () => {
    // 缺省 shell：Windows=Git Bash/PowerShell，POSIX=$SHELL/sh——echo 两端语义一致
    const fn = compileCommandHook({ type: "command", command: "echo hello-shell-form" }, CTX_PRE)!;
    expect(await invoke(fn)).toEqual({}); // 纯文本 stdout → 无结构化输出
  }, 30_000);
  it("shell 形式 exit 2 → deny（shell 通道也能阻断）", async () => {
    const fn = compileCommandHook({ type: "command", command: "echo blocked-by-hook 1>&2; exit 2", shell: "bash" }, CTX_PRE, {
      platform: process.platform === "win32" ? "win32" : process.platform,
    });
    if (!fn) return; // 本机无 bash（编译期已 fail-visible 丢弃）：臂由 powershell 测试机覆盖
    const out = await invoke(fn);
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  }, 30_000);
  it("超时：杀子进程并 {} 放行（N4 不留孤儿）", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fn = compileCommandHook(nodeEntry("setTimeout(()=>{},30000)", { timeout: 0.4 }), CTX_PRE)!;
    const t0 = Date.now();
    expect(await invoke(fn)).toEqual({});
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(err.mock.calls.map((c) => String(c[0])).join()).toContain("超时");
  }, 15_000);
  it("signal 已 aborted：不 spawn 直接 {}", async () => {
    const fn = compileCommandHook(nodeEntry("console.log(1)"), CTX_PRE)!;
    const ac = new AbortController();
    ac.abort();
    expect(await fn(preInput, undefined, { signal: ac.signal })).toEqual({});
  });
  it("执行中 abort：杀子进程并 {}", async () => {
    const fn = compileCommandHook(nodeEntry("setTimeout(()=>{},30000)"), CTX_PRE)!;
    const ac = new AbortController();
    const p = fn(preInput, undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    expect(await p).toEqual({});
  }, 15_000);
  it("stdout 超上限截断不撑爆（>256KB 输出仍收敛为非 JSON → {}）", async () => {
    const fn = compileCommandHook(nodeEntry("console.log('x'.repeat(400000))"), CTX_PRE)!;
    expect(await invoke(fn)).toEqual({});
  }, 20_000);
  it("子进程提前退出：stdin EPIPE 不炸（close 收口）", async () => {
    const fn = compileCommandHook(nodeEntry("process.exit(0)"), CTX_PRE)!;
    // 立即退出 + 大 stdin 载荷 → 写入吃 EPIPE 的概率臂；结果仍按 exit 0 收敛
    const big = { ...preInput, pad: "y".repeat(64 * 1024) } as unknown as HookInput;
    expect(await fn(big, undefined, { signal: new AbortController().signal })).toEqual({});
  }, 15_000);
  it("cwd 注入：hook 子进程工作目录 = ctx.cwd", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cmdhook-"));
    try {
      const fn = compileCommandHook(
        nodeEntry("console.log(JSON.stringify({systemMessage:process.cwd().replace(/\\\\/g,'/')}))"),
        { event: "PreToolUse", cwd: dir },
      )!;
      const out = (await invoke(fn)) as { systemMessage?: string };
      expect(out.systemMessage?.toLowerCase()).toContain(dir.replace(/\\/g, "/").split("/").pop()!.toLowerCase());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

// ---- 防御臂：describeErr 的 `?? e` 右臂（非 Error 异常）----
// 真实 spawn 只抛 Error 实例，右臂无法经公共面构造——用 doMock 的独立模块
// 实例注入「抛字符串的 spawn」。放文件末尾 + resetModules 隔离，静态顶层
// import 的真模块实例不受影响（其它用例照常跑真子进程）。
describe("commandHooks — 非 Error 异常防御臂", () => {
  it("spawn 同步抛字符串 → 原文进 console.error（describeErr ?? e 右臂）", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await (importOriginal() as Promise<typeof import("node:child_process")>);
      return {
        ...actual,
        spawn: () => {
          // eslint-disable-next-line no-throw-literal -- 刻意构造非 Error 异常钉防御臂
          throw "plain-string-failure";
        },
      };
    });
    const mod = await import("./commandHooks");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fn = mod.compileCommandHook(
      { type: "command", command: process.execPath, args: ["-e", "0"] },
      CTX_PRE,
    )!;
    expect(typeof fn).toBe("function");
    expect(await fn(preInput, undefined, { signal: new AbortController().signal })).toEqual({});
    expect(err.mock.calls.map((c) => String(c[0])).join()).toContain("plain-string-failure");
    vi.doUnmock("node:child_process");
    vi.resetModules();
    err.mockRestore();
  });
});
