# 远程控制 v3 信息架构落地计划（聊天升主屏 + 抽屉导航）

> 状态：待实施
> 原型：`design/remote/index.html`（展台）+ `design/remote/app.html`（应用本体）
> 日期：2026-09-06

## 背景与目标

原型 v3 已定稿：**聊天升主屏，会话列表收进左侧抽屉**（Kimi 式导航）。本计划把
原型信息架构落进 ArkTS 工程，含本轮原型迭代的三项改动：

1. 「＋ 新会话」迁入抽屉「历史会话」标题行（刷新左侧）
2. 顶栏常驻「⏹ 停止会话」按钮（原「断开连接」位置；`interrupt_session` 语义）
3. 会话三态状态点：**待确认（橙，呼吸）> 回复中（绿，呼吸）> 已启动（蓝，静态）**，
   列表只留点不带文字，颜色语义的文字说明只保留在工作区卡计数处

现状差距：工程当前是「列表页（SessionsPage）→ 路由推进会话页（ChatPage）」的
二级结构，无抽屉、无工作区/供应商切换、无新会话空态。

## 改动清单（按文件）

### 状态 / 模型层

**1. `session/SessionsModel.ets` — 扩展三态推导（纯客户端事件推导，无协议改动）**

- `waitConfirmIds`：
  - 置位：`permission_request`
  - 清除：`permission_cancelled` / `message_stop` / `error` / `session_dead` /
    本机应答（respondPermission 成功后联动）；恢复工作的事件
    （`tool_use_start` / `text_delta` / `thinking*`）亦清除——桌面侧放行后
    等待态实际已结束（sidecar 阻塞期间无工作事件，首个工作事件即「已应答」信号）
- `startedIds`：见过任意 chat-event 即视为运行时存活；`message_stop` **保留**
  （进程仍在，仅回合结束）；`session_dead` / 致命 `error` 清除
  - 仅内存态：应用重启后需等下一事件才能点亮（假阴性可接受）；权威态需
    `list_sessions` 扩展 `started / pending_confirm` 字段，维持原型实施清单
    标注的协议缺口，不在本计划内
- 徽标优先级 helper：待确认 > 回复中 > 已启动，单点取最高优先级

**2. `session/ChatModel.ets` — 新会话 spawn 链路**

- 空态发送 = spawn：`resumeId: null` + `workspaceRoot: 手机侧所选工作区`；
  `sessionId` 本地生成（生成方式实现前对照 PWA `useChatSession` 的
  `prepareSend` 确认，见「待确认」）
- `respondPermission` 成功后联动清除 `waitConfirmIds`（列表徽标同步）

**3. `session/ProviderModel.ets`（新）— 供应商模型**

- 封装 `get_providers` / `get_active_provider_id` / `set_active_provider_id`
- 可观察状态：providers 列表 + activeId；authed 后拉取，切换即时生效

**4. `session/WorkspaceModel.ets`（新）— 工作区模型**

- 工作区列表 + 手机侧选中态（`''` = 桌面当前活动工作区）
- **仅影响浏览范围与新会话去向，不改桌面活动工作区**——无此 RPC；
  原型弹层脚注同语义（「工作区由桌面 aide 管理」）
- 切换弹层打开时拉取各工作区会话列表（`list_sessions_for_workspace`），
  缓存计数；三态计数 = 各工作区会话列表 ∩ 全局事件推导三套 id 集合

### UI 层

**5. `session/ChatDrawer.ets`（新）— 抽屉组件**

自设备卡至搜索框，对照原型 `.dr-panel` 结构：

- 设备卡：logo + 「桌面 aide」+ 连接状态点（authed 绿 / offline 橙呼吸）+
  供应商徽标（点击开供应商半模态）
- 工作区区段：工作区卡（色彩字母头像 + 名称 + 路径 + 三态计数 meta，
  只列非零项）+「切换」affordance → 工作区半模态
- 历史会话区段：标题行「＋ 新会话」（刷新左侧）+「↻ 刷新」
- 会话列表：名称 + 相对时间 + 三态状态点（无文字）；点击切换会话；
  待确认会话切换后 toast 提示「有请求等待确认」
- 底部搜索框：按名称过滤当前工作区会话
- 两个半模态弹层（供应商 / 工作区）：HarmonyOS 半模态样式，选中项描边 +
  勾选；脚注提示管理入口回桌面

**6. `pages/ChatPage.ets` — 重构为常驻主屏**

- 去 `@Entry` / 路由参数读取，改为 Index 直接渲染的普通组件
- 顶栏：☰（开抽屉）+ 标题（副标题 = 工作区名）+ ⏹ 停止会话
  （常驻；闲态置灰、点击 toast「当前没有进行中的回复」；忙碌变红可点，
  点击走 `interrupt_session`，残段冻结 + 落系统分隔线）
- 新增「新会话」空态：logo + 「新会话」+「发消息即创建 · 发往工作区 X」
- 挂载抽屉（遮罩 + 左滑面板）
- 连接状态反应调整：`needsPairing` / `idle` 时不再 `router.back()`，
  由 Index 观察 conn 状态自动切回连接页
- **消息时间线 / 权限弹层 / 后台任务停靠区 / 输入区全部保留不动**

**7. `pages/Index.ets` — authed 直接渲染 ChatPage**

**8. `pages/SessionsPage.ets` — 删除**（被抽屉取代）

**9. `main_pages.json` — 移除 `pages/ChatPage` 注册**（仅剩 `pages/Index`）

### SDK / 资源层

**10. `sdk/api.ets` + `sdk/types.ets` — 补供应商 RPC 与 DTO**

- 新增 `getProviders` / `getActiveProviderId` / `setActiveProviderId`
- `ProviderConfig` DTO 镜像（字段以 Rust `runtime/provider/mod.rs` 为准，
  实现时先读，见「待确认」）

**11. `resources/base/element/color.json` — 补弱色资源**

- `accent_weak` / `warn_weak` / `danger_weak`（原型徽标底、停止按钮按压态、
  选中项弱色底；现缺）

## 明确不做（后续增量）

- 模型 chip / 思考程度 chip（需 `set_model` / `set_effort` +
  `models_available` 事件接入）
- 会话预览文本 `last_preview`（协议缺口）
- usage 尾注、@引用 display 载荷、btw 支线

## 实现顺序

1. 资源（color.json）→ SDK（types/api）
2. 模型层（SessionsModel 三态 → ChatModel spawn → Provider/Workspace 模型）
3. 抽屉组件 ChatDrawer
4. ChatPage 重构
5. Index 调整 + 删 SessionsPage + main_pages 清理
6. `arkts_check` 全量通过 → `build_project` 通过

每步之间用 `arkts_check` 快速反馈，最终以 `build_project` 收口。

## 待确认（实现前核对，不改行为）

| 项 | 说明 |
| --- | --- |
| spawn 时 `sessionId` 生成方式 | 对照 PWA `packages/aide-sdk/src/composables/useChatSession` 的 `prepareSend`（Rust 侧 `session_id` 是路由键、`resume_id` 独立字段不覆盖路由键） |
| `ProviderConfig` DTO 字段 | 读 `src-tauri/src/runtime/provider/mod.rs` |
| 桌面主机名 | 「HEAVEN-PC」在协议里是否有来源；无则固定文案「桌面 aide」 |

## 参考

- 原型规格：`design/remote/app.html`（抽屉结构 / 三态语义 / 停止会话交互）
- 展台说明：`design/remote/index.html`（屏 2/3 说明卡 + 实施清单协议缺口）
- 桌面 RPC 白名单：`src-tauri/src/remote/rpc.rs`（REGISTRY）
- 事件路由现状：`entry/src/main/ets/session/chat/ChatEvents.ets`
