# 权限与设置体系 — 用户文档 / 手工验收矩阵

本文档既是**用户文档**，也是发版前的**手工验收清单**。日常编辑入口是 **Aide 设置面板**（`设置 → 权限` / `设置 → 模型` 等图形界面），不是手编 JSON；下方的验收矩阵用于真机验证。

## 文件位置与可写性

| Scope | 文件路径 | 谁可写 | 说明 |
|---|---|---|---|
| 受管策略 (managed) | Windows `%ProgramData%/Aide/settings.json`；macOS `/Library/Application Support/Aide/settings.json`；Linux `/etc/aide/settings.json` | 管理员（部署方） | 只读，UI 不提供编辑入口，仅用于解释 |
| 用户全局 (user) | `~/.aide/settings.json` | 当前用户 | 普通偏好的默认层 |
| 项目共享 (project) | `<project>/.aide/settings.json` | 项目协作者 | 随项目提交、团队共享 |
| 项目本地 (local) | `<project>/.aide/settings.local.json` | 当前用户本机 | 仅本机，不建议提交 |
| 会话 (session) | 仅内存 | 运行时建立 | 不落盘，进程退出即消失 |

> Aide **不读取、不写入、不解释** Claude Code 的 `.claude/settings.json` / `.claude/settings.local.json` 权限规则，也不做其格式兼容层。Aide 的 `CLAUDE.md` 指令由 sidecar 自己加载 `~/.aide/claude/CLAUDE.md` + 项目根 `CLAUDE.md` 追加到 SDK preset system prompt，不依赖 SDK 的 setting source。

## 安全行为

- **API key / auth token / CodeGraph key** 只存 **OS 凭据库**（Windows Credential Manager / macOS Keychain / Linux secret service），**绝不**写入任何 `settings*.json`、不返回 Vue、不进日志/测试快照/错误字符串。UI 只显示「已配置 / 未配置」，不能导出明文。
- **首次启动**把旧 `~/.aide/config.json` 一次性迁移为 `~/.aide/settings.json`：秘密抽进 keychain，并写一份**脱敏**备份 `config.json.migrated.bak`（API key / auth token / CodeGraph key 字段被替换为 `{"configured": true}`，不保留明文）。迁移**幂等**：新 document 已存在后不再读旧文件。
- **原子写入**：临时文件 + `sync_all` + rename，失败时旧文件与内存缓存都保持原样，不更新活动 snapshot。
- 任何 `SettingsError` 的 `Display` 只显示逻辑 secret key（如 `aide/settings/provider/p1/apiKey`），绝不格式化 value。

## 权限策略 precedence

规则效果 `allow | ask | deny`，由工具名 + 匹配条件组成（`tool` / `bash {all|prefix|contains}` / `path {file_path|path|notebook_path} {folder?}` / `field {url|query|command} equals`）。

- **同一 scope**：按 **具体度降序、稳定 order 升序** 选候选；具体度固定（tool=0，bash all=1/contains=2/prefix=3，path all=1/folder=3，field=3），**不**按字符串长度变。
- **跨 scope**：**上层 scope 的 `deny` 不能被下层 `allow` 放宽**。各 scope winner 中只要存在 `deny` 即拒绝（最高优先级 deny 被选中），解释链记录该 deny 压过的低层结果；否则按 `session > local > project > user > managed` 选 winner。
- **无匹配规则**：回退到现有 provider permission mode（`defer`），**不放宽**。
- **Bash 前缀 allow** 对含未引用 shell 控制符（`;` `|` `&` `<` `>` 换行 反引号 `$(`）的命令一律不匹配；`contains` 只能作为 `ask`/`deny` 条件，**禁止**作为 `allow` 条件；prefix 还需检查命令边界（`pnpm testx` 不匹配 `pnpm test`）。
- **文件夹规则**按归一化路径组件比较（不做字符串前缀），执行期解析最深存在祖先 `realpath` 防 symlink 从已允许目录逃逸；任何 realpath/权限错误返回 no-match，不返回 allow。

## 即时生效

保存规则成功 → 原子写 document + 重算 snapshot → 广播给受影响的活动会话（sidecar 命令 `update_permission_policy`，`revision` 单调递增，sidecar 不接受低于当前值的 snapshot）。**已显示的确认框不会被事后自动批准/拒绝**——live update 只影响后续工具调用；当前已打开的权限确认框仍由用户手动结算。runtime 不存在/重启时保留 route 的最新 revision，下一条 send 自动补发。

## 手工验收矩阵

启动 `pnpm tauri dev`，逐项验证并勾选。验收前确认跑的是新 bundle（旧 WebView2 缓存会让人误判"修完不生效"）。

### 1. 旧 config.json 迁移
- [ ] 从含 Provider、CodeGraph key、workspace layout、普通偏好的旧 `~/.aide/config.json` 启动
- [ ] `~/.aide/settings.json` 无秘密（grep 不到 apiKey / authToken 明文）
- [ ] keychain 配置状态正确（设置 → 模型 / 设置 → 代码索引 显示「已配置」）
- [ ] 布局 / 偏好不丢失
- [ ] `config.json.migrated.bak` 存在且脱敏（无明文 key / token）

### 2. 用户层 Bash prefix allow + shell chaining 防护
- [ ] 用户层新增 `allow Bash prefix "pnpm test"`
- [ ] （临时让 Auto classifier 不可用）运行 `pnpm test --runInBand` → 直接放行
- [ ] 运行 `pnpm test && rm -rf build` → 不因 prefix 规则放行（走原 permission mode）

### 3. managed deny 跨层压过 local allow
- [ ] managed 写 `deny Bash prefix "rm"`
- [ ] project local 写 `allow Bash prefix "rm -rf build"`
- [ ] 运行 `rm -rf build` → 最终 deny
- [ ] 解释面板展示 managed rule 为 winner，local allow 标 `overridden_by_deny`

### 4. 删除规则即时生效，旧确认框不被结算
- [ ] 删除规则后不重启会话，执行同一调用
- [ ] 下一次走原 permission mode
- [ ] 当前已打开的旧确认框不被自动结算

### 5. 不可写 / 只读 scope 文案
- [ ] 无 project 时 project/local 按钮 disabled，reason「尚未打开项目」
- [ ] project 只读时 reason 显示实际路径「目录不可写」
- [ ] managed 显示只读 banner，无 add / edit / delete 控件

### 6. 主题化
- [ ] warm-dark / catppuccin / glass 下：tab、scope states、modal、toast、focus、explanation panel 全部随主题变化
- [ ] 无原生浏览器 UI（tooltip / alert / confirm / prompt）、无白底、无硬编码色

### 7. 既有流程不回归
- [ ] AskUserQuestion 仍正常（答案重组进 `updatedInput`）
- [ ] ExitPlanMode 仍正常（nextMode 选择保留）
- [ ] 子代理 permission attribution 仍正常（来源标注）
- [ ] provider 切换仍正常
- [ ] 图片 Read guard 仍正常（policy hook 排在 image guard 之前）
- [ ] 普通 PermissionDialog 只显示「允许 / 拒绝」（无 always allow 按钮）

### 8. 「允许并记住」对话框内一键持久化
权限确认框新增「允许并记住」按钮：本次放行 + 就地推导一条 `allow` 规则写到默认作用域（项目本地优先，不可写回退用户全局），替代被移除的旧「总是允许」。推导规则：Bash→命令前缀（在首个未引用 shell 控制符处截断）、Write/Edit/MultiEdit→所在文件夹、NotebookEdit→notebook 所在文件夹、WebFetch→完整 URL equals、其它→工具级。

- [ ] 启动 `pnpm tauri dev` 并打开一个项目（让 local scope 可写），确认跑的是新 bundle（旧 WebView2 缓存会误判"修完不生效"）
- [ ] 让模型调用 Bash（如 `pnpm test`）：权限框出现「允许并记住」按钮 + 描述行「将记住到本项目本地：执行以 "pnpm test" 开头的命令时始终允许」
- [ ] 点「允许并记住」→ toast「已记住到本项目本地，下次自动放行」+ 本次放行
- [ ] 设置 → 权限 → 项目本地 tab 出现对应 allow 规则（`.aide/settings.local.json`）
- [ ] 再次触发同类命令（如 `pnpm test --runInBand`）→ 不弹窗，直接放行
- [ ] Bash 链式安全：记住 `pnpm test` 后，运行 `pnpm test && rm -rf build` → **仍弹窗**（prefix-allow 不放行含未引用控制符的命令）
- [ ] 去重：对同一命令再点「允许并记住」→ 不产生第二条规则（规则数不增）
- [ ] Write/Edit：记住后，同目录及子目录下文件编辑自动放行；其它目录仍弹窗
- [ ] WebFetch：记住后，同 URL 再抓取自动放行；其它 URL 仍弹窗
- [ ] 计划批准（ExitPlanMode）/ AskUserQuestion 对话框**不**显示「允许并记住」按钮
- [ ] 无项目打开时：权限框描述显示「将记住到用户全局」，规则落到 `~/.aide/settings.json`
- [ ] 「允许」（单次）按钮仍存在且只放行本次、不写规则

## 自动化测试覆盖

下列测试在本地必须全绿。**唯一允许的失败**：`codegraph::query::semantic::tests::chinese_query_finds_pure_rust_code` 需本地 Ollama（`localhost:11434`），是环境依赖、非本计划回归（ledger 多次标注）。

- **Rust**：`cargo test --lib` — 覆盖 `settings::` / `policy::` / `commands::permissions` / `runtime::provider`
- **sidecar**：`pnpm exec vitest run agent-sidecar/src/policy agent-sidecar/src/permissions.test.ts agent-sidecar/src/session-worker.test.ts agent-sidecar/src/session-manager.test.ts agent-sidecar/src/instructions.test.ts`
- **前端**：`pnpm exec vitest run src/api/permissions.test.ts src/composables/usePermissions.test.ts src/components/settings/permissions src/components/SettingsPanel.test.ts src/components/PermissionDialog.test.ts src/utils/permissionRuleDerivation.test.ts`
- **类型**：`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`（⚠️ `pnpm vue-tsc --noEmit` 是 bogus shim，会打印 "Already up to date" 但不真跑 vue-tsc，必须用 direct binary）
- **构建**：`pnpm build` + `pnpm --dir agent-sidecar build`

## 相关文档

- 架构边界：[docs/ARCHITECTURE.md](../ARCHITECTURE.md) 「设置系统」章节
- 实施计划：[docs/superpowers/plans/2026-07-27-aide-settings-and-permissions.md](../superpowers/plans/2026-07-27-aide-settings-and-permissions.md)
- 设计规格：[docs/superpowers/specs/2026-07-22-aide-settings-and-permissions-design.md](../superpowers/specs/2026-07-22-aide-settings-and-permissions-design.md)