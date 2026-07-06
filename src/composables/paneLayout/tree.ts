/**
 * 聊天区分屏布局树 —— 纯数据结构与操作，不依赖 Vue / Tauri。
 *
 * 结构（VS Code 编辑器组语义）：
 *   PaneNode = SplitNode（某方向的一排孩子） | GroupNode（tab 组，承载会话面板）
 *
 * 所有导出操作维持以下不变量（normalize 强制成立，单测覆盖）：
 *   1. 无空组（组内 tab 清空 → 从父 split 摘除，尺寸并入兄弟）
 *   2. 无单孩子 split（拍平提升孩子）
 *   3. 无嵌套同方向 split（并入父级成多孩子 split，同 VS Code）
 *   4. sizes 与 children 等长且和为 1
 *   5. activeTabId / previewTabId 永远指向组内存在的 tab（或 null）
 *
 * 可能替换根节点的操作一律返回新根，由调用方（usePaneLayout）写回。
 */

export type Direction = "horizontal" | "vertical";

export interface TabItem {
  /** tab 自身 id，与 session id 无关 */
  id: string;
  /** null = 空白「新建会话」面板（尚未派发过消息） */
  sessionId: string | null;
  /** 空白面板预起的名字，等 SDK 确认真实 id 后由 App.vue 取走用于落盘 */
  pendingName?: string;
}

export interface GroupNode {
  type: "group";
  id: string;
  tabs: TabItem[];
  activeTabId: string | null;
  /** 本组的预览 tab（至多一个）：未启动会话/空白面板共用，会被下一次预览打开覆盖 */
  previewTabId: string | null;
}

export interface SplitNode {
  type: "split";
  id: string;
  /** horizontal = 孩子左右并排；vertical = 上下排列 */
  direction: Direction;
  children: PaneNode[];
  /** 与 children 等长的比例值，和为 1 */
  sizes: number[];
}

export type PaneNode = GroupNode | SplitNode;

export function newId(): string {
  return crypto.randomUUID();
}

export function createTab(sessionId: string | null, pendingName?: string): TabItem {
  return { id: newId(), sessionId, ...(pendingName !== undefined ? { pendingName } : {}) };
}

export function createGroup(tabs: TabItem[] = []): GroupNode {
  return {
    type: "group",
    id: newId(),
    tabs,
    activeTabId: tabs.length ? tabs[tabs.length - 1].id : null,
    previewTabId: null,
  };
}

/** 初始/兜底布局：单组 + 一个空白预览 tab（与旧版「空白可输入面板」等价）。 */
export function createBlankRoot(pendingName?: string): GroupNode {
  const tab = createTab(null, pendingName);
  const g = createGroup([tab]);
  g.previewTabId = tab.id;
  return g;
}

// ── 查找 ─────────────────────────────────────────────────────────────────────

/** 视觉顺序（先序遍历）罗列所有组。 */
export function listGroups(root: PaneNode): GroupNode[] {
  const out: GroupNode[] = [];
  const walk = (n: PaneNode) => {
    if (n.type === "group") out.push(n);
    else n.children.forEach(walk);
  };
  walk(root);
  return out;
}

export function findGroup(root: PaneNode, groupId: string): GroupNode | null {
  return listGroups(root).find((g) => g.id === groupId) ?? null;
}

export function findSplit(root: PaneNode, splitId: string): SplitNode | null {
  let found: SplitNode | null = null;
  const walk = (n: PaneNode) => {
    if (found || n.type !== "split") return;
    if (n.id === splitId) { found = n; return; }
    n.children.forEach(walk);
  };
  walk(root);
  return found;
}

export interface TabHit {
  group: GroupNode;
  tab: TabItem;
}

export function findTabBySession(root: PaneNode, sessionId: string): TabHit | null {
  for (const group of listGroups(root)) {
    const tab = group.tabs.find((t) => t.sessionId === sessionId);
    if (tab) return { group, tab };
  }
  return null;
}

export function findTabById(root: PaneNode, tabId: string): TabHit | null {
  for (const group of listGroups(root)) {
    const tab = group.tabs.find((t) => t.id === tabId);
    if (tab) return { group, tab };
  }
  return null;
}

// ── 规范化 ───────────────────────────────────────────────────────────────────

function fixGroupRefs(g: GroupNode) {
  if (g.activeTabId && !g.tabs.some((t) => t.id === g.activeTabId)) {
    g.activeTabId = g.tabs.length ? g.tabs[g.tabs.length - 1].id : null;
  }
  if (!g.activeTabId && g.tabs.length) g.activeTabId = g.tabs[0].id;
  if (g.previewTabId && !g.tabs.some((t) => t.id === g.previewTabId)) {
    g.previewTabId = null;
  }
}

function normalizeSizes(sizes: number[], count: number): number[] {
  let s = sizes.slice(0, count);
  while (s.length < count) s.push(1 / Math.max(count, 1));
  const valid = s.every((v) => typeof v === "number" && isFinite(v) && v > 0);
  if (!valid) return new Array(count).fill(1 / count);
  const sum = s.reduce((a, b) => a + b, 0);
  return sum > 0 ? s.map((v) => v / sum) : new Array(count).fill(1 / count);
}

/**
 * 递归规范化。空组剔除、单孩子 split 拍平、同方向嵌套并入、尺寸归一、组内引用修复。
 * 整棵树空了返回 null（调用方兜底 createBlankRoot）。
 */
export function normalize(node: PaneNode): PaneNode | null {
  if (node.type === "group") {
    if (node.tabs.length === 0) return null;
    fixGroupRefs(node);
    return node;
  }
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const n = normalize(child);
    if (!n) return;
    const size = node.sizes[i] ?? 0;
    if (n.type === "split" && n.direction === node.direction) {
      // 同方向嵌套：孩子的孩子按其占比并入本级
      n.children.forEach((gc, j) => {
        children.push(gc);
        sizes.push(size * (n.sizes[j] ?? 0));
      });
    } else {
      children.push(n);
      sizes.push(size);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  node.children = children;
  node.sizes = normalizeSizes(sizes, children.length);
  return node;
}

// ── 变更操作（可能换根，一律返回新根） ────────────────────────────────────────

/** 关掉一个 tab。被关的是激活 tab 时激活相邻 tab（右邻优先）。 */
export function removeTab(root: PaneNode, groupId: string, tabId: string): PaneNode | null {
  const group = findGroup(root, groupId);
  if (!group) return normalize(root);
  const idx = group.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return normalize(root);
  group.tabs.splice(idx, 1);
  if (group.previewTabId === tabId) group.previewTabId = null;
  if (group.activeTabId === tabId) {
    const next = group.tabs[idx] ?? group.tabs[idx - 1];
    group.activeTabId = next ? next.id : null;
  }
  return normalize(root);
}

/**
 * 把组所在位置切分出一个新组。
 *
 * moveActiveTab = true（tab 右键「拆分」）：组内 ≥2 个 tab 时把激活 tab 移入新组；
 * 只有 1 个 tab 时移走会让旧组变空、normalize 又把 split 拍平（等于白拆），改为
 * 给新组放一个空白预览 tab（拆出一块地方开新会话，语义上仍然有用）。
 *
 * moveActiveTab = false（侧栏「在分屏中打开」）：新组建成空组返回，**调用方必须
 * 立刻塞入一个 tab**（否则违反无空组不变量）——这一约束不跨越 usePaneLayout 边界。
 *
 * 父 split 同方向时直接在旁边插一列（新组分走原组一半宽度），否则原地替换成
 * 二孩子 split。返回可能更换的新根与新组。
 */
export function splitGroup(
  root: PaneNode,
  groupId: string,
  direction: Direction,
  moveActiveTab: boolean,
): { root: PaneNode; newGroup: GroupNode } | null {
  const group = findGroup(root, groupId);
  if (!group) return null;

  const newGroup = createGroup([]);
  if (moveActiveTab) {
    const active = group.tabs.find((t) => t.id === group.activeTabId);
    if (group.tabs.length >= 2 && active) {
      group.tabs = group.tabs.filter((t) => t.id !== active.id);
      if (group.previewTabId === active.id) group.previewTabId = null;
      fixGroupRefs(group);
      newGroup.tabs = [active];
      newGroup.activeTabId = active.id;
    } else {
      const blank = createTab(null);
      newGroup.tabs = [blank];
      newGroup.activeTabId = blank.id;
      newGroup.previewTabId = blank.id;
    }
  }

  const parent = findParentSplit(root, groupId);
  if (parent && parent.direction === direction) {
    const i = parent.children.findIndex((c) => c.id === groupId);
    const half = (parent.sizes[i] ?? 1 / parent.children.length) / 2;
    parent.sizes[i] = half;
    parent.children.splice(i + 1, 0, newGroup);
    parent.sizes.splice(i + 1, 0, half);
    return { root, newGroup };
  }

  const split: SplitNode = {
    type: "split",
    id: newId(),
    direction,
    children: [group, newGroup],
    sizes: [0.5, 0.5],
  };
  if (root === group) return { root: split, newGroup };
  replaceChild(root, groupId, split);
  return { root, newGroup };
}

function findParentSplit(root: PaneNode, childId: string): SplitNode | null {
  if (root.type !== "split") return null;
  if (root.children.some((c) => c.id === childId)) return root;
  for (const c of root.children) {
    const p = findParentSplit(c, childId);
    if (p) return p;
  }
  return null;
}

function replaceChild(root: PaneNode, childId: string, replacement: PaneNode) {
  const parent = findParentSplit(root, childId);
  if (!parent) return;
  const i = parent.children.findIndex((c) => c.id === childId);
  if (i !== -1) parent.children.splice(i, 1, replacement);
}

/** 分隔条拖拽写回：数量不符或非法值一律忽略（防御式）。 */
export function setSplitSizes(root: PaneNode, splitId: string, sizes: number[]): void {
  const split = findSplit(root, splitId);
  if (!split || sizes.length !== split.children.length) return;
  split.sizes = normalizeSizes(sizes, split.children.length);
}

// ── 持久化快照（v2）──────────────────────────────────────────────────────────
// 只存会话引用与结构：空白 tab、pendingName、预览标记、运行时 id 都不入快照。
// activeTab / focusedGroup 用索引表达，restore 时重建全部 id。
// v2 起每个 tab 附带会话名与工作区归属（混合 tab 布局：恢复时不依赖侧栏
// 懒加载就能显示名字/工作区后缀、校验会话存在性、给 sidecar 传正确 cwd）。

export interface SnapshotTab {
  sessionId: string;
  /** 会话显示名快照（恢复后作为注册表种子，侧栏加载后会覆盖为权威值） */
  name?: string;
  /** 所属工作区（编码 key + 根路径）；缺省 = 恢复时视为当前工作区 */
  wsKey?: string;
  wsPath?: string;
}

export interface SnapshotGroup {
  type: "group";
  tabs: SnapshotTab[];
  /** 激活 tab 在 tabs 里的下标 */
  active: number;
}

/** 序列化时由调用方注入的会话元信息解析器（名字/工作区来自模块级注册表） */
export type SessionMetaResolver = (sessionId: string) => Omit<SnapshotTab, "sessionId">;

export interface SnapshotSplit {
  type: "split";
  direction: Direction;
  sizes: number[];
  children: SnapshotNode[];
}

export type SnapshotNode = SnapshotGroup | SnapshotSplit;

export interface LayoutSnapshot {
  version: 2;
  root: SnapshotNode;
  /** 聚焦组在 listGroups 视觉序中的下标 */
  focusedGroup: number;
}

/** 序列化。剔除空白 tab 后整棵树没有任何会话 → 返回 null（无须持久化）。 */
export function toSnapshot(
  root: PaneNode,
  focusedGroupId: string,
  resolveMeta: SessionMetaResolver = () => ({}),
): LayoutSnapshot | null {
  const snap = (n: PaneNode): SnapshotNode | null => {
    if (n.type === "group") {
      const tabs = n.tabs.filter((t) => t.sessionId !== null);
      if (tabs.length === 0) return null;
      const activeIdx = tabs.findIndex((t) => t.id === n.activeTabId);
      return {
        type: "group",
        tabs: tabs.map((t) => ({ sessionId: t.sessionId as string, ...resolveMeta(t.sessionId as string) })),
        active: activeIdx === -1 ? tabs.length - 1 : activeIdx,
      };
    }
    const children: SnapshotNode[] = [];
    const sizes: number[] = [];
    n.children.forEach((c, i) => {
      const s = snap(c);
      if (s) {
        children.push(s);
        sizes.push(n.sizes[i] ?? 0);
      }
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { type: "split", direction: n.direction, sizes: normalizeSizes(sizes, children.length), children };
  };
  const snapRoot = snap(root);
  if (!snapRoot) return null;
  const focusedGroup = Math.max(0, listGroups(root).findIndex((g) => g.id === focusedGroupId));
  return { version: 2, root: snapRoot, focusedGroup };
}

const MAX_SNAPSHOT_DEPTH = 32;

/** 结构校验：任何字段缺失/类型不符/超深/空孩子 → null（调用方回退空白布局）。
 *  只认 v2；v1（按工作区分份的旧格式）直接作废，回退空白布局。 */
export function parseSnapshot(v: unknown): LayoutSnapshot | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o["version"] !== 2) return null;
  const focusedGroup = o["focusedGroup"];
  if (typeof focusedGroup !== "number" || !Number.isInteger(focusedGroup) || focusedGroup < 0) return null;
  const root = parseNode(o["root"], 0);
  if (!root) return null;
  return { version: 2, root, focusedGroup };
}

function parseSnapshotTab(v: unknown): SnapshotTab | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const sessionId = o["sessionId"];
  if (typeof sessionId !== "string" || !sessionId) return null;
  const tab: SnapshotTab = { sessionId };
  if (typeof o["name"] === "string") tab.name = o["name"];
  if (typeof o["wsKey"] === "string") tab.wsKey = o["wsKey"];
  if (typeof o["wsPath"] === "string") tab.wsPath = o["wsPath"];
  return tab;
}

function parseNode(v: unknown, depth: number): SnapshotNode | null {
  if (depth > MAX_SNAPSHOT_DEPTH) return null;
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o["type"] === "group") {
    const rawTabs = o["tabs"];
    if (!Array.isArray(rawTabs) || rawTabs.length === 0) return null;
    const tabs: SnapshotTab[] = [];
    for (const t of rawTabs) {
      const parsed = parseSnapshotTab(t);
      if (!parsed) return null;
      tabs.push(parsed);
    }
    const active = o["active"];
    if (typeof active !== "number" || !Number.isInteger(active)) return null;
    return { type: "group", tabs, active };
  }
  if (o["type"] === "split") {
    const dir = o["direction"];
    if (dir !== "horizontal" && dir !== "vertical") return null;
    const children = o["children"];
    if (!Array.isArray(children) || children.length < 2) return null;
    const parsed: SnapshotNode[] = [];
    for (const c of children) {
      const p = parseNode(c, depth + 1);
      if (!p) return null;
      parsed.push(p);
    }
    const sizes = Array.isArray(o["sizes"]) ? (o["sizes"] as unknown[]) : [];
    return {
      type: "split",
      direction: dir,
      sizes: normalizeSizes(sizes.map((s) => (typeof s === "number" ? s : 0)), parsed.length),
      children: parsed,
    };
  }
  return null;
}

/**
 * 从快照重建布局树。
 * - validSessionIds 提供时剔除已不存在的会话 tab（未提供 = 校验不可用，保守全保留）
 * - 同一会话出现两次时保首个（全局唯一不变量）
 * - 恢复出来的 tab 一律非预览（上次留下的布局即固定布局）
 * - 剔除后整棵树空了 → 返回 null（调用方回退空白布局）
 */
export function restoreSnapshot(
  snapshot: LayoutSnapshot,
  validSessionIds?: ReadonlySet<string>,
): { root: PaneNode; focusedGroupId: string } | null {
  const seen = new Set<string>();
  const build = (n: SnapshotNode): PaneNode => {
    if (n.type === "group") {
      const kept: TabItem[] = [];
      let activeId: string | null = null;
      n.tabs.forEach((t, i) => {
        if (seen.has(t.sessionId)) return;
        if (validSessionIds && !validSessionIds.has(t.sessionId)) return;
        seen.add(t.sessionId);
        const tab = createTab(t.sessionId);
        kept.push(tab);
        if (i === n.active) activeId = tab.id;
      });
      const g = createGroup(kept);
      if (activeId) g.activeTabId = activeId;
      return g;
    }
    return {
      type: "split",
      id: newId(),
      direction: n.direction,
      children: n.children.map(build),
      sizes: n.sizes.slice(),
    };
  };
  const root = normalize(build(snapshot.root));
  if (!root) return null;
  const groups = listGroups(root);
  const focused = groups[Math.min(snapshot.focusedGroup, groups.length - 1)];
  return { root, focusedGroupId: focused.id };
}

/** 平铺列出快照里的全部 tab（注册表 seed / 按工作区校验用）。 */
export function listSnapshotTabs(snapshot: LayoutSnapshot): SnapshotTab[] {
  const out: SnapshotTab[] = [];
  const walk = (n: SnapshotNode) => {
    if (n.type === "group") out.push(...n.tabs);
    else n.children.forEach(walk);
  };
  walk(snapshot.root);
  return out;
}
