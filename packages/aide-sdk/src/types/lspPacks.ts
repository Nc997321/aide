/** 插件市场「语言服务器」分类里的一个语言包（后端 `lsp::packs::PackView`）。 */
export interface LanguagePack {
  id: string;
  name: string;
  /** 语言服务器名（如 typescript-language-server）。 */
  server: string;
  summary: string;
  /** 服务的语言，与 lspDetectLanguages / 「语言环境」面板同一套键（typescript、python…）。 */
  langs: string[];
  /** 目录里的版本。 */
  version: string;
  /** 安装方式说明。 */
  method: string;
  installed: InstalledLanguagePack | null;
  /** 后端正在安装（另一个窗口点的也算）。 */
  installing: boolean;
}

export interface InstalledLanguagePack {
  version: string;
  installedAt: string;
  /** 安装来源：npm / rustup 组件 / GitHub Releases。 */
  source: string;
  updateAvailable: boolean;
}

/** 会话前询问卡片上的一种语言（后端 `lsp::workspace_langs::PreflightLang`）。 */
export interface PreflightLang {
  lang: string;
  /** 语言服务器已可用（覆盖 / 语言包 / 捆绑 / PATH 任一）。 */
  installed: boolean;
  /** 未安装但语言包目录里有：可「安装并开启」。 */
  packId?: string;
}

/** 会话启动前「要不要问开不开语言服务器」（后端 `lsp_session_preflight`）。 */
export type LspPreflight =
  | { kind: "untrusted" }
  | { kind: "decided"; enabled: boolean }
  | { kind: "nothing" }
  | { kind: "ask"; langs: PreflightLang[] };

/** Host 语言服务器状态板的一份（`lsp-status` 事件 / `lsp_status` 快照，后端 `lsp::status_board::LangStatus`）。
 *  「就绪」只认 Host 的实测探针：`nav` = 跳转可用，`symbols` = 按名查询可用。 */
export interface LspBoardStatus {
  workspaceRoot: string;
  lang: string;
  phase: "off" | "disabled" | "missing" | "starting" | "loading" | "indexing" | "ready" | "failed" | "sleeping";
  nav: boolean;
  symbols: "unknown" | "ready" | "unsupported";
  /** server 自报的百分比。 */
  progress?: number;
  /** server 自报的阶段说明（原文）。 */
  message?: string;
  error?: string;
  /** 进入当前阶段的时间（unix ms）。 */
  since: number;
  /** 预计空闲休眠的时间点（unix ms），前端本地算倒计时。 */
  sleepAt?: number;
  /** 不休眠的原因（"editor"：编辑器开着该语言的文件）。 */
  keptBy?: "editor";
  /** 进程树实际占用的内存（字节），约 30s 采样一次。 */
  memory?: number;
}
