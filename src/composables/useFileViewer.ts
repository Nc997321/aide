import { ref, readonly } from "vue";
import { api } from "../api";
import { useRecent } from "./useRecent";
import { useCodeGraphProgress } from "./useCodeGraphProgress";
import { useNotifications } from "./useNotifications";
import { imageMimeFromPath } from "../utils/imageMime";
import type { DiffPair } from "../types";

/**
 * 多窗口文件查看/编辑器的状态层。
 *
 * - 每个打开的文件是一个独立窗口（FileWindowState），可同时开多个，
 *   平铺/聚焦布局由 FileViewer.vue（管理层）负责，这里只管数据。
 * - 默认直接可编辑（看齐 VS Code）；只读的三种情况：图片、注入内容的
 *   虚拟视图（git diff 等）、超过 MAX_EDITABLE_SIZE 的大文件。
 * - Markdown 有三种视图模式：全编辑 / 分屏（编辑+实时预览，默认）/ 全预览。
 */

export type MarkdownMode = "edit" | "split" | "preview";

/** 跳转定义/引用就地导航的后退栈条目：压栈时窗口所显示文件的完整快照 */
export interface NavEntry {
  filePath: string;
  /** 压栈时的编辑内容；与 content 相等表示当时干净 */
  editContent: string;
  /** 磁盘基线——恢复后 dirty 判定靠 editContent !== content 自然成立 */
  content: string;
  /** 触发跳转时光标所在行（后退落点）；未知为 null */
  line: number | null;
  /** markdown 三态随栈恢复 */
  mdMode: MarkdownMode;
}

export interface FileWindowState {
  id: string;
  filePath: string;
  fileName: string;
  /** 磁盘内容基线——保存成功后同步，用于 dirty 判定 */
  content: string;
  /** 编辑器实时内容 */
  editContent: string;
  imageUrl: string;
  /** 显式注入的语言标识，空串走扩展名推断 */
  language: string;
  /** git diff 对比数据（virtual 窗口专用）；存在则渲染 DiffViewer */
  diffPair: DiffPair | null;
  error: string;
  saving: boolean;
  /** 图片 / 虚拟内容 / 大文件——不挂编辑器 */
  readonly: boolean;
  /** 内容由调用方注入（无磁盘对应物，不可保存） */
  virtual: boolean;
  isMarkdown: boolean;
  mdMode: MarkdownMode;
  /** 挂载后要滚到的行号，FileWindow 消费后置回 null */
  scrollToLine: number | null;
  /** 跳转定义/引用的后退栈：栈顶 = 上一个位置；空 = 未发生过就地跳转 */
  navStack: NavEntry[];
  /** 窗口几何（px，视口坐标）——自动平铺由 FileViewer 层计算，拖拽直接改 x/y */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 用户已手动调整过尺寸——retile 跳过此窗口，保留用户意图，不再被自动平铺覆盖 */
  userResized: boolean;
}

const MAX_EDITABLE_SIZE = 1_000_000;

// ── 模块级单例状态 ──
const windows = ref<FileWindowState[]>([]);
/** 聚焦窗口：恢复默认弹窗大小居中，其余缩进底部小条；null = 平铺全览 */
const focusedId = ref<string | null>(null);
const projectRoot = ref("");
/** goto-definition 浮层归属的窗口（useGotoDefinition 是单例，浮层只在触发它的窗口里渲染） */
const gotoOwnerId = ref<string | null>(null);
/**
 * "在文件树中定位" 信号：FileWindow 按钮写入目标文件路径，
 * App.vue 侧 watch 消费——切到文件标签 → 调 FileTree.revealFile()。
 * 消费后重置为 null。
 */
const revealInTreePath = ref<string | null>(null);

// 每窗口图片 Blob URL，关窗时释放；非响应式，仅用于清理。
const blobUrls = new Map<string, string>();

// ── 保存触发的「索引已更新」轻量提示 ──
// 保存成功增量更新索引后，在编辑器窗口附近短暂闪一条提示（约 1.5s 自消失），
// 不进通知中心（成功是常态，进通知中心会刷屏）。只有失败 / embed 未就绪
// 这类需要用户知晓的情况才走 useNotifications 进通知中心（见 save()）。
// 单例：同一时刻只显示最近一次保存的提示；新保存覆盖旧的（重置计时）。
const indexHintWinId = ref<string | null>(null);
let indexHintTimer: ReturnType<typeof setTimeout> | null = null;
const { push: pushNotification } = useNotifications();

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function isMarkdownPath(path: string): boolean {
  const ext = fileNameOf(path).split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "mdx";
}

export function isWindowDirty(win: FileWindowState): boolean {
  return !win.readonly && !win.error && !win.imageUrl && win.editContent !== win.content;
}

/**
 * 闪一条「索引已更新」轻量提示，绑定到指定窗口。约 1.5s 后自消失；
 * 新一次保存会覆盖旧的（清旧计时、重置），故同时只有一个窗口显示。
 */
function showIndexHint(winId: string) {
  indexHintWinId.value = winId;
  if (indexHintTimer) clearTimeout(indexHintTimer);
  indexHintTimer = setTimeout(() => {
    // 仅当仍是本窗口时清，避免被更新的提示误清
    if (indexHintWinId.value === winId) indexHintWinId.value = null;
    indexHintTimer = null;
  }, 1500);
}

async function detectProjectRoot() {
  try {
    const info = await api.getProjectInfo();
    projectRoot.value = info.root;
    // 构建触发统一走 ensureIndex（lastIndexedRoot 守卫防重复）。
    // 这里是打开文件时的兜底；主触发点在 FileTree.loadRoot（项目加载锚点）。
    if (info.root) useCodeGraphProgress().ensureIndex(info.root);
  } catch {
    // best effort; goto falls back to grep
  }
}

/**
 * 按路径读取文件并填充窗口字段（open / 就地导航共用）。
 * 重置全部内容相关字段后重新加载：图片走 Blob URL，文本按大小判只读，
 * 读取失败写 win.error（调用方决定是否允许后退恢复）。
 */
async function loadIntoWindow(win: FileWindowState, path: string) {
  // 旧图片的 Blob URL 先释放（同窗口换文件，避免泄漏）
  const oldUrl = blobUrls.get(win.id);
  if (oldUrl) {
    URL.revokeObjectURL(oldUrl);
    blobUrls.delete(win.id);
  }

  win.filePath = path;
  win.fileName = fileNameOf(path);
  win.content = "";
  win.editContent = "";
  win.imageUrl = "";
  win.language = "";
  win.diffPair = null;
  win.error = "";
  win.readonly = false;
  win.isMarkdown = isMarkdownPath(path);
  win.mdMode = "preview";
  win.scrollToLine = null;

  const mime = imageMimeFromPath(path);
  if (mime) {
    // 图片：读取原始字节并构造 Blob URL，避免 UTF-8 解码失败。
    try {
      const buf = await api.readFileBinary(path);
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      blobUrls.set(win.id, url);
      win.imageUrl = url;
      win.readonly = true;
    } catch (e) {
      win.error = String(e);
    }
  } else {
    try {
      win.content = await api.readFileContent(path);
      win.editContent = win.content;
      if (win.content.length > MAX_EDITABLE_SIZE) win.readonly = true;
    } catch (e) {
      win.error = String(e);
    }
  }
  // 记录最近访问文件（best effort，绝不阻断打开主流程）
  void useRecent().recordFile(path, win.fileName);
}

export function useFileViewer() {
  /**
   * 打开文件。同一磁盘路径已开着 → 聚焦已有窗口（文件树重复点击不产生副本）；
   * 注入内容的虚拟视图（git diff）同路径重开 → 原窗口内容就地刷新。
   * 新窗口加入平铺全览（取消聚焦），窗口随数量增多平均变小。
   */
  async function open(path: string, opts?: { content?: string; language?: string; diffPair?: DiffPair }) {
    const isVirtual = opts?.content !== undefined || opts?.diffPair !== undefined;
    const existing = windows.value.find((w) => w.filePath === path && w.virtual === isVirtual);
    if (existing) {
      if (opts?.diffPair) {
        existing.diffPair = opts.diffPair;
      } else if (isVirtual) {
        existing.content = opts!.content!;
        existing.editContent = opts!.content!;
        existing.language = opts?.language || existing.language;
      }
      focusedId.value = existing.id;
      return;
    }

    const win: FileWindowState = {
      id: crypto.randomUUID(),
      filePath: path,
      fileName: fileNameOf(path),
      content: "",
      editContent: "",
      imageUrl: "",
      language: opts?.language || "",
      diffPair: opts?.diffPair || null,
      error: "",
      saving: false,
      readonly: isVirtual,
      virtual: isVirtual,
      isMarkdown: !isVirtual && isMarkdownPath(path),
      // Markdown 默认全预览，编辑/分屏由用户按需切
      mdMode: "preview",
      scrollToLine: null,
      navStack: [],
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      userResized: false,
    };

    if (isVirtual) {
      if (!opts?.diffPair) {
        win.content = opts!.content!;
        win.editContent = win.content;
      }
    } else {
      await loadIntoWindow(win, path);
      if (opts?.language) win.language = opts.language;
    }

    void detectProjectRoot();
    windows.value.push(win);
    // 新窗口进平铺全览，让所有已开窗口一起可见
    focusedId.value = null;
  }

  /** 打开并滚动到目标行（聊天文件链接 / 跳转定义共用入口） */
  async function openAndScrollTo(targetPath: string, line: number) {
    await open(targetPath);
    const win = windows.value.find((w) => w.filePath === targetPath && !w.virtual);
    if (!win) return;
    if (!win.readonly && !win.error) win.scrollToLine = line;
    focusedId.value = win.id;
  }

  /**
   * 跳转定义/引用的就地导航：不新开窗口，把目标文件灌进同一个窗口，
   * 当前状态（含未保存修改）压入 navStack，由 navigateBack 逐级弹回。
   * 目标已在另一窗口打开时退化为聚焦该窗口（保住路径唯一不变量，不入栈）。
   */
  async function navigateInPlace(
    winId: string,
    targetPath: string,
    opts: { line: number | null; sourceLine: number | null },
  ) {
    const win = windows.value.find((w) => w.id === winId);
    if (!win || win.virtual) return;

    const other = windows.value.find(
      (w) => w.id !== winId && w.filePath === targetPath && !w.virtual,
    );
    if (other) {
      if (!other.readonly && !other.error && opts.line != null) other.scrollToLine = opts.line;
      focusedId.value = other.id;
      return;
    }

    win.navStack.push({
      filePath: win.filePath,
      editContent: win.editContent,
      content: win.content,
      line: opts.sourceLine,
      mdMode: win.mdMode,
    });
    await loadIntoWindow(win, targetPath);
    if (!win.readonly && !win.error && opts.line != null) win.scrollToLine = opts.line;
  }

  /**
   * 后退一步：弹栈顶并就地恢复上一个文件，未保存修改随栈原样带回。
   * 已知边界：若原路径此刻已在别的窗口打开，不查重、照常恢复
   * （概率极小；两窗口同路径时保存后者覆盖前者，与主流编辑器一致）。
   */
  async function navigateBack(winId: string) {
    const win = windows.value.find((w) => w.id === winId);
    if (!win || win.navStack.length === 0) return;
    const entry = win.navStack.pop()!;
    await loadIntoWindow(win, entry.filePath);
    // 磁盘现读可能被压栈后的外部保存改变过——恢复以快照为准，未保存修改不丢
    win.content = entry.content;
    win.editContent = entry.editContent;
    win.mdMode = entry.mdMode;
    if (!win.readonly && !win.error && entry.line != null) win.scrollToLine = entry.line;
  }

  /** 栈中是否压着带未保存修改的文件（关窗检查用） */
  function navStackHasDirty(win: FileWindowState): boolean {
    return win.navStack.some((e) => e.editContent !== e.content);
  }

  function closeWindow(id: string) {
    const idx = windows.value.findIndex((w) => w.id === id);
    if (idx === -1) return;
    const url = blobUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      blobUrls.delete(id);
    }
    windows.value.splice(idx, 1);
    if (focusedId.value === id) focusedId.value = null;
    if (gotoOwnerId.value === id) gotoOwnerId.value = null;
  }

  function focusWindow(id: string) {
    focusedId.value = id;
  }

  /** 回到平铺全览 */
  function unfocus() {
    focusedId.value = null;
  }

  async function save(id: string) {
    const win = windows.value.find((w) => w.id === id);
    if (!win || win.readonly || win.saving) return;
    win.saving = true;
    try {
      await api.writeFileContent(win.filePath, win.editContent);
      win.content = win.editContent;
      // 增量更新 codegraph 索引（best-effort，绝不阻断保存主流程）。
      // 后端返回结构化状态：更新成功 / 被跳过（带原因）/ 失败。
      // 反馈分流：
      //   · reindexed:true        → 轻量提示「索引已更新」(~1.5s 自消失，不进通知中心)
      //   · skipped:embed_not_ready → 进通知中心（语义搜索不可用，需用户知晓）
      //   · skipped:no_active_index / not_in_project → 静默（文件不在索引范围，常态）
      //   · reject (失败)         → 进通知中心（error）
      if (projectRoot.value) {
        api
          .codegraphReindexFile(projectRoot.value, win.filePath)
          .then((r) => {
            if (!r) return;
            if (r.reindexed) {
              console.info(`[codegraph] 保存已增量更新索引：${win.filePath}`);
              showIndexHint(win.id);
            } else if (r.skipped === "embed_not_ready") {
              console.info(`[codegraph] 保存未触发索引更新（embed_not_ready）：${win.filePath}`);
              pushNotification({
                severity: "warning",
                source: "codegraph",
                title: "语义索引未就绪",
                body: "保存时未更新语义索引：embed 尚未完成（后台构建中 / embedder 早停）。结构层精确跳转仍可用。",
                timestamp: Date.now(),
                dedupKey: `codegraph:save:embed_not_ready:${projectRoot.value}`,
              });
            } else if (r.skipped) {
              console.info(`[codegraph] 保存未触发索引更新（${r.skipped}）：${win.filePath}`);
            }
          })
          .catch((e) => {
            console.warn(`[codegraph] 保存增量更新失败：${win.filePath}`, e);
            pushNotification({
              severity: "error",
              source: "codegraph",
              title: "保存更新索引失败",
              body: `${win.fileName}: ${String(e)}`,
              timestamp: Date.now(),
              dedupKey: `codegraph:save:err:${win.filePath}`,
            });
          });
      }
    } catch (e) {
      win.error = String(e);
    }
    win.saving = false;
  }

  /** 仅测试用 */
  function __resetForTest() {
    for (const w of [...windows.value]) closeWindow(w.id);
    projectRoot.value = "";
    gotoOwnerId.value = null;
    if (indexHintTimer) {
      clearTimeout(indexHintTimer);
      indexHintTimer = null;
    }
    indexHintWinId.value = null;
    useCodeGraphProgress().__resetForTest();
  }

  return {
    // 窗口对象需要被组件层直接改（编辑器 v-model / mdMode 切换），不包 readonly
    windows,
    focusedId: readonly(focusedId),
    projectRoot: readonly(projectRoot),
    gotoOwnerId,
    /** 当前显示「索引已更新」提示的窗口 id（null = 无）；FileWindow 按 win.id 匹配渲染 */
    indexHintWinId: readonly(indexHintWinId),
    /** 在文件树中定位文件路径信号：FileWindow 写入 → App.vue 消费 */
    revealInTreePath,
    open,
    openAndScrollTo,
    navigateInPlace,
    navigateBack,
    navStackHasDirty,
    closeWindow,
    focusWindow,
    unfocus,
    save,
    __resetForTest,
  };
}
