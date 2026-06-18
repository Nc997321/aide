# 工作台终端（Quake 式下拉）设计

- 日期：2026-06-18
- 状态：已确认，待写实现计划
- 范围：新增一个通用 shell 终端工作台，与现有 Claude TUI 独立共存

## 1. 背景与目标

Aide 当前只有 Claude TUI（中间面板，由 PTY 跑 `claude --resume`）作为"干活的机器"，缺少一个供用户**手动敲命令**（`git`、`npm`、构建、看日志）的通用终端工作台。

本设计新增一个 **Quake 式下拉终端**：按快捷键从窗口顶部瞬时滑下一块终端浮层，再按收起。它不是 Claude 终端的外壳改造，而是一个**独立的、单一常驻的 shell 终端**。

### 核心特征

- **不占布局**：纯浮层 overlay，收起后不留痕迹，Claude TUI 全屏可用。
- **常驻**：收起只是隐藏 DOM，shell 进程一直活着，命令历史和输出全保留。
- **浮动胶囊外观**：四周留边、圆角、深阴影浮起，mac 风三圆点顶栏。
- **OS 感知 + 可配置 shell**：Windows 默认 PowerShell，Linux 默认 bash，用户可在设置中改路径。

## 2. 交互模型

| 行为 | 说明 |
|---|---|
| 召唤/收起 | `Ctrl+\`` toggle。`Esc` 也可收起。全局快捷键，无视当前焦点。 |
| 动画 | 从顶部 `translateY(-100% → 0)` 滑下，180ms ease-out；收起反向。 |
| 焦点 | 显示时聚焦 xterm；收起时把焦点还给之前活跃的 Claude 终端/预览。 |
| 持久 | 收起不杀进程。面板始终保留同一个 shell 实例（应用生命周期内）。 |
| Shell 退出 | 用户敲 `exit` 或进程意外退出 → 面板内显示「Shell 已退出，按 Enter 重启」遮罩，清掉 PTY，可重启。 |
| 拖拽 | 顶栏整条可上下拖拽改高度（高度存到设置，记忆）。 |
| 清屏 | `⌫` 按钮 → `terminal.clear()`，只清前端缓冲，不杀进程。 |
| 关闭 | `✕` 按钮 → 杀 shell 进程并收起面板；下次 `Ctrl+\`` 重新拉起新 shell。 |

### 显隐时序

1. 首次按 `Ctrl+\``：若 shell 未启动 → `pty_spawn_shell` 拉起 → 展开面板 → 聚焦。
2. 再次按 `Ctrl+\``：仅隐藏 DOM（进程保留）。
3. 再按：展开，焦点回到 xterm。

## 3. 外观 · 浮动胶囊

面板从顶部下拉，但**四周留 8–10px 边距、8px 圆角、深阴影浮起**，不顶满窗口边缘。

- **顶栏 20px**：左侧三个 mac 风圆点（装饰，红/黄/绿），右侧显示当前 shell 名（如 `PowerShell` / `bash`）+ 小字 `⌫` `✕` 按钮。顶栏整条可拖拽改高度。
- **主体**：xterm 终端，撑满剩余空间。
- **配色/字号/字体**：复用 `useSettings`，与 Claude 终端统一（Catppuccin Mocha）。
- **z-index**：高于三栏布局，低于模态弹窗（SettingsPanel 等）。
- **宽度**：`calc(100% - 2*边距)`，居中。**高度**：默认约 45% 窗口高，可拖拽，记忆到设置。

## 4. Shell 与 OS 感知

启动时按 OS 选默认 shell，cwd = 当前工作区 `path`（`WorkspaceState`）。

| OS | 默认 shell | 探测顺序 |
|---|---|---|
| Windows | PowerShell | `pwsh.exe`（PS7，PATH）→ `powershell.exe`（系统自带） |
| Linux | bash | `$SHELL` 环境变量 → `bash` → `sh` |

- **可配置**：设置新增 `shell_path` 字段。空 = 自动探测；填了就直接用该路径（跳过探测）。
- **OS 区分在 Rust 侧** `pty_spawn_shell`：若 `shell` 参数为空，按 `cfg(target_os)` 选默认探测逻辑。
- **顶栏 shell 名标签**：前端从实际使用的 shell 路径推导显示名（取文件名主干，如 `pwsh.exe` → `PowerShell`，`bash` → `bash`）。
- **未找到**：探测全失败 → 面板内提示「未找到默认 shell，请在设置中配置 shell_path」，不启动 PTY。

## 5. 架构

### Rust 侧（复用现有 PTY 基础设施）

现有 `pty_spawn_claude` 是 Claude 专用（跑 `claude --resume`）。新增一个**通用 shell 启动命令**：

| 新命令 | 参数 | 说明 |
|---|---|---|
| `pty_spawn_shell` | `session_id, rows, cols, cwd, shell` | 启动任意 shell 程序，复用 `PtyManager` |

`pty_write` / `pty_resize` / `poll_pty_output` / `pty_kill` **全部复用**，无需新增 —— 它们本就按 session_id 寻址，工作台用保留 id `"__workbench__"`。`pty-exit` 事件也会为工作台触发，前端按需处理（显示退出遮罩）。

#### ⚠️ Windows 坑点说明（已核实）

CLAUDE.md 中 `CREATE_NO_WINDOW` 规则针对的是 `std::process::Command::new()`（git.rs/marketplace.rs/filesystem.rs），**不适用于 PTY 启动**：portable-pty 0.8.1 在 Windows 用 ConPty，ConPty 创建的是不可见 pseudo-console，不会弹出控制台窗口（现有 `claude` 启动即如此）。且 portable-pty 0.8.1 的 `CommandBuilder` 并未暴露 `creation_flags`。因此 `pty_spawn_shell` **无需也无法**设 `CREATE_NO_WINDOW`。

但需注意现有 `spawn_command` 在 Windows 会给命令名追加 `.cmd`（line 49-50，专为 `claude` → `claude.cmd` 设计）。`pty_spawn_shell` 解析出的已是完整路径（`powershell.exe` / `bash.exe`），**绝不能走 `.cmd` 追加逻辑**，否则拼成 `powershell.exe.cmd` 启动失败。因此 `pty_spawn_shell` 必须用独立的 CommandBuilder 构造路径，不复用 `spawn_command` 的 `.cmd` 分支。

#### Shell 路径探测（Rust 侧 `pty_spawn_shell` 内）

新增依赖 `which = "7"`（Cargo.toml），用于在 PATH 上解析可执行文件。

```
if shell 参数非空 → 直接用
else:
  #[cfg(windows)]:
    1. which::which("pwsh.exe")   // PS7
    2. which::which("powershell.exe")
    3. 失败 → 返回错误
  #[cfg(not(windows))]:
    1. env var SHELL（非空则用）
    2. which::which("bash")
    3. which::which("sh")
    4. 失败 → 返回错误
```

cwd 直接传当前工作区 `path`。

### 前端侧

| 文件 | 职责 |
|---|---|
| `components/WorkbenchTerminal.vue` | 浮层面板：xterm 容器 + 浮动胶囊顶栏（三圆点 + shell 名 + `⌫`/`✕`）+ 拖拽改高 + 退出遮罩。非 scoped 样式（同 TerminalPanel 约定）。 |
| `composables/useWorkbenchTerminal.ts` | 单例：管理唯一 xterm 实例 + PTY 生命周期 + toggle 显隐 + 独立 100ms 轮询 + 拖拽高度记忆 + shell 退出处理。 |
| `App.vue` | 注册全局 `Ctrl+\`` keydown → toggle；渲染 `<WorkbenchTerminal>`（与三栏布局平级，`position: fixed` 浮层）。 |
| `useSettings.ts` / `settings.rs` | 新增 `shell_path` 字段（可空）。 |

#### 轮询

工作台 shell 存活期间**始终轮询**（收起也轮询），避免缓冲区堆积、展开时一次性灌爆 xterm。复用现有 `poll_pty_output` 拉取模式，独立 100ms `setInterval`。

#### xterm 实例

theme/字号/字体复用 `useSettings`（与 Claude 终端一致）。`ResizeObserver` 监听面板宽度 → `pty_resize`；高度变化只改 xterm 可视行数。

#### 工作区切换

shell **不重启**，保持当前 cwd。未来可加「cd 到工作区」按钮（不在本期范围）。

## 6. 边界 & 错误

- **Shell 未启动时按 `Ctrl+\``**：首次展开自动 `pty_spawn_shell` 拉起，后续 toggle 只显隐。
- **Git Bash / PowerShell 未找到**：探测全失败 → 面板内提示配置 `shell_path`，不启动 PTY。
- **窗口缩放**：`ResizeObserver` → `pty_resize`。
- **焦点冲突**：`Ctrl+\`` 全局键，即便焦点在文件树输入框也响应（`Ctrl+\`` 不与文本输入冲突）。
- **应用退出**：`cleanup()` 里 `pty_kill("__workbench__")`。
- **shell 退出**：`pty-exit` 事件 → 前端显示退出遮罩，清 PTY 引用，等待用户按 Enter 重启。

## 7. 不在本期范围（YAGNI）

- 多 tab / 分屏（已明确选单一常驻 shell）。
- 工作区切换时自动 cd 到新工作区。
- shell 历史命令搜索 / 命令面板。
- 主题切换（暂统一 Catppuccin Mocha）。

## 8. 触及文件清单

新增：
- `src/components/WorkbenchTerminal.vue`
- `src/composables/useWorkbenchTerminal.ts`
- `src-tauri/src/commands/` 下 `pty_spawn_shell` 命令（加到 `pty.rs`）

修改：
- `src/App.vue`（全局快捷键 + 渲染浮层）
- `src/composables/useSettings.ts` + `src-tauri/src/commands/settings.rs`（`shell_path` 字段）
- `src/types.ts` / `AppSettings` 结构（`shell_path`）
- `src/api.ts`（`ptySpawnShell` 封装）
- `src-tauri/src/lib.rs`（注册新命令）
- `src-tauri/Cargo.toml`（新增 `which = "7"` 依赖）
