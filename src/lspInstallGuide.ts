/**
 * 各语言 LSP server 的安装指引静态表（标题栏 LSP 面板用）。
 * 与 docs/lsp-manual-test-checklist.md 的「各语言 server 安装」表保持同步。
 * 只有提供可靠安装方式的语言才在这里登记；没登记的走通用 fallback 文案。
 */
export interface LspInstallGuide {
  /** 徽章/行内短名（TypeScript → TS） */
  shortName: string;
  /** 面板行的完整显示名 */
  displayName: string;
  /** server 二进制名（PATH 发现目标） */
  serverBinary: string;
  /** 安装命令（逐行展示） */
  steps: string[];
  /** 官方/下载链接（可选） */
  url?: string;
  /** 附加说明（如 JDK 版本要求） */
  note?: string;
}

export const LSP_INSTALL_GUIDES: Record<string, LspInstallGuide> = {
  rust: {
    shortName: "Rust",
    displayName: "Rust",
    serverBinary: "rust-analyzer",
    steps: ["rustup component add rust-analyzer"],
    url: "https://rust-analyzer.github.io/",
    note: "rustup 装好后 rust-analyzer 在 ~/.cargo/bin（已在 PATH）。",
  },
  typescript: {
    shortName: "TS",
    displayName: "TypeScript",
    serverBinary: "typescript-language-server",
    steps: ["npm i -g typescript-language-server typescript"],
  },
  javascript: {
    shortName: "JS",
    displayName: "JavaScript",
    serverBinary: "typescript-language-server",
    steps: ["npm i -g typescript-language-server typescript"],
  },
  vue: {
    shortName: "Vue",
    displayName: "Vue",
    serverBinary: "typescript-language-server",
    steps: ["npm i -g typescript-language-server typescript"],
  },
  go: {
    shortName: "Go",
    displayName: "Go",
    serverBinary: "gopls",
    steps: ["go install golang.org/x/tools/gopls@latest"],
  },
  java: {
    shortName: "Java",
    displayName: "Java",
    serverBinary: "jdtls",
    steps: ["scoop bucket add java && scoop install jdtls"],
    url: "https://github.com/eclipse-jdtls/eclipse.jdt.ls/releases",
    note: "需要 JDK 17+。scoop 不可用时：下载 zip 手动解压，把 bin/ 加入 PATH。",
  },
  python: {
    shortName: "Py",
    displayName: "Python",
    serverBinary: "pyright-langserver",
    steps: ["npm i -g pyright"],
    note: "npm 包名 pyright，二进制是 pyright-langserver。",
  },
  kotlin: {
    shortName: "Kt",
    displayName: "Kotlin",
    serverBinary: "kotlin-language-server",
    steps: ["下载 release 包解压后把 bin 加入 PATH"],
    url: "https://github.com/fwcd/kotlin-language-server/releases",
  },
};

/** 未登记语言的通用 fallback（面板缺省文案）。 */
export const LSP_INSTALL_FALLBACK =
  "在 PATH 中安装该语言的 LSP server，或在设置中为它配置 program 路径。";

export function installGuideFor(lang: string): LspInstallGuide | undefined {
  return LSP_INSTALL_GUIDES[lang];
}
