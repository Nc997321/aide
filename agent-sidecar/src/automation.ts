/** 自动化运行（无人值守 headless 会话）的配置与纯函数判定。
 *
 *  与 btw 支线的关键区别：
 *  - 转录要落盘（persistSession 不动，默认 true）——运行历史复用会话查看器；
 *  - 跑完自毁（与 btw 同款 selfTeardown，防幽灵 worker/进程残留）；
 *  - 权限模型（2026-08-22 定案，替代三档白名单）：
 *    · auto（默认）——内建工具全量可见，CLI auto 模式裁决（安全操作自动放行、
 *      高危操作经 canUseTool 兜底 deny）；连接器始终显式预授权。
 *    · full——内建工具 policy hook 全 allow + bypassPermissions。
 *    连接器（MCP）与预设无关：mcpServers 按白名单过滤挂载（未授权的工具不存在），
 *    policy hook 对 MCP 工具按 server key 裁决。
 *
 *  分层职责：Rust 调度器把预设与连接器映射进 send 命令；sidecar 不解释预设，
 *  只做裁决与 options 透传。 */
export interface AutomationConfig {
  taskId: string;
  runId: string;
  preset: "auto" | "full";
  /** 内建工具可见性白名单；两档预设都是 ["*"]（全量可见）——收口在行为层。 */
  tools: string[];
  /** 预授权 MCP server key（连接器），如 "aide-codegraph"。 */
  mcpAllowlist: string[];
  /** 任务目录（~/.aide/automations/<id>/）的绝对路径：写工具落进此目录即放行
   *  （playbook.md / scripts/ 的蒸馏写入与运行中的手册自愈合写回都在 cwd 之外，
   *  auto 模式写目录外会被兜底 deny，必须有这个例外）。 */
  taskDir: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

/** "mcp__<server>__<tool>" → server key；非 MCP 工具名返回 null。
 *  server key 本身可能含单下划线，分隔符是双下划线——按第一个 "__" 切。 */
export function parseMcpServerKey(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const idx = rest.indexOf("__");
  return idx === -1 ? rest : rest.slice(0, idx);
}

export type AutomationVerdict = "allow" | "deny" | "defer";

/** 文件写入工具（任务目录写例外的作用对象）。 */
const FILE_WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];

/** 路径归一化：统一分隔符为 /；Windows 大小写不敏感再转小写。 */
function normalizePath(p: string): string {
  const unified = p.replace(/\\/g, "/");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/** file_path 是否落在任务目录内（含边界）。 */
export function isUnderTaskDir(filePath: unknown, taskDir: string): boolean {
  if (typeof filePath !== "string" || !filePath || !taskDir) return false;
  const dir = normalizePath(taskDir).replace(/\/+$/, "") + "/";
  return normalizePath(filePath).startsWith(dir);
}

/** policy hook 自动化分支的三值裁决（按序）：
 *  1. MCP 工具：连接器白名单内 allow、其余 deny（与预设无关——连接器永远显式）；
 *  2. 写工具落进任务目录 → allow（蒸馏写 playbook/scripts、运行中手册自愈合写回）；
 *  3. 其余内建工具：full 预设 allow；auto 预设 defer（hook 返回 {} 不表态），交还
 *    CLI auto 模式裁决——安全操作自动放行，高危操作 CLI 询问 → canUseTool 的
 *    自动化分支兜底 deny（无人值守，没人能应答弹窗）。 */
export function automationHookVerdict(
  toolName: string,
  toolInput: unknown,
  cfg: AutomationConfig,
): AutomationVerdict {
  const server = parseMcpServerKey(toolName);
  if (server !== null) return cfg.mcpAllowlist.includes(server) ? "allow" : "deny";
  if (
    FILE_WRITE_TOOLS.includes(toolName) &&
    isUnderTaskDir((toolInput as { file_path?: unknown } | undefined)?.file_path, cfg.taskDir)
  ) {
    return "allow";
  }
  return cfg.preset === "full" ? "allow" : "defer";
}

/** query() options 增量（铺在最后，覆盖统一直觉值）：
 *  - tools 收成白名单 = 内建工具可见性收口；"*" 不动 tools 选项 = 全量可见
 *    （当前两档预设都是 "*"——可见性不收口，行为层收口）；
 *  - maxTurns/maxBudgetUsd 无人值守护栏透传（SDK 原生选项，触顶 result 带
 *    error_max_turns/error_max_budget_usd → mapper 走 error 事件通道）。 */
export function automationQueryOverrides(cfg?: AutomationConfig | null): {
  tools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
} {
  if (!cfg) return {};
  const out: { tools?: string[]; maxTurns?: number; maxBudgetUsd?: number } = {};
  if (!cfg.tools.includes("*")) out.tools = cfg.tools;
  if (cfg.maxTurns && cfg.maxTurns > 0) out.maxTurns = cfg.maxTurns;
  if (cfg.maxBudgetUsd && cfg.maxBudgetUsd > 0) out.maxBudgetUsd = cfg.maxBudgetUsd;
  return out;
}

/** 按连接器白名单过滤组装好的 mcpServers——未预授权的 server 不挂载，
 *  其工具对模型根本不存在（第一层）；policy hook 裁决是第二层。 */
export function filterMcpServers<T>(
  servers: Record<string, T>,
  allowlist: readonly string[],
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(servers)) {
    if (allowlist.includes(key)) out[key] = servers[key];
  }
  return out;
}
