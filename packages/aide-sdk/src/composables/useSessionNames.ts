import { reactive } from "vue";

/**
 * 会话 id → 显示名 的模块级注册表。
 *
 * 名字的权威数据在侧栏（SidebarLeft 从磁盘加载的会话列表），但分屏组的 tab 栏、
 * ChatPanel 头部等处也要显示名字——它们与侧栏没有 props 通路（递归组件树），
 * 于是抽成共享注册表：SidebarLeft 在加载/新增/重命名时写入，其余地方只读。
 */
const names = reactive<Record<string, string>>({});

/**
 * 待用标题：sid → 由首条消息截取出的会话名，等待会话定名后落盘。
 *
 * 存在的原因纯粹是时序：sidecar 在 `send` 时同步发 `session_title`
 * （`session-worker.ts` handleSend 首条分支，早于 startLoop），那一刻会话只有
 * 临时 id、元数据还没落盘。此刻拿它去 `auto_rename_session` 会把标题写进
 * `<tempId>.json`，紧接着 `create_session(realId, 默认名)` 用「新会话 HH:MM:SS」
 * 建真正的文件 —— 标题就此变成无人读取的孤儿（2026-09-06 实锤 21 例）。
 *
 * 所以标题先在这里暂存，`finalizeSession` 定名时随其它注册表一起从 tempId 迁到
 * realId，再由落盘方（`onSessionCreated`）直接用作名字：一次写盘即最终名。
 */
const pendingTitles = new Map<string, string>();

export function useSessionNames() {
  function setName(id: string, name: string) {
    names[id] = name;
  }

  function setFromSessions(list: Array<{ id: string; name: string }>) {
    for (const s of list) names[s.id] = s.name;
  }

  /** 未注册的 id 退化为 id 前 8 位（与标题栏活跃会话列表一致）。 */
  function displayName(id: string): string {
    return names[id] || id.slice(0, 8);
  }

  /** 会话销毁时收口注册表条目（关 tab / 删会话 / 预览改绑）。读点 displayName
   *  有 `||` 兜底，删后自然回落 id 前 8 位。 */
  function removeName(id: string): void {
    delete names[id];
  }

  /** 暂存待用标题（会话尚处临时 id 阶段）。重复到达保留首次——标题取自首条
   *  消息，同一会话不会被第二条消息改写。 */
  function setPendingTitle(id: string, title: string): void {
    if (!pendingTitles.has(id)) pendingTitles.set(id, title);
  }

  /** 取走待用标题（一次性）：落盘方在 `onSessionCreated` 里调，用完即弃，
   *  避免会话重建/重开时拿旧标题覆盖用户后改的名字。 */
  function takePendingTitle(id: string): string | undefined {
    const title = pendingTitles.get(id);
    if (title !== undefined) pendingTitles.delete(id);
    return title;
  }

  /** 定名搬迁：临时 key → 真实 id（finalizeSession）。与 workspaces / identity
   *  的 migrate 同款语义：目标已有值时不覆盖。 */
  function migratePendingTitle(from: string, to: string): void {
    const title = pendingTitles.get(from);
    if (title === undefined) return;
    pendingTitles.delete(from);
    if (!pendingTitles.has(to)) pendingTitles.set(to, title);
  }

  function clearPendingTitles(): void {
    pendingTitles.clear();
  }

  return {
    names,
    setName,
    setFromSessions,
    displayName,
    removeName,
    setPendingTitle,
    takePendingTitle,
    migratePendingTitle,
    clearPendingTitles,
  };
}
