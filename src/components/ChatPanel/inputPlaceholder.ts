/**
 * 输入框 placeholder 的纯函数。
 *
 * 为什么抽出来：原本是三层嵌套三元写在模板里（btw ? … : busy ? … : hero ? … : …），
 * 加模式分叉会变成四层，撞「嵌套 ≤ 3 层」的红线。这里按优先级线性化，顺带可测。
 *
 * 模式只在 hero（欢迎态 / 新建对话页）分叉：对话进行中仍一律「输入消息…」——
 * 那时用户已经知道自己在跟谁说话，不需要再被提醒「这是日常还是工程」。
 */
export interface InputPlaceholderState {
  /** 支线（顺便问一下，不进入主对话） */
  readonly btw: boolean;
  /** 正在生成：发送会进排队 */
  readonly busy: boolean;
  /** 欢迎态 / 新建对话页（零消息） */
  readonly hero: boolean;
  /** 当前是日常模式（仅 hero 时有意义） */
  readonly daily: boolean;
}

export function inputPlaceholder(s: InputPlaceholderState): string {
  if (s.btw) return "顺便问一下,不进入主对话…";
  if (s.busy) return "生成中，发送的消息将排队…";
  if (s.hero) return s.daily ? "今天想聊点什么？" : "你正在解决什么问题？";
  return "输入消息…";
}
