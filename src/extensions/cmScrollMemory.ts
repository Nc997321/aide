import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { useScrollMemory } from "../composables/useScrollMemory";

/**
 * CodeMirror 滚动位置记忆扩展（事件层）。
 *
 * - 滚动时把 scrollDOM.scrollTop 写进 useScrollMemory（会话级内存，重启即忘）。
 * - 编辑器创建时若有记忆则恢复。恢复走 requestMeasure 的 write 阶段——
 *   要等 CM 完成首次测量、给全文档估好高度后 scrollTop 才不会被钳到 0。
 * - shouldRestore 在插件创建时同步求值：外部有显式跳行请求挂起
 *   （FileWindow 的 scrollToLine）时放弃恢复，让跳行赢。
 */

export interface ScrollMemoryOptions {
  key: string;
  shouldRestore?: () => boolean;
}

export function cmScrollMemory(opts: ScrollMemoryOptions): Extension {
  const { remember, recall } = useScrollMemory();

  return ViewPlugin.define((view: EditorView) => {
    const wantRestore = opts.shouldRestore ? opts.shouldRestore() : true;
    const saved = recall(opts.key);
    if (wantRestore && saved !== undefined && saved > 0) {
      view.requestMeasure({
        read: () => {},
        write: () => {
          view.scrollDOM.scrollTop = saved;
        },
      });
    }

    const onScroll = () => remember(opts.key, view.scrollDOM.scrollTop);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });

    return {
      destroy() {
        view.scrollDOM.removeEventListener("scroll", onScroll);
      },
    };
  });
}
