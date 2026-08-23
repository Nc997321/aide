import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, type ViewUpdate } from "@codemirror/view";
import { useLsp } from "../composables/useLsp";
import * as resolver from "../composables/definitionResolver";

/** 跳转定义的 hover 预取 + 缓存失效观察者（CodeMirror 适配器）。
 *
 *  这一层让「点击就跳转」近/真瞬时：用户 hover 一个词 300ms 后，预取的 LSP
 *  definition 请求已在途或已完成；点击时 `useGotoDefinition` 先 `peek` 缓存（命中
 *  即真瞬时），否则 `resolve` await 同一 in-flight promise（近瞬时）。详见
 *  `composables/definitionResolver/index.ts`。
 *
 *  ── 预取：第二个 `hoverTooltip` source（返回 `null`，不画 tooltip）在 300ms 停留
 *  后算 `wordAt(pos)` → `resolver.prefetch`。source 必须**同步返 `null`**——返
 *  promise 会被 CM6 HoverPlugin 置 `pending` 并在每次 editor update 后 20ms 重触
 *  （node_modules/@codemirror/view/dist/index.js:10670，预取风暴）。LSP 开关在
 *  source 内实时读 `useLsp().isLspOn`（无 reconfigure churn）。
 *
 *  ── 失效：独立 ViewPlugin 在任意 `docChanged` 时失效本文件缓存 →
 *  `resolver.invalidateFile`。换页不产生 `docChanged`——靠 CodeEditor 合并 watch 与
 *  useFileViewer.loadIntoWindow 协同：CodeEditor 把 filePath 与 modelValue 两个 watch
 *  合并成单 watch（Vue 批处理使同 tick 连改批成一次回调）；loadIntoWindow 把 editContent
 *  与 filePath 等全部字段推迟到 readFile 之后一次性同步设置（读期间保留旧 editContent、
 *  不闪空）。二者落在同一同步块连改 → 合并 watch 走 createEditor 重建（销毁旧视图、不
 *  dispatch），旧编辑器不再被程序性灌入新内容。故裸 docChanged 只在「用户键入」与
 *  「同文件磁盘重载」这类真实内容变更时触发，不误清源缓存。（曾有两个根因致换页误清：
 *  ① 拆两个独立 watch——modelValue 先于 filePath 触发，旧编辑器吃一次 parent-sync
 *  dispatch 误清源缓存；② loadIntoWindow 在 readFile 前提前清 editContent=""，同样让
 *  modelValue 先于 filePath 变空走 parent-sync 分支。两根因已结构消除——合并 watch +
 *  推迟到 readFile 后一次性同步设置，缺一不可。）
 *  `destroy()` 不失效（同 VSCode：仅内容变更失效，不因关闭/导航失效——否则换页就
 *  清掉源缓存，回退再点照样 miss）。常驻 CodeEditor **基础扩展数组**（非 cmLsp 数组——
 *  后者 `enabled:false` 返 `[]` 会留 LSP-关→编辑→LSP-开 陈旧窗口）；故 `cmLsp.ts` 零改动。
 *
 *  ── 词首列 = `wa.from - lineObj.from + 1`，与 CodeEditor click emit 的 `wordColumn`
 *  同式 → hover 与 click 对同一词产出同键 → 预取真正暖到点击。 */
export function cmDefinitionPrefetch(opts: { workspaceRoot: string; filePath: string }): Extension {
  if (!opts.workspaceRoot || !opts.filePath) return [];
  const { workspaceRoot, filePath } = opts;

  // 预取 source：300ms 停留后算词首列预取。同步返 null（无 pending、无重触）。
  const prefetchSource = hoverTooltip((view: EditorView, pos: number) => {
    if (!useLsp().isLspOn(workspaceRoot)) { console.warn(`[hover] prefetch skip lsp-off pos=${pos} file=${filePath}`); return null; } // 实时门控：LSP 关时不预取
    const wa = view.state.wordAt(pos);
    if (!wa) { console.warn(`[hover] prefetch no-word pos=${pos}`); return null; } // 空白/槽线无词
    const word = view.state.doc.sliceString(wa.from, wa.to);
    if (!word) return null;
    const lineObj = view.state.doc.lineAt(pos);
    const wordCol = wa.from - lineObj.from + 1;
    console.warn(`[hover] prefetch source line=${lineObj.number} col=${wordCol} word=${word} pos=${pos} file=${filePath}`);
    resolver.prefetch({ workspaceRoot, word }, { file: filePath, line: lineObj.number, col: wordCol });
    return null;
  }, { hoverTime: 300 });

  // 失效观察者：doc 改了就失效本文件缓存。换页不产生 docChanged（CodeEditor 合并
  // watch 后换页走 createEditor 重建、不 dispatch，见模块头注释），故这里裸
  // docChanged 只在用户键入 / 同文件磁盘重载这类真实内容变更时触发。
  const invalidator = ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
        if (update.docChanged) {
          resolver.invalidateFile(filePath);
        }
      }
    },
  );

  return [prefetchSource, invalidator];
}