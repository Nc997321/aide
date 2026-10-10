/** 权限名 → 给用户看的说明（同意卡片用）。未知的权限原样显示名字，不能悄悄略过。 */
const LABELS: Record<string, string> = {
  storage: "保存自己的数据",
  secrets: "保存密码、令牌等机密",
  net: "访问任意网络地址",
  "workspace:read": "读取当前工作区的文件",
  "workspace:write": "修改当前工作区的文件",
  "session:read": "查看当前会话里 agent 的活动",
  composer: "往输入框里填内容（不会替你发送）",
};

export function describePermission(permission: string): string {
  if (permission.startsWith("net:")) return `访问 ${permission.slice(4)}`;
  return LABELS[permission] ?? permission;
}
