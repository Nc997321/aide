import { ref, readonly } from "vue";
import { api } from "../api";
import { useRecent } from "./useRecent";
import { useCodeGraphProgress } from "./useCodeGraphProgress";
import { useNotifications } from "./useNotifications";
import { imageMimeFromPath } from "../utils/imageMime";

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

export interface FileWindowState {
  id: string;
  filePath: string;
  fileName: string;
  /** 磁盘内容基线——保存成功后同步，用于 dirty 判定 */
  content: string;
  /** 编辑器实时内容 */
  editContent: string;
  imageUrl: string;
  /** 显式注入的语言标识（如 "diff"），空串走扩展名推断 */
  language: string;
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
  /** 窗口几何（px，视口坐标）——自动平铺由 FileViewer 层计算，拖拽直接改 x/y */
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_EDITABLE_SIZE = 1_000_000;

// ── 模块级单例状态 ──
const windows = ref<FileWindowState[]>([]);
/** 聚焦窗口：恢复默认弹窗大小居中，其余缩进底部小条；null = 平铺全览 */
const focusedId = ref<string | null>(null);
const projectRoot = ref("");
/** goto-definition 浮层归属的窗口（useGotoDefinition 是单例，浮层只在触发它的窗口里渲染） */
const gotoOwnerId = ref<string | null>(null);

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

export function useFileViewer() {
  /**
   * 打开文件。同一磁盘路径已开着 → 聚焦已有窗口（文件树重复点击不产生副本）；
   * 注入内容的虚拟视图（git diff）同路径重开 → 原窗口内容就地刷新。
   * 新窗口加入平铺全览（取消聚焦），窗口随数量增多平均变小。
   */
  async function open(path: string, opts?: { content?: string; language?: string }) {
    const isVirtual = opts?.content !== undefined;
    const existing = windows.value.find((w) => w.filePath === path && w.virtual === isVirtual);
    if (existing) {
      if (isVirtual) {
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
      error: "",
      saving: false,
      readonly: isVirtual,
      virtual: isVirtual,
      isMarkdown: !isVirtual && isMarkdownPath(path),
      // Markdown 默认全预览，编辑/分屏由用户按需切
      mdMode: "preview",
      scrollToLine: null,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    };

    if (isVirtual) {
      win.content = opts!.content!;
      win.editContent = win.content;
    } else {
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
    open,
    openAndScrollTo,
    closeWindow,
    focusWindow,
    unfocus,
    save,
    __resetForTest,
  };
}
