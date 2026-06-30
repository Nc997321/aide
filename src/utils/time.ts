/**
 * 把毫秒时间戳转为「x 分钟前 / x 小时前 / x 天前 / x 周前」中文相对时间。
 * 与原 SidebarLeft 中的实现一致，抽到共享 util 供侧栏与命令面板复用。
 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  return `${Math.floor(days / 7)}周前`;
}