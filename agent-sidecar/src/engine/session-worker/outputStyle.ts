// 会话输出样式落地。值由 Rust 从设置读出、随每条 send 下发（engine/types.ts 的
// output_style），worker 在 handleSend 归一到本地，建 query 后应用一次。
//
// ⚠️ 必须走 applyFlagSettings，**不能**改写成 spawn options.outputStyle：
// 2026-09-13 三臂实测——spawn 通道被 CLI 静默丢弃（内置 Learning 与插件样式都不
// 生效，init 回报恒为 "default" 且 stderr 无任何抱怨），只有 flag-settings 层生效。
// 会话中切换同样有效，但本模块刻意不做热切：样式是系统提示的一部分，中途换会破
// 当轮 prompt cache，且要引入回滚/回声/广播一整套语义。
//
// 时序：必须在首轮 prompt 被 CLI 取走之前应用（startLoop 里 query() 返回后立刻调。
// 这一行是启动路径上的同步点：CLI 若活着但不回控制响应，startLoop 会停在这里，故
// 应用失败必须吞成告警而非抛出）。晚于首轮 = 第一条消息吃不到样式。
//
// 已知不继承的两条支线（刻意，与 thinking_enabled 现状一致）：btw 支线
// （src-tauri/src/commands/chat.rs 的 start_btw_session 自建 send JSON，不下发本
// 字段）与 automation 运行（src-tauri/src/automation/scheduler.rs 自建）。代价一条：
// 这两条与主会话的 prompt cache 前缀不再逐字节一致。要让 btw 跟随，需在 chat.rs
// 的 btw 分支补一行 attach。
import type { Settings } from "@anthropic-ai/claude-agent-sdk";

/** 值域唯一真相源：类型由元组派生、运行时判定由同一元组构造，两者不可能漂移。
 *  ⚠️ 与 packages/aide-sdk 的 OutputStyle（那里多一个 "default"）同形，改动要
 *  一起改——漂移会让样式静默失效，同 UserMessageBlock 先例。 */
const OUTPUT_STYLES = ["Proactive", "Concise", "Explanatory", "Learning"] as const;

/** 可下发的输出样式。不含 "default"——它与「不下发」等价，见 normalizeOutputStyle。 */
export type OutputStyle = (typeof OUTPUT_STYLES)[number];

const OUTPUT_STYLE_SET: ReadonlySet<string> = new Set<string>(OUTPUT_STYLES);

/** 输出样式的最小能力面——query 对象只需要这一个方法，测试可用替身。
 *
 *  参数用 `Pick<Settings, "outputStyle">` 而不是手写的 `{ outputStyle?: ... }`：
 *  SDK 的 applyFlagSettings 形参是全可选映射类型，手写接口对键名拼错完全无感
 *  （结构赋值不校验键名、也不触发多余属性检查）。
 *
 *  ⚠️ 边界要说清——Pick 守的是**本地**键名与调用点字面量的一致性（拼错立报
 *  TS2561），属性类型跟随 SDK 声明。**SDK 改名/删键守不住**：`Settings` 带顶层
 *  索引签名 `[k: string]: unknown`（sdk.d.ts），`Pick` 会退化成
 *  `{ outputStyle?: unknown }`，调用点照旧编得过、运行时静默失效。
 *  该值域的真伪由 2026-09-13 三臂实测兜底（见文件头注），不靠类型系统。 */
export interface OutputStyleSettable {
  applyFlagSettings(settings: Pick<Settings, "outputStyle">): Promise<void>;
}

/**
 * 归一：命中值域 → 该样式；`"default"` / 未知值 / 空 → null。
 *
 * 未知值当默认而非报错：样式是锦上添花，CLI 未来改名不该炸掉会话（代价是新值静默
 * 不生效，需要人回来加进 OUTPUT_STYLES）；`"default"` 归一为 null 是因为它与
 * 「不下发」等价，少发一次无意义的控制请求。
 */
export function normalizeOutputStyle(raw: string | undefined | null): OutputStyle | null {
  const v = (raw ?? "").trim();
  // Set.has 返回 boolean、不带类型谓词，收窄只能靠断言；但值域由 OUTPUT_STYLES
  // 单点派生，类型不可能比集合宽，这个断言不会说谎。
  return OUTPUT_STYLE_SET.has(v) ? (v as OutputStyle) : null;
}

/**
 * 应用会话输出样式（薄外壳）：query 建好后、首轮 prompt 被 CLI 取走之前调用。
 *
 * - null（默认/未知）直接跳过，不发控制请求。
 * - 失败只告警不抛：样式没生效是遗憾不是故障——会话必须照常跑完。
 */
export async function applyOutputStyle(
  style: OutputStyle | null,
  query: OutputStyleSettable,
): Promise<void> {
  if (!style) return;
  try {
    await query.applyFlagSettings({ outputStyle: style });
  } catch (e) {
    console.warn(`[output-style] ${style} 未生效，会话继续用默认样式：`, e);
  }
}
