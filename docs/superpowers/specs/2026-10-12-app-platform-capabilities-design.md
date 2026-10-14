# 侧栏应用的平台能力扩展：让应用够得着工作区、进程和 Aide 自身

> 状态：**已实现，未提交**（2026-10-13）。自动化测试通过；界面与 Windows 上的行为还没有真机验证，见 §9。
> 前置：[侧栏应用设计](2026-10-09-sidebar-apps-design.md)（下称「原设计」）。本文只加能力，不改原设计的隔离模型、同意流程和目录布局。

## 1. 问题

用户想让 agent 做一个 IDE 里那样的构建 / 任务面板：列出工程里的模块和可执行的任务，点一下就跑，看着日志滚动，失败了能跳到出错的文件。按现在的应用平台做不出来，卡在三处（均已对照代码核实）：

| 缺口 | 现状 | 出处 |
|---|---|---|
| 应用不知道工作区在哪 | `host.info` 只返回 `{ os, source }`；后端的工作目录是应用自己的文件夹，环境变量只有 `AIDE_APP_DATA` | `apps/bridge.rs`、`apps/servers.rs` |
| 没有长任务和实时输出 | 界面调后端是一问一答，`CALL_TIMEOUT` = 120 秒；后端 10 分钟没人调被回收，应用文件一改就重启 | `apps/servers.rs` |
| 界面不能运行命令 | 桥里没有进程类方法（有测试专门钉住 `process.run` 不存在） | `apps/bridge.rs` |

这不是某一个构建工具的问题。构建工具、脚本运行、测试运行器、日志查看、TODO 汇总、提交助手，凡是「围绕当前工程干活」的面板都撞同样的墙。Aide 的 Host 本身已经有这些能力（终端与运行配置、搜索、git、LSP），只是没有向应用开口。

顺带一处与原设计的出入：原设计 §3 写 `aide.host` 返回「Host 类型（本机 / WSL / SSH）、系统」，实现只返回了系统和应用来源，没有 Host 类型。

## 2. 原则

1. **能开口子的只开口子，不重写实现。** 应用桥是 Host 命令表的又一个前门（CLAUDE.md「一张命令表，多个前门」）。新方法尽量落到一个已有的 Host 能力上，桥只做参数收窄和权限判定；下文每项都写明复用哪个现有命令。**例外是运行命令（§3.3）**：复核后确认现有实现承载不了，要新写一个进程池。
2. **权限裁决仍只在 `apps::bridge` 一处。** GUI 侧能力（打开文件、通知）沿用 `composer` 的做法，在前端按清单判。
3. **一项能力一个权限，同意界面说人话。** 最重的是运行命令，同意时必须写明「可以在你的工程里执行任意命令」。
4. **边界是面板所在的那个工作区，由调用显式带上，不是 Host 当时的「活动工作区」。** 一个窗口里多个工作区的会话并存（混合 tab），「活动工作区」只是文件树和侧栏当下显示哪个项目，随时会变；拿它在调用落地时现取，就是会话侧已经踩过的「跑错项目」。做法与会话的 `workspaceRoot` 一致：外层 GUI（不是应用的 iframe）在每次调用里带上面板加载时的工作区根，Host 校验它是已登记的工作区（或日常目录）且目录还在才用；没带就是「没有打开工作区」，**不回落**活动工作区。读写文件不要求工作区受信任（与原先一致），运行命令要求（§3.3）。路径一律相对该根，越界即拒，规则与 `wsfs.rs` 现有的一致。现有的 `fs.read` / `list` / `write` 一并改成这样（见 §7 第 6 项）。
5. **应用收到的是投影，不是原始数据。** 沿用 `session:read` 的口径：给「发生了什么」，不给对话正文、工具入参和输出。
6. **手机端不变。** 新增的 `app_*` 能力不进 `aide-link` 暴露目录；应用事件只发给桌面窗口。

## 3. 第一批：补上就能做构建 / 任务面板

### 3.1 工作区信息

```js
const ws = await aide.workspace.info();
// → { name, root, trusted, host: "local" | "wsl" | "ssh" }   没有打开工作区时 → null
```

- 权限：`workspace:read`。不需要任何权限的 `host.info` 不加路径，否则只申请了存储的应用也能看到用户的本机目录结构。
- 后端：启动时多给一个环境变量 `AIDE_WORKSPACE_ROOT`。会话用的那一份取会话自己的 cwd。
- 界面用的那一份**按「应用 × 工作区」各起一个**，工作区根在它一生中不变；用户切走不重启、切回来还是那一个，空闲回收照旧。池子的键从应用 id 改成（应用 id, 工作区根）。
- 用户切换显示的工作区时，面板由 Aide 重载（§7 第 6 项），应用启动时取一次即可，不提供变化回调。
- 顺带把 `host.info` 补上 Host 类型，兑现原设计。

### 3.2 应用事件通道（Host → 界面）

现在唯一推给应用的是 GUI 侧的 `session` 事件。新增一条由 Host 发起的通道，后面的进程输出、文件变化、工作区切换都走它。

- Host 发事件 `app-event { appId, channel, payload }`，GUI 只转给对应应用的 iframe（外层已有按应用隔离的 `postMessage` 管道）。
- 界面侧统一成 `aide.on(channel, fn)`，现有的 `session.onEvent` 保持不变。
- **`app-event` 只带小载荷，不带进程输出正文。** Host 的全部事件都进同一个事件总线的留底环（`bus.rs`：5 万条 / 16 MB，先到先止），它同时是手机和 Host 窗口断线续传 `chat-event` 的依据。一次构建的日志灌进去会把对话事件挤出留底，重连就只能报 `gap`。所以进程输出走「事件只报有新输出，正文由界面拉」，见 §3.3。后端通知同理要限单条大小和频率。
- **后端也能推**：后端在 stdout 写一条不带 id 的通知 `notifications/aide/event { channel, payload }`，Host 收到即转发。要改两处（`servers.rs`）：
  - **读取要改成常驻分发。** 现在 `rpc` 独占 `Receiver`，只在调用期间消费，并且把 id 不匹配的行一律跳过——调用之间到达的通知不是积着，而是被下一次调用丢掉。改法是读线程常驻、按 id 把回应分给等待中的调用、把通知转成 `app-event`；`rpc` 的超时判定随之重写。
  - **空闲回收要认事件。** `last_used` 只在调用时更新，只推事件、不被调用的后端 10 分钟后会被别的应用的调用顺手回收。后端发出通知也算活动。
- 限制：单条不超过 16 KB、每个后端每秒不超过 20 条，超出的丢掉；`theme` / `session` / `fs` / `process:*` 是 Aide 自己的频道，后端不能冒用。
- 有了它，后端的长任务不必再塞进一次 120 秒的调用：启动即返回，进度走事件。`CALL_TIMEOUT` 不动。

### 3.3 运行命令

```js
const { runId } = await aide.process.run({
  command: "npm", args: ["run", "build", "--workspace", "core"],
  cwd: "",            // 相对工作区根
  env: { NODE_ENV: "production" },
});
aide.on(`process:${runId}`, (e) => { /* { type:"output", data } | { type:"exit", code } */ });
await aide.process.kill(runId);
await aide.process.list();                    // 本应用还在跑的
await aide.process.attach(runId, { since });  // 面板重载后续上输出
```

- **实现：新写应用进程池（`apps/process.rs`），不复用运行配置那条路。** 原稿打算复用 `run_process_start` → `core.pty.spawn_run_command`，读过实现后确认对不上：
  - 输出是读线程往一个无上限的 `String` 里追加、前端 `poll_output` 取走即清空——没有事件、没有环形缓冲、没有 `since`，`attach` 续传做不出来；面板关着没人取时缓冲一直涨。
  - 退出事件 `pty-exit` 只带 `success: bool`，没有退出码。
  - `launch` 开头会先杀同 id 的旧会话，id 是 `run__<config_id>`；应用进程需要自己的 id 空间。
  - 它只收一条 shell 字符串（`sh -c` / `cmd /c`）。
- 进程仍跑在 Host 上，WSL / SSH 工作区自然在目标机执行。
- 默认走管道而不是 PTY（理由见 §7 第 2 项）；输出按行、带序号进进程池自己的环形缓冲，`attach` 按 `since` 续。
- **输出的投递是「通知 + 拉取」**：Host 只发节流过的 `app-event { channel: "process:<runId>", payload: { head } }`（`head` = 最新序号），`aide_app.js` 收到后用 `attach(since)` 把正文拉回来，再以 `{ type:"output", data }` 交给应用。应用看到的接口不变，正文不经事件总线（原因见 §3.2）。退出事件载荷小，直接带 `code`。
- 权限：`process`，同意卡片上写「在当前工作区里运行任意命令（和你自己在终端里敲的一样）」。**工作区必须受信任**：应用跑的多半是工程自己定义的脚本，在不受信任的仓库里跑它等于执行那个仓库的代码。
- 约束：
  - `cwd` 限在工作区内。
  - 进程归 Host 管，不归面板：面板关了、重载了，进程照跑，输出留在环形缓冲里供 `attach`。
  - **进程记在（应用, 工作区）名下，切换显示的工作区不影响它。** 在 A 工程点了构建再切去看 B，构建照跑；`list` / `attach` / `kill` 和输出通知都只对面板当前所在的工作区生效，切回 A 用 `attach(since)` 续上。
  - 每个应用同时最多 4 个进程（所有工作区合计）；缓冲留最近 5000 行 / 2 MB，没有换行的输出每 8 KB 切一行，`\r` 也算换行；跑完的进程留 10 分钟供面板回来看结果。
  - 输出按行解码：先当 UTF-8，不是就按 GB18030（与读文件同一套判定）——中文 Windows 上不少工具往管道里写 GBK。
  - 结束 = 整棵进程树：Unix 上进程自成一组，先 TERM、3 秒后 KILL；Windows 上 `taskkill /T /F`。
  - 应用被禁用、卸载或 Host 退出时一并结束。工作区自带的开发态应用在切走后即被卸载，它的进程随之结束。
  - 应用起的进程在应用管理处列出（带所属工作区）并可结束，不依赖应用自己的界面。
  - 所有 `Command::new` 按红线加 `CREATE_NO_WINDOW`。
  - 命令由 Host 在 PATH 里解析成可执行文件（`which`，Windows 上会找到 `.cmd` / `.bat` 垫片）；垫片交给标准库的 `Command`，由它包 `cmd /c` 并转义，转义不了的参数它会拒绝而不是硬拼。
- 为什么不让每个应用自己用后端起进程：那样每个应用都要重写一遍进程管理，用户也没有一个统一的地方看到「现在有哪些东西在跑」。

### 3.4 搜索

```js
await aide.fs.find("package.json", { limit: 200 });            // 按文件名 → 相对路径数组（默认 50，最多 500）
await aide.fs.search("TODO", { mask: "*.ts", limit: 500 });    // 按内容
// → { files: [{ file, matches: [{ line, column, lineText, matchStart, matchEnd }] }], total, truncated }
await aide.fs.stat("package.json");                            // { isDir, size, mtime }
```

- 复用：`find_files_by_name`、`search_in_files`（`commands/fs.rs`），已核对实现：
  - `search`：返回的路径本来就相对搜索根，形状可以原样给应用；过滤参数是文件名掩码（`*.ts`），不是路径 glob，接口照此命名为 `mask`；另有 `regex` / `caseSensitive` / `wholeWord` 可透传。
  - `find`：返回的是**绝对路径**，桥要转成相对工作区根再给应用。匹配语义是「文件名相等优先，其次文件名包含」，不是 glob；上限默认 50、最多 500。
  - 两者都遵守 `.gitignore`，`find` 还跳过隐藏文件、最深 20 层——被忽略的目录里的文件找不到，技能文档里要写明。
- 权限：`workspace:read`。
- 解决现在「目录一次只能列一层」的问题：找出多模块工程里所有的工程描述文件不必一层层走。

### 3.5 在编辑器里打开文件

```js
await aide.editor.open("core/src/app.ts", { line: 42 });
```

- GUI 侧能力，走 `useFileResolver().openResolved`，与对话里点文件链接同一条路。
- 权限：`workspace:read`。
- 构建失败、测试失败、搜索结果，点一下跳过去。

### 3.6 文件变化通知

```js
aide.fs.watch((e) => { /* { dirs: ["core/src", …] }  或  { full: true } */ });
```

- 不新起监听。Host 已经在递归监听当前显示的工作区（`aide-workspace/src/watch.rs`），防抖、合并后发 `file-tree-changed`，载荷是「受影响的父目录」数组，空数组表示全量刷新。GUI 把这条现成事件转成相对路径后分给申请了 `workspace:read` 的应用。
- 因此粒度是**目录**，不是文件，也不支持 glob：应用收到通知后自己重新 `list` / `find` / `read`。`.git` 内部的变化不报。
- 只覆盖当前显示的工作区，正好等于面板所在的工作区。

## 4. 第二批：把 Aide 已有的能力接出来

按实际想做的应用再挑，不必一次铺开。

| 能力 | 接口大意 | 复用 | 权限 |
|---|---|---|---|
| git 只读 | `aide.git.status()` / `log()` / `branches()` / `diff(path)` | `git_status`、`git_log`、`git_branches`、`git_diff_files` | `git:read` |
| 代码导航 | `aide.code.symbols(names)` / `definition()` / `references()` / `outline(file)` | aide-lsp 工具走的那条 Host 查询 | `code:read` |
| 会话信息 | `aide.session.current()` → `{ id, title, model }`；本轮用量 | 会话档案与 `context_usage` 事件 | `session:read` |
| 系统通知 | `aide.ui.notify({ title, body })` | `Core::notify` → `system-notification` | `notify` |

## 5. 不做

- 读对话正文、工具入参与输出（可能含密钥和隐私；原设计刻意只给事件骨架）。
- 知识库读写、驱动内嵌浏览器（前者是团队数据，后者带着用户的登录态）。
- 工作区之外的文件。
- 原设计 §3 已排除的：改聊天区 / 编辑器 / 其他面板的渲染，拦截或改写 agent 的工具调用与提示词，应用之间互调。
- **替用户发送消息**：原设计明确排除，本文不推翻。应用想让 agent 干活，仍然是 `composer.fill` 填进输入框、由用户按发送。

## 6. 改动点

| 位置 | 改什么 |
|---|---|
| `aide-core/src/apps/bridge.rs` | 工作区根改由调用带入并校验（已登记、受信任），不再现取活动工作区；方法表加 `workspace.info`、`process.*`、`fs.find` / `search` / `stat`；`Ctx` 带上进程池与事件出口；钉住 `process.run` 不存在的那条测试换一个方法名 |
| `aide-core/src/apps/process.rs`（新） | 应用进程池：起进程（管道，可选 PTY）、命令解析与 Windows 垫片处理、按（应用, 工作区）归属、并发上限、带序号的环形输出缓冲、退出码、随应用停用而结束 |
| `aide-core/src/apps/servers.rs` | 读线程常驻分发（回应按 id 分给调用方、通知转 `app-event`），`rpc` 超时随之重写；通知计入空闲判定；池子的键改成（应用, 工作区根），`Spec` 的环境变量加工作区根 |
| `aide-core/src/apps/manifest.rs` | 权限白名单加 `process`（第二批再加 `git:read` 等） |
| `aide-core/src/apps/mod.rs` | 发 `app-event`（带工作区根）；`app_call` 收工作区根并校验；`app_process_list` / `app_process_kill`；应用不在了（卸载、禁用、开发态随工作区切走）就结束它的进程；`apps::shutdown` 供每扇前门退出时调 |
| `aide-core/src/commands/workspace/mod.rs` | `is_known_workspace_in`：路径是不是登记过的工作区 |
| `agent-sidecar/src/engine/userExtensions.ts` | 会话里的那份后端带上 `AIDE_WORKSPACE_ROOT` = 会话的 cwd |
| `src/components/titlebar/AppProcessIndicator.vue`、`apps/AppProcessList.vue`、`composables/useAppProcesses.ts`（新） | 标题栏的进程徽标、两处共用的清单、清单状态 |
| `src-tauri/src/commands/aide_app.js` | `aide.workspace` / `process` / `on` / `editor`，以及 `fs` 的新方法 |
| `src/composables/appBridge.ts`、`AppPanel.vue` | 每次调用带上面板所在的工作区根；按工作区过滤并转发 `app-event`；把 `file-tree-changed` 转给应用；iframe 的 key 带上工作区（仅 `workspace:read` 应用）；顶条的「运行中」徽标与列表，禁用 / 卸载的连带确认；`editor.open` 的 GUI 侧实现；同意界面的 `process` 文案 |
| `agent-sidecar/src/extensions/appSkill.ts` | 技能文档补新接口和「长任务怎么写」 |
| `docs/examples/aide-apps/task-runner/` | 示例：列出各 `package.json` 的脚本，点了就跑，日志可点跳转，重载后接回正在跑的 |

## 7. 已定事项（2026-10-13）

1. **`process.run` 的命令形状：`command + args` 数组，不经 shell。** 避免应用把从工程文件里读出的名字拼进命令行造成注入。代价：不能直接写管道和重定向；Windows 上常见的构建 / 包管理命令是 `.cmd` 垫片，不经 `cmd /c` 起不来，Host 要自己做「解析可执行文件 + 对垫片包 `cmd /c` 并正确转义」。
2. **输出走管道。** 管道是干净的行输出，应用可以按行解析报错位置，还能拿到真实退出码；Windows 的 ConPTY 输出除颜色码外还混着光标移动和按列宽的重排。PTY 留作可选项（`pty: true` 并带 `cols` / `rows`，给自带终端渲染的应用用），可以晚于第一批。默认没有颜色，需要的应用自己给工具加强制着色的参数。
3. **应用起的进程要出现在 Aide 自己的界面里，两个入口都做**。Aide 没有集中的应用管理页，管理入口是每个应用面板顶上那一条，所以：
   - **标题栏徽标「N 个进程在运行」**：全部应用、全部工作区，按应用分组，每行标所属工作区，点工作区名切过去。没有进程时徽标不出现。
   - **应用面板顶条「运行中 N」**：只管本应用，数字只算当前工作区，另提示别处还有几个。
   - 结束要点两次（第一次变「确认结束」，点别处取消，与现有卸载一致）；结束或跑完的行留几秒显示结果再消失。
   - 禁用 / 卸载应用时若有进程在跑，确认按钮写明「并结束 N 个进程」。
4. **`fs.watch` 在第一批做**，建在现成的文件树监听上，粒度是目录（§3.6）。
5. **`workspace:read` 不拆。** 工作区信息、读文件、搜索、文件变化、编辑器跳转都在它下面。
6. **不再按「单一活动工作区、切换即离开旧工作区」来设计。** 核实结论：窗口里多个工作区的会话并存，会话的工作区归属是自持属性，「活动工作区」只表示当下显示哪个项目。原稿（以及现在的 `apps::bridge`）在调用落地时现取 Host 的活动工作区，是旧模型留下的。调整为：
   - 调用显式带工作区根、Host 校验（原则 4）；现有 `fs.*` 一并改。
   - 应用后端按（应用, 工作区）各起一个，切换不重启（§3.1）。
   - 进程记在（应用, 工作区）名下，切换不影响，切回可续（§3.3）。
   - 工作区自带的开发态应用仍跟着它的工作区走：切走即卸载，进程随之结束。
   - **切换显示的工作区时，Aide 重载申请了 `workspace:read` 的应用面板**；没申请的不动。现状是面板按应用 id 保活、iframe 只在应用文件变了才重载（`AppPanel.vue` 的 `src` 只带 `revision`），已安装的应用切换后会停在旧工程的内容上。重载后应用用 `process.list` / `attach` 恢复状态，不依赖 agent 写的应用记得处理切换。`workspace.onChange` 因此不再需要，从接口里去掉。

## 8. 分期与验收

| 期 | 内容 | 规模（粗估） |
|---|---|---|
| A1 | 工作区信息（§3.1）；调用显式带工作区根；后端按（应用, 工作区）起（原则 4、§7 第 6 项） | 小到中：改的是现有代码，要先做，后面各项都建在它上面 |
| A2 | 应用事件通道 + 运行命令（§3.2、§3.3） | 中偏大：进程池是新写的，后端读取模型要改，主要工作量在这里 |
| A3 | 搜索 + 打开文件 + 文件变化通知（§3.4–§3.6） | 小 |
| B | 第二批，按需 | 逐项评估 |

**验收样例：任务面板。** A1–A3 做完后，在一个多模块工程里对 agent 说「做一个构建 / 任务面板」，只靠 `aide-app` 技能、不另外指点，产出的应用要能：

- 列出全部模块和各自可执行的任务；
- 点一个任务后日志实时滚动，任务跑五分钟不超时；
- 中途可取消；面板关掉再打开能续上正在跑的任务；
- 任务跑着时切到另一个工作区再切回来，任务没断、日志续得上，期间另一个工作区里看不到它；
- 在外部改了工程描述文件，面板里的任务列表自己刷新；
- 报错的行可以点击跳到文件；
- 本机工作区（Windows）与 WSL 工作区各验一次。

单测沿用原设计 §9 的口径：每个新方法缺权限必拒、`cwd` 越界必拒、应用停用后其进程必须结束、带入的工作区根未登记或不受信任必拒。另加：调用之间到达的后端通知不丢；只推事件的后端不被空闲回收；`attach` 按 `since` 续上且不重不漏。

## 9. 实现后还没有验证的事

自动化测试覆盖了 Host 侧的逻辑（进程池、后端事件、工作区校验、搜索）、桥的两半和进程清单的状态；下面这些没有：

- **界面没有实际跑过。** 开发机是 WSL，编不了桌面壳。标题栏徽标、面板顶条的下拉、切工作区时面板重载、`editor.open` 跳转、同意卡片上的新文案，都只过了类型检查和单测，没有人眼看过。
- **Windows 上只验了 Host 侧**：aide-core 在 Windows 上编译通过，`apps::` 的测试全过，其中两条是 Windows 专属的——PATH 里的 `.cmd` 垫片按裸名起得来、带空格和 `&` 的参数原样到达、退出码是真的；结束时 `cmd` 起的子进程一并消失。桌面壳（`src-tauri`）没有在 Windows 上编译，「不弹控制台窗口」也没有人眼确认。
- **验收样例没有跑**：§8 那几条（用 `docs/examples/aide-apps/task-runner`，或让 agent 只靠技能写一个）要在本机工作区和 WSL 工作区各走一遍。
- WSL / SSH Host 窗口：`app-event` 经总线转到桌面这一段没有实测。
- 可选的 PTY 模式没有做（§7 第 2 项说可以晚于第一批）。

## 10. 实现前没有核实、现在仍然成立的事

- §4（第二批）的「复用某命令」只核对了命令存在和大致签名，没有核对返回形状是否适合直接投影给应用。§3.4 的两个已核对。
- 文件树收起或没加载时监听是否还开着，没有看前端；它决定 `fs.watch` 会不会在某些布局下收不到事件。文件树切进日常目录时监听跟着走，这期间工作区里的变化应用收不到。
- 关于 ConPTY 输出形态的判断来自对 ConPTY 的一般了解，没有在本仓库实测；默认已定为管道，只影响可选的 PTY 模式。
- 规模是按改动面估的，不是按工时。
