// 会话级元数据与 MCP 头注入 —— 引擎机制①（headless 宿主/网关对接用）。
//
// 机制/策略定界（CLAUDE.md sidecar 边界章节第 4 条）：引擎提供机制、不认识"租户"。
//   - metadata：不透明键值（网关塞租户上下文），进程内 hooks 经
//     HookBuildContext.session.metadata() 读取；**绝不注入 cliEnv**——子进程 env
//     会被 Bash 工具继承，模型跑 `env` 即可外带凭据（安全红线）。
//   - mcp_headers：会话级请求头注入（如租户 token），query() 组装 mcpServers 时
//     合并进 http/sse 型 server 配置。SDK 已实锤透传（probe-sdk-mcp-headers.ts，
//     McpHttpServerConfig/McpSSEServerConfig 均带 headers?: Record<string,string>）。
//
// ⚠️ N5：mcp_headers 的值是凭据——任何日志/错误消息不得输出其值，只报形状/字段名。
// ⚠️ 生效时机：mcpServers 随 query() spawn 固化，send 刷新的新头在**下一次** query()
//    重连才生效（当前存活 query 仍用旧头）。token 轮换场景可接受（网关 token 通常
//    会话期内有效）。

/** 会话元数据：引擎不解释内容，只存储与暴露（hooks 读取口）。 */
export type SessionMetadata = Record<string, unknown>;

/** MCP 头注入表：serverName → headers；"*" = 所有 http/sse 型 server（精确名优先）。 */
export type McpHeaderMap = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** 边界守卫：纯对象（非数组、非 null）。metadata/mcp_headers/header 值层共用。 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 边界收窄（N1/M3）：unknown → McpHeaderMap。返回 undefined = 缺席或形状非法
 * （调用方按「在场但 parse 失败」区分报错，见 headless validateInvokeBody）。
 *
 * 校验重建而非透传：逐层核结构（对象 → 对象 → string 值），拷贝成新对象。
 * 一条非法 = 整体拒绝（fail-closed）：注入表直达网络请求配置，半对半错的表
 * 比没有更糟（部分 server 拿到非法头，故障面不可预测）。
 */
export function parseMcpHeaders(raw: unknown): McpHeaderMap | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const [server, hdrs] of Object.entries(raw)) {
    if (!isPlainObject(hdrs)) return undefined;
    const entry: Record<string, string> = {};
    for (const [k, v] of Object.entries(hdrs)) {
      if (typeof v !== "string") return undefined;
      entry[k] = v;
    }
    out[server] = entry;
  }
  return out;
}

/**
 * 把会话级 headers 合并进已组装的 mcpServers（query() options 前的最后一步）。
 *
 * 规矩：
 * - 只注入 `type === "http" | "sse"` 的 server——stdio 无请求头概念；sdk 型
 *   （codegraph/docs 内建进程内 server）不出网络，注入无意义。type 缺失的
 *   条目跳过（fail-closed：不向未知类型注入）。
 * - "*" 通配打底、精确 server 名覆盖（同键精确名优先）。
 * - 注入头覆盖 server 配置自带的同名头（会话级授权身份优先于静态配置）。
 * - headers 表里点名但 servers 里不存在的 server：忽略（无处可注）。
 * - 返回新对象，不改原配置；无注入可言时原引用返回（零拷贝，桌面恒路径）。
 */
export function applyMcpHeaders<T>(
  servers: Record<string, T>,
  headers: McpHeaderMap | undefined,
): Record<string, T> {
  if (headers === undefined || Object.keys(headers).length === 0) return servers;
  const wildcard = headers["*"];
  const out: Record<string, T> = { ...servers };
  for (const [name, cfg] of Object.entries(servers)) {
    if (!isPlainObject(cfg)) continue; // 非法条目原样透传（组装层的既有信任面，不在此拦截）
    if (cfg.type !== "http" && cfg.type !== "sse") continue;
    const injected: Readonly<Record<string, string>> = { ...(wildcard ?? {}), ...(headers[name] ?? {}) };
    if (Object.keys(injected).length === 0) continue;
    // 配置自带头（settings.json 透传，未校验形状）只在是纯对象时参与合并，否则视为无。
    const own = isPlainObject(cfg.headers) ? cfg.headers : {};
    // 断言可辩护（X2）：仅对 type http/sse 条目操作，headers 是两种 SDK 配置
    // （McpHttpServerConfig/McpSSEServerConfig）各自的可选属性，覆盖它不破坏 T
    // 的契约；泛型 T 无约束，编译器无法证明展开重建后仍是 T。
    out[name] = { ...(cfg as Record<string, unknown>), headers: { ...own, ...injected } } as T;
  }
  return out;
}
