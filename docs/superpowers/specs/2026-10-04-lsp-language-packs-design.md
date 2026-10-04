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
