/**
 * 各语言 LSP server 的简明信息（标题栏 LSP 面板用）。
 * 完整安装步骤见随包分发的安装向导（lsp-install-guide.html，面板底部「打开安装向导」）——
 * 面板只显示 note（关键约束/一句话提示），不重复步骤。
 */
export interface LspInstallGuide {
  /** 徽章/行内短名（TypeScript → TS） */
  shortName: string;
  /** 面板行的完整显示名 */
  displayName: string;
  /** server 二进制名（PATH 发现目标） */
  serverBinary: string;
  /** 附加说明（JDK 要求、安装方式一句话、生效条件） */
  note?: string;
}

export const LSP_INSTALL_GUIDES: Record<string, LspInstallGuide> = {
  rust: {
    shortName: "Rust",
    displayName: "Rust",
    serverBinary: "rust-analyzer",
    note: "rustup 装好后自动在 PATH（~/.cargo/bin）。",
  },
  typescript: {
    shortName: "TS",
    displayName: "TypeScript",
    serverBinary: "typescript-language-server",
    note: "npm 全局安装 typescript-language-server + typescript。Vue 项目（.vue）还需在项目内装 @vue/typescript-plugin，否则 .vue 无诊断/跳转（.ts 照常）。",
  },
  javascript: {
    shortName: "JS",
    displayName: "JavaScript",
    serverBinary: "typescript-language-server",
    note: "npm 全局安装 typescript-language-server + typescript。",
  },
  go: {
    shortName: "Go",
    displayName: "Go",
    serverBinary: "gopls",
    note: "go install golang.org/x/tools/gopls@latest，装完重开终端。",
  },
  java: {
    shortName: "Java",
    displayName: "Java",
    serverBinary: "jdtls",
    note: "需要 JDK 21+（jdtls 1.44 起最低要求，java -version 确认）；装完重启 Aide 生效。",
  },
  python: {
    shortName: "Py",
    displayName: "Python",
    serverBinary: "pyright-langserver",
    note: "npm 包名 pyright，二进制是 pyright-langserver。",
  },
  kotlin: {
    shortName: "Kt",
    displayName: "Kotlin",
    serverBinary: "kotlin-language-server",
    note: "GitHub releases 解压后把 bin/ 加入 PATH。",
  },
};

/** 未登记语言的通用 fallback（面板缺省文案）。 */
export const LSP_INSTALL_FALLBACK =
  "在 PATH 中安装该语言的 LSP server，或在设置中为它配置 program 路径。安装方法见「打开安装向导」。";

export function installGuideFor(lang: string): LspInstallGuide | undefined {
  return LSP_INSTALL_GUIDES[lang];
}
