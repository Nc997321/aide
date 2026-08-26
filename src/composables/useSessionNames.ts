import { reactive } from "vue";

/**
 * 会话 id → 显示名 的模块级注册表。
 *
 * 名字的权威数据在侧栏（SidebarLeft 从磁盘加载的会话列表），但分屏组的 tab 栏、
 * ChatPanel 头部等处也要显示名字——它们与侧栏没有 props 通路（递归组件树），
 * 于是抽成共享注册表：SidebarLeft 在加载/新增/重命名时写入，其余地方只读。
 */
const names = reactive<Record<string, string>>({});

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

  return { names, setName, setFromSessions, displayName, removeName };
}
