# 语言包：插件市场一键安装语言服务器

> 状态：第一期已落地（2026-10-04）——TypeScript / JavaScript、Python、Rust。第二期：Go、Java、Kotlin。

## 1. 问题

语言服务器原本只有三个来源：设置里手动指定 > 随包捆绑 > PATH 发现。实际情况是：

- 随包捆绑形同虚设：发布包只带 `lombok.jar`，TS / Rust 的捆绑路径指向不存在的文件；远程套件更不带。
- 用户只能照安装向导自己 `npm i -g`、下载解压、配 PATH。WSL 上更糟：PATH 里混着 `/mnt/c` 的 Windows 版，Linux Host 找到的是一个起不来的 `.cmd`。
- 插件市场里官方的「xxx-lsp」插件只是一份 `lspServers` 配置（去 PATH 上找某个二进制），服务器本身不装；Aide 在受信任工作区还会退役它们。用户装了等于没装。

## 2. 方案

**语言包 = 一键把某语言的服务器装到当前 Host。** 市场里新增「语言服务器」伪分类（与「推荐」「已安装」同级，不来自任何市场源）。

- **装在 Host 上**：安装是 Host 命令（`lsp_pack_install`），在窗口连着的那台机器上执行，装进它的 `~/.aide/lsp/packs/<id>/`。本机 / WSL / SSH 各装各的，符合「插件、MCP 按 Host 自持」。
- **查找链**：设置里手动指定 > **语言包** > 随包捆绑 > PATH。语言包排在 PATH 前：它是用户明确为这台 Host 装的；PATH 上的常是别的来路。
- **目录是数据**（`lsp/packs/catalog.rs`）：每条记录写清装什么、从哪装、怎么启动，版本钉死。安装器、查找链对语言一无所知——加一门语言只加一条记录。
- **两种配方**：
  - `Npm`：从 registry 直取 tarball（**不调用 npm**；入选的包都没有必需的运行时依赖），校验 `dist.integrity`（sha512），解进 `node_modules/<name>`，用 node 跑入口脚本。
  - `Binary`：有工具链（rustup）就装官方组件；没有就下 GitHub Releases 的平台包（`.gz` 单文件 / `.zip`）。
- **Node 运行时**（npm 系用）：Aide 装过的那份 > PATH 上 ≥18 的 > sidecar 正在用的那份；都没有才下载（官方 / 镜像，按 SHASUMS256 校验）到 `~/.aide/lsp/runtime`。
- **TS 的 SDK**：TypeScript 语言包自带 typescript 5.9（有 `lib/tsserver.js`），作为 `ts_sdk` 的兜底档，排在 PATH 上的 `tsc` 之前（全局常见的 7.x 是 Go 重写版，没有 tsserver）。
- **下载源回退链**与远程套件共用 `aide_core::mirrors`（官方 → npmmirror），走 Aide 的代理探测。
- **原子安装**：装进同级临时目录，写好 `pack.json` 再整体换上；失败不留半截。换装前按语言停掉正在跑的 server（`LspManager::kill_lang`，顺带清启动失败冷却），下一次请求按新查找链重启。

## 3. 入口

一套实现（`useLanguagePacks`，模块级单例），三个入口：

1. 插件市场「语言服务器」分类：全部语言包，当前项目在用的置顶、标「当前项目在用」。
2. 市场推荐首页：当前项目在用但没装的，在「精选推荐」上方提示一栏。
3. 标题栏「语言环境」面板：某语言「未安装」或「启动失败」且有对应语言包没装时，那一行给「一键安装」；装好后面板据 `revision` 重探。「就绪」行的来源说明按查找链同序显示（手动路径 / 语言包 / PATH）。

agent 的 LSP 工具读同一张注册表，语言包装好后 agent 的代码导航随之可用。

## 4. 安全

- npm 包：registry 公布的 sha512 不符即拒装；元数据缺 integrity 也拒装。
- Node 发行包：官方 SHASUMS256.txt 校验。
- GitHub 发行包（rust-analyzer）上游不发校验和，只走 github.com 官方地址，不经第三方代理镜像。
- 解压：条目只接受普通路径组件（`..`、绝对路径、盘符前缀拒绝），符号链接不展开。

## 5. 验证

- 单测：目录约束、下载校验、解压防越界、原子替换、查找链优先级、启动命令拼接、前端状态与卡片。
- 真机端到端（`packs::tests::e2e_install_and_handshake_every_pack`，`--ignored`）：WSL 上三个语言包真装、真起、真握手；另以 `PATH=/usr/bin:/bin` 跑一遍覆盖「没有 node → 下载 node」与「没有 rustup → GitHub 发行包」两条路径。

## 补记（2026-10-15）：JVM 系语言包 · Java

- **新配方 `Recipe::JvmArchive`**：tar.gz（钉版本 + sha256）+ 本机 JDK 运行 `java <jvm_args> -jar <launcher>`。jdtls 特有的东西（launcher jar 名、`-Declipse.application` 等、各平台共享配置区）全是 `catalog.rs` 里的数据；安装器与查找链只认「JVM 压缩包」这种形态，不认语言。启动方式 `Launch::Jar`，`{dir}` 启动时换成安装目录。
- **JDK 不下载**（`packs/jvm.rs`）：找本机版本够的——JAVA_HOME → PATH → `~/.jdks` / `Program Files\Java` 等常见目录；读 `release` 文件判版本，PATH 上的 shim 才退回 `java -version`。安装前先查，没有就直接说「需要 JDK 21+」，不白下 50MB。运行时与工程 JDK 是两回事：jdtls 跑在 21 上照样分析 Java 8 工程（po-api 实测）。
- **版本钉 jdtls 1.58.0**：之后的快照要求 Java 25 才能启动（JDK 21 上 OSGi 报 `osgi.ee=JavaSE 25`）。不走官方 `bin/jdtls(.bat)`：它要 Python（Windows 上常是应用商店占位），`.bat` 末尾还有 `pause`。参数与其 `jdtls.py` 一致；平台 config 目录作**只读共享配置区**，多实例并发不写安装目录。
- **profile 的 `--jvm-arg=X` 约定**（原本给 jdtls 的 Python 启动脚本用）在 JVM 语言包下由 `registry::reshape_for_jvm` 挪到 `-jar` 之前——`profiles/java.rs` 不用为语言包改一行（堆、lombok、元数据重定向照旧）。
- **下载**：只用官方源（国内没有可用镜像：USTC 1.58 是 404，清华 / 阿里没有 jdtls）。`fetch::download_resumable`：断点续传（`Range`，源回 200 就从头写）、连续 12 次失败才放弃且保留半截文件、下完校验 sha256、不过即删。进度经 `lsp-pack-progress` 广播（~4 次/秒），插件市场卡片与「语言环境」面板显示「安装中… 37%（19 / 51 MB）」。
- 真机（宿主机，临时用户目录）：预置 40MB 半截 → 续传到 100% → 校验通过 → 9.3s 装完；preflight 从「可装」变「已装」；开启后 10s ServiceReady、37.9s 按名就绪，`MediaService` 命中。
