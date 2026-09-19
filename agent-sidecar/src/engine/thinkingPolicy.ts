// 「本会话该不该关思考」的唯一推导点。
//
// 为什么必须只有一个：这个值有两个消费口——CLI 子进程 env（cliEnv.ts 注入
// CLAUDE_CODE_EXTRA_BODY）与 SDK spawn 选项（queryOptions.ts 的 thinking）。
// 两处各推一遍会在装配的 await 窗口里劈叉（档位被下一条 send 刷新），env 与选项
// 给出互相矛盾的答案。与 Rust 侧 thinking_enabled_for_effort
//（src-tauri/src/commands/chat.rs）同源：**档位是唯一事实源**。

export interface ThinkingInputs {
  /** 本会话是 automation 会话（tasks/btw 等内部隔离轮）。 */
  automation: boolean;
  /** send.thinking_enabled 刷新的活值（缺省 true，见 SessionWorker.thinkingEnabled）。 */
  thinkingEnabled: boolean;
}

/** automation 恒关思考；普通会话由档位决定（快速 ⇒ 关，见 thinking_enabled_for_effort）。 */
export function thinkingDisabledFor(p: ThinkingInputs): boolean {
  return p.automation || !p.thinkingEnabled;
}
