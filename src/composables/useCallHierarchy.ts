import { computed, ref } from "vue";
import { api } from "../api";
import { useFileViewer } from "./useFileViewer";
import type { CallHierarchyDirection, CallHierarchyNode, JumpStatus } from "../types";

/**
 * 调用层级（callHierarchy）状态层 —— 模块级单例。
 *
 * 触发点在编辑器深处（PaneGroup→FileWindow→CodeEditor 的 gutter ⇄ 标记），面板挂在
 * App 右侧栏，跨组件树通信走本单例（同 useFileResolver 模式）。App.vue watch 根变化
 * 切到面板 tab；面板用 v-show 保活，切走再切回树状态不丢。
 *
 * 数据流：openHierarchy 设根查询点 → lsp_call_hierarchy（prepare + 第一层）→
 * 展开下一层 = 递归同一命令（查询点 = 子节点声明位置）。epoch 自增丢弃换根/换向/
 * 重试路上的旧响应（展开请求并发多个，各自捕获 epoch 比较）。
 */

// ── 模块单例状态 ──
const root = ref<CallHierarchyNode | null>(null);
/** 根符号名兜底（prepare 失败时显示 gutter 点击的词；成功后被 root.name 覆盖） */
const rootWord = ref("");
const rootQuery = ref<{
  workspaceRoot: string;
  filePath: string;
  line: number;
  column: number;
} | null>(null);
const direction = ref<CallHierarchyDirection>("incoming");
/** 第一层节点（根的直接调用方/被调用方） */
const firstLevel = ref<CallHierarchyNode[]>([]);
const loadingRoot = ref(false);
/** 根查询终态（null=查询中）；expand 失败单独走 expandFailKeys */
const rootStatus = ref<JumpStatus | null>(null);

/** nodeKey → 下一层节点（展开缓存：收起再展开不重查；换根/换向清空） */
const childrenByNode = ref<Map<string, CallHierarchyNode[]>>(new Map());
const expandedKeys = ref<Set<string>>(new Set());
const expandingKeys = ref<Set<string>>(new Set());
/** nodeKey → 展开查询失败（timeout/not_ready/gone/异常）：显示重试行而非「链到此为止」 */
const expandFailKeys = ref<Set<string>>(new Set());

/** 世代号：openHierarchy/setDirection/retry/clear 时自增；进行中的查询据此丢弃旧响应 */
let epoch = 0;

/** 节点唯一键 = 声明位置（file:line:column）。递归环（A→B→A）同键命中同一份缓存，UI 层过滤。 */
export function callNodeKey(n: CallHierarchyNode): string {
  return `${n.file}:${n.line}:${n.column}`;
}

export function useCallHierarchy() {
  const viewer = useFileViewer();

  function resetExpansion() {
    childrenByNode.value = new Map();
    expandedKeys.value = new Set();
    expandingKeys.value = new Set();
    expandFailKeys.value = new Set();
  }

  /** 查第一层（prepare + incoming/outgoing）。rootStatus 记录终态供面板渲染提示。 */
  async function queryFirstLevel() {
    const q = rootQuery.value;
    if (!q) return;
    const myEpoch = epoch;
    loadingRoot.value = true;
    rootStatus.value = null;
    firstLevel.value = [];
    try {
      const res = await api.lspCallHierarchy(
        q.workspaceRoot, q.filePath, q.line, q.column, direction.value,
      );
      if (myEpoch !== epoch) return;
      rootStatus.value = res.status;
      if (res.root) {
        root.value = res.root;
        rootWord.value = res.root.name;
      }
      firstLevel.value = res.status === "ok" ? res.nodes : [];
    } catch {
      if (myEpoch !== epoch) return;
      // invoke 通道异常（序列化/通道断）按「未就绪」展示，面板提示稍后重试
      rootStatus.value = "not_ready";
      firstLevel.value = [];
    } finally {
      if (myEpoch === epoch) loadingRoot.value = false;
    }
  }

  /** gutter ⇄ 点击入口：设根并查第一层。 */
  async function openHierarchy(params: {
    workspaceRoot: string;
    filePath: string;
    line: number;
    column: number;
    word: string;
  }) {
    rootQuery.value = params;
    rootWord.value = params.word;
    root.value = null;
    epoch++;
    resetExpansion();
    await queryFirstLevel();
  }

  /** 方向切换：incoming ⇄ outgoing。保持根不变，清展开重查第一层。 */
  async function setDirection(dir: CallHierarchyDirection) {
    if (direction.value === dir) return;
    direction.value = dir;
    if (!rootQuery.value) return;
    epoch++;
    resetExpansion();
    await queryFirstLevel();
  }

  /** timeout/not_ready 后手动重试。 */
  async function retry() {
    if (!rootQuery.value) return;
    epoch++;
    resetExpansion();
    await queryFirstLevel();
  }

  /** 展开/收起节点。首次展开懒加载（查询点 = 该节点声明位置，方向同当前）；
   *  缓存命中直接展开；失败记 expandFailKeys 显示重试。 */
  async function toggleNode(node: CallHierarchyNode) {
    const key = callNodeKey(node);
    if (expandedKeys.value.has(key)) {
      const next = new Set(expandedKeys.value);
      next.delete(key);
      expandedKeys.value = next;
      return;
    }
    if (childrenByNode.value.has(key)) {
      const next = new Set(expandedKeys.value);
      next.add(key);
      expandedKeys.value = next;
      return;
    }
    const q = rootQuery.value;
    if (!q) return;
    const myEpoch = epoch;
    const nextExpanding = new Set(expandingKeys.value);
    nextExpanding.add(key);
    expandingKeys.value = nextExpanding;
    try {
      // node.file 相对工作区（后端 resolve_file_uri 兜底拼接）；跨工作区为绝对路径直接可用
      const res = await api.lspCallHierarchy(
        q.workspaceRoot, node.file, node.line, node.column, direction.value,
      );
      if (myEpoch !== epoch) return;
      const nextChildren = new Map(childrenByNode.value);
      nextChildren.set(key, res.status === "ok" ? res.nodes : []);
      childrenByNode.value = nextChildren;
      if (res.status === "ok") {
        const next = new Set(expandedKeys.value);
        next.add(key);
        expandedKeys.value = next;
      } else {
        const nextFails = new Set(expandFailKeys.value);
        nextFails.add(key);
        expandFailKeys.value = nextFails;
      }
    } catch {
      if (myEpoch !== epoch) return;
      const nextChildren = new Map(childrenByNode.value);
      nextChildren.set(key, []);
      childrenByNode.value = nextChildren;
      const nextFails = new Set(expandFailKeys.value);
      nextFails.add(key);
      expandFailKeys.value = nextFails;
    } finally {
      if (myEpoch === epoch) {
        const nextExpanding = new Set(expandingKeys.value);
        nextExpanding.delete(key);
        expandingKeys.value = nextExpanding;
      }
    }
  }

  /** 失败节点的重试（清失败标记后重新展开）。 */
  async function retryNode(node: CallHierarchyNode) {
    const key = callNodeKey(node);
    const nextFails = new Set(expandFailKeys.value);
    nextFails.delete(key);
    expandFailKeys.value = nextFails;
    const nextChildren = new Map(childrenByNode.value);
    nextChildren.delete(key);
    childrenByNode.value = nextChildren;
    await toggleNode(node);
  }

  /** 相对路径 → 绝对（与 FileWindow.jumpToResult 同规则：绝对直接用，相对拼 root）。 */
  function absOf(file: string): string | null {
    const q = rootQuery.value;
    if (!q) return null;
    const sep = q.workspaceRoot.includes("\\") ? "\\" : "/";
    const norm = file.replace(/[\\/]/g, sep);
    const isAbs = /^[A-Za-z]:[\\/]/.test(norm) || /^[\\/]/.test(norm);
    return isAbs ? norm : q.workspaceRoot + sep + norm;
  }

  /** 点节点主体 → 跳到声明处（跨文件由 openAndScrollTo 先打开）。 */
  async function jumpToNode(node: CallHierarchyNode) {
    const abs = absOf(node.file);
    if (abs) await viewer.openAndScrollTo(abs, node.line, 3);
  }

  /** 点调用点子行（fromRanges）→ 跳到该调用处。 */
  async function jumpToSite(node: CallHierarchyNode, siteLine: number, siteColumn: number) {
    const abs = absOf(node.file);
    if (abs) await viewer.openAndScrollTo(abs, siteLine, 3);
  }

  function clear() {
    epoch++;
    root.value = null;
    rootWord.value = "";
    rootQuery.value = null;
    firstLevel.value = [];
    loadingRoot.value = false;
    rootStatus.value = null;
    resetExpansion();
  }

  return {
    root: computed(() => root.value),
    rootWord: computed(() => rootWord.value),
    rootQuery: computed(() => rootQuery.value),
    direction: computed(() => direction.value),
    firstLevel: computed(() => firstLevel.value),
    loadingRoot: computed(() => loadingRoot.value),
    rootStatus: computed(() => rootStatus.value),
    childrenByNode: computed(() => childrenByNode.value),
    expandedKeys: computed(() => expandedKeys.value),
    expandingKeys: computed(() => expandingKeys.value),
    expandFailKeys: computed(() => expandFailKeys.value),
    openHierarchy,
    setDirection,
    toggleNode,
    retry,
    retryNode,
    jumpToNode,
    jumpToSite,
    clear,
  };
}

/** 测试复位（仅测试用）。 */
export function __resetCallHierarchyForTest() {
  epoch++;
  root.value = null;
  rootWord.value = "";
  rootQuery.value = null;
  direction.value = "incoming";
  firstLevel.value = [];
  loadingRoot.value = false;
  rootStatus.value = null;
  childrenByNode.value = new Map();
  expandedKeys.value = new Set();
  expandingKeys.value = new Set();
  expandFailKeys.value = new Set();
}
