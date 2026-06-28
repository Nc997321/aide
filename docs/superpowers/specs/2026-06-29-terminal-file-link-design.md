# 设计文档：终端文件路径可点击链接

**日期**：2026-06-29  
**状态**：已批准

## 需求

Claude 在终端回复中会频繁输出文件路径（如 `src/components/FileTree.vue:45`）。用户希望通过 **Ctrl+左键点击** 这些路径，直接在右侧 FileViewer 面板中打开对应文件并跳转到指定行。

## 方案选型

采用 **xterm.js `registerLinkProvider` API**（方案 A）。

- 纯 JavaScript API，在 WebView 内运行，无需原生终端能力
- xterm.js 内置 hover 高亮、文本范围匹配支持
- VS Code 集成终端同样采用此方案

排除方案：
- OSC 8 超链接协议：依赖终端原生支持，WebView 中兼容性不稳定
- 透明 DOM 覆盖层：坐标反算脆弱，维护成本高

## 架构

```
TerminalPanel.vue
  └─ terminal 实例初始化后
        useTerminalLinkProvider(workspacePath, openFile)
          ├─ .registerTo(terminal)
          │     └─ terminal.registerLinkProvider(provider)
          │           ├─ provideLinks(): 正则扫描行文本 → 返回匹配范围
          │           ├─ activate(event): event.ctrlKey → openFile(path, line)
          │           └─ hover(): 显示下划线（xterm.js 默认行为）
          └─ 内部: invoke('file_exists') 验证路径存在性
```

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `src/composables/useTerminalLinkProvider.ts` | 新增 | 封装 link provider 全部逻辑 |
| `src/components/TerminalPanel.vue` | 修改 | 初始化 terminal 后调用 composable |
| `src-tauri/src/commands/filesystem.rs` | 修改 | 新增 `file_exists` 命令 |
| `src/api.ts` | 修改 | 新增 `fileExists()` 封装 |

## 路径匹配规则

### 正则

```
/((?:[\w./\\-]+\/)?[\w.-]+\.(ts|tsx|vue|rs|js|jsx|css|scss|json|md|toml|yaml|yml|sh|py))(:\d+)?/g
```

覆盖场景：
- `src/components/FileTree.vue:45`（相对路径 + 行号）
- `src/components/FileTree.vue`（相对路径，无行号）
- `useTerminalManager.ts:120`（文件名 + 行号）
- `/absolute/path/to/file.ts`（绝对路径）

排除场景：
- `http://` / `https://` 开头 → 跳过（xterm.js 默认 URL 处理）
- 无扩展名的路径 → 不匹配

### 文件存在性验证

hover 触发时异步调用 `fileExists(workspacePath, matchedPath)`：
- 相对路径：拼接当前 workspace 根目录后检查
- 绝对路径：直接检查
- 不存在：不显示下划线，不响应点击（静默忽略）

## 交互行为

| 操作 | 行为 |
|---|---|
| 鼠标悬停在匹配路径上 | 显示下划线（文件存在时） |
| 普通左键点击 | 不响应（不干扰文本选择） |
| Ctrl + 左键点击 | 打开 FileViewer，跳转到对应行 |
| 文件不存在 | 静默，无提示、无报错 |

## useTerminalLinkProvider 接口

```typescript
interface TerminalLinkProviderOptions {
  workspacePath: Ref<string>
  openFile: (path: string, line?: number) => void
}

function useTerminalLinkProvider(options: TerminalLinkProviderOptions): {
  registerTo: (terminal: Terminal) => void
}
```

`TerminalPanel.vue` 在每个 terminal 实例初始化后调用 `registerTo(terminal)`，支持多实例（live sessions）。

## file_exists Rust 命令

```rust
#[tauri::command]
async fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}
```

轻量、无副作用，仅返回布尔值。需加 `CREATE_NO_WINDOW` 标志（若涉及子进程，此处不涉及）。

## 边界与约束

- 每个 terminal 实例独立注册 provider，terminal 销毁时 xterm.js 自动清理
- workspace 路径来自现有 session 状态（`useSettings` 或 session working directory）
- 行号解析：取 `:` 后第一个数字段，忽略列号（如 `:45:12` 只取 `45`）
- 不处理多选文本场景（Ctrl+Click 时若有选中文本则不触发）
