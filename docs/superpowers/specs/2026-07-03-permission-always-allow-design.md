# 权限「总是允许」持久化 — 设计

对应 PLANS.md 第 2 项。

## 背景

`PermissionDialog.vue` 目前只有「允许」/「拒绝」两个按钮，每次工具调用都要重新确认，即使是同一个工具在同一个项目里反复用（比如每次 `npm test` 都要点一次允许）。

## 方案：复用 Agent SDK 原生持久化，不自建存储

Agent SDK 的 `canUseTool` 回调收到的 `options.suggestions`（`PermissionUpdate[]`）是 SDK 根据这次具体工具调用生成的规则建议（Bash 按命令前缀、Read 按目录等，比"整个工具名"更精细）。把这份 suggestions 原样通过 `PermissionResult.updatedPermissions` 带回去，并指定 `destination: 'projectSettings'`，SDK/CLI 会自己写入当前项目的 `.claude/settings.json`——和 Claude Code CLI 官方"不再询问"是同一套机制，`claude` CLI 直接跑在这个项目里也认，重启 app 后依然生效。

**不新建 Rust 侧存储**（`settings.rs` 不改动）：PLANS.md 草拟时列了这个文件，是当时还没确认 SDK 自带持久化；现在看没有必要——持久化数据是 Claude 专属概念（`.claude/settings.json` 里的 permission rules），物理上应该待在 `agent-sidecar`，不应该在 Rust 层另存一份、造成双写/不一致。

## 改动范围

### `agent-sidecar/src/permissions.ts`
- `pending` map 的 value 从单一 resolve 回调，改成 `{ resolve, suggestions? }`（`suggestions` 来自 `opts.suggestions`）。
- `resolve(id, approved, always?)` 新增可选 `always` 参数：
  - `approved && always && suggestions?.length`：返回时带上 `updatedPermissions: suggestions`（每条 suggestion 的 `destination` 由 SDK 自己给，通常已经是合适的值；不强改）。
  - `approved && always && !suggestions?.length`：兜底手写一条 `{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'projectSettings' }`。
  - 其余情况行为不变。

### `agent-sidecar/src/types.ts` + `src/types/chat.ts`（镜像）
- `SidecarCommand` 的 `permission_response` 变体加可选字段：`{ cmd: "permission_response"; id: string; approved: boolean; always?: boolean }`。
- 纯布尔标志，不暴露任何 Claude 专属类型，不违反核心协议 provider-agnostic 的红线。

### `src/components/PermissionDialog.vue`
- 新增「总是允许」按钮（`perm-btn--always`，视觉上和「允许」同色系但弱化，放在「允许」右侧或下方——具体样式实现时定，不在此展开）。
- 点击时 `emit('respond', permission.id, true, true)`。
- `respond` emit 签名扩展为 `[id: string, approved: boolean, always?: boolean]`。

### `src/composables/useChatSession.ts`
- `respondPermission(id: string, approved: boolean, always?: boolean)`，透传给 `invoke("permission_response", { sessionId, id, approved, always })`。

### `src-tauri/src/commands/chat.rs`
- `permission_response` 命令加 `always: Option<bool>` 参数，原样塞进转发给 sidecar 的 JSON：`json!({ "cmd": "permission_response", "id": id, "approved": approved, "always": always })`。

### `App.vue`
- `PermissionDialog` 的 `@respond` 处理函数透传第三个参数给 `respondPermission`。

## 范围边界（明确不做）

- 不做"总是拒绝"——PLANS.md 只提了允许侧，拒绝本来就是显式动作，没有"总是拒绝"的强需求。
- 不做用户级（`userSettings`，跨所有项目）持久化——只做当前项目级，SDK suggestions 给的 destination 是什么就用什么，不强行改写成 userSettings。
- 不在 Aide 自己的设置面板里做"已授权规则"管理 UI（查看/撤销）——规则本身在 `.claude/settings.json` 里，用户可以直接编辑那个文件；管理 UI 是独立的后续需求，不在本次范围。
- 不改变现有「允许」「拒绝」按钮的行为语义。

## 测试

- `permissions.ts`：`always: true` 时 resolve 的 `PermissionResult.updatedPermissions` 正确带上 suggestions（或兜底规则）；`always` 为空/false 时行为和现在一致（回归）。
- Rust `chat.rs`：`always` 参数正确进入转发给 sidecar 的 JSON（沿用现有 `apply_initial_model_override` 一类的单元测试风格）。
