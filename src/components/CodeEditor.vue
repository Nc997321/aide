<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from "vue";
import type { LspServiceId } from "../utils/lspLang";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { searchKeymap } from "@codemirror/search";
import { Compartment } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { vim } from "@replit/codemirror-vim";
import { registerVimExCommands, unregisterVimExCommands, type VimExCommand } from "../extensions/vimExCommands";
import { applyVimKeyMaps, clearVimKeyMaps, vimKeyExInterceptor } from "../extensions/vimKeybindings";
import { useSettings } from "../composables/useSettings";
import { useModal } from "../composables/useModal";
import { themes } from "../themes";
import type { ThemeTokens } from "../themes/tokens";
import { createHighlightStyle } from "../utils/cmHighlight";
import { loadLanguageExtension } from "../utils/cmLanguage";
import { ctrlHoverHighlight } from "../extensions/cmCtrlHover";
import { cmScrollMemory, type ScrollMemoryOptions } from "../extensions/cmScrollMemory";
import { cmLsp } from "../extensions/cmLsp";
import { cmDefinitionPrefetch } from "../extensions/cmDefinitionPrefetch";
import { cmIndent } from "../extensions/cmIndent";
import { cmImplGutter, type GutterGotoPayload } from "../extensions/cmImplGutter";
import { cmFlash, flashEffect } from "../extensions/cmFlash";
import { useLsp } from "../composables/useLsp";
import { parentSyncAnnotation, isUserEdit } from "../utils/cmModelSync";

const { settings } = useSettings();

const props = defineProps<{
  filePath: string;
  modelValue: string;
  /** 滚动位置记忆（会话级）；不传则不记 */
  scrollMemory?: ScrollMemoryOptions;
  workspaceRoot?: string;
  /** LSP 服务 id（见 utils/lspLang 的 LspServiceId）：收窄到字面量联合，
   *  打错一个字母就编译不过——后端 `lang_from_id_str` 解析不出会**静默**不给 LSP。 */
  lspLang?: LspServiceId;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  /** Ctrl/Cmd+Click 符号 → 跳定义。clientX/clientY 为点击坐标（client 系），
   *  供宿主把结果浮层锚定在符号旁（补全式）。 */
  (e: "goto-definition", payload: { word: string; filePath: string; line: number; column: number; wordColumn: number; viewportY: number; clientX: number; clientY: number }): void;
  /** Alt+Click 符号 → 查引用（LSP textDocument/references → grep 兜底）。
   *  payload 语义与 goto-definition 相同：位置取词、坐标锚定浮层。 */
  (e: "goto-references", payload: { word: string; filePath: string; line: number; column: number; wordColumn: number; viewportY: number; clientX: number; clientY: number }): void;
  /** gutter 标记点击（跳实现）：results 为缓存实现列表，viewportY 复刻点击处视口偏移
   *  以对齐目标行；line 为标记所在行（回退 sourceLine）；clientX/clientY 锚定浮层。 */
  (e: "gutter-goto", payload: GutterGotoPayload): void;
  /** gutter ⇄ 标记点击（调用层级）：声明位置 = prepareCallHierarchy 查询点，
   *  宿主（FileWindow）转 useCallHierarchy().openHierarchy 打开右侧栏面板。 */
  (e: "gutter-callhierarchy", payload: { word: string; line: number; column: number }): void;
  /** vim ex 命令（:w/:wq/:q/:q!）请求文件操作，由宿主组件（FileWindow）执行 */
  (e: "vim-ex", command: VimExCommand): void;
}>();

const mountEl = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;
let createId = 0;

// Track editor readiness for async createEditor completion
let readyPromise = Promise.resolve();
let resolveReady: (() => void) | null = null;

// ── Language detection ──
const ext = computed(() => {
  const parts = props.filePath.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
});

const themeCompartment = new Compartment();
// 缩进用 compartment 包：编辑器设置变化（缩进格数 / Tab vs 空格）时 reconfigure，
// 避免重建整个 EditorView。
const indentCompartment = new Compartment();
// cmLsp 用 compartment 包，使 LSP 开关变化（先开文件后开 LSP）能 reconfigure
// 触发 didOpen/didClose——否则 cmLsp 以 createEditor 时的 enabled 固化，后开的
// LSP 不会 didOpen 已开文件 → server 无该文档 → 跳转/补全返空（bug4 真因）。
const lspCompartment = new Compartment();
// 「跳转到实现 / 跳到父类」gutter 标记用 compartment 包：LSP 开关 + capability 到位后
// reconfigure（初始空，caps 查回后再装）。
const implGutterCompartment = new Compartment();
// vim 键位用 compartment 包：设置面板切 Vim 模式时 reconfigure 热切换，不重建编辑器。
// vim() 内部用 domEventHandlers.keydown 拦截按键（优先级高于 keymap），但只对 vim-core
// keymap 认识的键 preventDefault——Ctrl+G 无绑定（vim-core 仅 <C-a>~<C-y> 系），
// 事件放行，故下方 Mod-g 跳行在 normal 模式下仍可用。
const vimCompartment = new Compartment();

// ── Editor lifecycle ──

async function createEditor() {
  if (!mountEl.value) return;

  const id = ++createId; // capture before async work

  // Create fresh readiness promise for this invocation
  readyPromise = new Promise<void>(r => { resolveReady = r; });

  // Destroy existing instance
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  if (view) {
    unregisterVimExCommands(view); // 全局注册表按 view 路由：旧 view 解绑
    view.destroy();
    view = null;
  }

  const langExt = await loadLanguageExtension(ext.value);

  // Abort if a newer call has started
  if (id !== createId) return;

  const updateListener = EditorView.updateListener.of((update) => {
    // 只有用户真实编辑才回流 v-model；父层同步（带 parentSyncAnnotation）的
    // 程序性替换不回流——CM 会把 CRLF 归一化成 \n，回流会让 editContent 偏离
    // 磁盘基线造成假 dirty（见 utils/cmModelSync.ts）
    if (update.docChanged && isUserEdit(update.transactions)) {
      const newValue = update.state.doc.toString();
      emit("update:modelValue", newValue);
    }
  });

  view = new EditorView({
    doc: props.modelValue,
    extensions: [
      basicSetup,
      langExt,
      keymap.of([
        ...searchKeymap,
        { key: "Mod-g", run: openGoToLine },
      ]),
      themeCompartment.of(syntaxHighlighting(createHighlightStyle(themes[settings.theme] || themes["warm-dark"]))),
      indentCompartment.of(cmIndent(settings.editor)),
      vimCompartment.of(
        settings.editor.vimMode
          ? [
              vim(),
              vimKeyExInterceptor(settings.editor.vimKeybindings, (cmd) => emit("vim-ex", cmd)),
            ]
          : []
      ),
      updateListener,
      ctrlHoverHighlight(),
      // 跳转定义 hover 预取 + 缓存失效观察者：常驻基础数组（非 cmLsp 数组——后者
      // enabled:false 返 [] 会留 LSP-关→编辑→LSP-开 陈旧窗口）。LSP 开关在 source
      // 内实时读，cmLsp.ts 零改动。详见 extensions/cmDefinitionPrefetch.ts。
      cmDefinitionPrefetch({ workspaceRoot: props.workspaceRoot ?? "", filePath: props.filePath }),
      ...(props.scrollMemory ? [cmScrollMemory(props.scrollMemory)] : []),
      lspCompartment.of(
        props.workspaceRoot && props.lspLang
          ? cmLsp({
              workspaceRoot: props.workspaceRoot,
              enabled: useLsp().isLspOn(props.workspaceRoot),
              lang: props.lspLang,
              filePath: props.filePath,
            })
          : []
      ),
      // 实现标记 gutter：初始空，createEditor 末按 capability reconfigure（见 applyImplGutter）
      implGutterCompartment.of([]),
      EditorView.domEventHandlers({
        click(event, view) {
          // Alt+Click（无 Ctrl/Cmd/Shift 修饰）→ 查引用；Ctrl/Cmd+Click → 跳定义。
          // 取词/视口偏移两分支同构，仅事件不同；坐标（clientX/Y）随 payload 传出，
          // 宿主把结果浮层锚在点击符号旁。
          if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            const pos = view.posAtCoords({
              x: event.clientX,
              y: event.clientY,
            });
            if (pos !== null) {
              const wordAt = view.state.wordAt(pos);
              if (wordAt) {
                const word = view.state.doc.sliceString(wordAt.from, wordAt.to);
                if (word) {
                  event.preventDefault();
                  const lineObj = view.state.doc.lineAt(pos);
                  const viewportY = event.clientY - view.scrollDOM.getBoundingClientRect().top;
                  emit("goto-references", {
                    word,
                    filePath: props.filePath,
                    line: lineObj.number,
                    column: pos - lineObj.from + 1,
                    wordColumn: wordAt.from - lineObj.from + 1,
                    viewportY,
                    clientX: event.clientX,
                    clientY: event.clientY,
                  });
                }
              }
            }
          } else if (event.ctrlKey || event.metaKey) {
            const pos = view.posAtCoords({
              x: event.clientX,
              y: event.clientY,
            });
            if (pos !== null) {
              const wordAt = view.state.wordAt(pos);
              if (wordAt) {
                const word = view.state.doc.sliceString(
                  wordAt.from,
                  wordAt.to
                );
                if (word) {
                  event.preventDefault();
                  const lineObj = view.state.doc.lineAt(pos);
                  // 记下点击处在编辑器视口中的垂直偏移（相对 scrollDOM 顶），
                  // 供跳转目标按此偏移定位——目标符号落在与源符号相同的屏幕高度，
                  // 而不是被滚到视口顶部。回退时用同一偏移复刻原滚动位置。
                  const viewportY = event.clientY - view.scrollDOM.getBoundingClientRect().top;
                  emit("goto-definition", {
                    word,
                    filePath: props.filePath,
                    line: lineObj.number,
                    column: pos - lineObj.from + 1,
                    wordColumn: wordAt.from - lineObj.from + 1,
                    viewportY,
                    clientX: event.clientX,
                    clientY: event.clientY,
                  });
                }
              }
            }
          }
        },
      }),
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "var(--cm-font-size)",
          fontFamily: "var(--cm-font-family)",
          backgroundColor: "var(--aide-bg-deep)",
          color: "var(--aide-text-primary)",
        },
        ".cm-scroller": {
          overflow: "auto",
          // base 主题在 .cm-scroller 上硬设 font-family: monospace，会盖掉 & 上的
          // var(--cm-font-family) 继承（.cm-content/.cm-gutters 是其子节点，继承的是
          // monospace 而非用户字体）。在此同名选择器覆盖——用户主题优先级高于 baseTheme，
          // 等特异性 + 后注入 → 胜出，子节点随之继承用户字体。
          fontFamily: "var(--cm-font-family)",
        },
        ".cm-gutters": {
          backgroundColor: "var(--aide-bg-deep)",
          color: "var(--aide-text-muted)",
          borderRight: "1px solid var(--aide-surface-hover)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "var(--aide-surface-default)",
        },
        ".cm-activeLine": {
          backgroundColor: "color-mix(in srgb, var(--aide-text-primary) 3%, transparent)",
        },
        ".cm-selectionBackground": {
          backgroundColor: "var(--aide-selection-bg) !important",
        },
        ".cm-cursor": {
          borderLeftColor: "var(--aide-text-primary)",
        },
        ".cm-searchMatch": {
          backgroundColor: "color-mix(in srgb, var(--aide-warning) 25%, transparent)",
        },
        ".cm-searchMatch.cm-searchMatch-selected": {
          backgroundColor: "color-mix(in srgb, var(--aide-warning) 45%, transparent)",
        },
        ".cm-matchingBracket": {
          backgroundColor: "color-mix(in srgb, var(--aide-accent) 15%, transparent)",
          outline: "1px solid var(--aide-accent)",
        },
        ".cm-nonmatchingBracket": {
          backgroundColor: "color-mix(in srgb, var(--aide-danger) 15%, transparent)",
        },
        ".cm-tooltip": {
          // 标准浮层配方（bg-raised + surface-blur + border-strong）：hover 详情 /
          // 补全 / 签名帮助共用容器，毛玻璃主题带 blur，实底主题 surface-blur 为 "none" 无害
          backgroundColor: "var(--aide-bg-raised) !important",
          color: "var(--aide-text-primary) !important",
          border: "1px solid var(--aide-border-strong) !important",
          backdropFilter: "var(--aide-surface-blur) !important",
        },
        // ── 搜索面板 / goto-line 对话框（@codemirror/search，basicSetup 已含）──
        // 真实 DOM（读 @codemirror/search 源码确认）：面板是 .cm-panel.cm-search
        // （不是 .cm-panel-search）；按钮是 .cm-button；输入框是 .cm-textfield；
        // 复选框是裸 <input type=checkbox> 包在 <label> 里（没有 .cm-checkbox 类）；
        // 关闭按钮是 [name=close]（没有 .cm-button 类）；goto-line 对话框是
        // .cm-dialog + .cm-dialog-close。{ dark: true } 已让 CodeMirror 自带 &dark
        // 默认值生效，下面再用 --aide 精修到项目配色。
        ".cm-panels": {
          backgroundColor: "var(--aide-bg-deep) !important",
          color: "var(--aide-text-primary) !important",
        },
        ".cm-panels-top": {
          borderBottom: "1px solid var(--aide-border) !important",
        },
        ".cm-panels-bottom": {
          borderTop: "1px solid var(--aide-border) !important",
        },
        ".cm-dialog": {
          backgroundColor: "var(--aide-bg-deep) !important",
          color: "var(--aide-text-primary) !important",
        },
        ".cm-dialog-close": {
          color: "var(--aide-text-muted) !important",
        },
        ".cm-dialog-close:hover": {
          color: "var(--aide-text-primary) !important",
        },
        ".cm-panel": {
          backgroundColor: "var(--aide-bg-deep) !important",
          color: "var(--aide-text-primary) !important",
          border: "1px solid var(--aide-border) !important",
        },
        // vim ex 命令面板（:w/:wq/:q）：vim-core 的 openDialog 渲染裸 <input>
        // （无 .cm-textfield 类），自带的 baseTheme 只给了 border:none +
        // backgroundColor:inherit，color/字体/光标色仍是 UA 默认——补主题
        ".cm-vim-panel input": {
          color: "var(--aide-text-primary) !important",
          caretColor: "var(--aide-text-primary) !important",
          fontFamily: "var(--cm-font-family, monospace) !important",
          fontSize: "12.5px !important",
        },
        ".cm-vim-panel input:focus": {
          outline: "1px solid var(--aide-accent) !important",
          outlineOffset: "1px !important",
        },
        ".cm-panel.cm-search": {
          backgroundColor: "var(--aide-bg-raised) !important",
          boxShadow: "var(--aide-shadow-sm) !important",
          padding: "6px 8px !important",
        },
        ".cm-textfield": {
          backgroundColor: "var(--aide-bg-deep) !important",
          border: "1px solid var(--aide-border) !important",
          color: "var(--aide-text-primary) !important",
          borderRadius: "var(--aide-radius-sm) !important",
          padding: "2px 6px !important",
          fontSize: "12px !important",
          boxShadow: "var(--aide-shadow-inset) !important",
        },
        ".cm-textfield:focus": {
          borderColor: "var(--aide-accent) !important",
          boxShadow: "var(--aide-accent-ring) !important",
          outline: "none !important",
        },
        ".cm-button": {
          backgroundImage: "none !important",
          backgroundColor: "var(--aide-surface-default) !important",
          border: "1px solid var(--aide-border) !important",
          color: "var(--aide-text-secondary) !important",
          borderRadius: "var(--aide-radius-sm) !important",
          padding: "2px 8px !important",
          fontSize: "12px !important",
          boxShadow: "var(--aide-highlight-inset) !important",
        },
        ".cm-button:hover": {
          backgroundColor: "var(--aide-surface-hover) !important",
          color: "var(--aide-text-primary) !important",
        },
        ".cm-button:active": {
          backgroundColor: "var(--aide-surface-active) !important",
        },
        // 关闭按钮（无 .cm-button 类，靠 name 属性定位）
        ".cm-panel [name=close]": {
          color: "var(--aide-text-muted) !important",
          fontSize: "14px !important",
        },
        ".cm-panel [name=close]:hover": {
          color: "var(--aide-text-primary) !important",
        },
        // 复选框：<label><input type=checkbox> 文本</label>，label 里没有 .cm-checkbox
        ".cm-panel label": {
          color: "var(--aide-text-muted) !important",
          fontSize: "12px !important",
        },
        ".cm-panel input[type=checkbox]": {
          accentColor: "var(--aide-accent) !important",
        },
        // ── 自动补全（@codemirror/autocomplete，basicSetup 已含）──
        // 真实 DOM（读源码确认）：tooltip 是 .cm-tooltip.cm-tooltip-autocomplete；
        // 内部 <ul> 无 cm-completionList 类（仅有 cm-completionListIncompleteTop/
        // Bottom 表示未取完）；<li> 默认无类名（role=option，选中靠 aria-selected）；
        // 命中文字是 .cm-completionMatchedText（不是 cm-completion-matched）。
        ".cm-tooltip-autocomplete": {
          backgroundColor: "var(--aide-bg-deep) !important",
          border: "1px solid var(--aide-surface-hover) !important",
          boxShadow: "var(--aide-shadow-md) !important",
        },
        ".cm-tooltip-autocomplete ul": {
          padding: "2px !important",
          fontSize: "12.5px !important",
        },
        ".cm-tooltip-autocomplete li": {
          padding: "2px 8px !important",
          color: "var(--aide-text-secondary) !important",
        },
        ".cm-tooltip-autocomplete li:hover, .cm-tooltip-autocomplete li[aria-selected]": {
          backgroundColor: "var(--aide-surface-hover) !important",
          color: "var(--aide-text-primary) !important",
        },
        // 分组分隔条（<completion-section> 自定义元素），默认 silver 边
        ".cm-tooltip-autocomplete completion-section": {
          borderBottomColor: "var(--aide-border) !important",
          color: "var(--aide-text-muted) !important",
        },
        ".cm-completionLabel": {
          color: "var(--aide-text-primary) !important",
        },
        ".cm-completionIcon": {
          color: "var(--aide-text-muted) !important",
        },
        ".cm-completionDetail": {
          color: "var(--aide-text-muted) !important",
          fontStyle: "italic !important",
        },
        ".cm-completionMatchedText": {
          color: "var(--aide-accent) !important",
        },
        ".cm-completionInfo": {
          backgroundColor: "var(--aide-bg-raised) !important",
          border: "1px solid var(--aide-surface-hover) !important",
          color: "var(--aide-text-secondary) !important",
        },
        // ── 诊断 / lint（@codemirror/lint）──
        ".cm-diagnostic": {
          backgroundColor: "var(--aide-bg-deep) !important",
          color: "var(--aide-text-secondary) !important",
          borderLeft: "3px solid var(--aide-danger) !important",
          padding: "4px 8px !important",
          fontSize: "12px !important",
        },
        ".cm-diagnostic-warning": {
          borderLeftColor: "var(--aide-warning) !important",
        },
        ".cm-diagnostic-error": {
          borderLeftColor: "var(--aide-danger) !important",
        },
      }, { dark: true }),
      // 跳转定位后的「闪一下渐隐」行高亮（FileWindow 定位行后调 flashLine 触发）
      cmFlash(),
    ],
    parent: mountEl.value,
  });

  // vim ex 命令路由：本视图的 :w/:wq/:q/:q! 转 emit 让宿主（FileWindow）执行
  registerVimExCommands(view, (command) => emit("vim-ex", command));
  // 按键映射是 vim-core 全局副作用：vim 开时应用（拦截扩展已随 compartment 装入）
  if (settings.editor.vimMode) applyVimKeyMaps(settings.editor.vimKeybindings);

  // Signal that the editor is fully created (including async lang import)
  applyFontSettings();
  // 装载实现标记 gutter（按 LSP 开关 + capability 决定；caps 异步查回后 reconfigure）
  void applyImplGutter();
  resolveReady?.();
}

/** 按 LSP 开关 + server capability 决定是否装载 gutter 标记扩展。
 *  - LSP 关 / 无 workspaceRoot / 无 lspLang → 卸载（[]）
 *  - LSP 开但 server 不支持 documentSymbolProvider → 卸载（标记全部依赖符号表）
 *  - documentSymbol + implementationProvider → ↓ 跳实现 + ⇄ 调用层级（若支持 callHierarchyProvider）
 *  - documentSymbol + 仅 callHierarchyProvider → 只 ⇄（↓ 无意义）
 *  - documentSymbol + 仅 implementationProvider → 只 ↓（现有行为） */
async function applyImplGutter() {
  if (!view) return;
  const { workspaceRoot, lspLang } = props;
  if (!workspaceRoot || !lspLang || !useLsp().isLspOn(workspaceRoot)) {
    if (view) view.dispatch({ effects: implGutterCompartment.reconfigure([]) });
    return;
  }
  const caps = await useLsp().getCapabilities(workspaceRoot, lspLang);
  if (!view) return; // editor 可能已 destroy
  const on = caps.documentSymbolProvider
    && (caps.implementationProvider || caps.callHierarchyProvider);
  view.dispatch({
    effects: implGutterCompartment.reconfigure(
      on
        ? cmImplGutter({
            workspaceRoot,
            filePath: props.filePath,
            lang: lspLang,
            onGotoImplementation: (p) => emit("gutter-goto", p),
            onShowCallHierarchy: (p) => emit("gutter-callhierarchy", p),
          })
        : [],
    ),
  });
}

function applyFontSettings() {
  if (!view) return;
  view.dom.style.setProperty("--cm-font-size", `${settings.fontSize}px`);
  view.dom.style.setProperty("--cm-font-family", settings.editorFontFamily);
}

// ── React to user font settings changes ──
watch(
  [() => settings.fontSize, () => settings.editorFontFamily],
  () => applyFontSettings()
);

// ── React to theme changes: rebuild HighlightStyle with resolved CSS var colors ──
watch(() => settings.theme, () => {
  if (view) {
    view.dispatch({
      effects: themeCompartment.reconfigure(
        syntaxHighlighting(createHighlightStyle(themes[settings.theme] || themes["warm-dark"]))
      )
    });
  }
});

// ── React to editor indent settings: reconfigure indent compartment ──
watch(
  () => settings.editor.indentSize,
  () => {
    if (view) {
      view.dispatch({ effects: indentCompartment.reconfigure(cmIndent(settings.editor)) });
    }
  }
);

// ── React to vim mode toggle: reconfigure vim compartment ──
// 装载时同时 applyVimKeyMaps（按键映射是 vim-core 全局 defaultKeymap 副作用，
// 不随 compartment 生命周期走，需显式 apply/clear）；拦截扩展与 vim() 同 compartment
//（同生共死，vim 关即卸）。
watch(
  () => settings.editor.vimMode,
  (on) => {
    if (!view) return;
    if (on) applyVimKeyMaps(settings.editor.vimKeybindings);
    else clearVimKeyMaps();
    view.dispatch({
      effects: vimCompartment.reconfigure(
        on
          ? [vim(), vimKeyExInterceptor(settings.editor.vimKeybindings, (cmd) => emit("vim-ex", cmd))]
          : []
      ),
    });
  }
);

// ── React to vim keybinding edits: re-apply maps + swap interceptor bindings ──
watch(
  () => settings.editor.vimKeybindings,
  (bindings) => {
    if (!view) return;
    if (settings.editor.vimMode) applyVimKeyMaps(bindings);
    view.dispatch({
      effects: vimCompartment.reconfigure(
        settings.editor.vimMode
          ? [vim(), vimKeyExInterceptor(bindings, (cmd) => emit("vim-ex", cmd))]
          : []
      ),
    });
  },
  { deep: true } // 三模式嵌套数组，浅比较感知不到行增删
);

// ── React to LSP 开关变化：重装/卸载实现标记 gutter（caps 随 server 重启刷新）──
watch(
  () => (props.workspaceRoot ? useLsp().isLspOn(props.workspaceRoot) : false),
  () => { void applyImplGutter(); },
);

function openGoToLine(target: EditorView): boolean {
  const { prompt: modalPrompt } = useModal();
  modalPrompt("跳转到行:", "行号").then((line) => {
    if (line !== null && line !== "") {
      const lineNum = parseInt(line, 10);
      if (!isNaN(lineNum) && lineNum > 0) {
        const pos = target.state.doc.line(lineNum);
        target.dispatch({
          selection: { anchor: pos.from, head: pos.from },
          scrollIntoView: true,
        });
        target.focus();
      }
    }
  });
  return true;
}

// ── 文件切换 / 父层内容同步（合并单 watch，按变更来源分流）──
// filePath 与 modelValue 在「就地导航换页」（useFileViewer.loadIntoWindow）里
// 同步连改：先置 editContent(=modelValue) 后置 filePath。若拆两个独立 watch，
// modelValue 那个会先触发——此时 filePath 仍是旧文件、旧编辑器还挂着，parent-sync
// dispatch 把新内容灌进旧编辑器 → 旧文件 definition 缓存被误清（回退再点同词必 miss、
// 重发 LSP 等 3-4s）。合并成单 watch 后，Vue 把同步连改批成一次回调，回调内见两者
// 同变 → 走 createEditor 重建（销毁旧视图、不 dispatch），从源头消除对旧编辑器的
// 程序性灌入；失效观察者随之可回退到裸 docChanged（仅真实内容变更才失效）。
watch(
  [() => props.modelValue, () => props.filePath],
  ([newVal, newFilePath], [oldVal, oldFilePath]) => {
    if (newFilePath !== oldFilePath) {
      // 文件切换：重建编辑器。createEditor 读 props.modelValue 作新 doc（已就位），
      // cmLsp didOpen 拿到目标内容。不 parent-sync dispatch——旧编辑器不被注入新内容。
      createEditor();
      return;
    }
    // 同文件、父层内容变更（磁盘重载 / 外部更新）：同步进编辑器，带注解防回流假 dirty
    if (view && newVal !== view.state.doc.toString()) {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: newVal,
        },
        // 父层同步：带注解，updateListener 不把归一化文本回流 v-model
        annotations: parentSyncAnnotation.of(true),
      });
    }
  }
);

// ── LSP 开关变化（先开文件后开 LSP / LspIndicator 关 LSP）：reconfigure cmLsp，
// 触发 LspTracker 构造→didOpen / destroy→didClose。不加此 watch，cmLsp 以
// createEditor 时的 enabled 固化，后开的 LSP 不会 didOpen 已开文件，server 没有
// 该文档，lspDefinition/lspCompletion 一律返空（bug4 真因）。
watch(
  () => (props.workspaceRoot && props.lspLang ? useLsp().isLspOn(props.workspaceRoot) : false),
  (on) => {
    if (!view) return;
    view.dispatch({
      effects: lspCompartment.reconfigure(
        props.workspaceRoot && props.lspLang
          ? cmLsp({ workspaceRoot: props.workspaceRoot, enabled: on, lang: props.lspLang, filePath: props.filePath })
          : []
      ),
    });
  },
);

// ── Expose scrollToLine ──
// opts.viewportY：把目标行定位到编辑器视口顶下 viewportY 像素处（跳转定义复刻源符号
//   屏幕位置用）；省略则用默认 yMargin（行贴近视口顶部，聊天文件链接等沿用旧行为）。

function scrollToLine(line: number, opts?: { cursor?: boolean; viewportY?: number }) {
  if (!view) return;
  const docLine = view.state.doc.line(Math.min(line, view.state.doc.lines));
  const yMargin = opts?.viewportY ?? 5;
  if (opts?.cursor !== false) {
    view.dispatch({
      selection: { anchor: docLine.from, head: docLine.from },
      effects: EditorView.scrollIntoView(docLine.from, { y: "start", yMargin }),
    });
    view.focus();
  } else {
    view.dispatch({
      effects: EditorView.scrollIntoView(docLine.from, { y: "start", yMargin }),
    });
  }
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;

/** 跳转定位后「闪一下渐隐」高亮：给 line..line+count-1 行挂渐隐装饰，~1.5s 后清。
 *  timer 随重建/卸载清（见 createEditor / onUnmounted），避免回调 dispatch 到已销毁视图。 */
function flashLine(line: number, count = 1) {
  if (!view) return;
  view.dispatch({ effects: flashEffect.of({ line, count, add: true }) });
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    if (view) view.dispatch({ effects: flashEffect.of({ line, count, add: false }) });
  }, 1500);
}

function waitReady(): Promise<void> {
  return readyPromise;
}

/**
 * 当前主选区覆盖的行号区间（1-based 闭区间），供宿主「添加选中到对话」引用。
 *
 * 空选区（单光标）返回 null：那不是"选了零行"，而是"没选东西"——宿主据此决定
 * 菜单项是否可用。多光标只取主选区（main），与"一次引用一段"的语义一致。
 * 选区在行尾结束（to 落在下一行行首）时不算多选一行——否则选中一行却报两行。
 */
function selectionLines(): { start: number; end: number } | null {
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const doc = view.state.doc;
  const startLine = doc.lineAt(from).number;
  const endLine = doc.lineAt(to).number;
  // to 恰在某行行首（含行尾换行之后）→ 回退一行
  const lastLine = to > doc.line(endLine).from ? endLine : endLine - 1;
  const end = Math.max(startLine, lastLine);
  return { start: startLine, end };
}

/** 主选区文本；无选区返回空串（与 selectionLines 的 null 语义不同：这里是"要复制的内容"）。 */
function selectedText(): string {
  if (!view) return "";
  const { from, to } = view.state.selection.main;
  return from === to ? "" : view.state.sliceDoc(from, to);
}

/**
 * 用 text 替换主选区（插入后光标落在文本末尾）。
 *
 * 走 `view.dispatch` 而不是直接改 DOM：updateListener 判定为用户编辑 → 回流
 * v-model → dirty 成立、与 parent-sync 通道不冲突。cut/paste 都走这里。
 */
function replaceSelection(text: string): void {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

/** 右键菜单的复制/剪切/粘贴：剪贴板用现成的 Web API（与「复制路径」同一条通道），
 *  文档改动走 replaceSelection 统一入口。无选区时复制/剪切是空操作（菜单已置灰）。 */
async function copySelection(): Promise<void> {
  const text = selectedText();
  if (!text) return;
  await navigator.clipboard.writeText(text);
}

async function cutSelection(): Promise<void> {
  const text = selectedText();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  replaceSelection("");
}

async function pasteFromClipboard(): Promise<void> {
  const text = await navigator.clipboard.readText();
  if (!text) return;
  replaceSelection(text);
}

function selectAll(): void {
  if (!view) return;
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  view.focus();
}

defineExpose({
  scrollToLine,
  flashLine,
  waitReady,
  selectionLines,
  copySelection,
  cutSelection,
  pasteFromClipboard,
  selectAll,
});

onMounted(() => {
  createEditor();
});

onUnmounted(() => {
  clearVimKeyMaps(); // vim-core 全局映射随编辑器卸载清掉，避免残留到其他编辑器
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  if (view) {
    unregisterVimExCommands(view);
    view.destroy();
    view = null;
  }
});
</script>

<template>
  <div ref="mountEl" class="cm-editor-host"></div>
</template>

<style scoped>
.cm-editor-host {
  height: 100%;
  width: 100%;
  overflow: hidden;
}
</style>
