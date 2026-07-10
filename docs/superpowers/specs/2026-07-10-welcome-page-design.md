# Welcome Page 设计

日期：2026-07-10

## 背景

当前所有会话 tab 关闭后，聊天区显示灰字"开始新对话"，没有项目上下文提示，也没有切换工作区的入口。用户要在新文件夹中开始对话，只能离开应用去终端跑 `claude` 命令。

## 目标

关闭全部会话 tab 后，聊天区展示一个欢迎页，告诉用户当前在哪个工作区、可以直接输入，同时提供切换工作区的入口。

## 设计

### 布局

```
┌──────────────────────────────────────────────────┐
│                                                  │
│               ●  Aide                            │
│         Claude Agent 桌面客户端                    │
│                                                  │
│              当前工作区                            │
│           cypress-agent                          │
│                                                  │
│     在下方输入消息，在当前项目中开始新对话           │
│                                                  │
│          📂 打开其他项目文件夹                     │
│          Ctrl+O                                  │
│                                                  │
│──────────────────────────────────────────────────│
│  输入框  [模型] [权限]                  [发送]     │
└──────────────────────────────────────────────────┘
```

- **标题**：品牌名 + 副标题，居中，低调不抢眼
- **当前工作区**：醒目显示当前工作区名，让用户知道自己在哪
- **引导文字**：轻量提示，告诉用户可以直接打字
- **打开文件夹**：次要操作入口，点击弹出系统文件夹选择器
- **输入框**：ChatPanel 原有，不受影响，始终可用

### 交互

| 操作 | 行为 |
|------|------|
| 直接输入消息发送 | 在当前工作区创建新会话（= 现在的行为） |
| 点击"打开其他项目文件夹" | 弹出系统文件夹选择器 → 选中目录 → `setWorkspace` → `openBlankTab` |
| `Ctrl+O` | 同上，打开文件夹快捷方式 |
| `Ctrl+N` | 在当前工作区新建空白会话（= 现在的行为） |

### 组件层次

```
ChatPanel.vue
  .chat-messages
    v-if="messagesVal.length === 0 && !sessionId"
      <WelcomePage />          ← 替换原来的 <div class="chat-empty">开始新对话</div>
  ...输入框区域保持不变
```

`WelcomePage.vue` 接收 props：
- `workspacePath`: string — 当前工作区路径
- `workspaceName`: string — 当前工作区显示名

Events：
- `open-folder` — 触发文件夹选择

### 技术实现

#### Rust 端

1. **添加依赖**：`Cargo.toml` 加 `tauri-plugin-dialog`
2. **注册插件**：`lib.rs` 的 `tauri::Builder` 加 `.plugin(tauri_plugin_dialog::init())`
3. **新增命令** `pick_folder`（`commands/workspace.rs`）：
   - 调用 `tauri_plugin_dialog::FileDialogBuilder::new().pick_folder()` 
   - 返回选中路径（字符串）或 null
4. **Capability**：`default.json` 加 `dialog:default` 权限

#### 前端

1. **API**（`api.ts`）：`pickFolder(): Promise<string | null>`
2. **WelcomePage.vue**：新组件，渲染欢迎内容
3. **ChatPanel.vue**：空白态替换为 `<WelcomePage>`
4. **App.vue**：监听 `open-folder` 事件，调用 pickFolder → setWorkspace → openBlankTab
5. **快捷键**：App.vue 的 `handleKeydown` 加 `Ctrl+O` 处理

### 视觉风格

- 继承项目 Catppuccin 暗色主题 CSS 变量体系（`--aide-*`）
- 居中布局，留白呼吸感
- 品牌字用 `font-weight: 600`，副标题 `--aide-text-muted`
- 工作区名用较大字号 + `--aide-accent` 色，是页面视觉重心
- "打开文件夹"用 subtle 按钮风格（已有 `AButton` 或 ACard）

### 不需要做的

- 不需要最近项目列表
- 不需要 Rust 端创建工作区目录（SDK 首次对话自动创建）
- 不需要改变 tab/布局树机制
- 不需要改变 ChatPanel 输入区行为
