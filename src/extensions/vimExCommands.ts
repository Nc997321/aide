// vim ex 命令 → 文件操作接线。
//
// vim-core 默认只带空的 :write（wrapper 无 save 实现）、无 :quit，
// 所以 :w/:q 系命令必须用 Vim.defineEx 自己注册。defineEx 是全局注册表
// （后注册覆盖先注册），而多文件窗口各自持有 EditorView——这里用一个
// view → handler 的弱注册表做路由：ex 命令触发时拿到的是 CodeMirror
// wrapper（cm.cm6 即触发命令的那个 EditorView），查表转给对应窗口。
//
// 匹配规则（vim-core vim.js parseInput_ / matchCommand_）：
// - 命令名按 \w+ 贪婪匹配，最长前缀查注册表——:wq 必须单独注册 "wq"
//   前缀，注册 "w" 不会覆盖它（name 不以 "wq" 开头时 "w" 前缀不命中）；
// - :q! 的 ! 不属于 \w+，留在 params.argString，由 q handler 自行区分。

import type { EditorView } from "@codemirror/view";
import { Vim, type CodeMirror as VimCodeMirror } from "@replit/codemirror-vim";

/** vim ex 命令请求的文件操作，由宿主组件（FileWindow）执行 */
export type VimExCommand = "w" | "wq" | "q" | "q!";

type VimExHandler = (command: VimExCommand) => void;

// 全局注册表：EditorView → handler。多文件窗口各自注册、各自响应自己的 view。
const viewHandlers = new WeakMap<EditorView, VimExHandler>();
let defined = false;

// defineEx 只注册一次（全局副作用）；window 级冲突由 viewHandlers 路由化解。
function defineExCommands() {
  if (defined) return;
  defined = true;
  Vim.defineEx("w", "w", (cm) => dispatchEx(cm, "w"));
  Vim.defineEx("wq", "wq", (cm) => dispatchEx(cm, "wq"));
  Vim.defineEx("q", "q", (cm, params) => {
    dispatchEx(cm, params.argString?.trim().startsWith("!") ? "q!" : "q");
  });
}

function dispatchEx(cm: VimCodeMirror, command: VimExCommand) {
  const handler = viewHandlers.get(cm.cm6);
  if (!handler) return; // 编辑器已卸载 / 未注册宿主：静默忽略
  handler(command);
}

/** 注册 vim ex 命令路由：createEditor 建好 view 后调用 */
export function registerVimExCommands(view: EditorView, handler: VimExHandler): void {
  defineExCommands();
  viewHandlers.set(view, handler);
}

/** 注销路由：view 销毁前调用 */
export function unregisterVimExCommands(view: EditorView): void {
  viewHandlers.delete(view);
}
