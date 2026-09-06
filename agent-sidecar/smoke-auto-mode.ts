// 探针：确认本地 vendored runtime 能否真的跑 auto 权限模式（含分类器）。
//
// 【已静态确认的部分，本探针只验证运行时行为】
//  1. claude.exe --permission-mode 的 choices 含 "auto"（实测 --help 输出）
//     → 启动期传 permissionMode:'auto' 不会被拒，改默认值不会让会话起不来。
//  2. 分类器实现在 claude.exe 二进制里，不在 agent-sidecar/dist/runtime.js：
//     claude.exe 内 "cannot determine the safety" ×2、"classifier" ×614、
//     "AUTO_MODE" ×45、autoModeConfigSchema。
//     → runtime.js 里的 Dy.autoMode.buildGate:()=>false 是 node 侧「实验特性
//       设置面」门控（贡献 settings shape），与权限模式能否使用无关。别再拿它当证据。
//
// 【本探针要回答的唯一问题】分类器在你当前 provider 配置下能否成功判定。
//  分类器走 haiku 槽（aide 注入 ANTHROPIC_DEFAULT_HAIKU_MODEL）。
//  deepseek 预置 haiku = deepseek-v4-flash，能否承担分类任务只能实测。
//
// 判定逻辑：allowedTools 设为空，权限完全交给 permissionMode 决定。
//  - auto 生效   → 分类器静默放行 → canUseTool 不被调用 → probe-out.txt 被创建
//  - 退化 default → Write/Bash 来询问 → canUseTool 被调用
//  - 分类器挂了  → 工具被拦，报 "cannot determine the safety of X"（比 default 更糟）
//
// 用法（agent-sidecar 目录）：
//   凭证不在 settings.json（在 keyring，读不到），需外部注入：
//     AIDE_PROBE_TOKEN=<deepseek auth token> npx tsx smoke-auto-mode.ts
//   对照跑默认模式：
//     SMOKE_MODE=default AIDE_PROBE_TOKEN=... npx tsx smoke-auto-mode.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, readFile as _rf } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.USERPROFILE || process.env.HOME || "";

const DEFAULT_CLAUDE_EXE = join(
  __dirname,
  "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
);
const claudeExe =
  process.env.AIDE_CLAUDE_EXE ??
  (existsSync(DEFAULT_CLAUDE_EXE) ? DEFAULT_CLAUDE_EXE : undefined);

process.env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".aide/claude");

const MODE = (process.env.SMOKE_MODE ?? "auto") as "auto" | "default";

// ── 复现 aide 的 provider env 注入（关键：haiku 槽，分类器走它）──
const settingsPath = join(HOME, ".aide", "settings.json");
const settings = JSON.parse(await readFile(settingsPath, "utf8"));
const activeId = settings.values.activeProvider as string;
const provider = (settings.values.providers as any[]).find((p) => p.id === activeId);
if (!provider) throw new Error(`activeProvider ${activeId} 未找到`);

const catalogPath = join(__dirname, "..", "src-tauri", "resources", "provider-catalog.json");
const catalogRaw = JSON.parse(await readFile(catalogPath, "utf8"));
const catalogList: any[] = Array.isArray(catalogRaw) ? catalogRaw : (catalogRaw.providers ?? []);
const preset = catalogList.find((c) => c.kind === provider.kind);

const m = provider.modelMappings ?? {};
const merged: Record<string, string> = { ...(preset?.defaults ?? {}), ...m };
const baseUrl = provider.baseUrl || preset?.base_url || "";

// auth_mode：deepseek 用 auth_token，anthropic 官方用 api_key
const cred =
  process.env.AIDE_PROBE_TOKEN ??
  process.env.AIDE_PROBE_API_KEY ??
  process.env.ANTHROPIC_AUTH_TOKEN ??
  process.env.ANTHROPIC_API_KEY ??
  "";

// 复刻 runtime/provider/mod.rs: mappings_to_env + provider_to_env_vars
const env: Record<string, string | undefined> = {
  ...process.env,
  ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
  ANTHROPIC_AUTH_TOKEN: cred,
  ANTHROPIC_API_KEY: cred,
  ANTHROPIC_MODEL: merged.anthropicModel || merged.anthropic_model || "",
  ANTHROPIC_DEFAULT_OPUS_MODEL: merged.defaultOpusModel || merged.default_opus_model || "",
  ANTHROPIC_DEFAULT_SONNET_MODEL: merged.defaultSonnetModel || merged.default_sonnet_model || "",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: merged.defaultHaikuModel || merged.default_haiku_model || "",
  CLAUDE_CODE_SUBAGENT_MODEL: merged.subagent || "",
  CLAUDE_CODE_EFFORT_LEVEL: provider.effortLevel || "",
};
for (const k of Object.keys(env)) if (!env[k]) delete env[k];

const cwd = mkdtempSync(join(tmpdir(), "aide-auto-probe-"));
writeFileSync(join(cwd, "seed.txt"), "SEED_CONTENT_OK\n");

console.log("=== 探针配置 ===");
console.log("permissionMode    :", MODE);
console.log("activeProvider    :", provider.kind, `(${activeId})`);
console.log("base_url          :", baseUrl);
console.log("haiku 槽(分类器)  :", env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "(未注入)");
console.log("sonnet 槽(主模型) :", env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "(未注入)");
console.log("凭证              :", cred ? `已注入(len ${cred.length})` : "*** 缺失 ***");
console.log("claudeExe         :", claudeExe ?? "(SDK 内置)");
console.log("cwd               :", cwd);
console.log("allowedTools      : [] （不预授权，权限完全由模式决定）");

if (!cred) {
  console.log(
    "\n缺少凭证：aide 把它存在 keyring（io.aide.desktop / provider/<ref>/apiKey），" +
      "独立 node 进程读不到。请从 aide 设置里复制后注入：\n" +
      "  AIDE_PROBE_TOKEN=<token> npx tsx smoke-auto-mode.ts\n" +
      "或者更简单：直接在 aide UI 里把权限模式切到「自动模式」，让它跑一条 Bash，" +
      "看是否静默执行 —— 那条路径走的是完整 env 注入，比本脚本更真实。",
  );
  process.exit(2);
}

const canUseToolCalls: string[] = [];
const toolUses: string[] = [];
const autoMentions: string[] = [];

const q = query({
  prompt:
    "Do these two things without asking me any questions: " +
    "(1) use the Write tool to create a file named probe-out.txt containing exactly AUTO_PROBE_OK; " +
    "(2) use the Bash tool to run `cat seed.txt`. Then reply with one line stating what the file contained.",
  options: {
    cwd,
    env,
    settingSources: [],
    permissionMode: MODE,
    // 关键：空数组。任何预授权都会绕过 auto 分类器，污染判定。
    allowedTools: [],
    maxTurns: 4,
    canUseTool: async (name: string, input: unknown) => {
      canUseToolCalls.push(name);
      console.log(`[canUseTool] ${name} ${JSON.stringify(input).slice(0, 160)}`);
      return { behavior: "allow" as const, updatedInput: input as Record<string, unknown> };
    },
    ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
  },
});

let initSeen = false;

try {
  for await (const msg of q as any) {
    if (msg.type === "system" && msg.subtype === "init" && !initSeen) {
      initSeen = true;
      console.log("=== INIT ===");
      console.log("permissionMode:", msg.permissionMode ?? "(字段缺失)");
      try {
        await (q as any).setPermissionMode("auto");
        console.log("[setPermissionMode(auto)] OK");
      } catch (e) {
        console.log("[setPermissionMode(auto)] FAILED:", String((e as Error)?.message ?? e));
      }
    }
    if (msg.type === "assistant") {
      const blocks = msg.message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) if (b.type === "tool_use") toolUses.push(b.name);
      }
    }
    if (msg.type === "result") {
      console.log("=== RESULT ===", msg.subtype, "is_error=", msg.is_error);
      if (msg.result) console.log("result:", String(msg.result).slice(0, 400));
    }
    const raw = JSON.stringify(msg);
    if (/auto\s*mode|cannot determine the safety/i.test(raw)) autoMentions.push(raw.slice(0, 300));
  }
} catch (e) {
  console.log("=== QUERY THREW ===");
  console.log(String((e as Error)?.stack ?? e).slice(0, 1200));
}

const outPath = join(cwd, "probe-out.txt");
const written = existsSync(outPath);
const content = written ? readFileSync(outPath, "utf8").trim() : "(未创建)";

console.log("\n=== 结论 ===");
console.log("query 起来        :", initSeen ? "是" : "否");
console.log("模型发起的工具    :", toolUses.length ? toolUses.join(", ") : "(无)");
console.log(
  "canUseTool 被调用 :",
  canUseToolCalls.length,
  canUseToolCalls.length ? `→ ${canUseToolCalls.join(", ")}` : "→ 分类器静默放行，未询问",
);
console.log("probe-out.txt     :", written ? `已创建，内容=${content}` : "未创建");
console.log("auto 相关文案     :", autoMentions.length ? autoMentions.join("\n") : "(无)");
console.log("\n判定：");
if (!initSeen) console.log("  query 未起来 —— permissionMode:'auto' 启动期被拒，改默认会让会话起不来。");
else if (MODE === "auto" && canUseToolCalls.length === 0 && written)
  console.log("  ✅ auto 生效 —— 分类器放行，未触发任何询问。可以放心改默认。");
else if (MODE === "auto" && autoMentions.length)
  console.log("  ⚠️ auto 被接受但分类器报错 —— 命令会被拦截，比 default 更糟。先修 haiku 槽。");
else if (MODE === "auto" && canUseToolCalls.length > 0)
  console.log("  ⚠️ auto 未生效，退化成询问行为（等价 default）。");
else if (MODE === "auto" && !written)
  console.log("  ⚠️ auto 被接受但工具未执行。");
else console.log("  对照组（default）跑完，用于对比 canUseTool 调用次数。");
