# 通知中心（Notification Center）设计

- 日期：2026-07-12
- 状态：已通过设计评审，待写实施计划
- Mockup：`docs/notification-mockup.html`（方案 A）

## 1. 目标

为 Aide 增加一条统一的「应用内通知」通道：各子系统可向同一个 feed 推送事件（向量索引出错、未来新版本发布、新功能公告等），用户在标题栏铃铛查看、忽略、清除。

与现有 `src/composables/useNotification.ts`（OS 桌面通知，绑会话状态转换）**互不干扰**——那是系统级 toast / 任务栏进度，本设计是应用内 feed。

### v1 范围

- 建成通用基础设施（composable + 持久化 + 标题栏铃铛 + 下拉面板）。
- 只接入**一个源**：向量索引（codegraph）出错。`push()` API 通用，以后每个新源加几行即可。
- 不在 v1：新版本发布、新功能公告、会话进程异常等源；按源过滤/分组折叠；OS 桌面通知联动；设置开关。

## 2. 关键决策

| 维度 | 决策 |
|---|---|
| 持久化 | 按严重程度区分：`error`/`warning` 落盘，`info` 仅内存 |
| 入口 | 标题栏右侧 activity 指示器旁的铃铛，点击切换下拉面板（非悬停） |
| 已读模型 | 打开面板即全部标记已读（徽标归零），列表项保留；单条可忽略，可全部清除 |
| 数据层归属 | 前端 reactive store 持有状态；Rust 仅做文件 IO（load/save） |
| 去重 | `dedupKey` 命中未读项时合并刷新（时间戳更新、count++）而非新增 |
| 重启已读 | 落盘项重启重新载入为**未读**（提醒「还有个没修的错误」）；`read` 状态不落盘 |
| 视觉 | 方案 A 墨线：左侧 3px 严重度色条，呼应 ChatMessage/ToolCallBlock 墨线语言 |

## 3. 架构

```
┌─ 前端 ────────────────────────────────────────────┐
│ useNotifications.ts (模块级 reactive 单例)         │
│   notifications: Ref<AppNotification[]>            │
│   unreadCount: ComputedRef<number>                │
│   push / dismiss / clearAll / markAllRead          │
│   hydrate()  ← 启动时调一次                         │
└────────┬───────────────────────────┬───────────────┘
         │ error/warning 落盘          │ v1 唯一源
         ▼ (debounce 500ms)            ▼
┌─ Rust ──────────────────────────┐  useCodeGraphProgress.trackBuild
│ commands/notifications.rs       │    失败/可恢复分支 → notifications.push
│  load_notifications (async)      │
│  save_notifications (async)       │
│  ~/.claude-code-desktop/         │
│    notifications.json            │
└─────────────────────────────────┘
```

push 是纯前端内存操作（立即反映到 UI）；落盘是异步镜像，仅 `error`/`warning` 触发，debounce 500ms 合并连续 push。读路径（启动 rehydrate）只走一次 Rust。

## 4. 数据模型

```ts
type NotificationSeverity = "error" | "warning" | "info";

interface AppNotification {
  id: string;              // crypto.randomUUID()
  severity: NotificationSeverity;
  source: string;           // "codegraph" | "update" | ... 便于以后按源过滤/清理
  title: string;            // "向量索引加载失败"
  body?: string;            // 详情（可含 <code> 片段，下拉面板渲染为纯文本+内联 code）
  timestamp: number;        // ms
  dedupKey?: string;        // 可选；同 key 未读项 push 时合并而非新增，count++
  count?: number;           // 合并次数，默认 1
  action?: { label: string; url?: string }; // 可选按钮；url→浏览器打开；无 url→source handler
  read: boolean;
}
```

落盘规则：
- 仅 `severity ∈ {error, warning}` 写盘；`info` 永不落盘。
- 落盘内容**不含已 dismiss 的项**；**不含 `read` 状态**（重启回到未读）。
- 落盘列表软上限 100 条，超出按 `timestamp` 淘汰最旧。

去重：push 时若 `dedupKey` 命中一条未读项 → 原地更新（`title`/`body` 覆盖、`timestamp` 刷新、`count++`、`read` 保持 false），不新增；命中已读项则视为新条目。

## 5. `useNotifications.ts`（新建）

模块级单例（与 `useSettings`/`useRecent` 一致），全 app 共享。

```ts
export function useNotifications() {
  return {
    notifications: Readonly<Ref<AppNotification[]>>,   // 按 timestamp 降序
    unreadCount: Readonly<ComputedRef<number>>,        // read===false 计数
    push(n: Omit<AppNotification, "id" | "read" | "count"> & Partial<{ count: number }>): void,
    dismiss(id: string): void,
    clearAll(): void,
    markAllRead(): void,
    hydrate(): Promise<void>,   // load_notifications → 注入 error/warning 为未读
    registerActionHandler(source: string, fn: (n: AppNotification) => void): void,
    triggerAction(id: string): void,   // NotificationBell action-click → 查 handler 派发
  };
}
```

- `push`：内存立即更新 → 若 severity ∈ {error, warning}，触发 debounce 500ms 的 `save_notifications`。
- `dismiss` / `clearAll`：内存更新 + 同步触发落盘（清掉对应落盘项）。
- `markAllRead`：仅内存，不落盘（read 不持久化）。
- `hydrate`：启动时由 `main.ts` 调一次，`api.loadNotifications()` 拉落盘列表，全部以 `read: false` 注入。

## 6. Rust 持久化（`src-tauri/src/commands/notifications.rs`，新建）

两个 async 命令（文件 IO，按 CLAUDE.md「同步 command 禁止重 IO」红线，必须 `async fn` + `spawn_blocking`；带 `State` 引用参数时须返回 `Result`——本设计无 state，纯文件 IO，返回 `Result<_, String>` 即可）：

```rust
#[tauri::command]
async fn load_notifications() -> Result<Vec<NotificationRecord>, String> { ... }

#[tauri::command]
async fn save_notifications(records: Vec<NotificationRecord>) -> Result<(), String> { ... }
```

- 路径：`~/.claude-code-desktop/notifications.json`（与 diagnostics 同根，用 `dirs` crate 取 home 目录，`PathBuf` 拼接，不硬编码 `\\`）。
- 写入：临时文件 + rename 原子替换（与黑匣子报告同款，防写一半被强杀留损坏文件）。
- `lib.rs` 注册两命令；无新增 state。
- `NotificationRecord` 字段 = `AppNotification` 去掉 `read`、`info` 项（Rust 端 serde 结构；前端传什么落什么，info 项前端根本不传）。

`api.ts` 加类型安全封装：`api.loadNotifications()` / `api.saveNotifications(records)`。

## 7. UI：标题栏铃铛 + 下拉面板（方案 A 墨线）

新建 `src/components/titlebar/NotificationBell.vue`（自包含：按钮 + 下拉 + 状态全部从 `useNotifications` 读，不向 TitleBar 透传 props/emit）。在 `TitleBar.vue` 的 `titlebar-right` 中，`activity` 指示器**左边**插入 `<NotificationBell />`。

### 铃铛按钮
- 15px 铃铛图标（stroke 2）。
- 无未读：`color: var(--aide-text-muted)`；hover → `var(--aide-text-primary)` + `var(--aide-surface-default)` 底。
- 有未读：右上角红点徽标（`var(--aide-danger)` 底，白字，9px，min-width 14px，14px 高，`1.5px solid var(--aide-bg-deep)` 描边圈掉背景），显示 `unreadCount`，>9 显示 `9+`。
- 点击切换下拉开合；点外部关闭（监听 document click）。

### 下拉面板（360px 宽，复用 `activity-panel` 视觉语言）
- 容器：`var(--aide-bg-raised)` + `1px solid var(--aide-border)` + `var(--aide-radius-md)` + `var(--aide-shadow-lg)`，`margin-top: 6px`，右对齐。
- 头部：左侧标题「通知」+ 未读数（`var(--aide-accent)`）`uppercase 11px letter-spacing 0.8px`；右侧「全部清除」文字按钮。底部 `1px solid var(--aide-border)` 分割，带 `linear-gradient(180deg, var(--aide-border-subtle), transparent)` 顶光。
- body：`max-height: 420px; overflow-y: auto`。
- **每条 = 墨线行**（方案 A）：
  - 左侧 3px 严重度色条（error `--aide-danger` / warning `--aide-warning` / info `--aide-info`），`align-self: stretch`，`border-radius: 2px`。
  - 行体：`padding 10px 12px`，`gap: 4px` 纵向。
    - 顶行：title（12.5px 600 primary，ellipsis）+ 时间（10px muted，右贴）。
    - 正文：11.5px `--aide-text-secondary`，内联 `<code>` 用 `--aide-surface-default` 底。
    - 底行：`src-tag`（9.5px 600 uppercase，`--aide-text-muted` + `--aide-surface-default` 胶囊）+ action（文本链接 `--aide-accent` 或小胶囊按钮 `--aide-accent-subtle` 底）。
  - 右侧忽略 ✕：18×18，默认 `opacity:0`，行 hover 显出；hover `--aide-surface-hover` 底。
  - 行 hover：`color-mix(in srgb, var(--aide-surface-default) 50%, transparent)` 底。
  - 行间 `1px solid var(--aide-border)` 分割，末行无。
- 空态：`padding 28px 16px`，居中 12px muted「暂无通知」。
- 打开面板即调 `markAllRead()`（徽标归零，列表项保留）。
- action 按钮：`url` → `open(url)`（复用 `@tauri-apps/plugin-shell` 的 `open`）；无 `url` → NotificationBell emit `action-click` 携带该通知 `id`，`useNotifications` 按 `source` 查 handler 注册表派发（v1 仅 codegraph 注册「重建索引」→ `useCodeGraphProgress.rebuild(root)`）。

### 无障碍
- 铃铛按钮 `aria-label="通知"`，`aria-expanded` 跟随开合。
- 面板 `role="dialog"`，`aria-label="通知中心"`。
- Esc 关闭面板。
- 尊重 `prefers-reduced-motion`（下拉 transition 用 0.12s，已足够轻）。

## 8. v1 源接入：向量索引出错（codegraph）

在 `src/composables/useCodeGraphProgress.ts` 的 `trackBuild` 回调里，现有 `console.warn`/`console.info` 旁补推通知：

| 触发条件 | severity | dedupKey | title | body | action |
|---|---|---|---|---|---|
| `trackBuild` reject（spawn_blocking panic 等） | error | `codegraph:build:<root>` | 向量索引构建失败 | 错误信息 + 「结构层精确跳转仍可用，语义搜索不可用」 | 无（v1 不接日志查看入口） |
| resolve 且 `r.has_embeddings === false` | warning | `codegraph:embed:<root>` | 语义搜索不可用 | embedder 状态（模型未下载/服务不可达）+ 「结构层正常」 | 「重建索引」→ `rebuild(root)` |
| resolve 且 `r.total_symbols === 0` | warning | `codegraph:empty:<root>` | 未索引到任何符号 | `scanned_files=N` + 提示检查项目根/扩展名 | 无 |

自愈清理：`rebuild(root)` 成功后（resolve 且非上述三种异常分支），自动 `dismiss` 同 `dedupKey` 前缀 `codegraph:*:<root>` 的未读项——错误修好了就不再赖着。

接入约定：
- `useCodeGraphProgress` 已持有 `lastIndexedRoot`，`trackBuild` 闭包内可拿到当前 root 作为 `dedupKey` 后缀。
- 「重建索引」action 不带 `url`，NotificationBell emit `action-click(id)`，`useNotifications` 按 `source` 查 handler 注册表派发；codegraph 在初始化时注册 `source: "codegraph"` 的 handler，根据 `dedupKey` 解析出 root 调 `rebuild(root)`，成功后自愈 dismiss。NotificationBell 通用、不耦合 codegraph。
- `useNotifications` 暴露 `registerActionHandler(source, fn)` 供源注册；新源注册自己的 handler 即可。

## 9. 跨平台与红线对齐

- Rust 路径用 `PathBuf` + `dirs` crate，不硬编码 `\\`；写文件无 spawn 子进程，不需要 `CREATE_NO_WINDOW`。
- 文件 IO 全 `async fn` + `spawn_blocking`，不堵 Tauri 主线程。
- 不走 `app.emit`（跨线程 emit 是历史卡死根因）；本设计纯前端 store + 拉模型 hydrate。
- 不引入新颜色/新依赖；复用 `--aide-*` token。
- 不改 `useNotification.ts`（OS 桌面通知）。

## 10. 测试

- `useNotifications.test.ts`：push 顺序与降序、dedupKey 合并 count++、dismiss/clearAll、markAllRead 只改 read 不落盘、hydrate 注入为未读、落盘上限 100 淘汰最旧。
- Rust `notifications.rs` 单测：load 不存在文件返回空、save→load 往返一致、info 项与 read 字段不落盘、原子写（写中断模拟用临时文件存在校验）。
- 手测：切工作区触发 codegraph 失败 → 铃铛红点 → 打开面板看墨线行 → 全部清除 → 重启 app 验证 error/warning 仍在且未读、info 不在。

## 11. 文件清单

新增：
- `src/composables/useNotifications.ts` + `useNotifications.test.ts`
- `src/components/titlebar/NotificationBell.vue`
- `src-tauri/src/commands/notifications.rs`
- 修改：`src-tauri/src/lib.rs`（注册两命令）、`src/api.ts`（加 loadNotifications/saveNotifications 封装 + type）、`src/types.ts`（`AppNotification`/`NotificationRecord` 类型 + `ChatEvent` 不动）、`src/components/titlebar/TitleBar.vue`（插入 `<NotificationBell />`）、`src/composables/useCodeGraphProgress.ts`（接入 push + 自愈 dismiss + action handler 注册）、`src/main.ts`（启动调 `hydrate()`）。
- Mockup：`docs/notification-mockup.html`（参考用，可保留）。