# 资料库第一步（能放进去、能打开看）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让知识库能装 AI 做出的**网页**（今天只装 markdown 文档）、**你自己也能传**，存进去后能在 Aide 里点开就看——网页在右栏浏览器跑起来；并让打开知识库面板不再要求登录。

**Architecture:** 内容是「条目 = 原件 + 派生可搜文本」。新增的 html 是**文本形态**：原件原样存进 `revisions.content`，服务端按扩展名定 `documents.mime`，再由 `domain::search_text::derive(mime, content)` **在一个地方**算出可搜文本（只有 html 需要剥标记）。网页预览不另造渲染通路，而是给条目发一个**取件地址**（本机可达、带一次性 token 的 URL），右栏浏览器直接打开它——第三步「发布」复用同一条通路。

**范围**：只加 **html**。csv / json 是早期版本照抄 WorkBuddy 抄进来的，**不是本产品的格式**（spec §5.1），本计划全程不引入。

**Tech Stack:** Rust（axum + sqlx + PostgreSQL 17）、TypeScript（Vue 3 Composition API + vitest）、Tauri v2（WebView2 内嵌浏览器）。

**Spec:** `docs/superpowers/specs/2026-09-30-aide-library-design.md`

## 当前状态（2026-09-30 收尾，**新会话先读这一节**）

### ✅ 七个任务全部落地并验过（2026-09-30 夜）

| 任务 | 落点 | 证据 |
|---|---|---|
| **Task 1** html 解析 + 可搜文本唯一产地 | `adapter/parser/html.rs`、`domain/search_text.rs`、`ParsedDocument.mime` | `cargo test` 64 项绿（含 8 项新用例） |
| **Task 2** 落库 mime + `search_text` + 编辑重算 | `migrations/007_document_mime.sql`、`versioning.rs` 三个写入点、`ingest.rs`、`search.rs`、DTO 带 `mime` | 冒烟三条（mime / 剥标记 / 改后重算）全绿 |
| **Task 3** 取件地址 | `domain/preview_token.rs`、`api/preview.rs`、路由 `/p/{token}` | 冒烟：免 Bearer 200、Content-Type 对、字节逐字相同、无效票 404 中文 |
| **Task 4** 右栏 `openInBrowser` | `useRightPanel.ts`、`BrowserPanel.vue`（`consumePendingOpen` + `openExternally`） | `useRightPanel.test.ts` 4 项 + BrowserPanel 2 项；**真机**：面板点「在右栏打开」→ 服务端 200 → 取件地址在 WebView 里真渲染 |
| **Task 5** mime 分派 + 上传入口 | `previewKind.ts`、`kbClient.ingest/previewToken`、`KbDocumentView` 三档、`KbTree` 菜单第三项、空态入口 | 单测 87 项；**真机**：`.csv` 当场被拒且说清收哪些、`.html` 上传 201 并自动打开、`accept` 就是服务端那份列表 |
| **Task 6** 免登录 | `useKnowledgeBase.init` 分流 401 / network、`KbLogin` 文案 | 单测 3 项；**真机**：凭据失效落兜底页并清凭据，有凭据静默进入 |
| **Task 7** 滑动续期 + 绝对上限 | `domain/session.rs`、`config.rs`、`api/extract.rs` | 单测 5 项 + 冒烟三条（续期推后 / 超上限 401 / 过期 401） |

**测试总账**：knowledge-server `cargo test` 64 绿；前端 `pnpm test` 275 文件 / 3489 绿；`vue-tsc --noEmit` 干净；
`./smoke.sh`（隔离栈 `-p kbsmoke`，端口 18788）全部通过。

### ⚠️ 一条**预存在**的限制（不是本次引入，别再查一遍）

**`ts_headline` 只高亮「被标点/空格隔开」的中文词。** 例：搜「玄武」命中 `独特词：[[HL]]玄武[[/HL]]。`；
搜「填充文字」命中但**片段里没有 `[[HL]]`**（它在连续中文串里）。
根因：PG 的 `simple` 解析器把一整串 CJK 当成**一个 token**，而索引侧是 jieba 分好的词——
命中靠 tsv，片段靠原文，两边切法天生不一致。`coalesce(search_text, content)` 没有改变这一点
（md 条目走的还是原来的 `content`）。前端对「没有哨兵」是优雅降级（整段按普通文本渲染）。
真要修得上 zhparser，而我们刻意不引数据库扩展——**记在这里，不是本次的验收项**。

### 已经在源码里做完的（未提交，`git status` 可见）

知识库 UI 已经做过一轮**结构重做**（不只是视觉）。这些**不用再实现**：

| 已完成 | 落点 |
|---|---|
| **两个全屏态**：索引态（整屏目录）/ 阅读态（整屏内容），**常驻侧栏已删除** | `KnowledgeBase.vue`（`reading` 判据 + `backToIndex()`） |
| 目录改成"目录页"排版：行高 44、标题 16px、右侧一列时间（等宽数字对齐） | `KbTree.vue`（`fmtDate`） |
| 顶栏「＋ 新建」= 实心按钮（原来是个藏在角落的小图标） | `KnowledgeBase.vue` |
| **空间只有一个时不出现**；组织靠文件夹 | `KnowledgeBase.vue`（`k.spaces.value.length > 1`） |
| **使用指南变成库里一份真文档**：文本在 `guideText.ts`，索引页脚一次性入口「把使用指南存进资料库」装进来，之后可改名可删 | `guideText.ts` + `KnowledgeBase.installGuide()` |
| 修掉的真缺陷：三个**不存在的 token**（`--aide-bg-primary/secondary`、`--aide-error`，导致编辑区/修改说明/保存按钮**透底**）、两处硬编码 `#fff`、**「使用指南」打开过文档后就回不去**、树行只有文字可点、**键盘焦点全不可见** | 各组件 |
| 夹具：`docs/prototypes/_harness/kb-panel-live.{html,ts}`（真组件 + 拦 fetch 喂假数据） | 跑 `npx vite --port 5199` |

**测试**：知识库 85 项、全量 3497 项，均绿。

### 收尾补做的三件（2026-09-30 夜二轮，已验）

| 补做 | 落点 | 证据 |
|---|---|---|
| **删除/丢弃确认走应用统一对话框**（原来 4 处 `window.confirm`） | `KnowledgeBase.vue`、`KbDocumentView.vue` 改用 `useModal()`（`confirm` / `choice`）；夹具里补挂 `ModalDialog` | 新增 `KnowledgeBase.test.ts` 3 项；**真机**：点删除 → 主题化对话框 → 确认 → 条目消失 |
| **上传进度**（字节百分比 + 「服务端正在处理…」） | `kbClient.postWithProgress`（唯一不走 fetch 的一处）、`useKnowledgeBase.uploading`、索引态进度条 | 单测：0→37%→99% 文案切换、结束后清空；真机 25 MB 文件上传成功（环回太快，肉眼看不到条） |
| **`?live=1` 夹具连真服务** | 夹具 `live` 开关 + `window.__kbHarness` 钩子；`ModalDialog` 一起挂 | 见上表「真机」两列 |

### 还没做的（下一步的手上活）

1. **网页产物的相对资源**：取件地址只发一份文本，自包含的单文件 html 正常，
   带 `./style.css` / `./app.js` 的多文件产物取不到。**用户已定：先不做**（2026-09-30 问过）。
   理由（别重新论证）：agent 产出的网页基本是单文件；要做就得先让任意文件以**字节条目**进库，
   而那会推翻 spec §5.1 的「不认的格式当场拒绝」，且字节条目必须与现有 `assets`
   **一起收编**（spec §8），否则出现两套图片机制。**等真遇到多文件需求，或做「第二刀」时一并做。**
2. **没有中断上传的入口**：进度条出来了，但传错了只能等它传完。
3. **`?live=1` 夹具依赖隔离冒烟栈**：用它验面板前先按「前置事实」那节起 `-p kbsmoke` 栈。

### 用户已经拍板的、别忘掉的

- 原型硬规则：**原型里出现的每一个东西都是本次要交付的**，不许有"预告"。
- 作者维度（谁改的：人还是 AI）是**紧接着的独立一轮**，不依赖第一步。
- 第一步**只加 html**（csv/json 不是本产品的格式）。

---

## 前置事实（已实测，不要再验一遍）

- **隔离冒烟栈怎么起**（`docs/superpowers/plans/2026-09-18-knowledge-base-tree.md` 的「验证环境」）：
  `docker-compose.smoke.yml` 已在仓库里（`ports: !override` 到 18788，且已进 `.gitignore`），
  `-p kbsmoke` 起的栈与用户实例完全隔离。要跑 `?live=1` 夹具时给栈加一句
  `KB_CORS_ALLOWED_ORIGINS=…,http://localhost:5199`，否则浏览器直连会被 CORS 拦。


- **右栏内嵌浏览器能加载本机 http 取件地址**——2026-09-30 探针实测：脚本执行、查询串 token 原样保留、相对资源（图片）加载、同源 fetch 全部正常。输出 `JS_RAN search=?token=abc123 imgW=1 fetch=200:hello`。所以 spec §4.6 的通路成立，**不需要为预览另造渲染方式**。
- **`url_guard` 不挡本机地址**：`src-tauri/src/browser/core/url_guard.rs:12` 的白名单是 `["http","https","file"]`，无 host/port 限制；校验点在 `src-tauri/src/browser/facade.rs:108`（create）与 `:170`（navigate）。
- **右栏浏览器目前没有"打开一个 URL"的接口**：`src/composables/useRightPanel.ts:128-145` 的导出里没有任何 URL 成员，`BrowserPanel.vue` 无 props / 无 emits / 无 `defineExpose`，URL 是它的私有状态。Task 4 要补这个接口。

## Global Constraints

- **跨平台**：路径拼接用 `PathBuf` / `path.join`，平台特有逻辑必须 `#[cfg(windows)]` 隔离。本次不涉及子进程。
- **第三方库只准待在 adapter**：新格式的解析放 `knowledge-server/src/adapter/parser/`；`src/port/` 与 `src/domain/` 不得 `use` 任何解析库（`CLAUDE.md`「可替换技术藏在端口后面」）。
- **主题 token 是配色的唯一来源**：所有颜色/背景/边框/圆角/间距走 `var(--aide-*)`，**禁止硬编码 hex**。
- **DTO 一律 camelCase**（`#[serde(rename_all = "camelCase")]`）；枚举**值**保持 snake_case 并与 SQL CHECK 字面量一致。
- **错误文案是中文**，且要写清下一步（`AppError::BadRequest("…")` 的字符串直接给用户看）。
- **迁移文件不写 `BEGIN` / `COMMIT`**——`knowledge-server/src/db.rs::migrate` 统一包事务；按文件名排序执行，**已应用的文件追加 SQL 不会重跑**，只能新开文件（下一个序号是 **007**）。
- **前端调知识库只走 `kbClient`**，不得散写 `fetch`。
- **前端测试**：vitest，`pnpm exec vitest run <路径>`；组件测试在文件首行加 `// @vitest-environment jsdom`；`@` 别名指向 `src`。
- **本次不动 agent-sidecar**：MCP 工具集不变（spec §5.4）。新增格式经 `ParserRegistry` 自动被 `ingest_file` 接受，不需要改 sidecar。
- **改后端必须重新发布服务端**：前端与 knowledge-server 分开部署，验收清单默认这一点已满足。

## Review Focus

以下五类输入 spec 没有明说、但一个人真用起来一定会撞上，**每一条都必须在下面指定的任务里有测试钉住**（已分配到各任务）：

1. **非 UTF-8 的文件（GBK 编码的 html）**——中文用户第一坑。期望：如实报"读取失败"，**绝不静默乱码**。（Task 1）
2. **html 里的 `<script>` / `<style>` 正文**——不该被搜出来，否则搜一个变量名满屏命中。（Task 1）
3. **上传一个资料库不认的格式（比如 `.csv`）**——期望**当场拒绝**并说清收哪些。静默收下是最糟的一类错：东西进了库，但没人知道它其实没被正确理解。（Task 5）
4. **编辑 html 条目后，可搜文本必须跟着重算**——否则搜索静默返回**旧内容**，这是最难发现的一类错。（Task 2）
5. **取件 token 过期 / 服务重启后全部失效**——期望明确失效，不是白屏。（Task 3）

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `knowledge-server/src/port/document_parser.rs` | 解析端口 | 改：`ParsedDocument` 加 `mime` |
| `knowledge-server/src/adapter/parser/html.rs` | html/htm —— 文本产物，原件原样入库 | 建（Task 1） |
| `knowledge-server/src/adapter/parser/mod.rs` | 后端模块表 | 改：注册 `html`（Task 1） |
| `knowledge-server/src/adapter/parser/registry.rs` | 后端优先级与按扩展名分派 | 改：默认链加一行（Task 1） |
| `knowledge-server/src/adapter/parser/{markdown,docx_to_md,docx_lite,pdf}.rs` | 既有四个后端 | 改：各自填 `mime`（Task 1） |
| `knowledge-server/src/domain/search_text.rs` | **可搜文本的唯一产地**（html 剥标记） | 建（Task 1） |
| `knowledge-server/migrations/007_document_mime.sql` | `documents.mime` + `revisions.search_text` | 建（Task 2） |
| `knowledge-server/src/domain/versioning.rs` | 版本推进（**三个写入点**） | 改：写 mime/search_text、tokenize 取值改源（Task 2） |
| `knowledge-server/src/domain/ingest.rs` | 解析结果落库 | 改：把 `parsed.mime` 传进 `create_node`（Task 2） |
| `knowledge-server/src/api/documents.rs` | 文档读写 | 改：`create` 给默认 mime（Task 2） |
| `knowledge-server/src/api/search.rs` + `src/domain/search.rs` | 检索读取端 | 改：高亮片段取值改 `coalesce(search_text, content)`（Task 2） |
| `knowledge-server/src/domain/preview_token.rs` | 取件票据的签发与校验 | 建（Task 3） |
| `knowledge-server/src/api/preview.rs` | `POST …/preview-token` + `GET /p/{token}` | 建（Task 3） |
| `knowledge-server/src/api/mod.rs` | 路由表 + AppState | 改：挂两条路由（Task 3） |
| `knowledge-server/smoke.sh` | 端到端冒烟 | 改：资料库段落（Task 2、3） |
| `src/composables/useRightPanel.ts` | 右栏 tab 裁决 | 改：新增 `openInBrowser`（Task 4） |
| `src/components/Browser/BrowserPanel.vue` | 浏览器 tab | 改：消费待打开地址（Task 4） |
| `src/components/KnowledgeBase/kbClient.ts` | 知识库 REST 客户端 | 改：DTO 加 `mime`、新增 `previewToken` / `formats` / `ingest`（Task 4、5） |
| `src/components/KnowledgeBase/previewKind.ts` | **按 mime 分派预览的唯一产地**（两档 + 兜底） | 建（Task 5） |
| `src/components/KnowledgeBase/KbTree.vue` | 目录页（索引态） | 改：`openCreateMenu` 里加「上传文件…」（Task 5） |
| `src/components/KnowledgeBase/KbDocumentView.vue` | 阅读态（正文三态） | 改：按 mime 分派（Task 5） |
| `src/composables/useKnowledgeBase.ts` | 面板状态闭包 | 改：免登录自动进入（Task 6） |
| `src/components/KnowledgeBase/KbLogin.vue` | 登录页 | 改：退化为兜底页（Task 6） |
| `knowledge-server/README.md` | 服务端说明 | 改：新格式与取件地址（Task 3） |
| `knowledge-server/src/domain/session.rs` | 会话有效期算术（纯函数，可测） | 建（Task 7） |
| `knowledge-server/src/api/extract.rs` | 鉴权提取器 | 改：绝对上限 + 节流滑动续期（Task 7） |
| `knowledge-server/src/config.rs` | 配置 | 改：加绝对上限配置（Task 7） |

---

### Task 1: html 能被解析，且可搜文本只有一个产地

**Files:**
- Modify: `knowledge-server/src/port/document_parser.rs:40-54`（`ParsedDocument` 加字段）
- Modify: `knowledge-server/src/adapter/parser/markdown.rs:28-33`、`docx_to_md.rs`、`docx_lite.rs`、`pdf.rs`（各自填 `mime`）
- Create: `knowledge-server/src/domain/search_text.rs`
- Create: `knowledge-server/src/adapter/parser/html.rs`
- Modify: `knowledge-server/src/adapter/parser/mod.rs:6-11`、`registry.rs:27-37`
- Modify: `knowledge-server/src/domain/mod.rs`（加 `pub mod search_text;`）

**Interfaces:**
- Consumes: 无（本任务只动解析层）
- Produces:
  - `ParsedDocument` 新字段 `pub mime: String`（描述**库里存的那份内容**的类型）
  - `pub fn search_text::derive(mime: &str, content: &str) -> Option<String>` —— `None` 表示"原文即可搜"
  - `pub struct HtmlParser`，`id() == "html"`，扩展名 `["html", "htm"]`，产物类型 `text/html`

**背景**（不要重新推理）：`docx` / `pdf` 传进来会被解析成 markdown，所以它们的产物类型**仍然是 `text/markdown`**——`mime` 描述的是落库内容，不是上传文件。html 是文本形态，**原件原样存 `content`**（agent 要能读能改它），另派生一份剥掉标记的可搜文本。

**范围提醒**：本任务**只加 html**。csv / json **不在范围内**——Aide 全仓没有 csv 处理，文件类型词汇只有 markdown 与 html（spec §5.1）。别顺手加回来。

- [ ] **Step 1: 写失败的测试**

新建 `knowledge-server/src/domain/search_text.rs` 的测试部分先写出来（文件里先只有测试 + 一个 `todo!()` 之外的桩）：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_has_no_separate_search_text() {
        assert_eq!(derive("text/markdown", "# 标题\n正文"), None);
    }

    /// Review Focus #2：脚本与样式的内容不该被搜出来。
    #[test]
    fn drops_script_and_style_bodies() {
        let html = "<html><head><style>.a{color:red}</style>\
                    <script>var secretName=1;</script></head>\
                    <body><p>季度复盘</p></body></html>";
        let text = derive("text/html", html).unwrap();
        assert!(text.contains("季度复盘"), "正文没被抽出来: {text}");
        assert!(!text.contains("secretName"), "脚本内容混进了可搜文本: {text}");
        assert!(!text.contains("color:red"), "样式内容混进了可搜文本: {text}");
    }

    #[test]
    fn drops_tags_but_keeps_words_apart() {
        let text = derive("text/html", "<h1>一季度</h1><p>复盘</p>").unwrap();
        assert_eq!(text, "一季度 复盘");
    }

    #[test]
    fn drops_comments() {
        let text = derive("text/html", "a<!-- 草稿 -->b").unwrap();
        assert!(!text.contains("草稿"), "注释混进了可搜文本: {text}");
    }

    #[test]
    fn only_html_needs_a_separate_search_text() {
        // 反向钉住范围：产品里没有 csv / json（spec §5.1），
        // 真出现也一律走「原文即可搜」，不在这里给它们开后门。
        assert_eq!(derive("text/csv", "a,b\n1,2"), None);
        assert_eq!(derive("application/json", "{\"a\":1}"), None);
        assert_eq!(derive("text/plain", "一句话"), None);
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd knowledge-server && cargo test search_text`
Expected: 编译失败（`derive` 未定义）

- [ ] **Step 3: 实现 `domain/search_text.rs`**

```rust
//! 可搜文本的唯一产地。
//!
//! 「条目 = 原件 + 派生可搜文本」（spec §4.1）。派生文本**允许失真**——它只服务检索，
//! agent 读到的永远是原件。所以这里剥标记可以糙，但**不能把脚本内容搜出来**，
//! 那是让人搜不到正文的噪声。
//!
//! 放在 domain 而不是 adapter：它是纯文本变换，不是文件解析；解析端口是文件级的
//! （`parse(path)`），而编辑保存也要重算可搜文本（spec Review Focus #4），
//! 两条路必须共用同一份规则——否则编辑过的 html 会留着旧的搜索内容。

/// `None` = 与 `content` 相同（md 及一切「原文即可搜」的条目）。
pub fn derive(mime: &str, content: &str) -> Option<String> {
    match mime {
        "text/html" => Some(html_to_text(content)),
        _ => None,
    }
}

/// 粗剥 HTML，只服务于检索。
///
/// 明确**不做**的事（够用即可，别扩）：
/// - 不解码实体：`&amp;` 保持原样（搜"&"命中不到词，可接受）
/// - 不判 CSS 隐藏：`display:none` 的文字仍会被搜到
/// - 不还原表格结构：单元格只当成词
fn html_to_text(html: &str) -> String {
    const RAW: [&str; 2] = ["script", "style"];
    let mut out = String::with_capacity(html.len() / 2);
    let mut rest = html;
    loop {
        let Some(lt) = rest.find('<') else {
            push_text(&mut out, rest);
            break;
        };
        push_text(&mut out, &rest[..lt]);
        let after = &rest[lt + 1..];
        let Some(gt) = after.find('>') else {
            push_text(&mut out, &rest[lt..]); // 未闭合的 '<' 当正文
            break;
        };
        let tag = after[..gt].trim();
        let name = tag
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();

        // raw 元素：整段跳到它自己的结束标签之后
        if !tag.starts_with('/') && RAW.contains(&name.as_str()) {
            let close = format!("</{name}");
            let tail = &after[gt + 1..];
            rest = match find_ci(tail, &close) {
                Some(p) => {
                    let after_close = &tail[p + close.len()..];
                    after_close.find('>').map_or("", |q| &after_close[q + 1..])
                }
                None => "",
            };
            continue;
        }

        // 注释 / 声明：整段丢掉；其余标签一律当一个分隔符
        if !tag.starts_with('!') {
            out.push(' ');
        }
        rest = &after[gt + 1..];
    }
    collapse_ws(&out)
}

fn push_text(out: &mut String, raw: &str) {
    out.push_str(raw);
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn find_ci(haystack: &str, needle_lower: &str) -> Option<usize> {
    let h = haystack.to_ascii_lowercase();
    h.find(needle_lower)
}
```

> ⚠️ `find_ci` 用 `to_ascii_lowercase` 后 `find`，返回的字节下标与原串一致——ASCII 大小写转换不改字节长度，**前提是 haystack 里没有非 ASCII 的大小写折叠**（这里只拿它找 `</script`/`</style`，安全）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd knowledge-server && cargo test search_text`
Expected: 5 个用例全过

- [ ] **Step 5: 写 html 后端的失败测试**

在 `knowledge-server/src/adapter/parser/html.rs` 里先写测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::DocumentParser;
    use std::io::Write;

    fn write_fixture(name: &str, body: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("aide-kb-html-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(body).unwrap();
        p
    }

    #[test]
    fn claims_both_html_extensions_and_nothing_else() {
        let exts = HtmlParser.extensions();
        assert!(exts.contains(&"html"));
        assert!(exts.contains(&"htm"));
        // 反向钉住：别顺手把 csv / json 加回来（spec §5.1 —— Aide 没有这些格式）
        assert!(!exts.contains(&"csv"));
        assert!(!exts.contains(&"json"));
    }

    #[test]
    fn mime_is_html_regardless_of_which_extension() {
        for name in ["a.html", "b.htm"] {
            let p = write_fixture(name, b"<p>x</p>");
            assert_eq!(HtmlParser.parse(&p).unwrap().mime, "text/html", "{name}");
        }
    }

    #[test]
    fn html_source_is_kept_verbatim() {
        // agent 读到的必须是原件——它可能要改它，剥过标签的 html 是废的。
        let src = "<p>你好</p>";
        let p = write_fixture("b.html", src.as_bytes());
        assert_eq!(HtmlParser.parse(&p).unwrap().markdown, src);
    }

    /// Review Focus #1：非 UTF-8（GBK）必须如实报错，不许静默乱码。
    #[test]
    fn non_utf8_file_fails_loudly() {
        // 0xC4 0xE3 是 GBK 的「你」，不是合法 UTF-8
        let p = write_fixture("gbk.html", &[0xC4, 0xE3, b',', b'1']);
        let err = HtmlParser.parse(&p).unwrap_err();
        assert!(format!("{err}").contains("读取失败"), "错误文案没写清原因: {err}");
    }

    #[test]
    fn title_is_left_to_the_ingest_fallback() {
        let p = write_fixture("季度复盘.html", b"<p>x</p>");
        assert_eq!(HtmlParser.parse(&p).unwrap().title, None);
    }
}
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd knowledge-server && cargo test html`
Expected: 编译失败（`HtmlParser` 未定义）

- [ ] **Step 7: 实现 html 后端并接线**

`knowledge-server/src/adapter/parser/html.rs`（测试块之上）：

```rust
//! html —— **文本产物**：原件原样入库。
//!
//! `ParsedDocument.markdown` 就是文件内容本身，不做任何转换：agent 读到的、
//! 人在编辑器里改的都是这份文本本体（剥过标签的 html 对 agent 是废的）。
//!
//! 可搜文本**不在这里产出**——它由 `domain::search_text::derive` 按 mime 一处算出，
//! 否则编辑保存的路径会漏算（spec Review Focus #4）。
//!
//! 范围：只有 html / htm。**csv / json 不在内**——Aide 全仓没有 csv 处理，
//! 文件类型词汇只有 markdown 与 html（spec §5.1）。

use std::path::Path;

use crate::port::{DocumentParser, ParsedDocument, ParseError};

pub struct HtmlParser;

impl DocumentParser for HtmlParser {
    fn id(&self) -> &'static str {
        "html"
    }

    fn extensions(&self) -> &[&'static str] {
        &["html", "htm"]
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParseError> {
        let content = std::fs::read_to_string(path).map_err(|e| ParseError::Failed {
            path: path.display().to_string(),
            reason: format!("读取失败: {e}"),
        })?;
        Ok(ParsedDocument {
            // 产物类型由**服务端按扩展名**决定，绝不采信客户端给的 Content-Type
            mime: "text/html".to_string(),
            markdown: content,
            title: None, // 交给 ingest 用文件名兜底（domain/ingest.rs::parse_file）
            warnings: Vec::new(),
            assets: Vec::new(),
        })
    }
}
```

接线三处（缺一处都不生效）：

1. `knowledge-server/src/adapter/parser/mod.rs` —— 与既有 `pub mod markdown;` 并列加 `pub mod html;`
2. `knowledge-server/src/adapter/parser/registry.rs:28-36` —— 在 `with_defaults()` 的 Vec 里加 `Arc::new(HtmlParser)`。**放在 `markdown` 之后、`docx_to_md` 之前**（Vec 顺序即优先级；扩展名与既有后端不重叠，位置只影响可读性）。
3. `knowledge-server/src/domain/mod.rs` —— 加 `pub mod search_text;`

- [ ] **Step 8: 给四个既有后端补 `mime` 字段**

`ParsedDocument` 加字段后它们全部编译不过，逐个补 `mime: "text/markdown".to_string(),`：

- `adapter/parser/markdown.rs:28-33`
- `adapter/parser/docx_to_md.rs`、`docx_lite.rs`、`pdf.rs` 各自构造 `ParsedDocument` 的那一处

（docx/pdf 的产物是解析出来的 markdown，所以**不是** `application/pdf`——见本任务「背景」。）

- [ ] **Step 9: 跑全部测试**

Run: `cd knowledge-server && cargo test`
Expected: 全绿（含既有 10 处 `#[cfg(test)] mod tests`）

- [ ] **Step 10: 提交**

```bash
git add knowledge-server/src
git commit -m "feat(kb): html 产物入库 + 可搜文本的唯一产地"
```

---

### Task 2: 落库 —— mime 与可搜文本进表，编辑后重算

**Files:**
- Create: `knowledge-server/migrations/007_document_mime.sql`
- Modify: `knowledge-server/src/domain/versioning.rs:17-25`（`SaveInput`）、`:28-33`（`save_revision`）、`:36-48`（SELECT）、`:58-95`（合并分支）、`:97-126`（新版本分支）、`:137-145`（`CreateInput`）、`:157-168`（`create_node`）、`:173`（`insert_node`）、`:196-206`（`insert_first_revision`）
- Modify: `knowledge-server/src/domain/ingest.rs:33-41`（`IngestInput`）、`:129-142`（调 `create_node`）
- Modify: `knowledge-server/src/api/ingest.rs:54-59` 附近（把 `parsed.mime` 传下去）
- Modify: `knowledge-server/src/api/documents.rs:134-143`（新建走默认 mime）
- Modify: `knowledge-server/src/domain/search.rs:49-51`（高亮片段取值源）
- Modify: `knowledge-server/src/types.rs`（`KbDocumentSummary`/`DocumentView` 加 `mime` 字段——**确切结构以该文件现状为准**）
- Modify: `knowledge-server/src/api/spaces.rs`（列表带 `mime`）
- Modify: `knowledge-server/src/api/documents.rs`（详情带 `mime`）
- Modify: `knowledge-server/smoke.sh`（资料库段落）

**Interfaces:**
- Consumes: `search_text::derive(mime, content) -> Option<String>`（Task 1）
- Produces:
  - `documents.mime text NOT NULL DEFAULT 'text/markdown'`
  - `revisions.search_text text`（NULL = 与 `content` 相同）
  - `CreateInput` 新字段 `pub mime: String`
  - 列表与详情 DTO 新字段 `mime: String`

**为什么 `search_text` 存一份而不是每次现算**：`tsv` 是生成列，必须由表里的列算（`002_search.sql:34-38`）；检索的高亮片段也从它切。代价是 md 条目与 `content` 重复一份——`002_search.sql` 已经为 `title_tokenized`/`content_tokenized` 付过同样的冗余，理由一样：可诊断、换规则后能一眼看出派生对不对。

**改动面清单（`006_documents_tree.sql:23-25` 明文规定"维持一致的责任落在这三个写入点"）**：

| 写入点 | 行 | 要改什么 |
|---|---|---|
| 合并窗口分支 `UPDATE revisions … SET` | `versioning.rs:61-68` | 加 `search_text` 列与 bind |
| 新版本分支 `INSERT INTO revisions` | `versioning.rs:105-109` | 加 `search_text` 列与 bind |
| 首版本 `insert_first_revision` | `versioning.rs:196-200` | 加 `search_text` 列与 bind |
| tokenize 取值 | `versioning.rs:73-74`、`:115-116`、`:205-206` | 源从 `content` 改成 `search_text.unwrap_or(content)` |
| `INSERT INTO documents`（**全仓唯一**） | `versioning.rs:173` | 加 `mime` 列与 bind |

- [ ] **Step 1: 写迁移**

新建 `knowledge-server/migrations/007_document_mime.sql`：

```sql
-- 007_document_mime.sql — 条目的存储类型 + 派生可搜文本。
-- 背景：docs/superpowers/specs/2026-09-30-aide-library-design.md §5.2
--
-- ⚠️ 事务由 src/db.rs 的 migrate() 统一包裹，本文件内不要写 BEGIN / COMMIT。

-- mime 描述的是**库里存的那份内容**的类型，不是上传时的文件类型：
-- docx/pdf 传进来会被解析成 markdown，所以它们的产物类型仍是 text/markdown。
-- 值由服务端按扩展名决定（adapter/parser/html.rs），**不采信客户端
-- 给的 Content-Type**——那是发送方自己声明的，正是 spec §4.3 禁止的那类信任。
-- DEFAULT 让存量行自动成为 markdown：它们本来就是。
ALTER TABLE documents ADD COLUMN mime text NOT NULL DEFAULT 'text/markdown';

-- 派生可搜文本。NULL = 与 content 相同（md 及一切「原文即可搜」的条目）。
--
-- 存一份而不是每次现算，是因为 tsv 是**生成列**、必须由表里的列算（002_search.sql），
-- 且检索高亮片段也从它切——现算的话每查一次都要重跑一遍剥标记。
-- 代价：md 条目与 content 重复一份。002_search.sql 为 title_tokenized/content_tokenized
-- 付过同样的冗余，理由相同：可诊断，且换了派生规则能一眼看出对不对。
ALTER TABLE revisions ADD COLUMN search_text text;
```

- [ ] **Step 2: 改写入端（三个写入点 + tokenize 取值 + mime）**

`versioning.rs` 的具体改法：

1. `CreateInput` 加 `pub mime: String,`；`SaveInput` **不加**（保存路径的 mime 从库里读）。
2. `save_revision` 开头那个 `SELECT current_revision_id, kind FROM documents … FOR UPDATE`（`:36-48`）**多取一列 `mime`**。
3. 三个写入点在写之前先算两样东西，**只算一次**：

```rust
// 可搜文本与分词输入都从同一次派生来——两者不同源会让"能搜到"和"高亮在哪"
// 对不上，而那种错只能靠翻库才看得出来。
let search_text = crate::domain::search_text::derive(&mime, &content);
let tokenize_src = search_text.as_deref().unwrap_or(&content);
let content_tokenized = tokenizer.tokenize(tokenize_src);
```

4. 三处 SQL 各加一列 `search_text` 并 bind `search_text`（类型 `Option<String>`）。
5. `insert_node`（`:173`）的 `INSERT INTO documents` 加 `mime` 列并 bind `input.mime`。
6. `create_node` 内部同样按上面第 3 步派生（首版本走 `insert_first_revision`）。

- [ ] **Step 3: 改 ingest 通路**

`domain/ingest.rs::IngestInput` 加 `pub mime: String`；`:129-142` 调 `create_node` 时传 `mime: input.mime.clone()`；`api/ingest.rs` 在构造 `IngestInput` 处传 `parsed.mime.clone()`（`parse_file` 的返回里已经带着它）。

- [ ] **Step 4: 改检索读取端**

`domain/search.rs:49-51` 的 `ts_headline` 取值源：

```
ts_headline('simple'::regconfig, coalesce(r.search_text, r.content), q, '…同上…') AS snippet
```

`tsv` 的生成列**不动**——`002_search.sql` 里它取的是 `coalesce(content_tokenized, content)`，而 `content_tokenized` 已经由第 2 步改成了派生文本的分词结果，html 条目自然就不带标签噪声了。

- [ ] **Step 5: DTO 带出 mime**

`types.rs` 里文档摘要与详情两个结构各加 `pub mime: String`；`api/spaces.rs`（列表查询）与 `api/documents.rs`（详情查询）的 SELECT 各带上 `d.mime` / `documents.mime`。字段名走既有的 `#[serde(rename_all = "camelCase")]`，**不要手写 `rename`**（跨 IPC 的嵌套字段名不做大小写转换，写歪即静默丢字段——见 memory「tauri-nested-struct-field-names」）。

- [ ] **Step 6: 冒烟——建栈 → 跑 → 拆栈**

按 `docs/superpowers/plans/2026-09-18-knowledge-base-tree.md` 的「验证环境」一节原样执行（隔离 stack、端口 18788、`-p kbsmoke`）。在 `smoke.sh` 的资料库段落里加三条断言：

1. **上传一个 html** → `GET /api/documents/{id}` 的 `mime` 是 `text/html`；`GET /api/ingest/formats` 里**有 html、没有 csv**（反向钉住范围，spec §5.1）
2. **上传一个 html**（正文含一个独特词，且 `<script>` 里含另一个独特词）→ `GET /api/search?q=<正文词>` 命中；`GET /api/search?q=<脚本里的词>` **零命中**（Review Focus #2）
3. **编辑那个 html**（PUT 换掉正文里的词）→ 搜**新**词命中、搜**旧**词零命中（Review Focus #4）

- [ ] **Step 7: 提交**

```bash
git add knowledge-server
git commit -m "feat(kb): 条目带 mime 与派生可搜文本，编辑后重算"
```

---

### Task 3: 取件地址（本机可达的预览通路）

**Files:**
- Create: `knowledge-server/src/domain/preview_token.rs`
- Create: `knowledge-server/src/api/preview.rs`
- Modify: `knowledge-server/src/api/mod.rs`（路由表 + `AppState`）
- Modify: `knowledge-server/src/domain/mod.rs`、`src/api/mod.rs` 的模块声明
- Modify: `knowledge-server/smoke.sh`
- Modify: `knowledge-server/README.md`

**Interfaces:**
- Consumes: `documents.mime`、`revisions.content`（Task 2）
- Produces:
  - `POST /api/documents/{id}/preview-token` → `{"token": String, "expiresAt": i64}`（**要 Bearer**）
  - `GET /p/{token}` → 原件字节 + 该条目的 `Content-Type`（**不要 Bearer**）
  - `preview_token::mint(...)` / `preview_token::redeem(...)`

**为什么地址不带 Bearer**：右栏浏览器是直接导航过去的，地址栏发不出 `Authorization` 头——这正是 `assetLoader.ts` 要绕道 objectURL 的同一个原因。所以取件口用**不透明 token**鉴权（spec §4.5 / §4.6）。

**为什么 token 只在内存里**：预览地址是"点一下马上打开"的短时票据，进程重启即失效是**正确行为**，不是缺陷（spec Review Focus #5 把它钉住）。第三步「发布」需要持久票据，届时另加。

**本任务不做**：多文件产物（WorkBuddy 那种 `-Hero.html` + `janus.data.json` 一套）。本次一个条目 = 一份文本，相对资源取不到；自包含的单文件 html 正常。

- [ ] **Step 1: 写失败的测试**

`knowledge-server/src/domain/preview_token.rs` 的测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn token_is_unguessable_and_unique() {
        let store = PreviewTokens::new();
        let a = store.mint(Uuid::new_v4(), 60);
        let b = store.mint(Uuid::new_v4(), 60);
        assert_ne!(a.0, b.0);
        assert!(a.0.len() >= 32, "token 太短，可被枚举: {}", a.0.len());
    }

    /// Review Focus #5：过期与未知都必须明确失效。
    #[test]
    fn unknown_and_expired_tokens_are_rejected() {
        let store = PreviewTokens::new();
        assert!(store.redeem("nope").is_none(), "未知 token 不该被放行");

        let doc = Uuid::new_v4();
        let (token, _) = store.mint(doc, 0); // 立刻过期
        assert!(store.redeem(&token).is_none(), "过期 token 不该被放行");
    }

    #[test]
    fn redeem_returns_the_right_document() {
        let store = PreviewTokens::new();
        let doc = Uuid::new_v4();
        let (token, _) = store.mint(doc, 60);
        assert_eq!(store.redeem(&token), Some(doc));
    }

    /// 预览票据是**只读**的：换一份条目就得换一个 token，不能拿一个 token 探别人。
    #[test]
    fn token_grants_exactly_one_document() {
        let store = PreviewTokens::new();
        let (token, _) = store.mint(Uuid::new_v4(), 60);
        assert_eq!(store.redeem(&token), Some(store.peek_owner(&token).unwrap()));
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd knowledge-server && cargo test preview_token`
Expected: 编译失败（`PreviewTokens` 未定义）

- [ ] **Step 3: 实现票据仓**

`knowledge-server/src/domain/preview_token.rs`：`PreviewTokens` 持 `Mutex<HashMap<String, Ticket>>`，`Ticket { document_id: Uuid, expires_at: i64 }`。token 用 `Uuid::new_v4()` 两次拼成 64 位十六进制（**不引入新的随机数依赖**）。`mint(document_id, ttl_secs) -> (String, i64)`、`redeem(&str) -> Option<Uuid>`（顺带清掉过期项）、`peek_owner(&str) -> Option<Uuid>`（测试用）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd knowledge-server && cargo test preview_token`
Expected: 4 个用例全过

- [ ] **Step 5: 挂路由**

`api/preview.rs`：

- `mint_token(State, CurrentUser, Path(id)) -> AppResult<Json<PreviewTokenResponse>>` —— **沿用文档读权限判权**（照抄 `api/documents.rs::get` 的判权调用，不要另写一套），签 10 分钟票据。
- `fetch(State, Path(token)) -> AppResult<Response>` —— `redeem` 拿 `document_id`；查 `documents.mime` 与当前 revision 的 `content`；组装 `Content-Type`（**空/未知 mime 显式退化成 `text/plain; charset=utf-8`**，照 `api/assets.rs:28-33` 的既有写法）；返回字节。未知/过期 → `404`，文案写清"这个预览链接已失效，请回到资料库重新打开"。

`api/mod.rs`：路由表加

```rust
.route("/api/documents/{id}/preview-token", post(preview::mint_token))
.route("/p/{token}", get(preview::fetch))
```

**`/p/{token}` 不要挂进任何 Bearer 中间件**——它是唯一一条不需要登录的读路由，挂错就白做。

- [ ] **Step 6: 冒烟断言**

在 `smoke.sh` 的资料库段落加：

1. 上传 html → `POST …/preview-token` 拿到 token → `curl -s http://127.0.0.1:18788/p/<token>` 返回的正文**逐字等于**上传的 html、`Content-Type` 是 `text/html`
2. **不带** Authorization 访问 `/p/<token>` → 200（确认取件口不要求 Bearer）
3. 访问 `/p/一个不存在的token` → 404，且响应体是中文失效文案（Review Focus #5）

- [ ] **Step 7: 更新 README**

`knowledge-server/README.md` 加两小节：新增的三种扩展名、取件地址的语义（短时、只读、进程重启即失效、第三步「发布」会另加持久票据）。

- [ ] **Step 8: 提交**

```bash
git add knowledge-server
git commit -m "feat(kb): 取件地址——本机可达、只读、一次性的预览通路"
```

---

### Task 4: 前端能把一个地址开到右栏浏览器

**Files:**
- Modify: `src/composables/useRightPanel.ts:128-145`（导出）、`:24-25` 附近（模块级状态）
- Modify: `src/components/Browser/BrowserPanel.vue`（新增 watch）
- Test: `src/composables/useRightPanel.test.ts`（新建）

**Interfaces:**
- Consumes: `ensureBrowserShown()`（`useRightPanel.ts:83-85`，已有）
- Produces:
  - `openInBrowser(url: string): void`
  - `pendingBrowserUrl: Ref<string | null>`
  - `consumePendingBrowserUrl(): string | null`

**背景**：右栏所有 tab 是同一个 `tab` ref 的单例槽位，靠 `v-show` 切换；`BrowserPanel.vue` 完全自闭（无 props/emits/`defineExpose`），URL 是它内部私有状态，外部唯一合法的程序化入口是 Rust 侧的 agent 桥（`op=open` + `op=focus`，两步、且建出来的视口写死 1280×800，是给 agent 用的）。所以本任务走**待办请求**模式：右栏记下一个待打开的地址，面板自己消费——`useBrowserViews.ts:35-39` 的 `pendingFocusViewId` 就是这个模式，照它写。

- [ ] **Step 1: 写失败的测试**

新建 `src/composables/useRightPanel.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useRightPanel } from "./useRightPanel";

describe("useRightPanel.openInBrowser", () => {
  beforeEach(() => {
    const p = useRightPanel();
    p.consumePendingBrowserUrl(); // 清掉上一条用例留下的待办
    p.setMaximized(false);
  });

  it("展开右栏并记住要打开的地址", () => {
    const p = useRightPanel();
    p.openInBrowser("http://127.0.0.1:8788/p/abc");
    expect(p.tab.value).toBe("browser");
    expect(p.collapsed.value).toBe(false);
    expect(p.pendingBrowserUrl.value).toBe("http://127.0.0.1:8788/p/abc");
  });

  it("消费之后待办清空，不会被第二个面板重复打开", () => {
    const p = useRightPanel();
    p.openInBrowser("http://127.0.0.1:8788/p/abc");
    expect(p.consumePendingBrowserUrl()).toBe("http://127.0.0.1:8788/p/abc");
    expect(p.consumePendingBrowserUrl()).toBeNull();
    expect(p.pendingBrowserUrl.value).toBeNull();
  });

  it("连开两个地址时后者覆盖前者", () => {
    const p = useRightPanel();
    p.openInBrowser("http://127.0.0.1:8788/p/one");
    p.openInBrowser("http://127.0.0.1:8788/p/two");
    expect(p.pendingBrowserUrl.value).toBe("http://127.0.0.1:8788/p/two");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/composables/useRightPanel.test.ts`
Expected: FAIL —— `p.openInBrowser is not a function`

- [ ] **Step 3: 实现**

`useRightPanel.ts`：模块级加

```ts
// 待打开的地址：右栏只负责"记下来 + 把浏览器 tab 露出来"，真正去
// browser.create / browser.navigate 的是 BrowserPanel 自己——它的内部状态
// 不对外暴露（无 props / 无 emits / 无 defineExpose），这个 ref 是唯一的缝。
const pendingBrowserUrl = ref<string | null>(null);
```

闭包内加

```ts
function openInBrowser(url: string): void {
  ensureBrowserShown();
  pendingBrowserUrl.value = url;
}

function consumePendingBrowserUrl(): string | null {
  const url = pendingBrowserUrl.value;
  pendingBrowserUrl.value = null;
  return url;
}
```

并把 `pendingBrowserUrl` / `openInBrowser` / `consumePendingBrowserUrl` 加进 `:128-145` 的返回对象。

`BrowserPanel.vue`：`onMounted` 之后加一个 watch，复用面板**已有的**建视图/导航路径，不要重写一份：

```ts
watch(
  () => rightPanel.pendingBrowserUrl.value,
  (url) => {
    if (!url) return;
    const target = rightPanel.consumePendingBrowserUrl();
    if (!target) return;
    // 复用面板自己的 go()/ensureView 路径，保证地址栏、收藏、标签状态一致
    void openExternally(target);
  },
);
```

其中 `openExternally` 是面板内**新增的薄函数**，把地址写进它已有的 tab 列表并调用 `ensureView`（照 `go()` 在 `BrowserPanel.vue:353-364` 的写法）。**不要**直接调 `browser.create` 绕过面板状态。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/composables/useRightPanel.test.ts`
Expected: 3 个用例全过

- [ ] **Step 5: 提交**

```bash
git add src/composables/useRightPanel.ts src/composables/useRightPanel.test.ts src/components/Browser/BrowserPanel.vue
git commit -m "feat(browser): 右栏支持被程序化请求打开一个地址"
```

---

### Task 5: 正文按 mime 分派预览 + 上传入口

**Files:**
- Create: `src/components/KnowledgeBase/previewKind.ts`
- Modify: `src/components/KnowledgeBase/kbClient.ts`（DTO 加 `mime`；新增 `previewToken` / `ingest`）
- Modify: `src/components/KnowledgeBase/KbDocumentView.vue`（阅读态按 mime 分派）
- Modify: `src/components/KnowledgeBase/KbTree.vue`（新建菜单里加「上传文件…」）
- Modify: `src/components/KnowledgeBase/KnowledgeBase.vue`（索引态空态也给上传入口 + 两态转场）
- Test: `src/components/KnowledgeBase/previewKind.test.ts`（新建）

> ⚠️ **本任务是在 UI 结构重做之后改写的。** 常驻侧栏已经没了，界面是「索引态 / 阅读态」两个全屏态
> （`KnowledgeBase.vue` 的 `reading` 判据）。**别再按"树在左侧栏、正文在右边"那版写。**

**Interfaces:**
- Consumes: `kb.openInBrowser`（Task 4）、`POST /api/documents/{id}/preview-token`（Task 3）、`GET /api/ingest/formats`（既有）
- Produces:
  - `previewKindFor(mime: string): "markdown" | "html" | "text"`
  - `kb.previewToken(id: string): Promise<{ token: string; expiresAt: number }>`
  - `kb.ingest(input: { spaceId: string; parentId?: string | null; file: File }): Promise<{ documentId: string }>`

**范围**：预览**只有两档 + 一个兜底**（markdown / html / 纯文本），与 Aide 自己的文件类型词汇一致（spec §5.1：`useFileViewer` 的 `isMarkdown` + `FileWindow` 的 `isHtmlFilePath`）。**不要加 csv / json 预览**——产品里没有这些东西。

- [ ] **Step 1: 写失败的测试**

`src/components/KnowledgeBase/previewKind.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { previewKindFor } from "./previewKind";

describe("previewKindFor", () => {
  it("认识产品既有的两种", () => {
    expect(previewKindFor("text/markdown")).toBe("markdown");
    expect(previewKindFor("text/html")).toBe("html");
  });

  it("带 charset 参数也认得", () => {
    expect(previewKindFor("text/html; charset=utf-8")).toBe("html");
  });

  it("不认识的一律退化成纯文本，绝不留白", () => {
    expect(previewKindFor("application/octet-stream")).toBe("text");
    expect(previewKindFor("")).toBe("text");
  });

  // 反向钉住：别顺手引入产品里没有的格式（spec §5.1）
  it("csv / json 没有专门预览", () => {
    expect(previewKindFor("text/csv")).toBe("text");
    expect(previewKindFor("application/json")).toBe("text");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/components/KnowledgeBase/previewKind.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现分派**

`previewKind.ts`：按 mime 主类型判定，**先剥 `;` 参数再 trim 小写**；只返回那三种。注释里写明为什么只有这三种，并引用 spec §5.1（免得后人"顺手补齐"）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/components/KnowledgeBase/previewKind.test.ts`
Expected: 4 个用例全过

- [ ] **Step 5: 接线：分派 + 上传入口**

1. `kbClient.ts`：`KbDocumentSummary` / `KbDocument` 加 `mime: string`；新增
   ```ts
   previewToken(id: string): Promise<{ token: string; expiresAt: number }>
   ingest(input: { spaceId: string; parentId?: string | null; file: File }): Promise<{ documentId: string }>
   ```
   `previewToken` 走既有 `request<T>()`；**`ingest` 是 multipart**（`FormData`，`spaceId`/`parentId` 进 query，文件字段名按服务端 `next_field()` 的约定），要**照 `getAsset` 的写法自己走 fetch 分支**——`request<T>()` 只处理 JSON。
2. `KbDocumentView.vue` 把 `:263-268` 那处 `v-html="renderKbMarkdown(...)"` 换成分派：
   - `markdown` → 现有渲染（**一行不改**）
   - `html` → 「在右栏打开」按钮 + 打开时 `kb.previewToken(doc.id)` 拿 token，拼 `` `${getBaseUrl()}/p/${token}` ``，调 `useRightPanel().openInBrowser(url)`；旁边标一句"预览链接 10 分钟后失效，过期重新点一次"
   - `text` → 转义后 `<pre>`（防御性分支，现在到不了）
3. **上传入口放进「新建」菜单**（不是单独一个按钮，也不是独立组件）：
   - `KbTree.openCreateMenu` 现在给的是「新建文件夹 / 新建文档」二选一。**加第三项「上传文件…」**，落在该菜单对应的父节点下（根或某个文件夹）——上传和"新建"是同一类动作，本来就该在同一个入口里。
   - 菜单项按仓库惯例收进 `src/menus/contextMenus.ts`。
   - `<input type="file">`；**认哪些格式由服务端说了算**——读 `kb.formats()`（`GET /api/ingest/formats`，前端已有方法但没人调用）做 `accept` 与前端预检，**不预判、不硬编格式表**。
   - 认的格式走 `kb.ingest(...)`，成功后刷新目录。
   - **不认的格式当场拒绝**，文案写清"资料库只收：<服务端返回的列表>"（**Review Focus #3**）。
   - 413（超过既有的 32 MiB）给可读提示，不裸抛。
   - 索引态空空间的那句邀请（`kb-index-empty`）里也放一个上传入口。
4. **两个态之间的转场**（用户要"更狠"的那一条）：索引 ⇄ 阅读切换时给一次有方向的过渡——
   索引向上退、内容向上浮，180ms、`var(--aide-ease)`，**只此一处动效**，别在每张卡上加 hover 过渡。
   `prefers-reduced-motion` 下关掉。

- [ ] **Step 6: 跑前端全量测试**

Run: `pnpm test`
Expected: 全绿（含既有的 `useKnowledgeBase.test.ts` 等）

- [ ] **Step 7: 提交**

```bash
git add src/components/KnowledgeBase
git commit -m "feat(kb): 正文按 mime 分派预览（md/html）+ 上传入口"
```

---

### Task 6: 打开面板不再要求登录

**Files:**
- Modify: `src/composables/useKnowledgeBase.ts:85-121`（`init`）
- Modify: `src/components/KnowledgeBase/KnowledgeBase.vue:185-209`（分流与文案）
- Modify: `src/components/KnowledgeBase/KbLogin.vue:31-40`
- Test: `src/composables/useKnowledgeBase.test.ts`（扩展，**该文件已存在**）

**Interfaces:**
- Consumes: 无新外部接口
- Produces: `init()` 在"已有凭据"时静默进入主界面，不再落登录页

**硬约束（spec §4.3，不许为省事破坏）**：

1. **不得**实现成"本机请求一律信任"——免登录只能是"凭据由 Aide 替你带着"，**不能是"不用凭据"**。服务端 `auth::me` 仍是 Bearer 校验，本次**不动任何服务端鉴权**。
2. 凭据存哪**不变**：`kbClient.ts:12-13` 的 localStorage 键、`kbRuntime.ts` 的镜像机制与它的 6 个调用点全部保持原样。

**改动面**：唯一闸门是 `useKnowledgeBase.ts:104` 的 `if (initialized.value === false || !getToken())`。有 token 就继续走 `me()`；`me()` 失败时 `kbClient` 已经会清 token（`:217-220`），此时才落登录页。要区分的是 `401`（凭据失效 → 落登录页，文案说"登录已过期"）与 `network`（连不上 → 保留 token，文案说"连不上服务"），**不要把网络故障当成凭据失效去清 token**。

> ⚠️ `useKnowledgeBase.test.ts` 用 `vi.mock` 只桩了 5 个 `kbClient` 方法（`:8-28`）。`init()` 里若要新增调用，**必须同步扩那个 mock 工厂**，否则整文件报错。

- [ ] **Step 1: 写失败的测试**

在 `src/composables/useKnowledgeBase.test.ts` 里追加（沿用文件既有的 `deferred` 与 mock 工厂）：

```ts
it("已有凭据时静默进入主界面，不落登录页", async () => {
  mocks.status.mockResolvedValue({ initialized: true });
  mocks.me.mockResolvedValue({ id: "u1", username: "heaven", displayName: "heaven", isAdmin: true });
  mocks.listSpaces.mockResolvedValue([]);
  const k = useKnowledgeBase();
  await k.init();
  expect(k.user.value).not.toBeNull();
  expect(k.ready.value).toBe(true);
});

it("凭据失效（401）才落登录页，并且清掉 token", async () => {
  mocks.status.mockResolvedValue({ initialized: true });
  mocks.me.mockRejectedValue(new KbErrorStub("unauthorized", 401));
  const k = useKnowledgeBase();
  await k.init();
  expect(k.user.value).toBeNull();
  expect(setTokenSpy).toHaveBeenCalledWith(null);
});

it("网络故障不清 token——那不是凭据的问题", async () => {
  mocks.status.mockResolvedValue({ initialized: true });
  mocks.me.mockRejectedValue(new KbErrorStub("network", 0));
  const k = useKnowledgeBase();
  await k.init();
  expect(k.user.value).toBeNull();
  expect(setTokenSpy).not.toHaveBeenCalledWith(null);
  expect(k.error.value).toContain("连不上");
});
```

（`KbErrorStub` / `setTokenSpy` 按文件既有替身写法补；`Error` 的 code 语义照 `kbClient.ts:167` 的 `KbError`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/composables/useKnowledgeBase.test.ts`
Expected: 第三条用例 FAIL（现在 `me()` 一失败就清 token，不区分 401 与 network）

- [ ] **Step 3: 改 `init()` 与登录页角色**

- `init()`：有 token → `me()`；按 `KbError.code` 分流（`unauthorized`/401 → 清 token 落登录页；其余 → **保留 token**、`user=null`、`error` 写"连不上知识库服务，稍后重试"）。
- `KnowledgeBase.vue:185-209`：加载态文案改成"正在连接资料库…"；登录页仅作为兜底出现。
- `KbLogin.vue`：默认形态不变，只是**不再是必经之路**；文案补一句"凭据失效了才需要重新登录"。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/composables/useKnowledgeBase.test.ts`
Expected: 全过（含该文件既有的竞态护栏用例）

- [ ] **Step 5: 提交**

```bash
git add src/composables/useKnowledgeBase.ts src/composables/useKnowledgeBase.test.ts src/components/KnowledgeBase
git commit -m "feat(kb): 打开面板不再要求登录，凭据由 Aide 自动带"
```

---

### Task 7: 会话滑动续期 + 绝对上限

**Files:**
- Create: `knowledge-server/src/domain/session.rs`
- Modify: `knowledge-server/src/domain/mod.rs`（加 `pub mod session;`）
- Modify: `knowledge-server/src/config.rs:43`（新增绝对上限配置）
- Modify: `knowledge-server/src/api/extract.rs:53-69`（判据 + 节流滑动）
- Modify: `knowledge-server/smoke.sh`
- Modify: `knowledge-server/README.md`（说明有效期语义）

**Interfaces:**
- Consumes: `sessions.created_at` / `sessions.expires_at`（`001_init.sql:38-46`，**两列都已存在，不需要迁移**）
- Produces:
  - `session::hard_deadline(created_at: DateTime<Utc>, hard_ttl_hours: i64) -> DateTime<Utc>`
  - `session::slide_threshold(now: DateTime<Utc>, ttl_hours: i64, throttle_hours: i64) -> DateTime<Utc>`

**背景**（spec §4.3）：`KB_SESSION_TTL_HOURS` 默认 14 天且**没有续期**，所以"免登录"实际是"14 天内不用登录"，第 15 天打开面板照样落登录页——直接把 Task 6 的承诺打脸。做成滑动续期后，一直在用就一直不用重登；绝对上限保证它不会永生。

**代价必须写进 README**：滑动续期会让**泄露的凭据"只要攻击者一直在用就不过期"**，绝对上限就是给这一点兜底的。

- [ ] **Step 1: 写失败的测试**

新建 `knowledge-server/src/domain/session.rs` 的测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone, Utc};

    fn t(hours: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 30, 0, 0, 0).unwrap() + Duration::hours(hours)
    }

    #[test]
    fn hard_deadline_is_anchored_to_creation_not_to_last_use() {
        // 绝对上限必须钉在 created_at 上——钉在 expires_at 上就永远到不了
        let c = t(0);
        assert_eq!(hard_deadline(c, 24 * 90), c + Duration::hours(24 * 90));
    }

    /// 节流：一天最多续一次，别每个请求都写库。
    #[test]
    fn slide_threshold_leaves_most_of_the_window_alone() {
        let now = t(100);
        let threshold = slide_threshold(now, 24 * 14, 24);
        // 只有「剩余不足 1 天」时才该续
        assert!(threshold > now + Duration::hours(24 * 13));
        assert!(threshold < now + Duration::hours(24 * 14));
    }

    #[test]
    fn a_fresh_session_is_not_slid() {
        let now = t(0);
        let threshold = slide_threshold(now, 24 * 14, 24);
        // 刚建出来的 session，expires_at 远晚于阈值 → 不该触发写
        assert!(now + Duration::hours(24 * 14) > threshold);
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd knowledge-server && cargo test session`
Expected: 编译失败（`hard_deadline` 未定义）

- [ ] **Step 3: 实现纯函数**

`domain/session.rs`：两个函数各一行算术 + 注释说明为什么钉在 `created_at`、为什么节流。**不要在这里碰数据库**（纯函数才测得了）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd knowledge-server && cargo test session`
Expected: 3 个用例全过

- [ ] **Step 5: 配置与提取器**

- `config.rs:43` 旁加 `session_hard_ttl_hours: env_parse("KB_SESSION_HARD_TTL_HOURS", 24 * 90)`。
- `api/extract.rs:60-61` 的查询条件加绝对上限：
  ```sql
  WHERE s.token_hash = $1
    AND s.expires_at > now()
    AND s.created_at > $2          -- $2 = hard_deadline(now - hard_ttl) 的等价下界
  ```
  （用 `session::hard_deadline` 算出的边界绑定，**不要把天数硬编进 SQL**——那样就测不到了。）
- 鉴权通过后执行节流滑动（一条按主键索引的单行 UPDATE，`sessions_token_hash_uidx` 吃得到）：
  ```sql
  UPDATE sessions SET expires_at = now() + ($2::bigint * interval '1 hour')
  WHERE token_hash = $1 AND expires_at < $3
  ```
  `$3` = `session::slide_threshold(now, ttl_hours, 24)`。

- [ ] **Step 6: 冒烟断言**

在 `smoke.sh` 里加：

1. 正常凭据仍然 200（滑动没把正常路径弄坏）
2. **过期的凭据仍然 401**——用 SQL 把某条 session 的 `expires_at` 改到过去，断言 401
3. **绝对上限生效**——把某条 session 的 `created_at` 改到 100 天前（`expires_at` 保持未来），断言 **401**（这是本条改动的核心，必须钉住）

- [ ] **Step 7: 提交**

```bash
git add knowledge-server
git commit -m "feat(kb): 会话滑动续期 + 绝对上限，让免登录不再每两周破功"
```

---

## 本计划之外（属于**产品第二步**，别漏）

以下内容**不在本计划的六个（现为七个）任务里**，但它们已经定型在 spec 里，执行时不要以为漏了：

- **作者维度（spec §4.4）——独立的下一轮，紧跟本计划，不依赖它的任何东西。** AI 写入今天就在产生，所以"分不清谁写的"是当下就在疼的问题，不是等"收编"做完才出现。内容：`revisions` 加 `author_kind` / `session_id` / `session_title` / `model`；历史列表、条目头部、筛选、点回会话；MCP 写工具加"这次改了什么"的可选参数。
- **"来源"的不可伪造**（spec §4.4 末）：给 agent 一份**绑定会话的独立凭据**——**已定要做，不是可选项**。三条硬边界：① 令牌派生自用户凭据、绑同一 `user_id`，**权限一点不放大**；② 两个方向都关死（agent 令牌一律标 `ai`，人一律标 `human`）；③ 传递通道**必须按会话隔离**，不许复用现在那份全局的 `~/.aide/knowledge*.json`。
- **收编通路**（spec §3 第二步）：会话产物一键入库、记工作区/路径/轮次来源。
- **发布**（spec §3 第三步 / §4.5 / §4.6）。

---

## 交付验收（跑完七个任务后逐条核）

对应 spec §6，逐条给证据：

- [ ] 1. 把一个 `.html` **传进库** → 点"在右栏打开"能在右栏跑起来
- [ ] 1b. 传一个 `.csv` → **当场被拒**，文案说清只收哪些（Review Focus #3）
- [ ] 2. `GET /api/documents/{html条目}` 返回的 `content` 是**源码**（不是剥过标签的文本）——agent 读得到原件
- [ ] 3. 搜 html 正文里的词命中，且高亮片段里**没有标签**
- [ ] 4. md 文档的搜索、版本、回滚行为与之前**完全一致**（回归）
- [ ] 5. 打开知识库面板不再要求登录
- [ ] 6. 存量数据零迁移、零丢失（`007` 的两个 `ADD COLUMN` 都有 DEFAULT / 可空）
- [ ] 7. Review Focus 五条各自的测试都在对应任务里存在且通过
- [ ] 8. 凭据过期 → 401 落兜底页；**`created_at` 超过绝对上限 → 也 401**（Task 7 冒烟第 3 条）

## 执行顺序与依赖

`Task 1 → Task 2 → Task 3 → Task 7`（后端，串行；Task 7 与前三者无代码依赖，只共用同一套冒烟环境，放在一起跑省一次起栈）；`Task 4` 与后端无关可并行；`Task 5` 依赖 Task 3（取件地址）与 Task 4（打开接口）；`Task 6` 独立。
