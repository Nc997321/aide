/**
 * 默认档位解析（纯函数）。原实现散在 ChatInputBox 的三处 watcher 里，每处都直接
 * 调 providerDefaultEffort()；加「日常默认快速」就会变成三处各写一遍分叉。
 *
 * 优先级：**会话记住的（用户显式改过）> 日常快速 > provider 默认**。
 * 日常排在 provider 之前是刻意的 —— 日常的定位就是快（spec 2026-09-20）。
 *
 * 注意「快速(low)」会连带请求关掉思考（Rust 的 thinking_enabled_for_effort），
 * 即日常会话默认不推理：更快、更省 token。用户手动切档即离开这个默认。
 */
import { normalizeEffortOption } from "@aide/sdk/utils/effort";

/** 日常会话的默认档位：快速。 */
export const DAILY_DEFAULT_EFFORT = "low";

export interface EffortDefaultInput {
  /** 会话记住的档位（用户显式改过的）；读不到时 null */
  readonly remembered: string | null;
  /** 这个 tab 是不是日常 */
  readonly daily: boolean;
  /** provider 配置的默认档位（已归一的三档值） */
  readonly providerDefault: string;
}

export function defaultEffortFor(s: EffortDefaultInput): string {
  if (s.remembered) return normalizeEffortOption(s.remembered);
  if (s.daily) return DAILY_DEFAULT_EFFORT;
  return s.providerDefault;
}
