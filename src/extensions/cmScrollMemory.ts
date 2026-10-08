import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { StateEffect, type Extension } from "@codemirror/state";
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

/** 显式跳行（scrollToLine）随事务带上它：取消尚未落地的「恢复上次滚动位置」。
 *  恢复写在 requestMeasure 的 write 阶段（下一帧），而跳行常在编辑器创建后立刻发生——
 *  不取消的话恢复会晚于跳行执行，把落点盖回旧位置（目标行跑到视口外）。 */
export const cancelScrollRestore = StateEffect.define<null>();

/** 行锚记在同一张记忆表里，key 加后缀（useScrollMemory 只存数字，不必改状态层）。 */
function topKey(key: string): string {
  return `${key}@top`;
}

export interface ScrollMemoryOptions {
  key: string;
  shouldRestore?: () => boolean;
}

export function cmScrollMemory(opts: ScrollMemoryOptions): Extension {
  const { remember, recall } = useScrollMemory();

  return ViewPlugin.define((view: EditorView) => {
    const wantRestore = opts.shouldRestore ? opts.shouldRestore() : true;
    const saved = recall(opts.key);
    const savedTop = recall(topKey(opts.key));
    let cancelled = false;
    if (wantRestore && saved !== undefined && saved > 0) {
      // 优先按「视口顶部那一行的文档位置」恢复：新编辑器里屏幕外各行高度还是估算值，
      // 同一个 scrollTop 像素值会落到别的行（实测差 20+ 行）；scrollIntoView 会随测量收敛。
      // 没有行锚（旧记录）才退回像素恢复。
      if (savedTop !== undefined) {
        requestAnimationFrame(() => {
          if (cancelled) return;
          const pos = Math.min(savedTop, view.state.doc.length);
          view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 0 }) });
        });
      } else {
        view.requestMeasure({
          read: () => {},
          write: () => {
            if (!cancelled) view.scrollDOM.scrollTop = saved;
          },
        });
      }
    }

    const onScroll = () => {
      const top = view.scrollDOM.scrollTop;
      remember(opts.key, top);
      remember(topKey(opts.key), view.lineBlockAtHeight(top).from);
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });

    return {
      update(u: ViewUpdate) {
        if (u.transactions.some((tr) => tr.effects.some((e) => e.is(cancelScrollRestore)))) cancelled = true;
      },
      destroy() {
        view.scrollDOM.removeEventListener("scroll", onScroll);
      },
    };
  });
}
