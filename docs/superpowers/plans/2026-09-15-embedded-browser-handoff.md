# 内嵌浏览器 — 续作交接（HANDOFF，2026-09-15）

> 本文档是**续作 playbook**：现状 + 已锁决策 + 地雷 + 下一步 + 怎么跑。
> 架构与决策依据见同目录 `2026-09-10-embedded-browser.md`（§12 = 2026-09-15 形态定稿与扩展原则）。
> 旧的 `2026-09-10-embedded-browser-handoff.md` **已作废**（其"两步走/会话式 tab"方案被用户否掉）。

---

## 0. 一句话现状

内嵌浏览器已是**主区一级视图**（跟「插件/知识库」同范式，侧栏第 5 行入口 + `Ctrl+Shift+B`，右上角 ✕
关面板=保活），**面板自带标签页**（新建/切换/关闭，每标签一个原生视图、切走保活），**加载事件通道接通**
（`on_page_load` → 注册表状态机 → `browser-nav` 广播 → 地址栏/标签态跟随，含页面内点击与重定向），
**收藏夹**（地址栏 ★ + 收藏条 + 从 HTML/JSON 文件导入）已落地。
门面 `facade` 是能力入口（书签是旁支数据能力，直接走 `BookmarkStore`，不经门面）；命令层是薄壳
——**agent 路径从这里进，不用改内核**。

## 1. 已锁决策（别再翻案）

1. **方案 A 成立，不退 B**（multiwebview + 原生 WebView2 子视图）；`unstable` 锁死在 `adapter/`。
2. **形态 = 主区一级视图（不占 tab）+ 面板内自带标签条**（2026-09-15 用户拍板，废掉"会话式 tab"）。
3. **保活**：关面板 / 切标签只 `setVisible(false)`，视图留在注册表 → 切回来同一页面、同一滚动位置、
   前进后退历史都在。**关标签**才 `browser_close`（销毁）。
4. **身份归状态主人**：视图 id 由 Rust 注册表发（`browser-<n>`），前端不造 id——面板与未来的 agent
   工具拿到的是同一个可寻址 id。
5. **机制 / 用途分离**：门面不认识"用途"。读页面存知识库之类是**消费方的组合**，不是内核能力。
6. **UI 只认事件**：状态变化只由加载事件路径广播；命令路径回同步快照、不额外广播（两个驱动者看到
   同一个页面）。

## 2. 下一步（按序）

### 第 1 步：webview2-com 下钻 = agent 路径的地基（**最优先**）

没有"读"，agent 只能导航不能看。要落地的能力（端口方法已在，实现在 adapter 里如实报"未实现"）：

| 能力 | WebView2 API | 用途 |
|---|---|---|
| `eval` 带返回值 | `ExecuteScript` + completed handler（wry 是 fire-and-forget，要下钻） | agent 读 DOM / 点元素 / 取状态 |
| 截图 | `CapturePreview`（异步，回 PNG 流） | agent"看见"页面；也可给会话贴图 |
| 页面标题 | `DocumentTitleChanged` | 标签标题（现在用域名兜底） |
| 失败判定 | `NavigationCompleted.IsSuccess` | 区分真失败（现在一律当成功） |
| 前进后退能力位 | `CanGoBackChanged` / `CanGoForwardChanged` | 根治历史镜像漂移（届时前进后退整体委托 WebView2） |

下钻入口：`Webview::with_webview(|pw| pw.controller())`（门控 `feature="wry"` 默认开）→
`ICoreWebView2Controller` → `.CoreWebView2()`。`webview2-com` 0.38.2 已在依赖树，提为直接依赖同版本。

### 第 2 步：页面 → 可读文本

HTML → markdown（参照 `docsMcp` 把 docx 变 markdown 的形态），带 url/title/时间元数据。
**这个类型要放领域/端口层**（不放 UI）——它同时是"喂给模型""存进知识库""引用到会话"三件事的共用载体。

### 第 3 步：agent 工具 + 桥接（零新通道）

- 桥接**复用 codegraph 的既有模式**：sidecar 工具 `emit({type, request_id, ...})` → Rust 拦执行 →
  结果经 stdin 写回按 `request_id` 配对。参照 `agent-sidecar/src/extensions/codegraphClient.ts` +
  `src-tauri/src/codegraph/agent_bridge.rs`（+ `runtime/mod.rs` 的拦截与回写通道）。
- 工具面照 `knowledgeMcp`：**读工具自动放行、写/动作工具必弹窗**（`KNOWLEDGE_READ_RULES` 那条分工）。
- headless / 远程场景：如实返回「本环境没有内嵌浏览器」，不假装成功。
- **前端镜像登记**：CLAUDE.md 义务——内置 MCP 新增必须同步 `useCustomizations`。

## 3. 地雷（已核实源码，别重踩）

- **`add_child` / `eval` / `set_position` / `set_size` / `show` / `hide` 内部 `run_on_main_thread` +
  阻塞 `recv()`** → 必须从**非主线程**调用（命令层一律 `async fn`），否则主线程自锁。
- **`on_page_load` 回调本身就在主线程**（wry 用 `Rc` 持有 handler，非 `Send`）→ 回调里**只准做纯状态
  变更**：调上面那批方法 = 死锁；**调 `AppHandle::emit` 也 = 死锁**（投递终点是 `Webview::eval`，
  同一个阻塞 getter）→ 广播交给 `spawn_blocking`（见 `facade::apply_page_load`）。
- **`ContentLoading` 同一次导航会多次触发**（重载/子资源）→ 状态迁移必须幂等
  （`absorb_page_load` 用"同 URL 且已 Loading → 返回 false 不广播"处理）。
- **`PageLoadEvent::Finished` 成功失败都发**（wry 丢弃 `IsSuccess`）→ 现在 `Finished` 一律当成功。
- **`WebviewUrl` 从 crate 根 `tauri::WebviewUrl`** 导入（`tauri::webview::WebviewUrl` 私有 E0603）。
- **取窗口用 `app.get_window("main")`**（`WebviewWindow.window/.webview` 是 pub(crate) 取不到）。
- **坐标**：窗口 `decorations(false)` + 主 webview 铺满客户区 → `getBoundingClientRect()`(CSS px)
  **直接 == Tauri logical px**，无需换算；rect 视口相对，天然吸收滚动。
  **rect 空（display:none / 宽高 0）→ `setVisible(false)`**，这一招自动覆盖所有隐藏场景。
- **原生视图浮在所有 HTML 之上**（不受 z-index 约束）→ 面板关闭/切标签必须显式隐藏。**任何全屏
  遮罩**盖上来时也要让位（2026-09-16 修）：由浮层登记处统一驱动——`directives/overlayLayer.ts`
  的 `v-overlay-layer`（谁有遮罩谁在根元素挂）+ `BrowserPanel.vue` 的 `viewAllowed` 总闸。
  漏挂由 `pnpm check:overlay-layers` 在构建期拦下（`WorkbenchTerminal` 是常驻非模态，已登记豁免）。
  同一个登记处也接管了 `PermissionDialog` 的键盘让路（原先那份 `OVERLAY_SELECTOR` 遮罩类名表已删）。

## 4. 怎么跑 / 怎么验

- **dev**：`pnpm tauri dev`（改过 sidecar 也要 rebuild；browser 是纯 Rust+前端，不需要）。`Ctrl+Shift+B`
  或侧栏「浏览器」行开面板；`＋` 开标签；地址栏回车打开。
- **Rust 门禁**：`cd src-tauri && cargo check --all-targets` + `cargo test --lib browser`
  （51 用例；避开 codegraph 的 chinese_query 需 Ollama；LNK1104 = 杀软锁 exe，sleep 重试）。
- **前端门禁**：`npx vue-tsc --noEmit` + `pnpm test` + `pnpm check:tauri-imports` + `pnpm check:sync-io`。
- **格式化**：`cd src-tauri && cargo fmt -p aide`。
- **已知测试抖动**：全量 `pnpm test` 下 `ChatMessage.renderScale.test.ts` 会因**负载**超时
  （5s 默认；单跑 1s 通过），`agent-sidecar/session-worker.test.ts` 的 automation 自毁用例同理——
  两者都与浏览器改动无关（不在其依赖图内），是机器负载型 flake。

## 5. 已知限制与债

见设计文档 §12.6 的表（标签标题/失败判定/历史镜像/标签持久化/停止加载/本地预览/agent 读截图/
OAuth/macOS-Linux/覆盖率）与 §12.7 的书签限制（目录拍平 / 标题不可改 / GBK / 无排序搜索）。
当前**没有**模块级 `#![allow(dead_code)]`——剩余未接线项各自带理由。

## 6. 书签（收藏夹）快速索引

- 落盘 `~/.aide/browser/bookmarks.json`；去重键 = URL（`url_guard` 归一化后）；导入**只增不删**。
- 代码：`browser/bookmarks/{mod,parse}.rs`（存储 + 两种格式纯解析）、`browser/dto.rs`（BookmarkDto /
  ImportReportDto）、`commands/browser.rs`（4 条命令，`browser_bookmarks_*`）、
  `src/composables/useBrowserBookmarks.ts`（IPC + 单例列表）、`BrowserPanel.vue`（★ + 收藏条 + 导入）。
- **agent 将来要用书签**（"打开我收藏的 X"）：直接进 `BookmarkStore`，无需新机制——它就是"一份 URL 列表"。
