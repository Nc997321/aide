# 侧栏应用（Aide App）：用户与 agent 自己给 Aide 加功能

> 状态：P0 隔离实验在 Windows dev 上通过（2026-10-10）；P1–P4 代码已写完，Host 与前端的单测通过，**桌面侧未在真机跑过**（WSL 编不了 `src-tauri`）。打包版与 macOS / Linux 的 P0 还没跑。

## 1. 问题

用户想在 Aide 里加自己的功能：侧栏多一个按钮，点开是自己的界面，背后能真正干活——小游戏、接口调试（Postman 那类）、数据库查看器，任何东西。并且希望像 Claude Code 的 mod 那样，**在会话里说一句，agent 就把它做出来并热加载**。

现状做不到：

- 右栏 tab 写死：`useRightPanel.ts` 的 `RightTabId` 联合类型 + `App.vue` 的 `rightTabs` / `RAIL_DIGIT_TABS`，加一个 tab 要改三处源码。
- Claude Code 的 mod 搬不过来：sidecar 用 `settingSources: []` 隔离 `~/.claude`，且 mod 的界面由 Claude Code 自己的界面绘制，Aide 不在其中。
- OpenVSX 的扩展依赖 VS Code 扩展宿主（`vscode` API），Aide 没有，也不打算有。

**命名**：「扩展」在 Aide 里已指设置面板那个 tab（智能体 / 技能 / 指令 / Hook / MCP），本功能叫**应用（App）**，避免撞名。

## 2. 方案

**一个应用 = 清单 + 界面（沙箱网页）+ 可选后端（MCP server）。**

| 部分 | 是什么 | 跑在哪 |
|---|---|---|
| 入口 | 右栏 rail 上的一个图标 + 面板，或左侧栏导航组里的一行 + 主区面板（清单里选） | GUI |
| 界面 | 任意网页（框架不限），关在沙箱 iframe 里 | GUI |
| 能力 | 经桥调用 Aide 提供的 API，按清单申请的权限放行 | 权限裁决与执行都在 Host |
| 后端（可选） | 一个 stdio MCP server；**界面和 agent 共用它的工具** | Host |

- **应用归 Host**，装在 `~/.aide/apps/<id>/`，与「插件、MCP、记忆按 Host 自持」一致。理由是硬约束：agent 跑在 Host 上，只能往 Host 的磁盘写文件；远程窗口里它够不着 GUI 那台机器。窗口连着哪个 Host，rail 上就是哪个 Host 的应用。
- **开发态在工作区**：受信任工作区的 `{cwd}/.aide/apps/<id>/` 也会被加载并热更新（与 `dispatchPlugins` 加载 `{cwd}/.aide/claude/` 同一先例）。做好后「安装」= 复制到 `~/.aide/apps/`。
- **后端从 Host 发请求、连服务**：SSH 窗口里的数据库面板直接连目标机的 `localhost`，接口调试能打到 Host 所在内网，不受浏览器跨域限制。
- **手机端不变**：面板只在桌面；agent 调用应用工具的那一半，手机会话照常可用（就是普通 MCP 工具）。`app_*` 命令不进 `aide-link` 暴露目录。

### 目录与清单

```
~/.aide/apps/api-tester/
  app.json
  ui/index.html …        界面
  server/main.mjs        后端（可选）
```

```json
{
  "id": "api-tester",
  "name": "接口调试",
  "version": "0.1.0",
  "icon": "ui/icon.svg",
  "panel": { "entry": "ui/index.html", "placement": "main" },
  "permissions": ["storage", "net", "workspace:read"],
  "server": { "entry": "server/main.mjs" }
}
```

`placement` 取 `right`（默认，右栏 rail 的一个 tab，窄，适合小工具和小游戏）或 `main`（左侧栏导航组里的一行，点开占主区，适合接口调试、数据库这类要空间的工具）。

**清单里的 `placement` 只是初值，位置最终归用户**（2026-10-10 补）：面板顶栏常驻「移到主区 / 移到右栏」，点了就挪过去并在新位置打开。原因：位置只写在清单里时，用户根本不知道应用还能待在另一侧，只会以为它只能在右栏。用户的选择经 `app_set_placement` 记在 Host 的 `app-data/state.json`（与同意、启停同一份；按应用 id 记，开发态与安装版共用），不改清单——清单是应用作者的文件，改它会让开发态与安装版「不一样了」。挪过之后以用户的为准，卸干净才忘。

应用自己的数据（KV、密钥）不放在应用目录里，由 Host 另存（§3），卸载重装不丢、agent 改应用文件时碰不到。

## 3. 桥：应用能调什么

界面通过 `postMessage` 与外层通信；Aide 提供一个小脚本 `aide-app.js` 包成 `window.aide`。**GUI 只做管道**：每次调用原样转成一条 Host 命令 `app_call { appId, method, params }`，**权限检查只在 Host 的 `apps::bridge` 一处**（同 `catalog.rs` 的 `prepare` 只在一处）。

| API | 作用 | 所需权限 |
|---|---|---|
| `aide.theme` / `onThemeChange` | 当前主题 token；外层同时把 `--aide-*` 注入 iframe | 无 |
| `aide.host` | Host 类型（本机 / WSL / SSH）、系统 | 无 |
| `aide.ui.toast` / `setBadge` | 通知、rail 图标角标 | 无 |
| `aide.storage.*` | 应用私有 KV，存 Host | `storage` |
| `aide.secrets.*` | 应用私有密钥，进 Host 的 `SecretStore`（键前缀 `app/<id>/`） | `secrets` |
| `aide.net.fetch` | 由 Host 发 HTTP 请求 | `net`（可写成 `net:api.example.com` 限定主机） |
| `aide.fs.read` / `list` / `write` | 当前工作区内的文件 | `workspace:read` / `workspace:write` |
| `aide.session.onEvent` | 当前会话的只读事件（工具调用、子代理、回合起止） | `session:read` |
| `aide.composer.fill` | 往输入框填内容，**不代发** | `composer` |
| `aide.tools.call` | 调用本应用后端的工具 | 清单里有 `server` 即可 |

第一版**不开放**：改聊天区 / 编辑器 / 其他面板的渲染，拦截或改写 agent 的工具调用与提示词，应用之间互调，替用户发送消息。

## 4. 隔离（本方案的安全前提）

应用界面是用户或 agent 写的代码，必须拿不到 Tauri IPC——拿到就等于拿到全部 Host 命令。

已核实的事实（本机 cargo registry 的 tauri 2.11.2，`webview/mod.rs`）：

- `is_local_url` 把三类地址当本地页面：`tauri://` 协议、`frontendDist`/`devUrl` 之下、**以及应用注册的任何自定义协议**。
- `on_message` 对非本地来源一律查 ACL；Aide 的 `capabilities/default.json` 没有 `remote` 配置，所以远程来源调不到任何命令。

推论：**应用资源绝不能经 Tauri 自定义协议投递**（那样会被判成本地页面、IPC 全开）。`tauri.conf.json` 的 `csp: null` 也意味着现在没有第二道防线。

定案方向（待 P0 验证）：

- 桌面进程起一个只绑 `127.0.0.1` 的资源服务，地址形如 `http://127.0.0.1:<端口>/<窗口随机令牌>/<appId>/<路径>`；收到请求后经 `host_door` 向该窗口的 Host 取 `app_asset`。
- iframe 加 `sandbox="allow-scripts allow-forms allow-pointer-lock"`，**不给 `allow-same-origin`**（来源不透明，读不到别的应用，也读不到 `localStorage`——存储一律走桥）。
- 资源响应带 CSP：`connect-src 'none'`，脚本与样式只许同源和内联。应用想联网只能走 `aide.net.fetch`。
- 外层收消息时校验 `event.source === iframe.contentWindow`（不透明来源没法校验 origin）。

没走内嵌浏览器那条子 webview 路线：它目前只有 Windows 实现（`browser/adapter` 下 mac / Linux 是 `UnsupportedEngine`），违反跨平台红线。

### 同意

应用首次加载、或清单的权限 / 后端入口变了，弹一次确认，写明申请了什么。带后端的应用要单独说清：**「将以你的身份在 <Host> 上运行程序」**——这与装一个 MCP server 是同等信任级别，沙箱只管界面，管不了后端。同意记录存在 Host 的状态里（不在应用目录），按清单相关字段的哈希失效。**agent 写出的应用永不自动启用**，这是防提示注入的人工关口。

## 5. 后端

- **运行时**：Host 上的 Node（≥18），复用 `lsp::packs::node` 的查找 / 下载链。只承诺 Node 标准 API。
- **依赖**：第一版要求后端自带全部依赖（打包成单文件，或随目录带纯 JS 的 `node_modules`），**没有安装步骤，不支持原生模块**。`pg`、`mysql2` 这类纯 JS 驱动可用。
- **两处使用，各起各的进程**：
  - 界面调用：`aide-core` 的 `apps::servers` 按需拉起、空闲回收，用最小的 stdio JSON-RPC 客户端（`initialize` / `tools/list` / `tools/call`）。
  - 会话调用：把应用后端并进 sidecar 的 `mcpServers`（`userExtensions.ts` 的合并点），工具名 `mcp__app-<id>__<tool>`，走现有权限流程。
- 因此**后端不能把状态放在进程内存里**，要落到 `storage` 或自己的数据文件。面板想反映 agent 做了什么，订阅 `session:read` 里自己工具的调用事件后刷新。
- 所有 `Command::new` 按红线加 `CREATE_NO_WINDOW`。
- 应用的 MCP server 要在设置「扩展」tab 里可见（来源标「应用」），同步 `useCustomizations` 镜像。

## 6. 前端改动

- `RightTabId` 变为「内置 id ∪ `app:<id>`」；`useRightPanel` 的三态裁决不变。`rightTabs` 在内置项后追加已启用的应用。
- 左侧入口与右栏**不是同一套机制**：左侧栏的导航组（`SidebarNavGroup.vue`：插件 / 记忆观测台 / 知识库 / 浏览器）每行开关的是一块**主区面板**，各有模块级 `panelOpen`。`placement: "main"` 的应用在导航组末尾追加一行，开关由新的 `useApps` 统一持有（一次只开一个应用面板），与现有主区面板的互斥沿用它们现在的规则。两种位置共用同一个 `AppPanel`。
- 新增 `AppPanel.vue`：首次激活才挂、之后 `v-show` 保活（同 `browserEverActive`），负责 iframe、桥、主题注入、加载失败与崩溃的兜底界面（含「重新加载」「禁用」）。
- 能力走 `@aide/sdk` 的 api 门面（`api/apps.ts`），Host 命令在 `aide-core/src/commands/apps.rs`：`app_list` / `app_asset`（bytes）/ `app_call` / `app_install` / `app_uninstall` / `app_set_enabled` / `app_set_placement` / `app_consent`。
- 应用增删改经 Host 事件总线发 `apps-changed`，面板据此重载——不做本地乐观更新。

## 7. 让 agent 会做应用

- 内置 skill「编写 Aide 应用」：清单格式、桥 API、后端约束、一个可运行的模板。
- 内置工具：`app_validate`（校验清单与入口）、`app_open`（请求打开面板，用户未同意时如实返回）、`app_logs`（面板的控制台错误与后端 stderr）。没有这三样，agent 写完看不到结果，质量上不去。

## 8. 分期

| 期 | 内容 | 做完能做什么 |
|---|---|---|
| P0 | 隔离实验：Windows / macOS / Linux 上验证沙箱 iframe 内任何 Tauri 命令都调不通；回环地址在 `tauri://` 页面里能否正常加载 | 决定 §4 是否成立 |
| P1 | 清单、`app_list` / `app_asset`、动态 rail 与左侧导航行、`AppPanel`、主题、`storage`、工作区开发态 + 热加载、同意弹窗 | 小游戏、纯前端工具 |
| P2 | `net` / `secrets` / `fs` / `session:read` / `composer` | 接口调试的基础版 |
| P3 | 后端：运行时、进程管理、`tools.call`、并入会话 | 数据库面板；agent 也能用应用 |
| P4 | skill、`app_validate` / `app_open` / `app_logs`、模板；市场里加「应用」分类 | 「说一句就做出来」的闭环 |

### P0 结果

**Windows / dev（2026-10-10）：通过。** Host 侧的执行记录里只有对照组的两次调用。实验顺带确认了三件事：

- Tauri 把 `__TAURI_INTERNALS__`、`ipc`、`chrome.webview` 注入了**所有** frame，包括沙箱里的。沙箱不会让 IPC 对象消失，隔离完全靠 Tauri 按来源做的检查——所以「资源绝不走自定义协议」这条是硬约束，不是多一层保险。
- 两条拒绝路径都生效：回环来源被 ACL 拒（`not allowed on … URL: http://127.0.0.1:…`），不透明来源在更早处被拒（`Origin header is not a valid URL`）。
- 带 CSP 时 IPC 的 fetch 被 `connect-src 'none'` 拦掉，Tauri 自动回退到 postMessage 通道；那条通道的回应送不回子 frame（表现为超时），但命令**没有执行**。判定因此改成只认 Host 侧记录。

还没跑：打包版（主页面来源不同）、macOS、Linux。

### 落地情况（P1–P4）

与上文设计的出入，以代码为准：

**布局与投递**

- 应用数据与同意记录在 `~/.aide/app-data/`（`state.json`、每个应用一个目录、给 sidecar 的 `mcp-servers.json`），不在应用目录里。
- 资源地址是「每个（窗口，应用）一个随机前缀」：`http://127.0.0.1:<端口>/<前缀>/<应用内路径>`，由 GUI 命令 `app_frame_base` 发放；应用猜不到别的应用的前缀。桥脚本固定在 `/aide-app.js`。
- CSP 里的来源写成显式地址，不用 `'self'`（沙箱 iframe 来源不透明，`'self'` 在各内核里行为不一）。
- 应用图标（2026-10-10）：清单的 `icon` 经 `app_asset` 取字节（未同意也取得到，只此一个文件）→ blob 地址，**只当图片用**：SVG 走 CSS mask（只取形状、按主题色着色，与内置图标一致），位图走 `<img>`。内容本身绝不进 HTML（rail 是 `v-html`，放进去的只有我们自己生成的 blob 地址）。没给、取不到、格式不认识或超过 256KB 就退回内置拼图图标。
- 开发态目录 = 受信任的活动工作区 + 日常目录的 `.aide/apps`（日常会话的 cwd 在日常目录，窗口的活动工作区可以是别的；同 id 时活动工作区优先）。Aide 第一次看到一个开发态应用就往它的 `.aide-dev.log` 写 `manifest: ok`，agent 据此确认「已被看到」。
- 安装之后安装版接管：开发态那一份与安装版内容一样时不再盖在上面（否则点了「安装」界面毫无变化，2026-10-10 真机踩到）；agent 再改开发态，两份不一样了，它才重新盖上来，面板提示「更新安装」（`AppInfo.installed`）。没有后端的应用安装时把开发态的同意带过去；带后端的仍要再同意一次（安装版的只读工具免确认，得让用户看见）。
- 卸载 = 删掉用户眼前这一个（2026-10-10）：眼前是安装版就连同与它一模一样的开发态副本一起删（否则卸完立刻以「开发中」冒回来）；眼前是开发态就只删那一份（按钮叫「删除」，有安装版时叫「放弃改动」）。清单坏了的也删得掉。只管当前扫描到的开发态目录（活动工作区 + 日常目录）。
- 开发态面板顶上有一条提示：说明这是开发中的版本、为什么要安装，附「安装到 Aide」主按钮；skill 要求 agent 做完后把「同意」「安装」两步都告诉用户。
- 应用目录由 **Host 自己盯着**（`apps::start`，Host 启动职责，每 2.5 秒一轮）：有变化就记开发日志、发 `apps-changed`，界面只听事件（外加窗口聚焦时拉一次），不再轮询。原先靠界面轮询 `app_list`，但 agent 干活时用户多半在看别的窗口，被遮住的窗口定时器是停的——应用写好了没人扫、开发日志不出现（2026-10-10 真机：agent 转头去搭假桥、开浏览器自测）。`revision`（应用目录内最新修改时刻，点号开头的文件不算）变了前端就整页重载 iframe。没有接文件监听。

**桥**

- Host 侧（`apps::bridge`，唯一的权限裁决点）：`host.info`、`log.write`、`storage.*`、`secrets.*`、`net.fetch`、`fs.read` / `list` / `write`、`tools.list` / `tools.call`。
- GUI 侧：`theme.get`、`ui.toast`、`ui.setBadge`、`composer.fill`，以及 `session` 事件的推送。**`session:read` 与 `composer` 是在 GUI 侧按清单判的**（事件与输入框本来就只在前端），推给应用的是投影后的形状——只有「发生了什么」，不带工具入参、输出和对话文本。
- `net:<主机>` 是精确匹配，且这类应用不跟随重定向（一跳就出白名单）；`net` 才跟随。回环地址不走代理。
- `fs.write` 写不进 `.git` 与 `.aide`（前者的钩子、后者的 hooks 与别的应用都等于代码执行）。
- `composer.fill` 走 `useComposerInserter`，与文件树「添加到对话」（`useMentionInserter`）同一范式：只放一个待办，由选中会话的输入框认领；接在已有内容后面，只填不发。

**后端**

- 界面用的那一份由 `apps::servers` 管：按需拉起，版本变了重启，出错即收掉，十分钟没人调就回收；桌面退出时一并结束。
- 会话用的那一份：Host 把「已同意、已启用、带后端」的应用算成 `mcp-servers.json`，sidecar 只读结果（`loadAppMcpServers`），同意逻辑不在 TS 里重写。开发态应用只挂给它那个工作区的会话。
- 带后端的应用在用户点同意时准备 Node（找不到会下载）；准备不好就不记同意。
- 只读工具免确认：Host 起后端问一次 `tools/list`（按应用版本记住），把自己标了 `readOnlyHint` 的工具名写进 `mcp-servers.json`，sidecar 据此加工具级放行规则；其余工具照常确认。**只对安装版成立**——开发态的后端是 agent 自己在改的，认它自称的只读等于让 agent 写一个「只读」工具再自己调，绕过全部确认拿到任意代码执行。
- 设置「扩展」tab 的 MCP 列表里有一段「来自侧栏应用」，列出已挂进会话的应用后端和它们免确认的工具（只读，在应用面板上管理）。

**让 agent 会做应用**

- 内置 skill `aide-app`（`agent-sidecar/src/extensions/appSkill.ts`），随 runtime 启动落地。
- 反馈回路没有做成三个工具，而是一个文件：开发态应用目录里的 **`.aide-dev.log`**，记清单问题、界面报错（未捕获异常、未处理的拒绝、`console.error`）、后端 stderr 与调用失败。agent 本来就能读工作区里的文件，不需要新的工具通道。`app_open` 没有对应物：启用必须是用户点的。
- **没做**：市场里的「应用」分类。管理入口在面板自己的标题栏上（安装 / 禁用 / 卸载）。

**示例**（`docs/examples/aide-apps/`，复制到 `~/.aide/apps/<id>/` 即可试）

- `counter`：纯前端，右栏，用 `storage`。
- `api-tester`：带后端，占主区；界面与 agent 共用 `send_request` / `list_history` 两个工具。后端零依赖，手写 MCP。

### P0 怎么跑

代码已就位（`src-tauri/src/commands/app_probe.rs` + `app_probe_frame.html`、`src/dev/appIsolationProbe.ts`、判定 `src/dev/appIsolationVerdict.ts`）。

1. 以环境变量 `AIDE_APP_PROBE=1` 启动桌面（PowerShell：`$env:AIDE_APP_PROBE=1; pnpm tauri dev`）。不设这个变量时不开端口，快捷键无反应。
2. 在主窗口按 `Ctrl+Alt+Shift+I`。右下角出结论（通过 / 失败 / 无结论）和原始结果，同时落盘到临时目录的 `aide-app-probe-<os>.json`。
3. dev 与打包版各跑一次（两者主页面来源不同），三个平台都要跑。

四个变体：同源无沙箱的**对照**（应当调得通，证明探针有牙）、回环地址无沙箱、回环地址 + 沙箱、回环地址 + 沙箱 + CSP（定案方案）。后三个里任何一条通往 IPC 的路调通即失败；页面加载不出来也算失败（说明这种投递方式在该平台不可用）。**没测的一项**：frame 把顶层窗口导航走（沙箱不给 `allow-top-navigation` 应当拦住，但实测会把应用页面真的带走，留到 P1 用独立窗口验证）。

## 9. 验证

- 单测：清单解析与拒绝项、权限裁决（每个桥方法缺权限必拒）、`net` 主机白名单、`fs` 越界路径、同意哈希失效、`RightTabId` 动态项的三态裁决。
- 隔离回归（P0 的实验固化成测试）：沙箱页面里 `invoke` 任一命令必须失败。
- 真机：WSL 窗口里装一个带后端的应用，界面与会话各调一次同一工具；SSH 窗口里连目标机本地数据库。

## 10. 已确认（2026-10-09）

1. 名字叫「应用」。
2. 右栏与左侧栏入口都在 P1 做。
3. 后端依赖由应用自带，不支持原生模块，没有安装步骤。Claude Code 的 mod 也是这个口径：mod 自己的代码跑在无 Node、无 npm 的隔离环境里，只能 import 自己目录下的文件；真要后端就随插件带一个自成一体的 MCP server。
4. 应用把工具分成只读 / 写两类（MCP 的 `readOnlyHint`），写类一律走权限确认。
