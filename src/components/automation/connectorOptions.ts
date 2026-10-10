/** 自动化任务「预授权连接器」的候选 = 内置 MCP server + 用户配置的 MCP server。
 *
 *  内置清单取前端镜像 `builtinMcpServers`（sidecar 新增内置 MCP 时本来就要在那里登记），
 *  不在这里再写死一份——写死过只有 `aide-docs` 的一版，后来加的知识库 / 记忆 / 浏览器
 *  在自动化里就永远勾不到。
 *
 *  勾选 = 该 server 的**全部工具**在任务内免确认（policy hook 对白名单内的 MCP 工具
 *  一律 allow，见 agent-sidecar/src/desktop/automation.ts）。平时要逐次确认的操作
 *  （知识库写/删）勾上后同样不再问——所以每项都带一句说明，让用户自己判断。
 */
import { builtinMcpServers } from "@aide/sdk/composables/useCustomizations";

export interface ConnectorOption {
  name: string;
  /** 勾上意味着放行什么；用户自配的 server 没有说明。 */
  note: string;
  /** 勾上后有不可逆 / 等同本人身份的操作会免确认执行，选中时在表单里显式提示。 */
  caution: boolean;
}

/** 自动化里不提供的内置连接器：scheduler 刻意不下发 LSP 语言（见 build_send_command
 *  的 lsp_languages 注释），aide-lsp 的挂载闸门恒不通过——勾了也不会挂，不列出来骗人。 */
const UNAVAILABLE = new Set(["aide-lsp"]);

const NOTES: Record<string, { note: string; caution?: boolean }> = {
  "aide-docs": { note: "读写 docx / pdf 文档" },
  "aide-knowledge": {
    note: "知识库读写：含新建、覆盖、移动、删除文档，任务内不再逐次确认",
    caution: true,
  },
  "aide-memory": { note: "只读参考其他工作区的记忆" },
  "aide-browser": {
    note: "操作内嵌浏览器：能读你已登录的页面、以你的身份点击和发请求；仅桌面端可用",
    caution: true,
  },
};

export function automationConnectorOptions(userServers: string[]): ConnectorOption[] {
  const names = [
    ...builtinMcpServers.value.map((s) => s.id).filter((id) => !UNAVAILABLE.has(id)),
    ...userServers,
  ];
  return [...new Set(names)].map((name) => ({
    name,
    note: NOTES[name]?.note ?? "",
    caution: NOTES[name]?.caution ?? false,
  }));
}
