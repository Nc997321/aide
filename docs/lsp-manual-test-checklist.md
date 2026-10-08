# 内置 LSP 真实 server 手测清单

v1 不进 CI（慢 + 依赖外部安装）。每个 server 跑一遍下列流程，结果记 PR 描述。

## 通用流程（每语言）
1. 开某语言文件（如 `foo.rs`）→ 编辑器应起该语言 server（DevTools 看 lsp_ensure_server 调用）
2. 写一个类型错 → 波浪线诊断出现（@codemirror/lint）
3. Ctrl+Click 一个符号 → 跳到定义（LSP 优先；无 server 落 grep）
4. 键入触发补全 → 弹 `.cm-tooltip-autocomplete`，选项来自 server
5. 悬停某符号 → 弹 hover tooltip（markdown 渲染）
6. 关工作区 / 关 LSP toggle → server 进程退出（Task Manager 验）、波浪线消失
7. 排除目录：设 `target` 为排除 → 打开 `target/` 下文件不发 didOpen（无诊断/补全）

## server 矩阵
> 注：v1 **未捆绑任何 server**（registry 预留 Bundled 机制但打包未落地）。全部语言走 PATH 发现 / 设置覆盖——机器上没装的 server 会弹 "LSP server not found" toast，功能降级 codegraph/grep。各语言安装见下节。

- [ ] rust-analyzer（Rust，PATH 发现）：本仓库自身 `src-tauri/` 打开 → 诊断 + 跳转 + 补全 + hover
- [ ] typescript-language-server（TS/JS，PATH 发现）：本仓库 `src/` 打开 `.ts`/`.tsx`/`.jsx`/`.vue`（`.vue` 需项目装了 `@vue/typescript-plugin`；没装时该文件静默无服务，`.ts` 照常）
- [ ] **子目录项目探测 + TS 起得来**：工作区根是后端、前端在 `frontend/`（agri-ai-agent 形状）→ 面板应报出两种语言、各自起 server；**TS 行须显示 ✓ 就绪**（typescript SDK 在子目录里也由 `ts_sdk` 解析注入；修前是 `! 启动失败` —— TLS 只在工作区根找 SDK）。另：在这种工作区里按名查一个 `frontend/src` 里的符号，应能命中
- [ ] pyright-langserver（Python，PATH 发现；npm 包名 `pyright`，二进制 `pyright-langserver`）：任一 Python 项目
- [ ] gopls（Go，PATH 发现）：任一 Go 项目 + 验 directoryFilters 排除注入
- [ ] jdtls（Java，PATH 发现）：任一 Java 项目（需先装 jdtls，见下）。验：打开 `.java` → 诊断 + 跳转 + 补全；`-data` 目录落在项目内 `.aide/jdtls-workspace/`（源码目录无 .project/.classpath/.settings）；jdtls stderr 无 `--stdio` 参数报错

## 各语言 server 安装（PATH 发现的要求：二进制在 PATH 上，`which <bin>` 能找到）

| 语言 | 二进制 | 安装 |
|---|---|---|
| Rust | `rust-analyzer` | `rustup component add rust-analyzer`（rustup 装好后在 `~/.cargo/bin`）；或 [GitHub releases](https://github.com/rust-lang/rust-analyzer/releases) 下载对应平台 exe 放 PATH |
| TS/JS | `typescript-language-server` | `npm i -g typescript-language-server typescript`（新版自动装 node 运行时，无需单独 node） |
| Python | `pyright-langserver` | `npm i -g pyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Java | `jdtls` | 见下方 Java 专项 |

> 装好后重启 app 生效；仍报 not found 就用设置覆盖（LSP → 服务器覆盖，program 填完整路径）。

## Java：jdtls 安装与配置（Windows）
jdtls 是 Eclipse JDT Language Server，**默认走 stdio**（不传 `CLIENT_PORT`/`--pipe` 即 stdin/stdout），因此无需额外传输配置；**它不认 `--stdio`**（Aide 已对 Java 特判不注入，自动补 `-data`）。只需把 `jdtls` 命令搞到 PATH 上：

1. 装 JDK 21+（jdtls 1.44 起最低要求；已有 JDK 的用 `java -version` 确认。项目本身是 JDK 8 还是 21 不影响——jdtls 按各项目编译配置分析 Java 8~25）
2. 方式 A（手动，winget 无 jdtls 包）：从 [GitHub releases](https://github.com/eclipse-jdtls/eclipse.jdt.ls/releases) 下载最新版 zip（tag 持续更新，2026 年仍有发版）→ 解压到固定目录 → 把 `bin/` 目录加进 PATH（Windows 上 `bin/jdtls` 是脚本，需配合 PATHEXT 或直接用方式 B）。备选渠道：官方下载站 [download.eclipse.org/jdtls/snapshots/](https://download.eclipse.org/jdtls/snapshots/) 的 `jdt-language-server-latest.tar.gz`（约 50MB，持续构建）
3. 方式 B（不想动 PATH 时）：标题栏 LSP 徽章 → 打开面板 → 「服务器覆盖」→ 语言 `java`：program 填 `jdtls` 可执行文件完整路径（args 留空——Aide 自动补 `-data`；若自己配了 args 且想自定义 workspace 目录，显式写 `-data <目录>` 即可，Aide 不重复追加）
4. 验证安装：终端跑 `where jdtls`（有路径输出即装好）→ **重启 Aide**（dev build 需重编译，Rust 后端含 jdtls 特判；旧实例全关掉）
5. 验证生效：打开 Java 项目 → 标题栏 LSP 徽章点开面板 → 开 LSP 开关 → 面板显示 **Java ✓ 就绪**；打开 `.java` 文件 → 类型错有波浪线诊断、Ctrl+Click 跳转、键入补全

> 注意：jdtls 首次启动较慢（Eclipse OSGi 框架 + 索引），补全/诊断可能延迟数秒；`-data` 目录复用同一 workspace 后二次启动快很多。

**多 JDK 环境**（默认 JDK 是 8/17、另有 21）：jdtls 脚本从 PATH/JAVA_HOME 找 java，默认版本不够 21 会启动失败（面板显示「! 启动失败」）。无需全局改环境变量，二选一（入口都是标题栏 LSP 面板 → 「服务器覆盖」→ 语言 `java`）：
- wrapper：建 `jdtls21.bat`（`@echo off` + `set JAVA_HOME=C:\...\jdk-21` + `jdtls %*`），program 填该 bat 完整路径，args 留空
- `-vm`：program 填 jdtls 脚本路径，args 填 `-vm C:\...\jdk-21\bin\java.exe`（Eclipse 原生参数，Aide 原样透传并自动补 `-data`）

## 不测的（诚实声明）
- 真实 rust-analyzer 全协议兼容矩阵——v1 只覆盖 4 method + 诊断
- macOS/Linux bundled server 拉起——仅手测清单覆盖（v1 主力 Windows）
