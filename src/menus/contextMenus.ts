import type { MenuItem } from "../composables/useContextMenu";
import { useModal } from "../composables/useModal";
import { useFileViewer } from "../composables/useFileViewer";
import { useFileClipboard } from "../composables/useFileClipboard";
import { usePaneLayout } from "../composables/usePaneLayout";
import { useMentionInserter } from "../composables/useMentionInserter";
import { api } from "../api";

function sep(): MenuItem {
  return { label: "", separator: true };
}

const modal = useModal();
const cb = useFileClipboard();
const mentionInserter = useMentionInserter();

// ── File context menu ──

export function fileMenuItems(
  path: string,
  projectRoot: string,
  onDeleted?: () => void,
): MenuItem[] {
  const fileName = path.split(/[/\\]/).pop() || path;
  const viewer = useFileViewer();
  return [
    { label: "查看/编辑", action: () => viewer.open(path) },
    { label: "其他方式打开", action: () => api.fileOpen(path) },
    { label: "在文件资源管理器中打开", action: () => api.showInExplorer(path) },
    { label: "复制路径", action: () => navigator.clipboard.writeText(path) },
    {
      label: "复制相对路径",
      action: () => {
        const rel = path.startsWith(projectRoot)
          ? path.slice(projectRoot.length).replace(/^[/\\]/, "")
          : path;
        navigator.clipboard.writeText(rel);
      },
    },
    sep(),
    {
      label: "重命名",
      action: async () => {
        const newName = await modal.prompt("重命名文件", `「${fileName}」的新名称`, "重命名");
        if (!newName || newName === fileName) return;
        const newPath = path.slice(0, path.length - fileName.length) + newName;
        await api.moveFile(path, newPath);
        onDeleted?.();
      },
    },
    { label: "添加到对话", action: () => mentionInserter.insertMention(path, false) },
    // 文件语义复制/剪切（= Ctrl+C/X）：应用内 + 系统剪贴板双写
    { label: "复制", action: () => cb.copyWithOs([path]) },
    { label: "剪切", action: () => cb.cutWithOs([path]) },
    sep(),
    {
      label: "删除",
      danger: true,
      action: async () => {
        const ok = await modal.confirm("删除文件", `确定要删除「${fileName}」吗？`, "删除", true);
        if (!ok) return;
        await api.deleteFile(path);
        onDeleted?.();
      },
    },
  ];
}

// ── Directory context menu ──

export function directoryMenuItems(
  path: string,
  projectRoot: string,
  callbacks: {
    onToggle?: () => void;
    onRefresh?: () => void;
    onDeleted?: () => void;
    /** 粘贴时刷新「剪切源」所在目录（不同于本目录的 onRefresh） */
    refreshDir?: (dirPath: string) => void;
  },
): MenuItem[] {
  const { onToggle, onRefresh, onDeleted, refreshDir } = callbacks;
  const dirName = path.split(/[/\\]/).pop() || path;
  return [
    { label: "展开/折叠", action: onToggle },
    { label: "在文件资源管理器中打开", action: () => api.showInExplorer(path) },
    { label: "复制路径", action: () => navigator.clipboard.writeText(path) },
    {
      label: "重命名",
      action: async () => {
        const newName = await modal.prompt("重命名文件夹", `「${dirName}」的新名称`, "重命名");
        if (!newName || newName === dirName) return;
        const newPath = path.slice(0, path.length - dirName.length) + newName;
        await api.moveFile(path, newPath);
        onDeleted?.();
      },
    },
    sep(),
    {
      label: "新建文件",
      action: async () => {
        const name = await modal.prompt("新建文件", "输入文件名...", "创建");
        if (!name) return;
        await api.createFile(path, name);
        onRefresh?.();
      },
    },
    {
      label: "新建文件夹",
      action: async () => {
        const name = await modal.prompt("新建文件夹", "输入文件夹名...", "创建");
        if (!name) return;
        await api.createDir(path, name);
        onRefresh?.();
      },
    },
    sep(),
    { label: "添加到对话", action: () => mentionInserter.insertMention(path, true) },
    // 根目录不可复制/剪切（同键盘路径的 root 拦截）
    ...(path !== projectRoot ? [
      { label: "复制", action: () => cb.copyWithOs([path]) },
      { label: "剪切", action: () => cb.cutWithOs([path]) },
    ] : []),
    {
      // 粘贴常驻：应用内剪贴板无条目时兜底读系统剪贴板（与 Ctrl+V 同源）
      label: "粘贴",
      action: async () => {
        const entry = await cb.resolvePasteEntry();
        if (!entry) {
          await modal.notice("剪贴板为空", "应用内和系统剪贴板都没有可粘贴的文件");
          return;
        }
        await cb.executePaste(path, {
          onSrcRefresh: (dirs) => {
            if (refreshDir) {
              dirs.forEach(refreshDir);
              return;
            }
            onRefresh?.();
          },
          onDestRefresh: () => onRefresh?.(),
        });
      },
    },
    sep(),
    {
      label: "删除",
      danger: true,
      action: async () => {
        const ok = await modal.confirm("删除文件夹", `确定要删除「${dirName}」及其所有内容吗？`, "删除", true);
        if (!ok) return;
        await api.deleteFile(path);
        onDeleted?.();
      },
    },
  ];
}

// ── File tree blank area ──

export function fileTreeAreaMenuItems(rootPath: string, onRefresh: () => void): MenuItem[] {
  const items: MenuItem[] = [
    { label: "刷新", action: onRefresh },
    sep(),
    {
      label: "新建文件",
      action: async () => {
        const name = await modal.prompt("新建文件", "输入文件名...", "创建");
        if (!name) return;
        await api.createFile(rootPath, name);
        onRefresh();
      },
    },
    {
      label: "新建文件夹",
      action: async () => {
        const name = await modal.prompt("新建文件夹", "输入文件夹名...", "创建");
        if (!name) return;
        await api.createDir(rootPath, name);
        onRefresh();
      },
    },
    // 粘贴进工作区根（应用内为空时兜底读系统剪贴板，与 Ctrl+V 同源）。
    // 区域菜单只有整树刷新可用，粘贴后的源/目标目录刷新统一走 onRefresh。
    {
      label: "粘贴",
      action: async () => {
        const entry = await cb.resolvePasteEntry();
        if (!entry) {
          await modal.notice("剪贴板为空", "应用内和系统剪贴板都没有可粘贴的文件");
          return;
        }
        await cb.executePaste(rootPath, { onSrcRefresh: () => onRefresh(), onDestRefresh: () => onRefresh() });
      },
    },
  ];
  // 索引维护（更新/全量重建）已迁右侧栏「代码索引」tab——菜单不再收口开关类操作。
  return items;
}

// ── Session context menu ──

export function sessionMenuItems(
  id: string,
  callbacks: {
    onRenamed: (name: string) => void;
    onOptimisticRemove: () => void;
    onDeleteFailed: () => void;
  },
): MenuItem[] {
  const { onRenamed, onOptimisticRemove, onDeleteFailed } = callbacks;
  const pane = usePaneLayout();
  return [
    // 混合 tab 布局：任意工作区的会话都可直接开 tab/分屏，cwd 跟会话归属走
    { label: "在新标签页打开", action: () => pane.openSessionInNewTab(id) },
    { label: "在右侧分屏打开", action: () => pane.openSessionInSplit(id, "horizontal") },
    { label: "在下方分屏打开", action: () => pane.openSessionInSplit(id, "vertical") },
    sep(),
    {
      label: "重命名",
      action: async () => {
        const name = await modal.prompt("重命名会话", "输入新名称...", "保存");
        if (name) onRenamed(name);
      },
    },
    sep(),
    {
      label: "删除",
      danger: true,
      action: async () => {
        const ok = await modal.confirm(
          "删除会话",
          "此操作将同时删除 Claude 原生的对话记录（.jsonl），无法通过 --resume 恢复。确定删除？",
          "删除",
          true,
        );
        if (!ok) return;
        // 乐观移除：确认后先把卡片从列表里拿掉（离场动画即刻开始），
        // 后台再真正删除；失败由 onDeleteFailed 回滚列表 + 报错。
        onOptimisticRemove();
        try {
          // 运行中的 sidecar 先杀掉，避免进程泄漏 & 删除后 jsonl 被重新写回
          await api.stopChatSession(id).catch(() => {});
          await api.deleteSession(id);
        } catch {
          onDeleteFailed();
          return;
        }
        void pane.closeSessionTab(id); // 分屏里开着的 tab 一并关掉（fire-and-forget）
      },
    },
  ];
}

// ── Sidebar section menu（侧栏分区导航行 ⋯ 菜单）──

/** 「会话」导航行 ⋯：新建入口从分区头 ＋ 按钮收进此处（右槽位 计数⇄⋯ 交互）。 */
export function sessionSectionMenuItems(onNewSession: () => void): MenuItem[] {
  return [{ label: "新建会话", kbd: "Ctrl+N", action: onNewSession }];
}

/** 「自动化」导航行 ⋯：同上，新建任务入口。 */
export function automationSectionMenuItems(onNewTask: () => void): MenuItem[] {
  return [{ label: "新建自动化任务", action: onNewTask }];
}

/** 「插件」导航行 ⋯：打开市场面板 + 刷新全部市场源。 */
export function marketplaceSectionMenuItems(
  onOpen: () => void,
  onRefreshAll: () => void,
): MenuItem[] {
  return [
    { label: "打开插件市场", action: onOpen },
    { label: "刷新全部市场源", action: onRefreshAll },
  ];
}

// ── Workspace context menu（侧栏工作区行右键/⋯ 共用） ──

export function workspaceMenuItems(
  ws: { key: string; name: string; missing: boolean },
  onActivate?: () => void,
  onRemove?: () => void,
  /** 仅不受信任工作区传入：菜单提供信任入口（行内已不放「不受信任」文字徽标） */
  onTrust?: () => void,
  /** 在该工作区新建会话（不改活动工作区）；缺省 = 不提供（目录丢失 / 远程登记的工作区） */
  onNewSession?: () => void,
): MenuItem[] {
  return [
    ...(onNewSession && !ws.missing ? [{ label: "新增会话", action: onNewSession }] : []),
    ...(ws.missing ? [] : [{ label: "切换到此工作区", action: () => onActivate?.() }]),
    ...(onTrust ? [{ label: "信任此工作区", warning: true, action: onTrust }] : []),
    { label: "在文件资源管理器中打开", action: () => api.showInExplorer(ws.name) },
    { label: "复制路径", action: () => navigator.clipboard.writeText(ws.name) },
    sep(),
    {
      label: "从列表移除…",
      danger: true,
      action: () => onRemove?.(),
    },
  ];
}

// ── 知识库：目录树与空间 ──
//
// 这两组菜单用 `ContextMenu.vue`（Teleport 到 body + fixed + 视口边缘翻转），
// 不是行内绝对定位的浮层——侧栏的段落是 `overflow: auto` 的，行内浮层会被**裁掉**。

/**
 * 知识库节点的 ⋯ 菜单：都是**对这个节点本身**的操作。
 *
 * 「新建」不在这里——它有自己的入口（分组标题旁与文件夹行上的 `+`），两边各开一个
 * 二选一菜单（见 `kbCreateItems`）。同一个动作留两个入口只会让人猜哪个才是对的。
 */
export function kbNodeMenuItems(
  node: { id: string; title: string },
  h: {
    onRename: (id: string, title: string) => void;
    onMove: (id: string) => void;
    onLink: (id: string) => void;
    onDelete: (id: string) => void;
  },
): MenuItem[] {
  return [
    { label: "重命名", action: () => h.onRename(node.id, node.title) },
    { label: "移动到…", action: () => h.onMove(node.id) },
    { label: "关联项目…", action: () => h.onLink(node.id) },
    sep(),
    { label: "删除", danger: true, action: () => h.onDelete(node.id) },
  ];
}

/**
 * 「新建」的二选一。挂两处：分组标题旁的 `+`（建在根），以及文件夹行上的 `+`
 * （建在该文件夹里）。
 *
 * ⚠️ 之前把「新建文件夹」锁在 ⋯ 菜单里、两个 `+` 写死新建文档，结果是**根目录
 * 根本建不出文件夹**——而这正是知识库这次要提供的能力。
 */
export function kbCreateItems(h: {
  onNewFolder: () => void;
  onNewDoc: () => void;
  onUpload: () => void;
}): MenuItem[] {
  return [
    { label: "新建文件夹", action: h.onNewFolder },
    { label: "新建文档", action: h.onNewDoc },
    // 上传和「新建」是同一类动作（都是往这个位置放东西），所以同一个入口。
    // 认哪些格式由服务端定（见 useKnowledgeBase.uploadFile），这里不做判断。
    { label: "上传文件…", action: h.onUpload },
  ];
}

/**
 * 「移动到…」的目标选择。
 *
 * `blocked` 里的项**置灰而不是隐藏**——隐藏会让人以为列表坏了，置灰能让他明白
 * 「这个不能选」（移进自己的子树会被服务端拒）。
 */
export function kbMoveMenuItems(
  folders: { id: string; label: string }[],
  blocked: ReadonlySet<string>,
  onPick: (parentId: string | null) => void,
): MenuItem[] {
  return [
    { label: "根目录", action: () => onPick(null) },
    ...folders.map((f) => ({
      label: f.label,
      disabled: blocked.has(f.id),
      action: () => onPick(f.id),
    })),
  ];
}

/**
 * 「关联项目…」的选择：列出本 Host 上的工作区，已关联的打勾，点一下切换。
 * 关联项目让 AI 改这篇文档（或这个文件夹下的文档）时能只读地参考那个项目的记忆。
 * `inherited` 是从祖先文件夹继承来的——显示但不可在这里取消（要取消得去那个文件夹上改），
 * 置灰并注明来源，别让人以为点了没反应是坏了。
 */
export function kbLinkMenuItems(
  projects: { key: string; label: string; linked: boolean; inheritedFrom?: string }[],
  onToggle: (key: string) => void,
): MenuItem[] {
  if (projects.length === 0) return [{ label: "还没有打开过的工作区", disabled: true }];
  return projects.map((p) => ({
    label: p.inheritedFrom ? `${p.label}（继承自「${p.inheritedFrom}」）` : p.label,
    icon: p.linked || p.inheritedFrom ? "✓" : "○",
    disabled: !!p.inheritedFrom && !p.linked,
    action: () => onToggle(p.key),
  }));
}

/** 知识库空间的 ⋯ 菜单。目前只有重命名——删除空间与改可见性改动面太大，没做。 */
export function kbSpaceMenuItems(onRename: () => void): MenuItem[] {
  return [{ label: "重命名", action: onRename }];
}

// ── Pane tab context menu（聊天区分屏组的 tab 右键） ──

export function paneTabMenuItems(groupId: string, tabId: string): MenuItem[] {
  const pane = usePaneLayout();
  return [
    { label: "向右拆分", action: () => pane.splitFocusedGroup("horizontal", groupId) },
    { label: "向下拆分", action: () => pane.splitFocusedGroup("vertical", groupId) },
    sep(),
    { label: "关闭", action: () => { void pane.closeTab(groupId, tabId); } },
    { label: "关闭其他", action: () => { void pane.closeOtherTabs(groupId, tabId); } },
  ];
}
