import { ref } from "vue";

export interface MentionRequest {
  path: string;
  isDir: boolean;
  nonce: number;
}

/**
 * 文件树右键「添加到对话」→ 当前选中会话输入框的注入通道（模块级单例）。
 *
 * 多工作区/多分屏下同时存在多个输入框（每个分屏组一个 ChatPanel），菜单侧
 * 不知道也不该知道哪个是「选中的会话」——由 ChatPanel 自己判断：只有
 * props.focused（聚焦组的激活 tab）的那个实例消费并清空，其余实例无视。
 * 语义与 usePaneLayout.activeSessionId 一致：聚焦组激活 tab = 选中的会话。
 *
 * 消费方把引用渲染成输入框上方的「文件芯片」（不是往 textarea 插文本），
 * 发送时才展开成 @path 前缀（见 ChatPanel.handleSend）。
 * nonce 单调递增，保证同一路径连续添加两次也能触发 watch。
 */
const pending = ref<MentionRequest | null>(null);
let nextNonce = 0;

export function useMentionInserter() {
  /** 菜单侧：请求把一个文件/目录引用添加到选中会话的输入框。 */
  function insertMention(path: string, isDir: boolean) {
    pending.value = { path, isDir, nonce: ++nextNonce };
  }

  /** ChatPanel 侧（仅聚焦实例）：取走待注入引用（一次性），无则返回 null。 */
  function consumeMention(): MentionRequest | null {
    const p = pending.value;
    pending.value = null;
    return p;
  }

  return { pending, insertMention, consumeMention };
}
