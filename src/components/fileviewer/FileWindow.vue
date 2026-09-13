<script setup lang="ts">
import { computed, watch, ref, nextTick } from "vue";
import { useFileViewer, isWindowDirty } from "../../composables/useFileViewer";
import type { FileWindowState, MarkdownMode } from "../../composables/useFileViewer";
import { useGotoDefinition } from "../../composables/useGotoDefinition";
import { useCallHierarchy } from "../../composables/useCallHierarchy";
import { useModal } from "../../composables/useModal";
import { useNotifications } from "../../composables/useNotifications";
import type { QueryResult } from "../../types";
import { api } from "../../api";
import CodeEditor from "../CodeEditor.vue";
import type { GutterGotoPayload } from "../../extensions/cmImplGutter";
import type { VimExCommand } from "../../extensions/vimExCommands";
import DiffViewer from "./DiffViewer.vue";
import { firstChangedLine } from "./diffLocate";
import { extToLang, highlightCode } from "../../utils/highlight";
import { formatContent } from "../../utils/format";
import { useContextMenu, type MenuItem } from "../../composables/useContextMenu";
import { useMentionInserter } from "../../composables/useMentionInserter";
import { isHtmlFilePath } from "../../utils/fileLink";
import { marked } from "../../utils/markdown";

/** 文件扩展名 → LSP language id（用于 cmLsp 扩展）。 */
function lspLangFor(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    rs: "rust",
    ts: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", mjs: "javascript", cjs: "javascript",
    vue: "vue",
    go: "go",
    py: "python", pyi: "python",
    java: "java",
    kt: "kotlin", kts: "kotlin",
    dart: "dart",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    ex: "elixir", exs: "elixir",
  };
  return map[ext];
}

const props = defineProps<{
  win: FileWindowState;
  /** 窗口活动区（中央面板）的实时尺寸，拖拽钳制用 */
  bounds: { w: number; h: number };
}>();

const { closeWindow, save, projectRoot, gotoOwnerId, indexHintWinId, revealInTreePath, navigateInPlace, navigateBack, navStackHasDirty, openAndScrollTo } = useFileViewer();
const goto = useGotoDefinition();
const callHierarchy = useCallHierarchy();
const modal = useModal();
const { push: pushNotification } = useNotifications();
const { show: showContextMenu } = useContextMenu();
const mentionInserter = useMentionInserter();

const gotoPopoverRef = ref<HTMLElement | null>(null);
const codeEditorRef = ref<InstanceType<typeof CodeEditor> | null>(null);

const dirty = computed(() => isWindowDirty(props.win));
/** 本窗口是否正在显示「索引已更新」轻量提示（保存成功增量更新后闪现 ~1.5s） */
const showIndexHint = computed(() => indexHintWinId.value === props.win.id);

// ── 滚动位置记忆（会话级，重启即忘）──
// 同一文件的编辑器 / 预览 / 只读 pre 滚动度量不同，key 按视图类型分开；
// 虚拟视图（git diff）可能与真实文件同路径，加前缀隔离。
function scrollKey(kind: string): string {
  return `${props.win.virtual ? "virtual:" : ""}${props.win.filePath}#${kind}`;
}

// 编辑器侧：有显式跳行请求挂起时放弃恢复，让跳行赢（cmScrollMemory 创建时求值）
const cmScrollMemoryOpts = {
  key: scrollKey("cm"),
  shouldRestore: () => props.win.scrollToLine == null,
};
const isImage = computed(() => !!props.win.imageUrl);
const canOpenInBrowser = computed(() => !props.win.virtual && isHtmlFilePath(props.win.filePath));
/** 是否挂编辑器：非只读、非图片、非错误；markdown 全预览模式下也不挂 */
const editorActive = computed(
  () =>
    !props.win.readonly &&
    !props.win.error &&
    !isImage.value &&
    (!props.win.isMarkdown || props.win.mdMode !== "preview"),
);

const MD_MODES: Array<{ value: MarkdownMode; label: string }> = [
  { value: "preview", label: "预览" },
  { value: "split", label: "分屏" },
  { value: "edit", label: "编辑" },
];

const languageLabel = computed(() => {
  const ext = props.win.fileName.split(".").pop()?.toLowerCase() || "";
  return props.win.language || extToLang[ext] || ext || "text";
});

// 只读代码视图（大文件 / 虚拟内容）
const highlighted = computed(() => {
  if (!props.win.content) return "";
  const ext = props.win.fileName.split(".").pop()?.toLowerCase() || "";
  return highlightCode(props.win.content, ext);
});

// Markdown 实时预览：渲染编辑器里的内容而不是磁盘基线，分屏时所见即所得
const renderedMarkdown = computed(() => {
  const source = props.win.editContent || props.win.content;
  if (!source) return "";
  try {
    return marked.parse(source) as string;
  } catch {
    return source;
  }
});

// ── 关闭：干净直接关；当前文件或栈内文件有未保存修改时让用户选 ──
const stackDirty = computed(() => navStackHasDirty(props.win));

// 保存并关闭：保存失败（error 已显示）就停，别静默丢内容
async function saveAndClose() {
  await save(props.win.id);
  if (isWindowDirty(props.win)) return;
  closeWindow(props.win.id);
}

async function requestClose() {
  if (dirty.value || stackDirty.value) {
    const msg = dirty.value
      ? stackDirty.value
        ? `「${props.win.fileName}」和跳转前打开的文件都有未保存的修改。「保存并关闭」只保存当前文件。`
        : `「${props.win.fileName}」有未保存的修改。`
      : "跳转前打开的文件有未保存的修改，关闭将丢弃。";
    const res = await modal.choice(
      "关闭文件",
      msg,
      { confirmLabel: "保存并关闭", altLabel: "放弃修改" },
    );
    if (res === "cancel") return;
    if (res === "confirm") {
      await saveAndClose();
    }
  }
  closeWindow(props.win.id);
}

// ── vim ex 命令（CodeEditor 转发）：:w 保存 / :wq 保存并关闭 /
//    :q 复用关闭确认（有修改时让用户选）/ :q! 丢弃修改直接关 ──
async function onVimEx(cmd: VimExCommand) {
  switch (cmd) {
    case "w":
      await save(props.win.id);
      break;
    case "wq":
      await saveAndClose();
      break;
    case "q":
      await requestClose();
      break;
    case "q!":
      closeWindow(props.win.id);
      break;
  }
}

// ── 标题栏拖拽：随意挪动窗口（自动平铺会在开/关/切主窗时重新接管）──
const dragging = ref(false);

function onHeaderPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button")) return; // 按钮不当拖拽把手
  const offsetX = e.clientX - props.win.x;
  const offsetY = e.clientY - props.win.y;
  dragging.value = true;
  const onMove = (ev: PointerEvent) => {
    // 钳在中央面板内：至少留 80px 宽、整条标题栏可抓，窗口永远拖得回来
    props.win.x = Math.min(Math.max(ev.clientX - offsetX, 80 - props.win.w), props.bounds.w - 80);
    props.win.y = Math.min(Math.max(ev.clientY - offsetY, 0), props.bounds.h - 40);
  };
  const onUp = () => {
    dragging.value = false;
    window.removeEventListener("pointermove", onMove);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

// ── 右下角拖拽：调整窗口尺寸。拖完置 userResized，retile 不再覆盖。──
const MIN_W = 320;
const MIN_H = 200;

function onResizePointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  e.stopPropagation(); // 不触发标题栏拖拽 / 父层 focus capture
  const startW = props.win.w;
  const startH = props.win.h;
  const startX = e.clientX;
  const startY = e.clientY;
  dragging.value = true; // 复用拖拽态：暂停几何过渡
  const onMove = (ev: PointerEvent) => {
    const dw = ev.clientX - startX;
    const dh = ev.clientY - startY;
    props.win.w = Math.min(Math.max(startW + dw, MIN_W), props.bounds.w - props.win.x);
    props.win.h = Math.min(Math.max(startH + dh, MIN_H), props.bounds.h - props.win.y);
  };
  const onUp = () => {
    dragging.value = false;
    props.win.userResized = true;
    window.removeEventListener("pointermove", onMove);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

// ── 跳转到指定行（聊天文件链接 / 跳转定义落点）──
// markdown 默认全预览没有编辑器，行号挂起，等用户切到编辑/分屏时再消费。
watch(
  () => [props.win.scrollToLine, editorActive.value] as const,
  async ([line, active]) => {
    if (line == null || !active) return;
    await nextTick();
    await codeEditorRef.value?.waitReady();
    // viewportY 来自跳转定义的源点击偏移：把目标行定位到该视口高度（复刻源符号屏幕位置）。
    // null（聊天文件链接等）走默认，行贴近视口顶部。
    const viewportY = props.win.scrollViewportY;
    codeEditorRef.value?.scrollToLine(line, { viewportY: viewportY ?? undefined });
    // 定位后「闪一下渐隐」高亮目标块——所有 scrollToLine 定位都在此统一触发
    // （封装一处，不散落到各定位调用点）。flashCount 为整块行数（变更卡 new_string），
    // 默认 1 行（跳转定义/聊天链接）。只读 pre 视图不挂 CodeEditor，editorActive=false 不进此分支。
    codeEditorRef.value?.flashLine(line, props.win.flashCount ?? 1);
    props.win.scrollToLine = null;
    props.win.scrollViewportY = null;
    props.win.flashCount = null;
  },
  { immediate: true },
);

// ── goto-definition（useGotoDefinition 是单例，浮层只在触发窗口里渲染）──
const gotoActive = computed(() => goto.visible.value && gotoOwnerId.value === props.win.id);
/** 浮层标题后缀：按 mode 显示 引用/实现/定义。 */
const gotoModeLabel = computed(() => {
  switch (goto.mode.value) {
    case "references": return "引用";
    case "implementation": return "实现";
    default: return "定义";
  }
});
/** 浮层结果来源标签：按前端 orchestration 层打的 source 四档透明显示，缺 source（旧路径）按 confidence 兜底。
 *  lsp/ast 同 conf-structure 色（LSP 权威 / codegraph AST 结构层），semantic 走 conf-semantic，grep 走 conf-text。 */
function gotoConf(item: QueryResult): { cls: string; text: string } {
  if (item.source === "lsp") return { cls: "conf-structure", text: "[LSP]" };
  if (item.source === "ast") return { cls: "conf-structure", text: "[AST]" };
  if (item.source === "semantic")
    return { cls: "conf-semantic", text: `[语义·${item.score != null ? Math.round(item.score * 100) : "?"}%]` };
  if (item.source === "grep" || goto.isGrepFallback.value)
    return { cls: "conf-text", text: "[匹配]" };
  if (item.confidence === "Structure") return { cls: "conf-structure", text: "[精确]" };
  return { cls: "conf-semantic", text: `[语义·${item.score != null ? Math.round(item.score * 100) : "?"}%]` };
}
/** 触发跳转时的光标行——压栈时记入 NavEntry，后退回到这一行 */
const lastSourceLine = ref<number | null>(null);
/** 触发跳转时源符号在编辑器视口中的垂直偏移——跳转目标按此偏移定位，回退时复刻滚动位置 */
const lastSourceViewportY = ref<number | null>(null);

// ── goto 浮层锚定（补全式：浮层出现在触发符号旁，而非贴底全宽）──
const fwBodyRef = ref<HTMLElement | null>(null);
/** 锚点（相对 .fw-body 定位系）：x/y = 触发点；h = 捕获时 .fw-body 高度（翻转变换用）；
 *  flip = 触发点贴近底部，浮层放不下 → 向上翻。null = 无锚点（兜底贴底旧形态）。 */
const gotoAnchor = ref<{ x: number; y: number; h: number; flip: boolean } | null>(null);
/** 浮层固定宽度（px）；与 CSS min(380px, calc(100% - 16px)) 对应，横向钳制用 */
const GOTO_POPOVER_W = 380;
/** 触发点下方放不下浮层（含 header ~37px + 余量）→ 翻转阈值 */
const GOTO_FLIP_BUDGET = 330;

/** 捕获锚点：client 坐标 → .fw-body 定位系，横向钳制留 8px 边距。 */
function captureGotoAnchor(clientX: number, clientY: number) {
  const el = fwBodyRef.value;
  if (!el) { gotoAnchor.value = null; return; }
  const rect = el.getBoundingClientRect();
  const x = Math.min(Math.max(8, clientX - rect.left), Math.max(8, rect.width - GOTO_POPOVER_W - 8));
  const y = clientY - rect.top;
  gotoAnchor.value = { x, y, h: rect.height, flip: y > rect.height - GOTO_FLIP_BUDGET };
}

/** 锚定内联样式：有锚点 → 符号旁（下方放不下上翻）；无锚点 → undefined 走贴底兜底 CSS。 */
const gotoPopoverStyle = computed(() => {
  const a = gotoAnchor.value;
  if (!a) return undefined;
  return a.flip
    ? { left: `${a.x}px`, bottom: `${a.h - a.y + 6}px`, top: "auto", right: "auto", width: `min(${GOTO_POPOVER_W}px, calc(100% - 16px))` }
    : { left: `${a.x}px`, top: `${a.y + 22}px`, bottom: "auto", right: "auto", width: `min(${GOTO_POPOVER_W}px, calc(100% - 16px))` };
});

/** 点编辑器空白/正文任意处关闭浮层（补全一致契约：点外部即关）。
 *  capture 相位先于 CodeEditor 内部 click：若随后的点击本身是 Ctrl/Alt+Click 或 gutter
 *  标记（重开浮层的新触发），对应 search* 会同步接管 seq 并重新置 visible——无闪烁。 */
function onEditorAreaClick() {
  if (gotoActive.value) goto.dismiss();
}

/** 单结果直接跳、多结果留浮层供选（search* 已把 visible 置 true）。跳转定义/实现/父类共用。 */
function jumpOrPick() {
  if (goto.results.value.length === 1) {
    jumpToResult(goto.results.value[0]);
  }
}

/** 绝对路径 → 相对 projectRoot 的正斜杠路径（goto source 用）；越界（非本工作区）返空串。 */
function relPathOf(absPath: string): string {
  const root = projectRoot.value;
  const sep = root.includes("\\") ? "\\" : "/";
  return absPath.startsWith(root)
    ? absPath.slice(root.length + sep.length).replace(/\\/g, "/")
    : "";
}

async function onGotoDefinition(payload: { word: string; filePath: string; line: number; column: number; wordColumn: number; viewportY: number; clientX: number; clientY: number }) {
  gotoOwnerId.value = props.win.id;
  lastSourceLine.value = payload.line;
  lastSourceViewportY.value = payload.viewportY;
  captureGotoAnchor(payload.clientX, payload.clientY);
  const ext = payload.filePath.split(".").pop()?.toLowerCase() || "";
  await goto.search(payload.word, projectRoot.value, { sourceFile: relPathOf(payload.filePath), sourceFileAbs: payload.filePath, sourceLine: payload.line, sourceExt: ext, sourceColumn: payload.column, sourceWordColumn: payload.wordColumn });
  jumpOrPick();
}

/** Alt+Click 符号 → 查引用（LSP references → grep 兜底）。
 *  与 onGotoDefinition 同构；单命中 jumpOrPick 直接跳（引用场景跳转即全部目的），
 *  多命中浮层锚在符号旁供选。 */
async function onGotoReferences(payload: { word: string; filePath: string; line: number; column: number; wordColumn: number; viewportY: number; clientX: number; clientY: number }) {
  gotoOwnerId.value = props.win.id;
  lastSourceLine.value = payload.line;
  lastSourceViewportY.value = payload.viewportY;
  captureGotoAnchor(payload.clientX, payload.clientY);
  const ext = payload.filePath.split(".").pop()?.toLowerCase() || "";
  await goto.searchAllReferences(payload.word, projectRoot.value, { sourceFile: relPathOf(payload.filePath), sourceFileAbs: payload.filePath, sourceLine: payload.line, sourceExt: ext, sourceColumn: payload.column, sourceWordColumn: payload.wordColumn });
  jumpOrPick();
}

/** gutter 标记点击（跳实现）：结果已随标记缓存，直接填 results 走 jumpOrPick。
 *  payload.line/viewportY 用于回退复刻滚动；clientX/Y 锚定浮层（旧调用方缺省 → 贴底兜底）。 */
async function onGotoGutter(payload: GutterGotoPayload) {
  gotoOwnerId.value = props.win.id;
  lastSourceLine.value = payload.line;
  lastSourceViewportY.value = payload.viewportY;
  if (payload.clientX != null && payload.clientY != null) captureGotoAnchor(payload.clientX, payload.clientY);
  await goto.searchImplementations(payload.word, projectRoot.value, payload.results);
  jumpOrPick();
}

/** gutter ⇄ 标记点击：声明位置设为层级根，右侧栏面板换根（App.vue watch 切 tab）。 */
function onGutterCallHierarchy(payload: { word: string; line: number; column: number }) {
  if (!projectRoot.value) return;
  void callHierarchy.openHierarchy({
    workspaceRoot: projectRoot.value,
    filePath: props.win.filePath,
    line: payload.line,
    column: payload.column,
    word: payload.word,
  });
}

async function onSearchAllReferences() {
  await goto.searchAllReferences(goto.searchWord.value, projectRoot.value);
}
/** 降级 hint 链接「用本地索引跳转」：timeout 时用户主动取 codegraph+grep 结果（不调 LSP）。 */
async function onLocalManualSearch() {
  await goto.localManualSearch();
}

function jumpToResult(item: QueryResult) {
  goto.dismiss();
  const root = projectRoot.value;
  if (!root) return;
  const separator = root.includes("\\") ? "\\" : "/";
  // symbol.file 通常是相对工作区（codegraph/LSP 都归一到相对）；LSP 跨工作区定义
  // （如外部库源）会是绝对路径——绝对直接用，相对才拼 root，避免拼成 root+绝对（os error 123）。
  const norm = item.symbol.file.replace(/[\\/]/g, separator);
  const isAbs = /^[A-Za-z]:[\\/]/.test(norm) || /^[\\/]/.test(norm);
  const fullPath = isAbs ? norm : root + separator + norm;
  // 就地覆盖当前窗口（压栈），不新开窗口；后退箭头逐级弹回
  void navigateInPlace(props.win.id, fullPath, {
    line: item.symbol.line,
    sourceLine: lastSourceLine.value,
    viewportY: lastSourceViewportY.value,
  });
}

/** 栈顶文件名（后退箭头 tooltip） */
const backTargetName = computed(() => {
  const top = props.win.navStack[props.win.navStack.length - 1];
  return top ? top.filePath.split(/[\\/]/).pop() || top.filePath : "";
});

function goBack() {
  void navigateBack(props.win.id);
}

function onGotoKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    goto.dismiss();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    goto.selectNext();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    goto.selectPrev();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const selected = goto.getSelected();
    if (selected) jumpToResult(selected);
  }
}

watch(gotoActive, (v) => {
  if (v) nextTick(() => gotoPopoverRef.value?.focus());
});

// ── 快捷键：Ctrl+S 保存，Esc 关窗，Alt+← 后退（导航栈），Shift+Alt+F 格式化 ──
function onKeydown(e: KeyboardEvent) {
  if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (dirty.value) void save(props.win.id);
  } else if (e.key === "ArrowLeft" && e.altKey) {
    e.preventDefault();
    goBack();
  } else if (e.key === "F" && e.shiftKey && e.altKey) {
    e.preventDefault();
    if (canFormat.value) formatFile();
  } else if (e.key === "Escape") {
    // 消费标记（preventDefault）：PermissionDialog 的 window 级 Esc 见 defaultPrevented
    // 让路——文件窗焦点下按 Esc 只走关窗（含 dirty 确认），不同时触发权限弹窗负面动作。
    e.preventDefault();
    void requestClose();
  }
}

/** 可定位条件：普通文件恒真；diff 虚拟窗的 filePath 也是真实磁盘路径
 *  （git 入口已经 toAbsPath 补绝对），唯独 deleted 状态文件已不在盘上，
 *  定位无意义。 */
const canLocateInTree = computed(
  () =>
    !props.win.virtual ||
    (!!props.win.diffPair && props.win.diffPair.status !== "deleted"),
);

/** 「打开文件定位到首个变更」：仅 git 全文件 diff 窗（deleted 无文件可开）。
 *  聊天变更卡是片段 diff，走它自己的「打开 ↗」锚点定位，不经这里。 */
const canOpenAtChange = computed(
  () => !!props.win.diffPair && props.win.diffPair.status !== "deleted",
);

function locateInTree() {
  revealInTreePath.value = props.win.filePath;
}

/** 打开真实文件（与 diff 窗并存）并滚到首个变更行 */
function openAtFirstChange() {
  const pair = props.win.diffPair;
  if (!pair) return;
  void openAndScrollTo(props.win.filePath, firstChangedLine(pair));
}

async function openInBrowser() {
  try {
    await api.fileOpen(props.win.filePath);
  } catch (e) {
    pushNotification({
      severity: "error",
      source: "fileviewer",
      title: "浏览器打开失败",
      body: `${props.win.fileName}: ${String(e)}`,
      timestamp: Date.now(),
      dedupKey: `fileviewer:open-browser:${props.win.filePath}`,
    });
  }
}

// ── 格式化（JSON / JSONL）──
// 仅编辑器激活（非只读/虚拟/错误/图片）且扩展名 ∈ {json, jsonl} 时可用；
// jsonc 通常带注释 JSON.parse 必失败，不提供入口。
const canFormat = computed(() => {
  if (props.win.readonly || props.win.virtual || props.win.error || props.win.imageUrl) return false;
  const ext = props.win.fileName.split(".").pop()?.toLowerCase() || "";
  return ext === "json" || ext === "jsonl";
});

function formatFile() {
  const ext = props.win.fileName.split(".").pop()?.toLowerCase() || "";
  const result = formatContent(props.win.editContent, ext);
  if (!result.ok) {
    pushNotification({
      severity: "error",
      source: "fileviewer",
      title: "格式化失败",
      body: `${props.win.fileName}: ${result.error}`,
      timestamp: Date.now(),
      dedupKey: `fileviewer:format:${props.win.filePath}`,
    });
    return;
  }
  // 直接改 editContent：dirty 判定（editContent !== content）自然成立；
  // CodeEditor 合并 watch 走 parent-sync dispatch（带注解），不会回流造成假 dirty。
  props.win.editContent = result.text;
}

/**
 * 编辑器右键菜单（统一接管，不再放行原生菜单——半原生半自定义会让「全选」这类
 * 项有时有有时没有）。
 *
 * - 有选区 → 追加「添加选中到对话」：引用形态是 `path + 行号区间`，发送时只把
 *   这一段读出来拼进 prompt（模型不必读全文）。
 * - 复制/剪切/粘贴/全选：剪贴板走现成的 Web Clipboard API，文档改动由 CodeEditor
 *   的 replaceSelection 统一入口落（走 dispatch → v-model → dirty 成立）。
 * - JSON/JSONL 追加格式化/保存。
 */
function onEditorContextMenu(e: MouseEvent) {
  const editor = codeEditorRef.value;
  const range = editor?.selectionLines() ?? null;
  const items: MenuItem[] = [];
  if (range) {
    items.push({
      label: `添加选中到对话（第 ${range.start}-${range.end} 行）`,
      action: () => mentionInserter.insertMention(props.win.filePath, false, range),
    });
    items.push({ label: "", separator: true });
  }
  items.push(
    { label: "复制", kbd: "Ctrl+C", disabled: !range, action: () => runClipboardAction(editor?.copySelection()) },
    { label: "剪切", kbd: "Ctrl+X", disabled: !range, action: () => runClipboardAction(editor?.cutSelection()) },
    { label: "粘贴", kbd: "Ctrl+V", action: () => runClipboardAction(editor?.pasteFromClipboard()) },
    { label: "全选", kbd: "Ctrl+A", action: () => editor?.selectAll() },
  );
  if (canFormat.value) {
    items.push({ label: "", separator: true });
    items.push(
      { label: "格式化", kbd: "Shift+Alt+F", action: formatFile },
      { label: "保存", kbd: "Ctrl+S", action: () => save(props.win.id) },
    );
  }
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, items);
}

/**
 * 剪贴板动作收口：读剪贴板需要用户授权（WebView 里可能被拒），失败不能静默——
 * 否则用户点了「粘贴」没反应只会以为菜单坏了。
 */
function runClipboardAction(p: Promise<void> | undefined): void {
  void Promise.resolve(p).catch((err: unknown) => {
    pushNotification({
      severity: "error",
      source: "fileviewer",
      title: "剪贴板操作失败",
      body: String(err),
      timestamp: Date.now(),
      dedupKey: "fileviewer:editor-clipboard",
    });
  });
}
</script>

<template>
  <div class="fw-window" :class="{ 'fw-window--dragging': dragging }" tabindex="-1" @keydown="onKeydown">
    <div class="fw-header" @pointerdown="onHeaderPointerDown">
      <!-- 导航栈后退箭头：跳转定义/引用就地覆盖后出现，逐级弹回 -->
      <button
        v-if="win.navStack.length > 0"
        class="fw-icon-btn"
        v-tooltip="'返回到 ' + backTargetName"
        @click.stop="goBack"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5"/>
          <path d="M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <span v-if="dirty" class="fw-dirty" v-tooltip="'有未保存的修改'">●</span>
      <span class="fw-title">{{ win.fileName }}</span>
      <transition name="fw-index-hint-fade">
        <span v-if="showIndexHint" key="hint" class="fw-index-hint" aria-live="polite">索引已更新</span>
      </transition>
      <span class="fw-lang">{{ languageLabel }}</span>
      <span v-if="win.readonly && !isImage" class="fw-readonly-badge">只读</span>
      <span class="fw-path" v-tooltip="win.filePath">{{ win.filePath }}</span>

      <button
        v-if="canOpenInBrowser"
        class="fw-icon-btn"
        v-tooltip="'在浏览器中打开'"
        @click.stop="openInBrowser"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M2 12h20"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      </button>

      <!-- 打开真实文件并定位到首个变更处（仅 git diff 窗） -->
      <button
        v-if="canOpenAtChange"
        class="fw-icon-btn"
        v-tooltip="'打开文件并定位到首个变更处'"
        @click.stop="openAtFirstChange"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <path d="M15 3h6v6"/>
          <path d="M10 14L21 3"/>
        </svg>
      </button>

      <!-- 在文件树中定位（普通文件 + diff 窗口；纯注入内容的虚拟窗除外） -->
      <button
        v-if="canLocateInTree"
        class="fw-icon-btn"
        v-tooltip="'在文件树中定位'"
        @click.stop="locateInTree"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 2v4"/>
          <path d="M12 18v4"/>
          <path d="M2 12h4"/>
          <path d="M18 12h4"/>
        </svg>
      </button>

      <!-- Markdown 三态：全预览 / 分屏 / 全编辑 -->
      <div v-if="win.isMarkdown && !win.readonly && !win.error" class="fw-md-modes">
        <button
          v-for="m in MD_MODES"
          :key="m.value"
          class="fw-md-mode-btn"
          :class="{ active: win.mdMode === m.value }"
          @click="win.mdMode = m.value"
        >
          {{ m.label }}
        </button>
      </div>

      <button
        v-if="dirty || win.saving"
        class="fw-btn primary"
        :disabled="win.saving"
        @click="save(win.id)"
      >
        {{ win.saving ? "保存中…" : "保存" }}
      </button>
      <button class="fw-close" @click="requestClose">&times;</button>
    </div>

    <div ref="fwBodyRef" class="fw-body">
      <div v-if="win.error" class="fw-error">{{ win.error }}</div>

      <div v-else-if="isImage" class="fw-image-wrap">
        <img :src="win.imageUrl" class="fw-image" :alt="win.fileName" />
      </div>

      <!-- 只读：diff / 大文件 / 虚拟内容 -->
      <DiffViewer v-else-if="win.diffPair" :pair="win.diffPair" :filePath="win.filePath" />
      <pre v-else-if="win.readonly" v-scroll-memory="scrollKey('pre')" class="fw-pre"><code class="viewer-code" v-html="highlighted"></code></pre>

      <!-- Markdown 全预览 -->
      <div
        v-else-if="win.isMarkdown && win.mdMode === 'preview'"
        v-scroll-memory="scrollKey('md-preview')"
        class="fw-scroll viewer-markdown"
        v-html="renderedMarkdown"
      ></div>

      <!-- Markdown 分屏：左编辑右实时预览 -->
      <div v-else-if="win.isMarkdown && win.mdMode === 'split'" class="fw-split">
        <div class="fw-split-pane fw-editor" @contextmenu="onEditorContextMenu" @click.capture="onEditorAreaClick">
          <CodeEditor
            ref="codeEditorRef"
            v-model="win.editContent"
            :filePath="win.filePath"
            :scrollMemory="cmScrollMemoryOpts"
            :workspaceRoot="projectRoot"
            :lspLang="lspLangFor(win.filePath)"
            @goto-definition="onGotoDefinition"
            @goto-references="onGotoReferences"
            @gutter-goto="onGotoGutter"
            @gutter-callhierarchy="onGutterCallHierarchy"
            @vim-ex="onVimEx"
          />
        </div>
        <!-- 分屏预览是半宽，换行位置与全预览不同，滚动位置分开记 -->
        <div v-scroll-memory="scrollKey('md-split-preview')" class="fw-split-pane fw-scroll viewer-markdown" v-html="renderedMarkdown"></div>
      </div>

      <!-- 默认：直接可编辑（含 Markdown 全编辑） -->
      <div v-else class="fw-editor" @contextmenu="onEditorContextMenu" @click.capture="onEditorAreaClick">
        <CodeEditor
          ref="codeEditorRef"
          v-model="win.editContent"
          :filePath="win.filePath"
          :scrollMemory="cmScrollMemoryOpts"
          :workspaceRoot="projectRoot"
          :lspLang="lspLangFor(win.filePath)"
          @goto-definition="onGotoDefinition"
          @goto-references="onGotoReferences"
          @gutter-goto="onGotoGutter"
          @gutter-callhierarchy="onGutterCallHierarchy"
          @vim-ex="onVimEx"
        />
      </div>

      <!-- 跳转/引用结果浮层（锚定触发符号旁，补全式） -->
      <div v-if="gotoActive" ref="gotoPopoverRef" tabindex="-1" class="goto-popover" :style="gotoPopoverStyle" @keydown="onGotoKeydown">
        <div class="goto-popover-header">
          <span class="goto-popover-title">「{{ goto.searchWord.value }}」的{{ gotoModeLabel }}</span>
          <button class="goto-popover-close" @click="goto.dismiss()">&times;</button>
        </div>
        <div class="goto-popover-body">
          <!-- 跳转请求进行中：显示 loading，而非 await 期间的「未找到定义」空文案 -->
          <template v-if="goto.searching.value">
            <div class="goto-popover-empty">跳转中…</div>
          </template>
          <!-- LSP 降级且无结果：timeout=语言服务慢 / not_ready=未就绪，给手动「用本地索引跳转」链接
               （auto-fallback 仅 not_ready 路径已跑过本地索引；这里链接供 timeout 主动取本地结果） -->
          <template v-else-if="goto.degraded.value && goto.results.value.length === 0">
            <div class="goto-popover-empty">
              {{ goto.degraded.value === 'timeout' ? '语言服务响应较慢' : '语言服务未就绪' }} ·
              <span class="goto-popover-hint" @click="onLocalManualSearch">用本地索引跳转</span>
            </div>
          </template>
          <template v-else-if="goto.results.value.length === 0">
            <div class="goto-popover-empty">
              <template v-if="goto.mode.value === 'references'">未找到引用</template>
              <template v-else-if="goto.mode.value === 'implementation'">未找到实现</template>
              <template v-else>
                未找到定义 · <span class="goto-popover-hint" @click="onSearchAllReferences">搜索所有引用</span>
              </template>
            </div>
          </template>
          <template v-else>
            <div
              v-for="(item, idx) in goto.results.value"
              :key="`${item.symbol.file}:${item.symbol.line}:${idx}`"
              class="goto-result-item"
              :class="{ selected: idx === goto.selectedIndex.value }"
              @click="jumpToResult(item)"
            >
              <span class="goto-confidence" :class="gotoConf(item).cls">{{ gotoConf(item).text }}</span>
              <span class="goto-name">{{ item.symbol.name }}</span>
              <span v-if="item.symbol.parent" class="goto-parent">· {{ item.symbol.parent }}</span>
              <span class="goto-file">{{ item.symbol.file }}:{{ item.symbol.line }}</span>
            </div>
          </template>
        </div>
      </div>

      <!-- 右下角尺寸把手：拖拽改 w/h，置 userResized 后 retile 不再覆盖 -->
      <div class="fw-resize" @pointerdown="onResizePointerDown">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <path d="M9 1L1 9" />
          <path d="M9 5L5 9" />
        </svg>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fw-window {
  width: 100%;
  height: 100%;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  display: flex;
  flex-direction: column;
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  overflow: hidden;
  outline: none;
}

.fw-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--aide-surface-hover);
  flex-shrink: 0;
  min-width: 0;
  cursor: move; /* 标题栏即拖拽把手 */
  user-select: none;
}

.fw-window--dragging {
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset), 0 0 0 1px color-mix(in srgb, var(--aide-accent) 40%, transparent);
}

.fw-dirty {
  color: var(--aide-warning);
  font-size: 11px;
  flex-shrink: 0;
}

/* 保存成功增量更新索引后的轻量提示：标题栏闪一条「索引已更新」，~1.5s 自消失。
   不进通知中心（成功是常态），用 success 语义色。transition 控制淡入淡出。 */
.fw-index-hint {
  font-size: 10px;
  color: var(--aide-success);
  background: color-mix(in srgb, var(--aide-success) 14%, transparent);
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}

.fw-index-hint-fade-enter-active,
.fw-index-hint-fade-leave-active {
  transition: opacity 0.25s ease;
}
.fw-index-hint-fade-enter-from,
.fw-index-hint-fade-leave-to {
  opacity: 0;
}

.fw-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
  white-space: nowrap;
  flex-shrink: 0;
}

.fw-lang {
  font-size: 10px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
  padding: 2px 8px;
  border-radius: 4px;
  text-transform: uppercase;
  flex-shrink: 0;
}

.fw-readonly-badge {
  font-size: 10px;
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 12%, transparent);
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}

.fw-path {
  flex: 1;
  font-size: 11px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.fw-md-modes {
  display: flex;
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-sm);
  overflow: hidden;
  flex-shrink: 0;
}

.fw-md-mode-btn {
  background: var(--aide-bg-deep);
  border: none;
  color: var(--aide-text-secondary);
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.12s;
}

.fw-md-mode-btn + .fw-md-mode-btn {
  border-left: 1px solid var(--aide-surface-hover);
}

.fw-md-mode-btn:hover {
  color: var(--aide-text-primary);
}

.fw-md-mode-btn.active {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
}

.fw-btn {
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-surface-hover);
  color: var(--aide-text-secondary);
  padding: 3px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.fw-btn.primary {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  border-color: var(--aide-accent);
}
.fw-btn.primary:hover {
  opacity: 0.9;
}
.fw-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.fw-close {
  background: none;
  border: none;
  color: var(--aide-text-secondary);
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  border-radius: 4px;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.fw-close:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}

.fw-icon-btn {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.fw-icon-btn:hover {
  color: var(--aide-accent);
  background: var(--aide-surface-hover);
}

.fw-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

/* 右下角尺寸把手：绝对定位贴 .fw-body 右下角，z-index 盖过编辑器 */
.fw-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 2px;
  cursor: nwse-resize;
  color: var(--aide-text-muted);
  opacity: 0.5;
  z-index: 30;
  transition: opacity 0.15s ease, color 0.15s ease;
}
.fw-resize:hover {
  opacity: 1;
  color: var(--aide-accent);
}
/* 拖拽进行中由 .fw-window--dragging 标记，把手高亮提示正在调尺寸 */
.fw-window--dragging .fw-resize {
  opacity: 1;
  color: var(--aide-accent);
}

.fw-error {
  padding: 24px;
  color: var(--aide-danger);
  font-size: 13px;
}

.fw-image-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow: auto;
  background: var(--aide-bg-deep);
}

.fw-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
  width: auto;
  height: auto;
}

.fw-pre {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
}

.fw-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.fw-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

.fw-split {
  flex: 1;
  min-height: 0;
  display: flex;
}

.fw-split-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.fw-split-pane + .fw-split-pane {
  border-left: 1px solid var(--aide-surface-hover);
}

/* ── Goto popover ── */
/* 基础形态为无锚点兜底（贴底全宽）；锚定符号旁时由内联 style 覆盖四角+宽度（见 gotoPopoverStyle）。 */
.goto-popover {
  position: absolute;
  bottom: 8px;
  left: 8px;
  right: 8px;
  max-height: 280px;
  /* 标准浮层配方（bg-raised + surface-blur + border-strong + shadow-lg）：
     毛玻璃主题浮层带 blur，实底主题 surface-blur 为 "none" 无害 */
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  z-index: 10;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: fw-pop-in 0.12s ease;
}

/* 锚定弹出（补全式微缩放淡入）；向上翻（flip）时也自然（无方向性位移） */
@keyframes fw-pop-in {
  from { opacity: 0; transform: translateY(4px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.goto-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--aide-surface-hover);
  flex-shrink: 0;
}

.goto-popover-title {
  font-size: 12px;
  color: var(--aide-text-secondary);
}

.goto-popover-close {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  border-radius: 4px;
}
.goto-popover-close:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}

.goto-popover-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.goto-popover-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--aide-text-muted);
}

.goto-popover-hint {
  color: var(--aide-accent);
  cursor: pointer;
}

.goto-result-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.12s ease-out;
}
.goto-result-item:hover {
  background: var(--aide-surface-hover);
}
/* 选中态走 accent 色系，与 hover 区分（浅色主题 surface-hover 是白色，选中会看不出来） */
.goto-result-item.selected {
  background: var(--aide-accent-subtle);
}

.goto-confidence {
  font-size: 11px;
  margin-right: 6px;
  flex-shrink: 0;
}
.conf-structure { color: var(--aide-success); }
.conf-semantic { color: var(--aide-warning); }
/* grep 文本兜底：精确文本匹配但非 AST 结构层，用中性色与 [精确]/[语义] 区分 */
.conf-text { color: var(--aide-text-secondary); }

.goto-name {
  font-size: 12px;
  color: var(--aide-text-primary);
  font-weight: 500;
  white-space: nowrap;
}

.goto-parent {
  font-size: 11px;
  color: var(--aide-text-muted);
  white-space: nowrap;
}

.goto-file {
  font-size: 11px;
  color: var(--aide-accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-left: auto;
}
</style>

<!-- hljs / Markdown / diff 渲染样式（非 scoped——作用于 v-html 生成的动态 DOM） -->
<style>
.viewer-code {
  display: block;
  padding: 16px;
  margin: 0;
  font-family: var(--aide-font-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--aide-text-primary);
  white-space: pre;
  tab-size: 4;
}

.viewer-code .hljs-keyword,
.viewer-code .hljs-selector-tag,
.viewer-code .hljs-type,
.viewer-markdown pre code.hljs .hljs-keyword,
.viewer-markdown pre code.hljs .hljs-selector-tag,
.viewer-markdown pre code.hljs .hljs-type { color: var(--aide-syntax-keyword); }

.viewer-code .hljs-string,
.viewer-code .hljs-addition,
.viewer-code .hljs-regexp,
.viewer-markdown pre code.hljs .hljs-string,
.viewer-markdown pre code.hljs .hljs-addition,
.viewer-markdown pre code.hljs .hljs-regexp { color: var(--aide-success); }

.viewer-code .hljs-number,
.viewer-code .hljs-literal,
.viewer-code .hljs-variable,
.viewer-code .hljs-template-variable,
.viewer-code .hljs-tag .hljs-attr,
.viewer-markdown pre code.hljs .hljs-number,
.viewer-markdown pre code.hljs .hljs-literal,
.viewer-markdown pre code.hljs .hljs-variable,
.viewer-markdown pre code.hljs .hljs-template-variable,
.viewer-markdown pre code.hljs .hljs-tag .hljs-attr { color: var(--aide-syntax-number); }

.viewer-code .hljs-comment,
.viewer-code .hljs-quote,
.viewer-markdown pre code.hljs .hljs-comment,
.viewer-markdown pre code.hljs .hljs-quote { color: var(--aide-text-muted); font-style: italic; }

.viewer-code .hljs-title,
.viewer-code .hljs-title.class_,
.viewer-code .hljs-title.class_.inherited__,
.viewer-code .hljs-title.function_,
.viewer-markdown pre code.hljs .hljs-title,
.viewer-markdown pre code.hljs .hljs-title.class_,
.viewer-markdown pre code.hljs .hljs-title.class_.inherited__,
.viewer-markdown pre code.hljs .hljs-title.function_ { color: var(--aide-accent); }

.viewer-code .hljs-meta,
.viewer-code .hljs-meta .hljs-keyword,
.viewer-code .hljs-section,
.viewer-markdown pre code.hljs .hljs-meta,
.viewer-markdown pre code.hljs .hljs-meta .hljs-keyword,
.viewer-markdown pre code.hljs .hljs-section { color: var(--aide-accent); }

.viewer-code .hljs-attr,
.viewer-code .hljs-attribute,
.viewer-code .hljs-property,
.viewer-markdown pre code.hljs .hljs-attr,
.viewer-markdown pre code.hljs .hljs-attribute,
.viewer-markdown pre code.hljs .hljs-property { color: var(--aide-info); }

.viewer-code .hljs-built_in,
.viewer-code .hljs-symbol,
.viewer-code .hljs-params,
.viewer-markdown pre code.hljs .hljs-built_in,
.viewer-markdown pre code.hljs .hljs-symbol,
.viewer-markdown pre code.hljs .hljs-params { color: var(--aide-warning); }

.viewer-code .hljs-tag,
.viewer-code .hljs-selector-class,
.viewer-code .hljs-selector-id,
.viewer-markdown pre code.hljs .hljs-tag,
.viewer-markdown pre code.hljs .hljs-selector-class,
.viewer-markdown pre code.hljs .hljs-selector-id { color: var(--aide-danger); }

.viewer-code .hljs-emphasis,
.viewer-markdown pre code.hljs .hljs-emphasis { font-style: italic; }

.viewer-code .hljs-strong,
.viewer-markdown pre code.hljs .hljs-strong { font-weight: bold; }

.viewer-code .hljs-link,
.viewer-markdown pre code.hljs .hljs-link { color: var(--aide-accent); text-decoration: underline; }

.viewer-code .hljs-deletion,
.viewer-markdown pre code.hljs .hljs-deletion { color: var(--aide-danger); }

/* ── Markdown rendered content ── */
.viewer-markdown {
  padding: 24px 32px;
  font-size: 14px;
  line-height: 1.75;
  color: var(--aide-text-primary);
  /* App.vue 的 .app-layout 为防止拖拽分栏/标签时误选界面文字，全局设了
   * user-select: none；该属性可继承，会一路传导到 markdown 预览正文导致
   * 整段内容都无法选中复制（与 ChatMessage.vue 同一类问题）。这里在预览
   * 容器局部恢复，子内容（段落、代码块、表格等）随继承一并变回可选，
   * 不影响标题栏等其余界面元素的防误选行为。 */
  user-select: text;
  -webkit-user-select: text;
}

.viewer-markdown h1 { font-size: 1.6em; font-weight: 600; margin: 1.2em 0 0.6em; border-bottom: 1px solid var(--aide-surface-hover); padding-bottom: 0.3em; }
.viewer-markdown h1:first-child { margin-top: 0; }
.viewer-markdown h2 { font-size: 1.35em; font-weight: 600; margin: 1.1em 0 0.5em; border-bottom: 1px solid var(--aide-surface-hover); padding-bottom: 0.25em; }
.viewer-markdown h2:first-child { margin-top: 0; }
.viewer-markdown h3 { font-size: 1.15em; font-weight: 600; margin: 1em 0 0.4em; }
.viewer-markdown h3:first-child { margin-top: 0; }
.viewer-markdown h4 { font-size: 1em; font-weight: 600; margin: 0.9em 0 0.3em; }
.viewer-markdown h4:first-child { margin-top: 0; }

.viewer-markdown p { margin: 0.6em 0; }
.viewer-markdown a { color: var(--aide-accent); text-decoration: none; }
.viewer-markdown a:hover { text-decoration: underline; }

.viewer-markdown ul, .viewer-markdown ol { padding-left: 1.5em; margin: 0.5em 0; }
.viewer-markdown li { margin: 0.2em 0; }
.viewer-markdown li > input[type="checkbox"] { margin-right: 6px; }

.viewer-markdown blockquote {
  margin: 0.6em 0;
  padding: 4px 14px;
  border-left: 3px solid var(--aide-accent);
  color: var(--aide-text-secondary);
  background: var(--aide-bg-deep);
  border-radius: 0 4px 4px 0;
}

.viewer-markdown code {
  font-family: var(--aide-font-mono);
  font-size: 0.9em;
  background: var(--aide-bg-deep);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--aide-warning);
}

.viewer-markdown pre {
  margin: 0.8em 0;
  border-radius: 8px;
  overflow: hidden;
}
.viewer-markdown pre code {
  display: block;
  padding: 14px 18px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--aide-text-primary);
  background: var(--aide-bg-deep);
  border-radius: 8px;
  overflow-x: auto;
}

.viewer-markdown table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
}
.viewer-markdown th, .viewer-markdown td {
  border: 1px solid var(--aide-surface-hover);
  padding: 8px 12px;
  text-align: left;
  /* 列宽下限：不设则 auto 布局把富余宽度全给长文本列，窄列被压到一个汉字宽，
     两字单元格逐字竖排（实测 900px 容器复现）。5em = 62.5px，扣掉单元格
     padding+border 26px 后内容盒 36.5px，够两字（Maple Mono NF CN 1.2em = 30px）。
     桌面聊天同一问题见 src/styles/global.css、remote-pwa/src/styles.css。 */
  min-width: 5em;
}
.viewer-markdown th {
  background: var(--aide-bg-deep);
  font-weight: 600;
}
.viewer-markdown tr:nth-child(even) td {
  background: var(--aide-border-subtle);
}

.viewer-markdown hr {
  border: none;
  border-top: 1px solid var(--aide-surface-hover);
  margin: 1em 0;
}

.viewer-markdown img {
  max-width: 100%;
  border-radius: 6px;
}
</style>
