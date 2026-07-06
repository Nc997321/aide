import { reactive } from "vue";

/**
 * 会话 id → 所属工作区 的模块级注册表（与 useSessionNames 同构）。
 *
 * 混合 tab 布局下，会话可能来自任意工作区：sidecar 启动 cwd、tab 上的
 * 工作区后缀标识、快照校验都要靠它。写入方：SidebarLeft（加载会话列表时）、
 * App.vue（新会话创建时归属当前工作区）、布局快照恢复（seed）。
 */
export interface SessionWorkspaceInfo {
  /** 编码后的工作区 key（`~/.claude/projects/` 目录名） */
  wsKey: string;
  /** 工作区根路径（send_message 的 cwd） */
  wsPath: string;
}

const workspaces = reactive<Record<string, SessionWorkspaceInfo>>({});

/** 从工作区路径提取展示名（最后一段目录名），与侧栏 workspaceLabel 同规则。 */
export function workspaceLabelFromPath(wsPath: string): string {
  const parts = wsPath.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || wsPath;
}

export function useSessionWorkspaces() {
  function setWorkspace(sessionId: string, info: SessionWorkspaceInfo) {
    if (!info.wsPath && !info.wsKey) return;
    workspaces[sessionId] = info;
  }

  function setMany(sessionIds: Array<{ id: string }>, info: SessionWorkspaceInfo) {
    for (const s of sessionIds) setWorkspace(s.id, info);
  }

  function workspaceOf(sessionId: string): SessionWorkspaceInfo | null {
    return workspaces[sessionId] ?? null;
  }

  return { workspaces, setWorkspace, setMany, workspaceOf };
}
