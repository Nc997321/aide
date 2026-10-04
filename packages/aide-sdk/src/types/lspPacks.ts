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
