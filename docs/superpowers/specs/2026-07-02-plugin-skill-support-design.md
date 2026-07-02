# Plugin & Skill 支持设计

> 让 Aide Chat UI 支持 Claude Code 插件安装的 Skills，同时为未来接入其他 AI 工具（Codex、OpenCode 等）预留扩展点。

## 背景

用户通过 `/plugin install superpowers@claude-plugins-official` 安装的插件会在 `~/.claude/plugins/cache/` 下存放 `SKILL.md` 文件。当前 Aide 的 Agent SDK sidecar 已有 `settingSources: ["project", "user"]`，但缺少 `skills: "all"` 选项，导致：

1. Claude 无法自动调用已安装的 skills
2. 用户没有 `/skill-name` 主动触发入口

目标：**两者都支持**——Claude 自动调用（被动）+ 用户 `/` 主动触发（主动）。

---

## 架构总览

```
用户输入 "/brainstorming 帮我设计登录"
        ↓
ChatPanel.vue（检测 / 前缀，展示 dropdown）
        ↓ invoke("list_skills", { provider, cwd })
Tauri commands/shell.rs
        ↓ SkillRegistry.scan(provider, cwd)
src-tauri/src/skills.rs（trait SkillProvider）
        ↓ ClaudeSkillProvider.scan()
~/.claude/skills/ + .claude/skills/ + ~/.claude/plugins/cache/
        ↓ 返回 Vec<SkillMeta>
ChatPanel.vue（用户选中后读取 SKILL.md 内容，拼入消息）
        ↓ sendMessage(skill_content + "\n\n---\n\n" + user_prompt)
useChatSession → sidecar（skills: "all" 已启用，Claude 也可自动调用）
```

---

## 变更一：Sidecar（`agent-sidecar/src/index.ts`）

**改动**：`query()` 选项加一行 `skills: "all"`。

```typescript
options: {
  permissionMode: "default",
  canUseTool: permMgr.makeCallback(emit) as any,
  settingSources: ["project", "user"],
  skills: "all",   // 新增：启用所有已发现的 skills
  ...(sessionId ? { resume: sessionId } : {}),
}
```

**效果**：SDK 自动扫描 `~/.claude/skills/`、`{cwd}/.claude/skills/`、已安装插件目录，将 skills 暴露给 Claude，Claude 根据上下文自主决定何时调用 Skill 工具。无需将 `"Skill"` 加入 `allowedTools`，SDK 会自动处理。

---

## 变更二：可扩展 Skill 扫描层

### 新文件：`src-tauri/src/skills.rs`

定义抽象 trait 和 `ClaudeSkillProvider` 实现：

```rust
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    pub source: String,    // "user" | "project" | "plugin:superpowers"
    pub file_path: String, // 绝对路径，前端读取内容时使用（序列化为 filePath）
    pub provider: String,  // "claude" | "codex" | ...
}

pub trait SkillProvider: Send + Sync {
    fn provider_name(&self) -> &str;
    fn scan(&self, cwd: &Path) -> Vec<SkillMeta>;
}

pub struct SkillRegistry {
    providers: Vec<Box<dyn SkillProvider>>,
}

impl SkillRegistry {
    pub fn new() -> Self {
        let mut r = Self { providers: vec![] };
        r.register(Box::new(ClaudeSkillProvider));
        r
    }

    pub fn register(&mut self, p: Box<dyn SkillProvider>) {
        self.providers.push(p);
    }

    /// provider 为 None 时返回所有已注册 provider 的 skills
    pub fn list(&self, provider: Option<&str>, cwd: &Path) -> Vec<SkillMeta> {
        self.providers.iter()
            .filter(|p| provider.map_or(true, |name| p.provider_name() == name))
            .flat_map(|p| p.scan(cwd))
            .collect()
    }
}
```

**`ClaudeSkillProvider` 扫描三个目录：**

| 级别 | 路径 | `source` |
|------|------|---------|
| 用户级 | `~/.claude/skills/*/SKILL.md` | `"user"` |
| 项目级 | `{cwd}/.claude/skills/*/SKILL.md` | `"project"` |
| 插件级 | `~/.claude/plugins/cache/*/*/*/skills/*/SKILL.md` | `"plugin:{插件名}"` |

每个 SKILL.md 解析 YAML frontmatter（`---` 包裹的头部），提取 `name` 和 `description`。若 frontmatter 缺失，用目录名作为 `name`，空字符串作为 `description`。

**未来扩展**：新增 `CodexSkillProvider`、`OpenCodeSkillProvider` 只需实现 `SkillProvider` trait 并在 `SkillRegistry::new()` 中 `register`，命令层和前端零改动。

### 修改：`src-tauri/src/commands/shell.rs`

新增命令：

```rust
#[tauri::command]
pub async fn list_skills(
    provider: Option<String>,
    cwd: String,
    registry: tauri::State<'_, SkillRegistry>,
) -> Result<Vec<SkillMeta>, String> {
    let path = std::path::Path::new(&cwd);
    Ok(registry.list(provider.as_deref(), path))
}
```

### 修改：`src-tauri/src/lib.rs`

- 新增 `mod skills;`
- `.manage(skills::SkillRegistry::new())`
- `generate_handler!` 加入 `shell::list_skills`

---

## 变更三：前端斜杠命令 UI（`src/components/ChatPanel.vue`）

### 新增响应式状态

```typescript
const skillList = ref<SkillMeta[]>([]);
const slashDropdownActive = ref(false);
const slashFilter = ref("");
const slashSelectedIndex = ref(0);

// mount 时拉一次，之后缓存
onMounted(async () => {
  try {
    skillList.value = await invoke("list_skills", { cwd: props.workspacePath ?? "" });
  } catch { /* 静默失败，autocomplete 不显示 */ }
});
```

### 斜杠检测 computed

```typescript
const filteredSkills = computed(() => {
  if (!slashDropdownActive.value) return [];
  return skillList.value
    .filter(s => s.name.toLowerCase().includes(slashFilter.value.toLowerCase()))
    .slice(0, 8);
});
```

当 `inputText` 以 `/` 开头且不含空格时，激活 dropdown，`/` 后的字符串作为 filter；出现空格时关闭 dropdown（用户已选定 skill 或放弃）。

### 选中 skill

```typescript
function selectSkill(skill: SkillMeta) {
  inputText.value = "/" + skill.name + " ";
  slashDropdownActive.value = false;
  nextTick(() => textareaEl.value?.focus());
}
```

### 发送前注入 skill 内容

```typescript
async function handleSend() {
  const text = inputText.value.trim();
  if (!text || isBusyVal.value || !props.sessionId) return;

  let finalPrompt = text;
  const slashMatch = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (slashMatch) {
    const skillName = slashMatch[1];
    const userText = slashMatch[2].trim();
    const skill = skillList.value.find(s => s.name === skillName);
    if (skill) {
      try {
        const content = await invoke<string>("read_file_content", { path: skill.filePath });
        finalPrompt = userText
          ? `${content}\n\n---\n\n${userText}`
          : content;
      } catch { /* 读取失败则原样发送 */ }
    }
  }

  inputText.value = "";
  emit("send", finalPrompt);
}
```

### Dropdown 模板（绝对定位在输入框上方）

```html
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

键盘导航：textarea 的 `keydown` 事件处理 ↑↓（移动 `slashSelectedIndex`）、Enter/Tab（选中）、Esc（关闭）。

---

## 数据类型（前端 `src/types/index.ts`）

```typescript
export interface SkillMeta {
  name: string;
  description: string;
  source: string;    // "user" | "project" | "plugin:superpowers"
  filePath: string;
  provider: string;  // "claude" | future providers
}
```

---

## 错误处理

| 场景 | 处理 |
|------|------|
| `list_skills` 失败（目录不存在）| 静默，dropdown 不显示 |
| SKILL.md frontmatter 解析失败 | 跳过该 skill，不中断扫描 |
| `/skill-name` 找不到对应 skill | 原样发送，不注入 |
| `read_file` 读取 SKILL.md 失败 | 原样发送，不注入 |

---

## 涉及文件汇总

| 文件 | 类型 | 说明 |
|------|------|------|
| `agent-sidecar/src/index.ts` | 修改 | 加 `skills: "all"` |
| `src-tauri/src/skills.rs` | 新增 | `SkillProvider` trait + `ClaudeSkillProvider` + `SkillRegistry` |
| `src-tauri/src/commands/shell.rs` | 修改 | 加 `list_skills` 命令 |
| `src-tauri/src/lib.rs` | 修改 | 注册 `SkillRegistry` state + 命令 |
| `src/components/ChatPanel.vue` | 修改 | 斜杠 autocomplete + 内容注入逻辑 |
| `src/types/index.ts` | 修改 | 加 `SkillMeta` 类型 |

---

## 不在本次范围内

- 在 UI 中安装/卸载插件（marketplace 功能已独立存在）
- 其他 AI provider 的 SkillProvider 实现（trait 已预留，按需添加）
- Skill 内容预览面板
- `/` 命令的键盘快捷键帮助浮层
