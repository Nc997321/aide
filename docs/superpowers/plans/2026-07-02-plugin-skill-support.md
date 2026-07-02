# Plugin & Skill 支持实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Aide Chat UI 支持已安装的 Claude Code 插件/Skills——Claude 自动调用（被动）+ 用户 `/skill-name` 主动触发（主动）。

**Architecture:** Sidecar 加 `skills: "all"` 启用 SDK 原生 skill 调用；Rust `skills.rs` 通过 `SkillProvider` trait 扫描三个目录（用户级/项目级/插件级）；前端 ChatPanel.vue 检测 `/` 前缀显示 autocomplete，发送前读取 SKILL.md 内容注入到消息。

**Tech Stack:** TypeScript（agent-sidecar）、Rust + Tauri v2（后端命令）、Vue 3 + Composition API（前端）、`@anthropic-ai/claude-agent-sdk`、`dirs` crate（home dir）

## Global Constraints

- Windows 子进程必须加 `creation_flags(0x08000000)`（本次无新子进程，不涉及）
- 所有 Tauri 命令 snake_case，前端 invoke 参数 camelCase
- Rust struct 序列化到前端用 `#[serde(rename_all = "camelCase")]`
- 新命令不能叫 `list_skills`（`commands::customizations::list_skills` 已占用），统一叫 `scan_plugin_skills`
- `dirs` crate 版本 `"5"`，已有 `serde`/`serde_json`/`tokio` 无需重复添加
- sidecar 改动后必须重新 `npm run build`，Tauri dev 读的是 `agent-sidecar/dist/sidecar.js`
- 前端 `SkillMeta` 使用 camelCase（`filePath` 不是 `file_path`）

---

### Task 1: Sidecar — 启用 `skills: "all"`

**Files:**
- Modify: `agent-sidecar/src/index.ts`

**Interfaces:**
- Produces: SDK 自动发现并向 Claude 暴露所有已安装 skills，Claude 根据上下文自主调用

- [ ] **Step 1: 打开文件，定位 query 选项**

  打开 `agent-sidecar/src/index.ts`，找到如下代码块（约第 35-44 行）：

  ```typescript
  const q = query({
    prompt: queue[Symbol.asyncIterator](),
    options: {
      permissionMode: "default",
      canUseTool: permMgr.makeCallback(emit) as any,
      settingSources: ["project", "user"],
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });
  ```

- [ ] **Step 2: 加入 `skills: "all"`**

  将上面的代码块改为：

  ```typescript
  const q = query({
    prompt: queue[Symbol.asyncIterator](),
    options: {
      permissionMode: "default",
      canUseTool: permMgr.makeCallback(emit) as any,
      settingSources: ["project", "user"],
      skills: "all",
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });
  ```

- [ ] **Step 3: 重新构建 sidecar**

  ```bash
  cd agent-sidecar
  npm run build
  ```

  预期：`dist/sidecar.js` 更新，无编译错误。

- [ ] **Step 4: 验证构建产物包含改动**

  ```bash
  grep -c "skills" agent-sidecar/dist/sidecar.js
  ```

  预期：输出大于 0（`skills` 字符串存在于打包文件中）。

- [ ] **Step 5: Commit**

  ```bash
  git add agent-sidecar/src/index.ts agent-sidecar/dist/sidecar.js
  git commit -m "feat(sidecar): enable skills:all for Claude Agent SDK"
  ```

---

### Task 2: Rust — `src-tauri/src/skills.rs`

**Files:**
- Modify: `src-tauri/Cargo.toml`（加 `dirs = "5"`）
- Create: `src-tauri/src/skills.rs`

**Interfaces:**
- Produces:
  - `pub struct SkillMeta { name, description, source, file_path, provider }`（带 `#[serde(rename_all = "camelCase")]`）
  - `pub trait SkillProvider: Send + Sync { fn provider_name(&self) -> &str; fn scan(&self, cwd: &Path) -> Vec<SkillMeta>; }`
  - `pub struct SkillRegistry` 含 `pub fn new() -> Self` 和 `pub fn list(&self, provider: Option<&str>, cwd: &Path) -> Vec<SkillMeta>`
  - `pub struct ClaudeSkillProvider`（实现 `SkillProvider`）

- [ ] **Step 1: 在 `Cargo.toml` 加入 `dirs` 依赖**

  打开 `src-tauri/Cargo.toml`，在 `[dependencies]` 末尾追加：

  ```toml
  dirs = "5"
  ```

- [ ] **Step 2: 创建 `src-tauri/src/skills.rs`**

  创建新文件，完整内容如下：

  ```rust
  use std::path::{Path, PathBuf};
  use serde::{Deserialize, Serialize};

  // ── 公共数据类型 ─────────────────────────────────────────────────────────

  #[derive(Debug, Clone, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct SkillMeta {
      pub name: String,
      pub description: String,
      /// "user" | "project" | "plugin:superpowers"
      pub source: String,
      /// SKILL.md 绝对路径，前端读取内容时使用
      pub file_path: String,
      /// "claude" | 未来扩展: "codex" | "opencode"
      pub provider: String,
  }

  // ── Provider trait ────────────────────────────────────────────────────────

  pub trait SkillProvider: Send + Sync {
      fn provider_name(&self) -> &str;
      fn scan(&self, cwd: &Path) -> Vec<SkillMeta>;
  }

  // ── SkillRegistry ─────────────────────────────────────────────────────────

  pub struct SkillRegistry {
      providers: Vec<Box<dyn SkillProvider>>,
  }

  impl SkillRegistry {
      pub fn new() -> Self {
          let mut r = Self { providers: vec![] };
          r.providers.push(Box::new(ClaudeSkillProvider));
          r
      }

      /// provider 为 None 时返回所有已注册 provider 的 skills
      pub fn list(&self, provider: Option<&str>, cwd: &Path) -> Vec<SkillMeta> {
          self.providers
              .iter()
              .filter(|p| provider.map_or(true, |name| p.provider_name() == name))
              .flat_map(|p| p.scan(cwd))
              .collect()
      }
  }

  // ── ClaudeSkillProvider ───────────────────────────────────────────────────

  pub struct ClaudeSkillProvider;

  impl SkillProvider for ClaudeSkillProvider {
      fn provider_name(&self) -> &str {
          "claude"
      }

      fn scan(&self, cwd: &Path) -> Vec<SkillMeta> {
          let mut skills = Vec::new();
          let home = match dirs::home_dir() {
              Some(h) => h,
              None => return skills,
          };

          // 1. 用户级：~/.claude/skills/*/SKILL.md
          let user_skills = home.join(".claude").join("skills");
          skills.extend(scan_dir(&user_skills, "user", "claude"));

          // 2. 项目级：{cwd}/.claude/skills/*/SKILL.md
          let project_skills = cwd.join(".claude").join("skills");
          skills.extend(scan_dir(&project_skills, "project", "claude"));

          // 3. 插件级：~/.claude/plugins/cache/{registry}/{plugin}/{version}/skills/*/SKILL.md
          let plugins_cache = home.join(".claude").join("plugins").join("cache");
          skills.extend(scan_plugins(&plugins_cache, "claude"));

          skills
      }
  }

  // ── 内部扫描工具函数 ──────────────────────────────────────────────────────

  /// 扫描 `skills_dir/*/SKILL.md`，每个子目录一个 skill
  fn scan_dir(skills_dir: &Path, source: &str, provider: &str) -> Vec<SkillMeta> {
      let mut result = Vec::new();
      let Ok(entries) = std::fs::read_dir(skills_dir) else {
          return result;
      };
      for entry in entries.flatten() {
          let skill_file = entry.path().join("SKILL.md");
          if !skill_file.is_file() {
              continue;
          }
          let Ok(content) = std::fs::read_to_string(&skill_file) else {
              continue;
          };
          let dir_name = entry.file_name().to_string_lossy().to_string();
          let (name, description) = parse_frontmatter(&content);
          result.push(SkillMeta {
              name: name.unwrap_or_else(|| dir_name.clone()),
              description: description.unwrap_or_default(),
              source: source.to_string(),
              file_path: skill_file.to_string_lossy().replace('\\', "/"),
              provider: provider.to_string(),
          });
      }
      result
  }

  /// 扫描插件目录：cache/{registry}/{plugin}/{version}/skills/*/SKILL.md
  fn scan_plugins(plugins_cache: &Path, provider: &str) -> Vec<SkillMeta> {
      let mut result = Vec::new();
      let Ok(registries) = std::fs::read_dir(plugins_cache) else {
          return result;
      };
      for registry in registries.flatten() {
          let Ok(plugins) = std::fs::read_dir(registry.path()) else {
              continue;
          };
          for plugin in plugins.flatten() {
              let plugin_name = plugin.file_name().to_string_lossy().to_string();
              let source = format!("plugin:{plugin_name}");
              // 遍历所有版本，取最新（版本号字符串排序即可，只取最大的）
              let Ok(versions) = std::fs::read_dir(plugin.path()) else {
                  continue;
              };
              let mut version_dirs: Vec<PathBuf> = versions
                  .flatten()
                  .filter(|e| e.path().is_dir())
                  .map(|e| e.path())
                  .collect();
              version_dirs.sort(); // 字符串升序，最后一个即最新
              if let Some(latest) = version_dirs.last() {
                  let skills_dir = latest.join("skills");
                  result.extend(scan_dir(&skills_dir, &source, provider));
              }
          }
      }
      result
  }

  /// 解析 SKILL.md YAML frontmatter，返回 (name, description)
  /// frontmatter 格式：以 `---` 开头，以 `\n---` 结束
  pub fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
      let content = content.trim_start();
      if !content.starts_with("---") {
          return (None, None);
      }
      let after = &content[3..];
      let end = match after.find("\n---") {
          Some(p) => p,
          None => return (None, None),
      };
      let fm = &after[..end];
      let mut name: Option<String> = None;
      let mut description: Option<String> = None;
      for line in fm.lines() {
          let line = line.trim();
          if let Some(v) = line.strip_prefix("name:") {
              let v = v.trim().trim_matches('"').trim_matches('\'');
              name = Some(v.to_string());
          } else if let Some(v) = line.strip_prefix("description:") {
              let v = v.trim().trim_matches('"').trim_matches('\'');
              // 截断至 120 字符供 UI 展示
              let v = if v.chars().count() > 120 {
                  v.chars().take(120).collect::<String>()
              } else {
                  v.to_string()
              };
              description = Some(v);
          }
      }
      (name, description)
  }

  // ── 单元测试 ──────────────────────────────────────────────────────────────

  #[cfg(test)]
  mod tests {
      use super::*;
      use std::fs;

      fn make_skill_dir(root: &Path, name: &str, content: &str) {
          let dir = root.join(name);
          fs::create_dir_all(&dir).unwrap();
          fs::write(dir.join("SKILL.md"), content).unwrap();
      }

      #[test]
      fn test_parse_frontmatter_basic() {
          let content = "---\nname: my-skill\ndescription: \"Does something useful\"\n---\n# Body";
          let (name, desc) = parse_frontmatter(content);
          assert_eq!(name, Some("my-skill".to_string()));
          assert_eq!(desc, Some("Does something useful".to_string()));
      }

      #[test]
      fn test_parse_frontmatter_missing() {
          let content = "# No frontmatter here";
          let (name, desc) = parse_frontmatter(content);
          assert_eq!(name, None);
          assert_eq!(desc, None);
      }

      #[test]
      fn test_parse_frontmatter_single_quotes() {
          let content = "---\nname: 'quoted'\ndescription: 'single quoted'\n---\n";
          let (name, _) = parse_frontmatter(content);
          assert_eq!(name, Some("quoted".to_string()));
      }

      #[test]
      fn test_parse_frontmatter_truncates_description() {
          let long_desc = "x".repeat(200);
          let content = format!("---\nname: x\ndescription: \"{long_desc}\"\n---\n");
          let (_, desc) = parse_frontmatter(&content);
          assert_eq!(desc.unwrap().chars().count(), 120);
      }

      #[test]
      fn test_scan_dir_finds_skills() {
          let tmp = std::env::temp_dir().join(format!("aide-test-{}", std::process::id()));
          fs::create_dir_all(&tmp).unwrap();

          make_skill_dir(
              &tmp,
              "brainstorming",
              "---\nname: brainstorming\ndescription: \"Brainstorm ideas\"\n---\n# Content",
          );
          make_skill_dir(
              &tmp,
              "debugging",
              "---\nname: systematic-debugging\ndescription: \"Debug issues\"\n---\n",
          );

          let skills = scan_dir(&tmp, "user", "claude");
          assert_eq!(skills.len(), 2);

          let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
          assert!(names.contains(&"brainstorming"));
          assert!(names.contains(&"systematic-debugging"));
          assert_eq!(skills[0].provider, "claude");

          fs::remove_dir_all(&tmp).unwrap();
      }

      #[test]
      fn test_scan_dir_empty_on_missing_dir() {
          let skills = scan_dir(Path::new("/nonexistent/path"), "user", "claude");
          assert!(skills.is_empty());
      }

      #[test]
      fn test_scan_dir_uses_dirname_as_fallback_name() {
          let tmp = std::env::temp_dir().join(format!("aide-test-fallback-{}", std::process::id()));
          fs::create_dir_all(&tmp).unwrap();
          make_skill_dir(&tmp, "my-tool", "# No frontmatter");

          let skills = scan_dir(&tmp, "user", "claude");
          assert_eq!(skills.len(), 1);
          assert_eq!(skills[0].name, "my-tool");

          fs::remove_dir_all(&tmp).unwrap();
      }
  }
  ```

- [ ] **Step 3: 运行测试**

  ```bash
  cd src-tauri
  cargo test skills::
  ```

  预期：

  ```
  test skills::tests::test_parse_frontmatter_basic ... ok
  test skills::tests::test_parse_frontmatter_missing ... ok
  test skills::tests::test_parse_frontmatter_single_quotes ... ok
  test skills::tests::test_parse_frontmatter_truncates_description ... ok
  test skills::tests::test_scan_dir_finds_skills ... ok
  test skills::tests::test_scan_dir_empty_on_missing_dir ... ok
  test skills::tests::test_scan_dir_uses_dirname_as_fallback_name ... ok
  test result: ok. 7 passed; 0 failed
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src-tauri/Cargo.toml src-tauri/src/skills.rs
  git commit -m "feat(skills): add SkillRegistry + ClaudeSkillProvider with unit tests"
  ```

---

### Task 3: Rust — `scan_plugin_skills` 命令接线

**Files:**
- Modify: `src-tauri/src/commands/shell.rs`（加 `scan_plugin_skills` 命令）
- Modify: `src-tauri/src/lib.rs`（加 `mod skills`、`.manage(SkillRegistry::new())`、注册命令）

**Interfaces:**
- Consumes: `SkillRegistry`（Task 2）
- Produces: `scan_plugin_skills(provider?: string, cwd: string) -> SkillMeta[]`（Tauri 命令）

- [ ] **Step 1: 在 `shell.rs` 末尾追加命令**

  打开 `src-tauri/src/commands/shell.rs`，在文件最末尾追加：

  ```rust
  #[tauri::command]
  pub fn scan_plugin_skills(
      provider: Option<String>,
      cwd: String,
      registry: tauri::State<'_, crate::skills::SkillRegistry>,
  ) -> Vec<crate::skills::SkillMeta> {
      let path = std::path::Path::new(&cwd);
      registry.list(provider.as_deref(), path)
  }
  ```

- [ ] **Step 2: 在 `lib.rs` 声明 `skills` 模块**

  打开 `src-tauri/src/lib.rs`，找到文件顶部的模块声明区（第 1-4 行）：

  ```rust
  mod commands;
  mod shell;
  mod sidecar;
  mod conversation;
  ```

  在末尾追加一行：

  ```rust
  mod commands;
  mod shell;
  mod sidecar;
  mod conversation;
  mod skills;
  ```

- [ ] **Step 3: 在 `lib.rs` 中注册 `SkillRegistry` 状态**

  找到 `.manage(sidecar::SidecarManager::new())` 那行（约第 85 行），在它下面追加一行：

  ```rust
  .manage(shell_manager)
  .manage(sidecar::SidecarManager::new())
  .manage(skills::SkillRegistry::new())
  .manage(workspace_state)
  ```

- [ ] **Step 4: 在 `lib.rs` 的 `invoke_handler` 中注册命令**

  找到 `generate_handler!` 宏末尾（在 `commands::chat::stop_chat_session,` 之后），追加：

  ```rust
          commands::chat::stop_chat_session,
          // Plugin skills scanning
          commands::shell::scan_plugin_skills,
      ])
  ```

- [ ] **Step 5: 编译检查**

  ```bash
  cd src-tauri
  cargo check
  ```

  预期：无编译错误。如有 `dirs` 找不到的错误，确认 `Cargo.toml` 已加 `dirs = "5"` 并运行 `cargo build` 触发下载。

- [ ] **Step 6: Commit**

  ```bash
  git add src-tauri/src/commands/shell.rs src-tauri/src/lib.rs
  git commit -m "feat(skills): wire scan_plugin_skills Tauri command"
  ```

---

### Task 4: 前端 — 类型 + API 封装

**Files:**
- Create: `src/types/skill.ts`
- Modify: `src/types/index.ts`（export SkillMeta）
- Modify: `src/api.ts`（加 `scanPluginSkills` 方法）

**Interfaces:**
- Consumes: `scan_plugin_skills` Tauri 命令（Task 3）
- Produces:
  - `interface SkillMeta { name, description, source, filePath, provider }`
  - `api.scanPluginSkills(cwd: string, provider?: string): Promise<SkillMeta[]>`

- [ ] **Step 1: 创建 `src/types/skill.ts`**

  ```typescript
  export interface SkillMeta {
    name: string;
    description: string;
    /** "user" | "project" | "plugin:superpowers" */
    source: string;
    /** SKILL.md 绝对路径 */
    filePath: string;
    /** "claude" | future: "codex" | "opencode" */
    provider: string;
  }
  ```

- [ ] **Step 2: 在 `src/types/index.ts` 末尾导出**

  打开 `src/types/index.ts`，在文件末尾追加：

  ```typescript
  export type { SkillMeta } from "./skill";
  ```

- [ ] **Step 3: 在 `src/api.ts` 加入方法**

  打开 `src/api.ts`，在 `import` 区块顶部的类型导入里加上 `SkillMeta`：

  ```typescript
  import type {
    Session, WorkspaceInfo, FileEntry, ChatMessageItem,
    ProjectInfo, DiffEntry, LastEventInfo, ChangeRound, AppSettings,
    GrepMatch, ProviderConfig, RunConfig, RunTarget, RecentView,
    SkillMeta,
  } from "./types";
  ```

  然后在 `api` 对象中，找到 `// Chat (Agent SDK)` 注释块，在其后追加：

  ```typescript
    // Plugin skills
    scanPluginSkills(cwd: string, provider?: string): Promise<SkillMeta[]> {
      return invoke("scan_plugin_skills", { cwd, provider: provider ?? null });
    },
    readFileContent(path: string): Promise<string> {
      return invoke("read_file_content", { path });
    },
  ```

  > 注：`readFileContent` 在 Rust 侧已存在（`filesystem.rs:126`），但 `api.ts` 中尚未封装，这里补上供 ChatPanel 使用。

- [ ] **Step 4: TypeScript 编译检查**

  ```bash
  pnpm run build 2>&1 | grep -E "error TS" | head -20
  ```

  预期：无 TS 错误。

- [ ] **Step 5: Commit**

  ```bash
  git add src/types/skill.ts src/types/index.ts src/api.ts
  git commit -m "feat(skills): add SkillMeta type and scanPluginSkills API"
  ```

---

### Task 5: 前端 — ChatPanel 斜杠 Autocomplete

**Files:**
- Modify: `src/components/ChatPanel.vue`（script + template + style）

**Interfaces:**
- Consumes: `api.scanPluginSkills(cwd)` → `SkillMeta[]`（Task 4）
- Produces: 用户输入 `/xxx` 时弹出 dropdown，键盘 ↑↓/Enter/Esc 操作，选中后插入 `/skill-name `

- [ ] **Step 1: 在 `<script setup>` 顶部追加 imports**

  找到现有 import 区块，追加：

  ```typescript
  import { onMounted } from "vue";
  import type { SkillMeta } from "@/types";
  ```

  > 注：`ref`、`watch`、`nextTick`、`computed` 已在第 2 行 import，只需补 `onMounted`。

- [ ] **Step 2: 在 `inputText` 定义之后追加 skill 相关状态**

  找到 `const inputText = ref("");` 这一行，在其后插入：

  ```typescript
  const skillList = ref<SkillMeta[]>([]);
  const slashDropdownVisible = ref(false);
  const slashFilter = ref("");
  const slashSelectedIndex = ref(0);

  const filteredSkills = computed(() => {
    if (!slashDropdownVisible.value) return [];
    const q = slashFilter.value.toLowerCase();
    return skillList.value
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, 8);
  });
  ```

- [ ] **Step 3: 追加 `onMounted` 拉取 skill 列表**

  在 `scrollToBottom` 函数定义之前插入：

  ```typescript
  onMounted(async () => {
    try {
      skillList.value = await api.scanPluginSkills(props.workspacePath ?? "");
    } catch {
      // 静默失败，autocomplete 不显示
    }
  });
  ```

- [ ] **Step 4: 追加 inputText 监听，驱动 dropdown 显隐**

  在 `watch(() => messagesVal.value.length, scrollToBottom);` 之后追加：

  ```typescript
  watch(inputText, (val) => {
    const match = val.match(/^\/(\S*)$/); // / 开头且无空格
    if (match) {
      slashFilter.value = match[1];
      slashDropdownVisible.value = true;
      slashSelectedIndex.value = 0;
    } else {
      slashDropdownVisible.value = false;
    }
  });
  ```

- [ ] **Step 5: 追加 `selectSkill` 函数**

  在 `insertAtCursor` 函数之前插入：

  ```typescript
  function selectSkill(skill: SkillMeta) {
    inputText.value = "/" + skill.name + " ";
    slashDropdownVisible.value = false;
    nextTick(() => textareaEl.value?.focus());
  }
  ```

- [ ] **Step 6: 在 textarea 的 `@keydown` 处理 ↑↓/Enter/Esc**

  找到 template 中的 `<textarea>` 标签，将现有的：

  ```html
  @keydown.enter.exact.prevent="handleSend"
  @keydown.enter.shift.exact.prevent="inputText += '\n'"
  ```

  改为：

  ```html
  @keydown.enter.exact.prevent="slashDropdownVisible ? selectSkill(filteredSkills[slashSelectedIndex]) : handleSend()"
  @keydown.enter.shift.exact.prevent="inputText += '\n'"
  @keydown.tab.prevent="slashDropdownVisible && filteredSkills.length ? selectSkill(filteredSkills[slashSelectedIndex]) : undefined"
  @keydown.escape="slashDropdownVisible = false"
  @keydown.up.prevent="slashDropdownVisible && (slashSelectedIndex = Math.max(0, slashSelectedIndex - 1))"
  @keydown.down.prevent="slashDropdownVisible && (slashSelectedIndex = Math.min(filteredSkills.length - 1, slashSelectedIndex + 1))"
  ```

- [ ] **Step 7: 在 template 中加入 dropdown**

  找到 `<div class="chat-input-area">` 这一行，在它**之前**（消息列表和输入区之间）插入：

  ```html
  <!-- Slash command dropdown -->
  <div v-if="filteredSkills.length" class="skill-dropdown">
    <div
      v-for="(skill, i) in filteredSkills"
      :key="skill.provider + ':' + skill.name"
      :class="['skill-item', i === slashSelectedIndex ? 'skill-item--active' : '']"
      @mousedown.prevent="selectSkill(skill)"
    >
      <span class="skill-item-name">/{{ skill.name }}</span>
      <span class="skill-item-source">{{ skill.source }}</span>
      <span class="skill-item-desc">{{ skill.description }}</span>
    </div>
  </div>
  ```

- [ ] **Step 8: 在 `<style scoped>` 末尾追加 dropdown 样式**

  ```css
  .skill-dropdown {
    position: absolute;
    bottom: 100%;
    left: 12px;
    right: 12px;
    background: var(--aide-bg-raised);
    border: 1px solid var(--aide-border);
    border-radius: var(--aide-radius-sm);
    box-shadow: var(--aide-shadow-lg);
    z-index: 100;
    max-height: 280px;
    overflow-y: auto;
    margin-bottom: 4px;
  }

  .skill-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 12px;
    overflow: hidden;
  }

  .skill-item:hover,
  .skill-item--active {
    background: var(--aide-surface-hover);
  }

  .skill-item-name {
    font-weight: 600;
    color: var(--aide-accent);
    flex-shrink: 0;
    font-family: 'Cascadia Code', 'Consolas', monospace;
  }

  .skill-item-source {
    font-size: 10px;
    color: var(--aide-text-muted);
    flex-shrink: 0;
    background: var(--aide-bg-deep);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .skill-item-desc {
    color: var(--aide-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  ```

  同时给 `.chat-input-area` 加 `position: relative;`（dropdown 绝对定位的锚点）：

  ```css
  .chat-input-area {
    border-top: 1px solid var(--aide-border);
    padding: 8px 12px;
    flex-shrink: 0;
    position: relative;  /* ← 新增 */
  }
  ```

- [ ] **Step 9: 启动 dev 验证 dropdown**

  ```bash
  pnpm tauri dev
  ```

  测试步骤：
  1. 选择一个有工作区的会话，在输入框输入 `/`
  2. 预期：dropdown 出现，列出已安装的 skills
  3. 继续输入 `/bra`，预期：只显示 `brainstorming`
  4. 按 ↓ 移动高亮，按 Enter 选中，预期：输入框变为 `/brainstorming `
  5. 按 Esc，预期：dropdown 关闭

- [ ] **Step 10: Commit**

  ```bash
  git add src/components/ChatPanel.vue
  git commit -m "feat(chat): add slash command autocomplete dropdown for skills"
  ```

---

### Task 6: 前端 — Skill 内容注入

**Files:**
- Modify: `src/components/ChatPanel.vue`（仅 `handleSend` 函数）

**Interfaces:**
- Consumes: `api.readFileContent(path)` → `string`（Task 4）、`skillList`（Task 5）
- Produces: 用户发送 `/skill-name [prompt]` 时，skill 文件内容前置到消息后送出

- [ ] **Step 1: 将 `handleSend` 改为 async 并加入注入逻辑**

  找到现有的 `handleSend` 函数：

  ```typescript
  function handleSend() {
    const text = inputText.value.trim();
    if (!text || isBusyVal.value || !props.sessionId) return;
    inputText.value = "";
    emit("send", text);
  }
  ```

  替换为：

  ```typescript
  async function handleSend() {
    const text = inputText.value.trim();
    if (!text || isBusyVal.value || !props.sessionId) return;

    let finalPrompt = text;
    const slashMatch = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (slashMatch) {
      const skillName = slashMatch[1];
      const userText = (slashMatch[2] ?? "").trim();
      const skill = skillList.value.find((s) => s.name === skillName);
      if (skill) {
        try {
          const content = await api.readFileContent(skill.filePath);
          finalPrompt = userText ? `${content}\n\n---\n\n${userText}` : content;
        } catch {
          // 读取失败则原样发送
        }
      }
    }

    inputText.value = "";
    emit("send", finalPrompt);
  }
  ```

- [ ] **Step 2: 端到端验证 skill 注入**

  确保 `pnpm tauri dev` 正在运行（或重启），选择有工作区的会话：

  1. 输入 `/brainstorming 帮我设计一个登录功能` 然后回车
  2. 观察 Claude 的回复——预期：Claude 执行 brainstorming skill 的流程（逐步询问需求、提出设计选项）
  3. 输入 `/brainstorming`（不带额外文字）然后回车
  4. 预期：Claude 仍然执行 skill，但以 skill 默认行为响应

- [ ] **Step 3: 验证未知 skill 时原样发送**

  输入 `/notexist hello`，预期：直接把 `/notexist hello` 作为普通消息发送，不报错。

- [ ] **Step 4: 验证 Claude 自动调用**

  发送普通消息 `我想做一个新功能，帮我规划一下`，观察 Claude 是否自动调用 brainstorming skill（会显示相应 ToolCallBlock）。

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/ChatPanel.vue
  git commit -m "feat(chat): inject SKILL.md content when user sends /skill-name"
  ```

---

## 自查

### Spec 覆盖验证

| Spec 要求 | 覆盖 Task |
|-----------|----------|
| sidecar 加 `skills: "all"` | Task 1 |
| `SkillProvider` trait + `SkillRegistry` | Task 2 |
| `ClaudeSkillProvider` 扫描三级目录 | Task 2 |
| frontmatter 解析（name/description/fallback）| Task 2 |
| `scan_plugin_skills` Tauri 命令 | Task 3 |
| `SkillMeta` TS 类型 + `api.scanPluginSkills` | Task 4 |
| ChatPanel `/` 触发 dropdown | Task 5 |
| 键盘 ↑↓/Enter/Tab/Esc 导航 | Task 5 |
| 发送前注入 SKILL.md 内容 | Task 6 |
| 未知 skill 原样发送 | Task 6 |
| `provider` 参数扩展点 | Task 3/4（命令接受 `Option<String>`）|
| 插件目录仅取最新版本 | Task 2（`version_dirs.sort().last()`）|

### 类型一致性检查

- `SkillMeta.file_path`（Rust snake_case）→ 序列化为 `filePath`（TS camelCase）✅（`#[serde(rename_all = "camelCase")]`）
- `api.readFileContent(skill.filePath)` → `read_file_content` 命令已在 `lib.rs:135` 注册 ✅
- `api.scanPluginSkills` → `scan_plugin_skills` 命令在 Task 3 Step 4 注册 ✅
- `filteredSkills[slashSelectedIndex]` 可能越界：当 dropdown 空时 `keydown.enter` 走 `handleSend()`，不越界 ✅
