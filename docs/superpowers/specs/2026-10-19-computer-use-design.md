# 电脑操作（computer use）：让 agent 像人一样操作 Windows 桌面

日期：2026-10-19
状态：**设计中**
来源：用户提供的《Aide Windows 电脑操作系统：技术架构与 MVP 实施方案》（下称「原方案」）。本文是它按 Aide 现有架构与红线改写后的落地版；
与原方案不同的取舍逐条写在 §11。

## 1. 要解决的问题

用户想让 Aide 像人一样用电脑：看屏幕、认界面、点鼠标、敲键盘，做完一步看一眼对不对，再做下一步。
**范围是「人在几秒内能做完的一步」都要能做**——除了游戏这类拼反应速度的操作，任何桌面应用都算在内。
QQ、记事本只是例子；用户甚至希望 Aide 能操作一个终端窗口，和里面跑着的另一个 agent 对话。

今天 Aide 只能操作自己的内嵌浏览器（aide-browser）。桌面上其他应用它看不见也碰不到。

## 2. 目标 / 非目标

**目标**

- **通用**：工具面里不出现任何应用名词。验收尺同 aide-browser：**换一个应用，工具代码一行不动**；
  「某个应用怎么用」是 skill reference 里的资料，不是工具能力。
- **每一步 5 秒内**：从「看一眼」到「做一步并知道结果」的工具耗时，要把绝大部分时间留给模型思考（预算见 §7）。
- **闭环**：每个动作绑定它所依据的观察；界面变了就拒绝执行、要求重看；没有证据不报成功。
- **用户始终能接管**：用户一动鼠标键盘，agent 立即停手；有急停热键；agent 在操作时屏幕上看得见。
- **WSL / SSH Host 的会话一样能用**：agent 在哪台 Host 上跑都行，操作的是用户眼前这台 Windows。
- **跨平台红线**：Windows 先实现；macOS / Linux 能编译，调用时如实回「此平台暂不支持」。

**非目标（v1）**

- 游戏、实时性操作（拖拽类连续手势 v1 也不做，见 §12）。
- **系统安全边界内碰不到的东西**：以管理员身份运行的窗口（UIPI 拒收普通权限进程的输入）、UAC 安全桌面、锁屏、
  受保护内容（DRM 画面截出来是黑的）。遇到时**如实回报「碰不到」**，不尝试绕过。用户已确认接受。
- 独立桌面（Windows Sandbox / 独立用户会话 / VM）：v1 只操作当前真实桌面，接口留口子（§10）。
- 本地视觉模型分层：v1 让会话自己的模型直接看截图（§11-④）。
- 让 agent 执行任意脚本来控制桌面（原方案 §8.2 同口径）。

## 3. 总体落位：照搬内嵌浏览器那条桥

Aide 已经有一条形状完全一样的路：sidecar 里的工具发一条查询事件，**GUI 进程**（桌面 Rust）拦下来执行，
结果回写给 sidecar。电脑操作照抄，不新开 Named Pipe、不新开进程：

```
agent（Claude Agent SDK，任一 Host 上的 sidecar）
  │  mcp__aide-computer__computer_*            ← agent-sidecar/src/extensions/computerTools.ts
  │  emit chat-event {type:"computer_query", request_id, op, ...}
  ▼
本机 Host：AgentHooks.intercept（src-tauri/src/runtime/hooks.rs）
远程 Host：remote_workspace::on_host_event → host_window::answer_computer_query
  ▼
GUI 进程的执行器（src-tauri/src/computer/）
  策略层：桌面输入锁 · 观察版本 · 元素引用表 · 接管检测 · 急停
  端口：Screen / Accessibility / Input / WindowManager
  适配器：Windows（UIA + SendInput + 截屏）｜ 其他平台：unsupported
  ▼
回包 {cmd:"computer_result", request_id, ...}
  本机：经 runtime stdin ｜ 远程：agent_tool_result（aide-core 的 GUI_TOOL_RESULTS 白名单加一项）
```

**为什么执行器在 GUI 进程，不在 Host（aide-core）**：屏幕在用户眼前那台机器上，而 Host 可能在 WSL 或 SSH 机器上。
「操作这台电脑」是 GUI 前门的能力，和内嵌浏览器同类（docs/host-model.md P1e 的口径）。
这也让 aide-core 继续守「无系统 C 库、单静态二进制」。

**命名**：用 `computer` 而不是原方案的 `desktop`——`agent-sidecar/src/desktop/` 已经是「桌面 UI 协议层」
（jumpQueue / automation），同名会混。

**sidecar 职责边界**：工具定义属于 extensions（可选、按宿主装配），执行在 GUI；engine 不动。

### 3.1 改动清单

| 位置 | 内容 |
|---|---|
| `agent-sidecar/src/extensions/computerMcp.ts` | 注册 `aide-computer` server、instructions、allow 规则 |
| `agent-sidecar/src/extensions/computerTools.ts` + `computer/` | 工具定义、桥客户端（request_id 配对，同 `browserClient.ts`）、结果格式化 |
| `agent-sidecar/src/engine/session-worker/queryContext.ts` / `queryOptions.ts` | 挂载 server；只把观察类工具加进 allowedTools |
| `src-tauri/src/computer/` | 执行器：`bridge.rs`（解析 / 回包）、`mod.rs`（策略）、`port.rs`、`adapter/windows/*`、`adapter/unsupported.rs` |
| `src-tauri/src/runtime/hooks.rs` | `intercept` 增加 `computer_query` 分支 |
| `src-tauri/src/remote_workspace/mod.rs` + `host_window.rs` | 远程 Host 的转发（同 `answer_browser_query`） |
| `src-tauri/crates/aide-core/src/commands/agent_status.rs` | `GUI_TOOL_RESULTS` 加 `computer_result` |
| `src-tauri/Cargo.toml` | `windows` crate 增加 UIA / 输入 / 截屏相关 features（仅 `cfg(windows)`） |
| 前端 / 桌面壳 | 屏幕顶部提示条（§5.5）、`useCustomizations` 登记内置 MCP 镜像 |

## 4. 工具面

五个工具。原则同 aide-browser：**失败回文本、不抛错，文本里写下一步该怎么做**；图像只在明确要时给。

### 4.1 `computer_windows` — 列窗口（只读）

返回顶层可见窗口：`window_id`（句柄转字符串）、标题、进程名、pid、是否前台、是否最小化、位置尺寸、
**是否以管理员运行**（是 → 标「碰不到」，免得 agent 白费一轮）。

### 4.2 `computer_window` — 窗口级动作（需授权）

`action`：`launch`（按名字匹配开始菜单里的应用并启动，等它的窗口出现后返回 `window_id`）/ `focus` /
`minimize` / `maximize` / `restore` / `close`。

`launch` 单独做成动作而不是让 agent 按 Win 键敲名字：后者要多三四步、每步都可能被弹窗打断，5 秒预算扛不住。
从 WSL / SSH Host 来的会话也没有 Windows 的 shell 可用。

### 4.3 `computer_read` — 看一眼（只读）

参数：`window_id`（缺省 = 前台窗口）、`screenshot?: boolean`、`text_tail?: number`。

返回：

1. **观察版本号** `obs`（每个窗口单独递增）。
2. 窗口信息 + 当前焦点元素。
3. **裁剪后的控件树**，缩进文本，每个可操作或有内容的元素一行，带引用号：
   ```
   [e12] Edit "文件名:" value="新建文本文档.txt" focused
   [e13] Button "保存(S)"
   [e14] Button "取消"
   ```
   裁剪规则：去掉无名字且无交互能力的布局容器（子元素提上来）、去掉屏幕外元素、单次读取有元素数与耗时上限，
   超出时截断并写明「还有多少没列、怎么缩小范围」。
4. **大段文字控件**（文档、终端、聊天记录）走 UIA TextPattern 取可见文字，不逐行列元素；`text_tail` 控制取末尾多少行。
   **终端就是靠这个读的**：Windows Terminal 和 conhost 都提供 TextPattern，不需要识别截图里的字。
5. `screenshot: true` 时附一张**只含该窗口**的图（最长边压到 1280），并说明图像坐标与窗口的换算。
   控件树读不到东西的应用（自绘界面、部分游戏启动器）就靠这张图。

### 4.4 `computer_act` — 做一小串动作（需授权）

```ts
{
  window_id: string;
  intent: string;          // 一句话说明这串动作要达成什么，审批卡片与日志里展示
  steps: Step[];           // 1..8 步
}
type Target =
  | { ref: string }                          // 来自 computer_read 的 [eN]
  | { name: string; role?: string }          // 按可见名字找，多个命中 → 失败并列出候选
  | { x: number; y: number; obs: number };   // 截图坐标，必须带它所依据的观察版本
type Step =
  | { do: "click" | "double_click" | "right_click"; target: Target }
  | { do: "type"; text: string; target?: Target }   // 有 target 先聚焦它
  | { do: "press"; keys: string }                    // "ctrl+s"、"enter"、"alt+f4"
  | { do: "scroll"; target?: Target; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { do: "set_value"; target: Target; value: string }; // UIA ValuePattern，不走键盘
```

执行规则：

- **每步执行前都校验**：窗口还在、目标元素还在且名字 / 类型没变；坐标目标要求 `obs` 仍是该窗口最新版本、窗口尺寸没变。
  任一不满足 → **停在这一步**，返回「第 N 步没执行：界面变了」并附当前状态摘要。不拿旧坐标去碰运气。
- **能不动鼠标就不动**：引用目标支持 UIA 的 Invoke / Toggle / SelectionItem / ExpandCollapse 时直接调用，
  不抢前台、不移动光标；否则把窗口带到前台、在元素中心发真实鼠标事件。
- **打字用 Unicode 注入**（`KEYEVENTF_UNICODE`）：中文等任意字符都不经过输入法，结果确定。
  不默认走剪贴板，避免覆盖用户剪贴板。
- **做完自动回报变化**：最后一步后等界面静下来（最多 300 ms，或 UIA 结构 / 焦点事件停止），返回：
  前台窗口、焦点元素、新开 / 关掉的窗口、控件树相对执行前的增删改（有上限）、新的 `obs`。
  多数时候 agent 不用再单独看一眼。
- 动作只表示「已提交」，不表示「达到目的」——是否成功由 agent 根据回报或再看一眼判断（instructions 里写明）。

### 4.5 `computer_wait` — 在执行器里等（只读）

条件（一次一个）：`window_appears {title?, process?}` / `window_gone` / `element_appears {name, role?}` /
`element_gone` / `text_contains {text}` / `text_stable {quiet_ms}` / `focus_changes`。
默认超时 10 s，上限 60 s；执行器内部轮询（约 150 ms）或订阅 UIA 事件，**不让模型自己反复截图**。

`text_stable` 专为终端里边想边输出的对象准备：文字在 `quiet_ms` 内不再变化才返回，返回时附上新增的文字。

超时返回当前状态，不当错误处理。

## 5. 策略层（GUI 执行器内）

### 5.1 挂载：不设用户总开关

**不做「允许 agent 操作这台电脑」开关**（用户 2026-10-19 决定）。工具在可信工作区默认挂载，本机 / WSL / SSH 的会话一视同仁。
操作员级开关 `AIDE_COMPUTER_TOOLS=off` 同 aide-browser，直接不挂载；受限（不信任）工作区不挂载。

「GUI 与 Host 之间的跨界必须显式、用户看得见」由两件事保证：**agent 碰电脑时屏幕上一定有提示**（§5.5），
**会改东西的动作走权限审批**（§6）。

### 5.2 桌面输入锁

同一时刻只有一个会话能做动作（`computer_act` / `computer_window`）。锁跟着会话 id，
该会话一轮结束或 30 s 没有动作就释放。别的会话来做动作 → 回「电脑正被会话 X 使用」。只读工具不需要锁。

### 5.3 用户接管 = 立即停手

agent 持锁期间，执行器装底层鼠标 / 键盘钩子，用 `LLMHF_INJECTED` / `LLKHF_INJECTED` 区分「用户真按的」与「我们注入的」。
一旦有真实输入：

- 正在执行的 `computer_act` 停在当前步，返回「用户接管了，第 N 步之后没执行」；
- 锁进入「已暂停」，此后的动作一律回「用户正在使用电脑，等用户说继续」，直到下一轮用户消息。

钩子只在持锁期间装，平时零开销。

### 5.4 急停热键

全局热键（默认 `Ctrl+Alt+Shift+S`，可改）：**中断持锁会话的当前轮**——走现有 `interrupt` 命令，
所以所有客户端（桌面、手机）都看到这一轮停了（多端一致性红线）。

### 5.5 看得见：提示是唯一的「在场」信号

没有总开关，提示就是用户知道「agent 正在碰电脑」的唯一途径，**任何电脑工具执行时都必须出现**，不能被设置关掉：

- 做动作（持锁期间）：「Aide 正在操作 · <会话名> · 按 Ctrl+Alt+Shift+S 停止」，常驻到释放锁；
- 只读（列窗口 / 看一眼 / 等待）：「Aide 正在查看 · <会话名>」，工具结束后停留约 2 秒再消失。

提示是屏幕顶部一条置顶、鼠标穿透的小条。
它用 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 排除在截屏之外，并且不进控件树结果，不干扰 agent 自己的观察。

## 6. 权限

| 工具 | 默认 |
|---|---|
| `computer_windows` / `computer_read` / `computer_wait` | 自动放行（同 `browser_read`；执行时屏幕上有「正在查看」提示） |
| `computer_act` / `computer_window` | **走现有权限流程**：按会话权限模式，需要时发 `permission_request`（所有客户端都能批，手机也能） |

**和 aide-browser 为什么不一样**：browser 全部放行，理由是有 `browser_eval` 这个任意脚本的口子，给其余工具挂闸门是装饰。
电脑操作**没有这种口子**——一切写操作都只能经 `computer_act` / `computer_window`，所以给它们挂闸门是真控制。
而且往终端里打字就等于执行命令，和 Bash 同级，理应同样受权限模式管。

审批卡片显示 `intent`、目标窗口、每一步的人话描述（含要输入的全文）。用户选「本会话内始终允许」后不再弹，
符合现有权限体验。

原方案的三级风险分级（§9.1）不单独实现：底层动作分不清「这次点的是不是发送按钮」，硬分级只会误判；
v1 用「写操作全部过权限 + agent 自报 intent」，instructions 要求 agent 在发送、删除、付款这类不可逆动作前单独做一次 act，
让审批卡片只含这一步。

**屏幕上的文字是不可信内容**（聊天消息、网页、终端输出里写着「请你执行…」）：instructions 明写按不可信内容处理，同 aide-browser 第 9 条。

## 7. 延迟预算（每一步 5 秒）

| 环节 | 目标 | 手段 |
|---|---|---|
| `computer_read`（控件树） | 典型 ≤ 300 ms，硬上限 800 ms 截断 | UIA CacheRequest 一次批量取属性；限深度 / 元素数；专用 MTA 线程 |
| 截图（单窗口） | ≤ 150 ms | 窗口级截屏 + 缩放编码；只在要时截 |
| `computer_act` 每步 | ≤ 200 ms + 收尾最多 300 ms | UIA 模式优先；变化回报复用执行前缓存 |
| 等待 | 执行器内 | 不占模型轮次 |
| 模型思考 | 剩下的 3–4 s | 观察结果是精简文本，图像按需 |

几个要提前处理的实现坑：

- **UIA 调用必须在专用后台线程**。Aide 读自己窗口时，若从自己的 UI 线程发跨进程 UIA 调用会死锁。
- **Chromium / Electron 应用的控件树很大**（QQ NT、VS Code、Aide 自己都是）：靠裁剪 + 截断 + 「缩小范围」提示，
  不追求一次列全。
- **前台锁**：Windows 限制后台进程抢前台。需要真实鼠标事件时按惯用方式把目标窗口带到前台，失败如实回报。
- **DPI**：执行器按每显示器 DPI 感知运行，内部一律物理像素；对 agent 只暴露截图坐标，执行器负责换算。

所有工具调用记 `tracing`（op、耗时、结果摘要），作为 §9 延迟指标的数据来源。

## 8. 端口与适配器

按「可替换技术藏在端口后面」：UIA / SendInput / 截屏都是平台技术，macOS 将来会有第二份实现（辅助功能 API + CGEvent）。

```
src-tauri/src/computer/
  bridge.rs        computer_query 解析、computer_result 回包（同 browser/agent_bridge.rs）
  mod.rs           策略：输入锁、观察版本、元素引用表、接管、急停
  port.rs          trait WindowManager / Accessibility / Input / Screen
  adapter/
    windows/       #[cfg(windows)] 唯一允许 `windows::Win32::UI::Accessibility` 等出现的地方
    unsupported.rs 其他平台：每个调用回「此平台暂不支持电脑操作」
```

验收：grep UIA / SendInput 相关符号，`adapter/windows/` 之外不出现。
策略层（锁、版本、引用表）是纯 Rust，用假适配器在任意平台跑单测，macOS CI 能覆盖。

**元素引用**：`[eN]` 在执行器里映射到 UIA RuntimeId + 名字 + 类型 + 位置。执行时按 RuntimeId 找回元素并核对名字、类型；
找不到或对不上即判「界面变了」。引用表按窗口保存，窗口关闭即清。

## 9. 验收

**A. 记事本**：「打开记事本，写一段含中文的文字，保存到 X，告诉我保存好了没有」。
agent 用 launch → act（type）→ act（ctrl+s，在保存对话框填路径、确认）→ 读回文件内容核对 → 报告。

**B. 操控终端对话**：「打开终端，启动 claude，问它一个问题，把它的回答告诉我」。
考的是 TextPattern 读终端、`text_stable` 等对方写完、Unicode 输入。中途用户动一下鼠标 → agent 停手并如实报告。

**C. 通用性**：不改一行工具代码，再做三个不同类型的应用各一个小任务（如：资源管理器里重命名文件、计算器算一个数、
在 Aide 自己的界面里切到另一个会话）。

**指标**（在固定机器、分辨率、缩放下统计）：

- 单步工具耗时中位数 ≤ 1 s（不含模型思考）；
- 未经授权的写操作 0 次；用户接管后继续注入输入 0 次；
- 没有证据就报成功 0 次；结果不确定时重复执行不可逆动作 0 次。

v1 的真机验收只能在 Windows 上做（开发机 WSL 只能跑编译与策略层单测）。

## 10. 分期

**P1 — 本机闭环**：§4 五个工具、§5 全部（锁、接管、急停、提示条）、§6 权限、本机 Host 的桥、
其他平台的 unsupported 适配器。验收 A + B。

**P2 — 打磨与推广**：WSL / SSH Host 的转发；`computer-use` skill（工作流 + 常见应用的使用经验作为 reference）；
Chromium / Electron 应用的控件树裁剪调优；验收 C；按 tracing 数据压延迟。

**以后（各自单独设计）**：独立桌面（Windows Sandbox / 独立用户会话 / VM，在 `port.rs` 之上加一层会话选择）；
本地视觉模型（等出现「主模型看图太贵或不能看图」的实际需求再做）；macOS 适配器；拖拽等连续手势。

## 11. 与原方案的差异

| # | 原方案 | 本文 | 理由 |
|---|---|---|---|
| ① | TS 控制层 + 独立执行器 + Named Pipe | sidecar 工具 + GUI 进程执行器，走现有查询桥 | 仓库里已有同形的浏览器桥，免新进程、新通道和另一套访问控制 |
| ② | 执行器位置未定 | 必须在 GUI 进程 | Host 可能在 WSL / SSH 上，屏幕在用户眼前这台机器 |
| ③ | WinApp CLI / pywinauto / PyAutoGUI 适配器 | Rust 直接调 Windows API，放在适配器里 | 不引入预览期工具和 Python 运行时；`windows` crate 已是依赖 |
| ④ | 本地视觉模型 + 云端升级 | v1 会话模型直接看截图；控件树优先 | 主模型本来能看图；控件树是文字，只能处理文字的模型在控件可读的应用里也能用 |
| ⑤ | 独立 Controller 状态机 | 循环由 agent 自己驱动，执行器只管校验与执行 | Agent SDK 本身就是观察→规划→执行循环；再造一个状态机是重复 |
| ⑥ | 三级风险分级 | 写操作全部过现有权限流程 + agent 自报 intent | 底层动作分不清语义，硬分级会误判；复用权限即得多端审批 |
| ⑦ | 单独审计存储 | tracing + 会话转录 | 转录里已有每次工具调用与结果 |
| ⑧ | 工具名 `desktop_*` | `computer_*` | 避开 `agent-sidecar/src/desktop/` 的同名 |

不用 Anthropic 原生的 computer use 工具：它是按截图坐标设计的、绑定 Anthropic 模型；Aide 的会话可能跑在别家供应商上，
而且「控件树优先」比纯截图快且稳。

## 12. 待定

1. 拖拽（文件拖进窗口、滑块）：v1 不做；若验收 C 中频繁需要再加 `drag` 步骤。

已定（2026-10-19）：

- 不设用户总开关、不分「仅本机会话」档；急停热键默认 `Ctrl+Alt+Shift+S`，用户认可。
- **不做剪贴板粘贴**：Unicode 注入每字两个事件、`SendInput` 可整批提交，执行器分批发（批间极短间隔，防目标应用丢字），
  每秒上千字，长文本不是瓶颈。instructions 只陈述 `type` 的通用语义，**不写任何应用的特例**：
  文本里的换行按回车键发出；应用对按键的任何反应（含自动补全）都照常发生，结果以动作回报为准。

**原则：不为特定场景 / 应用打补丁**（用户 2026-10-19）。工具、instructions、执行器里只放所有应用通用的能力与语义；
某个应用的使用经验若将来要沉淀，放进 skill 资料，且只在确有共性时才抽成通用功能。
