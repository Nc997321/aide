import type { ChatEvent } from "./types.js";

/** 运行时切 effort 的最小能力面——query 对象只需要这一个方法，测试可用替身。 */
export interface EffortSettable {
  applyFlagSettings(settings: { effortLevel?: string | null }): Promise<void>;
}

/** 规范化 effort 档位：大小写不敏感，只认五个档；非法值返回 ""（调用方忽略）。 */
export function normalizeEffort(raw: string | undefined | null): string {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max" ? v : "";
}

export interface EffortSwitchParams {
  /** 用户选中的档位（任意大小写；normalize 后非法值直接忽略）。 */
  effort: string;
  /** 当前存活 query 的 applyFlagSettings 能力；null = query 未起（出错重连窗口等）。 */
  query: EffortSettable | null;
  /** 本地已坐实的当前档位——失败时回滚广播把选择器拉回这个值。 */
  currentEffort: string;
  emit: (e: ChatEvent) => void;
  /** 坐实（运行时成功）或本地落账（query 未起）时回写调用方的 currentEffort。 */
  commit: (effort: string) => void;
}

/**
 * 处理用户的 set_effort 请求，语义与 applyModelSwitch 对齐：成败都有回声，绝不静默——
 *
 * - query 未起（重连窗口）：存本地，startLoop 建 query 时经 options.effort 带上，
 *   立即广播同步选择器。
 * - query 在跑：走 SDK applyFlagSettings（flag settings 层，会话进行中动态生效）。
 *   成功 → 坐实 + effort_changed(新值)；失败 → effort_changed(旧值 + error) 回滚。
 *
 * 注意：CLAUDE_CODE_EFFORT_LEVEL env 会压过 applyFlagSettings（且与 options.effort
 * 就高合并，2026-08-01 smoke 实锤），所以 worker 绝不把该 env 透传给 CLI——
 * effort 只走 options.effort（建 query）+ applyFlagSettings（会话中）两条官方通道。
 * Settings.effortLevel 的 TS 类型只列到 xhigh，max 是类型外但运行时可用的值
 * （smoke-effort.ts 验证），故接口上 effortLevel 声明为 string。
 *
 * effort 与 thinking 的关系（2026-09-19 修订）：**本模块只改 effort，绝不碰
 * thinking**——SDK 根本没有运行时的 thinking setter，`applyFlagSettings({alwaysThinkingEnabled})`
 * 会被 CLI 静默接受但请求体一字不变（2026-09-19 实测：resolve 成功、零效果，
 * 且是单向锁死，关了再开也回不来）。
 *
 * 「快速 ⇒ 关思考」因此在**上层**实现，不在本模块：
 *   Rust send 路径算 thinking_enabled = 设置开关 && 档位非快速
 *   （commands/chat.rs 的 effective_thinking_enabled）
 *   → sidecar 发现该值与当前 query 的 spawn 值漂移时，在下一条 send **原地 resume
 *     重启**兑现（session-worker 的 restartQueryForThinking）。
 * 也就是说：effort 走热通道即时生效，思考只能等下一轮重建 query——两者生效时机
 * 不同，是刻意保留的差异（UI 文案据此区分，别合并成一句）。
 *
 * ⚠️ 另一层前提：即使重建了 query、spawn 参数写了 disabled，CLI 也可能**不发**这个
 * 参数——它按模型名查本地能力表，对不认识的模型名（deepseek-* / 本地 ollama 模型等）
 * 整个 `thinking` 字段都不发，兼容端点于是默认开推理（2026-09-19 实测）。真正的兜底
 * 是 cliEnv 注入的 CLAUDE_CODE_EXTRA_BODY：它绕过那份名单直接写请求体，既不依赖模型名、
 * 也不依赖端点认 Claude 名（见 docs/discussions/2026-09-19-thinking-disable-on-third-party-endpoints.md）。
 */
export function applyEffortSwitch(p: EffortSwitchParams): void {
  const next = normalizeEffort(p.effort);
  // 非法值/同值是 no-op：不坐实、不广播、不回执（选择器本来就没变化）。
  if (!next || next === p.currentEffort) return;

  if (!p.query) {
    p.commit(next);
    p.emit({ type: "effort_changed", effort: next });
    return;
  }
  p.query
    .applyFlagSettings({ effortLevel: next })
    .then(() => {
      p.commit(next);
      p.emit({ type: "effort_changed", effort: next });
    })
    .catch((e: unknown) => {
      p.emit({
        type: "effort_changed",
        effort: p.currentEffort,
        error: String((e as Error)?.message ?? e),
      });
    });
}
