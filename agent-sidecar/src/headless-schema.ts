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

// send.images 的一条：内嵌 base64 与引擎本地路径**互斥**（二选一；规则与理由见
// engine/types.ts 的 WireImageAttachment，读取与守卫见 engine/imageAttachments.ts）。
//   · 内嵌形态：data + mediaType 都必填——**不放松既有必填**（放松会让已写好的
//     调用方开始依赖新默认值，那是静默的行为变更）。
//   · 路径形态：只传 path（`{path: "…"}`，绕开 /invoke 的 1MB body 上限）；
//     mediaType 由引擎按魔数嗅探后自己填。
// 失败仍是 issue（path + code，N5 不回显值）：互斥违规 path=path、缺媒体类型
// path=mediaType，操作者据此判断触发的是哪条规则。
const imageAttachment = z
  .looseObject({
    data: z.string().min(1).optional(),
    mediaType: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const inline = v.data !== undefined;
    const byPath = v.path !== undefined;
    if (inline === byPath) {
      // 皆无 / 皆有：两种形态都不可判（前者缺字节来源，后者意图冲突）
      ctx.addIssue({ code: "custom", path: ["path"] });
      return;
    }
    if (inline && v.mediaType === undefined) {
      ctx.addIssue({ code: "custom", path: ["mediaType"] });
    }
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

// ---- 11 个可 invoke 命令。唯一真相就是下面这个 invokeBodySchema 判别联合
//      （headless-server.ts 的独立清单已删——两份白名单必然漂移） ----

const btwAskCommand = z.looseObject({
  cmd: z.literal("btw_ask"),
  session_id: sid,
  question: z.string().min(1),
  // 跨问历史封顶 20 条（前端截断后的数组；这里的上限是边界防御，与前端一致）。
  history: z
    .array(z.looseObject({ question: z.string(), response: z.string() }))
    .max(20)
    .optional(),
});

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
  automation: automationPayload.optional(),
  resume_session_id: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  mcp_headers: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  auto_title: z.boolean().optional(),
  thinking_enabled: z.boolean().optional(),
  // 输出样式名（内置四款 + "default"）。只在新建会话（建 query）时落地。
  output_style: z.string().optional(),
  trusted: z.boolean().optional(),
  codegraph_enabled: z.boolean().optional(),
  permission_policy: permissionPolicySnapshot.optional(),
});

const updatePermissionPolicyCommand = z.looseObject({
  cmd: z.literal("update_permission_policy"),
  session_id: sid,
  policy: permissionPolicySnapshot,
});

// ---- permission_response：标签联合（官方推荐）与扁平形态（兼容）**二选一** ----
//
// ⚠️ zod 机械约束（4.4.3 实测）：判别键 cmd 的取值必须全局唯一，同一个
// "permission_response" 字面量**不能有两个成员**——成员包成 z.union 也不行
// （判别表要求成员自带 propValues，$ZodUnion 没有 → 抛 "Invalid discriminated
// union option"，且该异常**穿透 safeParse** 而不是变成 issue）。故本命令在 union
// 里只占**一个**成员，形态互斥由 .superRefine 兜底：
//   · 恰好一个在场：response（标签形态）或 approved（扁平形态）
//   · 标签形态不得夹带扁平字段（混用 = 意图不可判）
// 失败仍是 issue（path + code，N5 不回显值）：互斥违规 path=response，混用
// path=approved——操作者据此判断触发的是哪条规则。变体语义见 engine/types.ts
// 的 PermissionResponseWire 与 engine/permissionResponse.ts 头注（能力一一对应）。
const permissionResponseWire = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("approve"),
    nextMode: z.string().optional(),
    sessionRules: z.array(permissionRuleDraft).optional(),
  }),
  // answers 必填：SDK 要求把作答重塑进 updatedInput，无作答的"放行问答"没有意义
  z.looseObject({ kind: z.literal("answer"), answers: z.record(z.string(), z.string()) }),
  z.looseObject({ kind: z.literal("deny"), message: z.string().optional() }),
  z.looseObject({ kind: z.literal("unanswered"), reason: z.string().optional() }),
]);

const permissionResponseCommand = z
  .looseObject({
    cmd: z.literal("permission_response"),
    session_id: sid,
    id: z.string().min(1),
    // 标签形态（网关用；见上）
    response: permissionResponseWire.optional(),
    // ---- 扁平形态（桌面 Rust / 远程 / ohos 恒走这条；网关不要用） ----
    // approved 在扁平形态下必填的严格性**不靠 .optional() 放松**，而由下面
    // superRefine 的「恰好一个在场」规则恢复：两形态皆无 = 400。
    approved: z.boolean().optional(),
    answers: z.record(z.string(), z.string()).optional(),
    nextMode: z.string().optional(),
    message: z.string().optional(),
    sessionRules: z.array(permissionRuleDraft).optional(),
  })
  .superRefine((v, ctx) => {
    const tagged = v.response !== undefined;
    const flat = v.approved !== undefined;
    if (tagged === flat) {
      // 皆无 / 皆有：两种形态都不可判（前者缺 approved，后者意图冲突）
      ctx.addIssue({ code: "custom", path: ["response"] });
      return;
    }
    if (
      tagged &&
      (v.answers !== undefined ||
        v.nextMode !== undefined ||
        v.message !== undefined ||
        v.sessionRules !== undefined)
    ) {
      ctx.addIssue({ code: "custom", path: ["approved"] });
    }
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
 * invoke body 判别联合。刻意**不含**两个 Rust 回包命令：
 *
 * - `codegraph_result`（永关）：桌面 Rust 的 codegraph 查询回包通道——headless 宿主没有 Rust
 *   回包方，且 codegraph MCP 仅在 send.codegraph_enabled === true 时注册（headless 客户端缺省
 *   不注册），命令开了也无消费方。
 * - `browser_result`（同理，2026-09-16 加）：内嵌浏览器只在**桌面**存在，headless 无 Rust 回包方；
 *   `browser_query` 在 headless 下被工具层提前短路（返回「本环境没有内嵌浏览器」），根本不发。
 *
 * 桌面扩展通道其余命令已按需收编（update_permission_policy / stop_bg_task /
 * model_switch_confirm_decision）。
 */
export const invokeBodySchema = z.discriminatedUnion("cmd", [
  sendCommand,
  btwAskCommand,
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
