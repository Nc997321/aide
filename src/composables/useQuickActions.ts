/** 工具栏快捷操作——仿照 useSearchProviders.ts 的注册表模式：模块级单例数组，
 *  register/unregister 是留给未来"自定义工具栏"功能的扩展点，当前只暴露
 *  内置的 /compact /clear 两个默认条目，不接任何自定义 UI。 */
export interface QuickAction {
  id: string;
  label: string;
  prompt: string;
  /** 胶囊气泡前缀图标（字符）。 */
  icon?: string;
  /** true = 执行前弹 useModal.confirm 二次确认（用于不可逆操作，如 /clear）。 */
  confirm?: boolean;
}

const actions: QuickAction[] = [
  { id: "compact", label: "压缩上下文", prompt: "/compact", icon: "✦" },
  { id: "clear", label: "清空上下文", prompt: "/clear", icon: "⌫", confirm: true },
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
