/** 斜杠命令注册表——/... 命令的唯一事实源。三个消费方都吃这张表：
 *  1. 分裂按钮菜单 = UI 投影（ChatSendButton 按 kind 渲染）；
 *  2. 输入框 /name args = 命令行投影（ChatPanel.handleSend 统一分发，
 *     不允许在发送路径上给单个命令打补丁）；
 *  3. 以后的 /review 等新命令 = 往这里加一行，两个入口自动都有。
 *  「顺便问一句」「压缩上下文」只是命令的 UX 标签（label），命令本身是 name。
 *  register/unregister 是留给未来"自定义工具栏"功能的扩展点。 */
export interface QuickAction {
  id: string;
  /** 斜杠命令名（不带 /）：输入框 /btw、/compact 据此匹配。 */
  command: string;
  /** UX 标签：菜单项与动作胶囊里展示的人性化名字。 */
  label: string;
  /** prompt = CLI 引擎层原生命令，原文发给 sidecar 执行（/compact /clear）；
   *  btw = 支线对话，aide 自己实现的 UX 增强（CLI 的 /btw 是 TUI 专属，
   *  SDK 环境不可用），走 send-btw 链路不发引擎。 */
  kind: "prompt" | "btw";
  /** 菜单项/胶囊气泡前缀图标（字符）。 */
  icon?: string;
  /** true = 执行前弹 useModal.confirm 二次确认（用于不可逆操作，如 /clear）。 */
  confirm?: boolean;
}

const actions: QuickAction[] = [
  { id: "btw", command: "btw", label: "顺便问一下", kind: "btw", icon: "↳" },
  { id: "compact", command: "compact", label: "压缩上下文", kind: "prompt", icon: "✦" },
  { id: "clear", command: "clear", label: "清空上下文", kind: "prompt", icon: "⌫", confirm: true },
];

function register(action: QuickAction) {
  const idx = actions.findIndex((a) => a.id === action.id);
  if (idx >= 0) {
    actions[idx] = action;
  } else {
    actions.push(action);
  }
}

function unregister(id: string) {
  const idx = actions.findIndex((a) => a.id === id);
  if (idx >= 0) actions.splice(idx, 1);
}

export function useQuickActions() {
  return { actions, register, unregister };
}
