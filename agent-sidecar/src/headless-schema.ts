// headless invoke 协议 schema（核心纯层，正式版）：zod 逐命令收窄重建
// SidecarCommand——HTTP 边界类型保护失效（M3），safeParse 重建后才交命令层。
// 骨架期手写轻校验（见 git 历史 validateInvokeBody）在此收口为字段级完整 schema。
//
// 形状纪律：
// - looseObject（未知字段**保留**不剥）：前向兼容——网关先于 sidecar 升级时新字段
//   照常透传到命令层，不静默丢字段（对账规则）；已知字段逐个类型化。
// - 错误消息只含 path + issue code，绝不回显收到的值（mcp_headers/env 值是
//   凭据，N5）。
// - session_id 恒必填（headless 客户端生成并持有，发送与事件订阅同一把钥匙）。
// - display 渲染描述块**不深校验**（只认「对象数组、type 是字符串」）：引擎不
//   解释内容、原样随 user_message 回灌，未知形态由各端自行降级（types.ts 契约）。
//
// 白名单外命令（如 codegraph_result）不在 union 里 = schema 层天然拒绝。
import { z } from "zod";
import type { SidecarCommand } from "./engine/types.js";

const sid = z.string().min(1);

const imageAttachment = z.looseObject({
  data: z.string(),
  mediaType: z.string(),
});

/** display 块：不透明透传面（见文件头），只校验「对象 + type 字符串」。 */
const displayBlock = z.looseObject({ type: z.string() });

const automationPayload = z.looseObject({
  task_id: z.string().min(1),
  run_id: z.string().min(1),
  preset: z.string().optional(),
  tools: z.array(z.string()),
  mcp_allowlist: z.array(z.string()),
  task_dir: z.string().optional(),
  session_dir: z.string().optional(),
  max_turns: z.number().optional(),
  max_budget_usd: z.number().optional(),
  fork: z.boolean().optional(),
});

// ---- 权限策略（镜像 engine/policy/types.ts，与 Rust policy/model.rs 同形） ----

const permissionMatcher = z.union([
  z.looseObject({ kind: z.literal("tool") }),
  z.looseObject({
    kind: z.literal("bash"),
    mode: z.enum(["all", "prefix", "contains"]),
    value: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal("path"),
    field: z.enum(["file_path", "path", "notebook_path"]),
    folder: z.string().optional(),
    file: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal("field"),
    field: z.enum(["url", "query", "command"]),
    equals: z.string(),
  }),
]);

const permissionRule = z.looseObject({
  id: z.string(),
  scope: z.enum(["managed", "user", "project", "local", "session"]),
  order: z.number(),
  effect: z.enum(["allow", "ask", "deny"]),
  tool: z.string(),
  matcher: permissionMatcher,
  source: z
    .looseObject({ label: z.string(), path: z.string().optional(), readOnly: z.boolean() })
    .optional(),
});

const permissionPolicySnapshot = z.looseObject({
  revision: z.number(),
  rules: z.array(permissionRule),
});

const permissionRuleDraft = z.looseObject({
  effect: z.enum(["allow", "deny", "ask"]),
  tool: z.string(),
  matcher: permissionMatcher,
});

// ---- 10 个可 invoke 命令（与 headless-server.ts 的 INVOKABLE_COMMANDS 一一对应，
//      一致性由 headless-server.test.ts 的对账用例钉住） ----

const sendCommand = z.looseObject({
  cmd: z.literal("send"),
  session_id: sid,
  prompt: z.string().min(1),
  images: z.array(imageAttachment).optional(),
  display: z.array(displayBlock).optional(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  provider_switched: z.boolean().optional(),
  jump_queue: z.boolean().optional(),
  btw: z.boolean().optional(),
  lightweight: z.boolean().optional(),
  fork_from: z.string().optional(),
  tools: z.array(z.string()).optional(),
  automation: automationPayload.optional(),
  resume_session_id: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  mcp_headers: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  auto_title: z.boolean().optional(),
  thinking_enabled: z.boolean().optional(),
  trusted: z.boolean().optional(),
  codegraph_enabled: z.boolean().optional(),
  permission_policy: permissionPolicySnapshot.optional(),
});

const updatePermissionPolicyCommand = z.looseObject({
  cmd: z.literal("update_permission_policy"),
  session_id: sid,
  policy: permissionPolicySnapshot,
});

const permissionResponseCommand = z.looseObject({
  cmd: z.literal("permission_response"),
  session_id: sid,
  id: z.string().min(1),
  approved: z.boolean(),
  answers: z.record(z.string(), z.string()).optional(),
  nextMode: z.string().optional(),
  message: z.string().optional(),
  sessionRules: z.array(permissionRuleDraft).optional(),
});

const interruptCommand = z.looseObject({ cmd: z.literal("interrupt"), session_id: sid });

const stopBgTaskCommand = z.looseObject({
  cmd: z.literal("stop_bg_task"),
  session_id: sid,
  task_id: z.string().min(1),
});

const setModelCommand = z.looseObject({
  cmd: z.literal("set_model"),
  session_id: sid,
  model: z.string().min(1),
});

const modelSwitchConfirmDecisionCommand = z.looseObject({
  cmd: z.literal("model_switch_confirm_decision"),
  session_id: sid,
  confirm_id: z.string().min(1),
  approve: z.boolean(),
});

const setEffortCommand = z.looseObject({
  cmd: z.literal("set_effort"),
  session_id: sid,
  effort: z.string().min(1),
});

const setPermissionModeCommand = z.looseObject({
  cmd: z.literal("set_permission_mode"),
  session_id: sid,
  mode: z.string().min(1),
});

const sessionStopCommand = z.looseObject({ cmd: z.literal("session_stop"), session_id: sid });

/**
 * invoke body 判别联合。刻意**不含** codegraph_result（永关）：它是桌面 Rust 的
 * codegraph 查询回包通道——headless 宿主没有 Rust 回包方，且 codegraph MCP 仅在
 * send.codegraph_enabled === true 时注册（headless 客户端缺省不注册），命令开了
 * 也无消费方。桌面扩展通道其余命令已按需收编（update_permission_policy /
 * stop_bg_task / model_switch_confirm_decision）。
 */
export const invokeBodySchema = z.discriminatedUnion("cmd", [
  sendCommand,
  updatePermissionPolicyCommand,
  permissionResponseCommand,
  interruptCommand,
  stopBgTaskCommand,
  setModelCommand,
  modelSwitchConfirmDecisionCommand,
  setEffortCommand,
  setPermissionModeCommand,
  sessionStopCommand,
]);

/** 非对象 body 的直接判词（不进 zod——union 对非对象的报错噪声大）。 */
function nonObjectVerdict(body: unknown): string {
  return `body must be a JSON object (got ${body === null ? "null" : Array.isArray(body) ? "array" : typeof body})`;
}

/**
 * 校验 invoke body → SidecarCommand（重建）。错误消息只含 path + issue code
 * （N5：不回显值——mcp_headers/env 的值是凭据）。
 *
 * 断言可辩护（X2）：zod 已逐字段收窄已知键；loose 面只承载**未知**扩展字段
 * （类型上 unknown 索引签名），与 SidecarCommand 的已知字段形状不冲突——编译器
 * 无法证明索引签名与具体联合的交叠，故此处整体断言。
 */
export function parseInvokeBody(
  body: unknown,
): { ok: true; command: SidecarCommand } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: nonObjectVerdict(body) };
  }
  const result = invokeBodySchema.safeParse(body);
  if (result.success) {
    return { ok: true, command: result.data as SidecarCommand };
  }
  const detail = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.code}`)
    .join("; ");
  return { ok: false, error: `invalid invoke body — ${detail}` };
}
