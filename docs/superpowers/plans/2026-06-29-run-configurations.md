# Run Configurations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-workspace Run Configuration system (JetBrains-style) that lets users save, select, and execute named run targets from the TitleBar, supporting microservice workspaces with multiple startable modules.

**Architecture:** A new `run_configs.rs` Rust module handles CRUD (stored in `~/.claude-code-desktop/run_configs/<encoded-ws-path>.json`) and multi-module auto-detection (Maven/Gradle/subdir scan). A new `useRunConfigs.ts` module-level singleton composable owns all frontend config state and syncs to disk. The TitleBar grows a grouped config-selector pill `[name ▾][▶]` that drives selection and execution. A `RunConfigsDialog.vue` component allows full CRUD management.

**Tech Stack:** Tauri v2, Rust (`serde_json`, `regex` already in Cargo.toml), Vue 3 Composition API + TypeScript, xterm.js (via existing `useWorkbenchTerminal`)

## Global Constraints

- All new Rust `Command::new()` calls MUST add `creation_flags(0x08000000)` on Windows (`CREATE_NO_WINDOW`)
- All new Rust files in `src-tauri/src/commands/` must be declared in `commands/mod.rs`
- All new Tauri commands must be registered in the `invoke_handler!` array in `lib.rs`
- New composables follow module-level singleton pattern (state declared outside the exported function)
- No files written to the user's workspace directory — all storage is in `~/.claude-code-desktop/`
- CSS in `TerminalPanel.vue`-style dynamic components must be non-scoped; everywhere else use `<style scoped>`
- `useRunConfigs` auto-detects on first workspace open (silent, no confirmation dialog)
- Workspace key passed to Rust as raw path string; Rust encodes it to a safe filename

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| **Already modified** | `src-tauri/src/commands/filesystem.rs` | Exposed `pub(crate) fn detect_command_for_path(root: &Path) -> Option<String>` |
| **Create** | `src-tauri/src/commands/run_configs.rs` | `RunConfig`/`RunTarget` structs, CRUD commands, `detect_run_targets` |
| **Modify** | `src-tauri/src/commands/mod.rs` | Add `pub mod run_configs;` |
| **Modify** | `src-tauri/src/lib.rs` | Register 3 new Tauri commands |
| **Modify** | `src/types.ts` | Add `RunConfig`, `RunTarget` interfaces |
| **Modify** | `src/api.ts` | Add `listRunConfigs`, `saveRunConfigs`, `detectRunTargets` |
| **Create** | `src/composables/useRunConfigs.ts` | Module-level singleton: configs list, activeId, CRUD, load/save |
| **Modify** | `src/composables/useRunProject.ts` | Delegate to `useRunConfigs().activeConfig` instead of calling `detectRunCommand` |
| **Modify** | `src/components/titlebar/TitleBar.vue` | Add `[config ▾][▶]` grouped selector with inline dropdown |
| **Create** | `src/components/RunConfigsDialog.vue` | Full CRUD dialog: list panel + edit form + auto-detect |
| **Modify** | `src/App.vue` | Call `useRunConfigs().load()` on workspace change; wire new TitleBar props/emits; manage dialog visibility |

---

## Task 1: Rust Backend — `run_configs.rs`

**Files:**
- `src-tauri/src/commands/filesystem.rs` — already has `pub(crate) fn detect_command_for_path` (done)
- Create: `src-tauri/src/commands/run_configs.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces produced:**
- `list_run_configs(ws_key: String) -> Result<Vec<RunConfig>, String>`
- `save_run_configs(ws_key: String, configs: Vec<RunConfig>) -> Result<(), String>`
- `detect_run_targets(cwd: String) -> Result<Vec<RunTarget>, String>`
- Structs: `RunConfig { id, name, cwd, command }`, `RunTarget { name, cwd, command }`

- [ ] **Step 1: Create `src-tauri/src/commands/run_configs.rs`**

```rust
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use super::{filesystem::detect_command_for_path, our_config_dir};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunConfig {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub command: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunTarget {
    pub name: String,
    pub cwd: String,
    pub command: String,
}

// Encode a workspace path to a safe filename component.
// Mirrors encode_project_path() in mod.rs.
fn encode_key(ws_key: &str) -> String {
    ws_key.replace([':', '\\', '/'], "-")
}

fn configs_path(ws_key: &str) -> std::path::PathBuf {
    our_config_dir()
        .join("run_configs")
        .join(format!("{}.json", encode_key(ws_key)))
}

#[tauri::command]
pub fn list_run_configs(ws_key: String) -> Result<Vec<RunConfig>, String> {
    let path = configs_path(&ws_key);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_run_configs(ws_key: String, configs: Vec<RunConfig>) -> Result<(), String> {
    let path = configs_path(&ws_key);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(&configs).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

// ── Detection helpers ────────────────────────────────────────────────────────

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | "target" | "build" | "dist"
            | ".idea" | "__pycache__" | ".gradle" | "out" | "vendor"
            | ".next" | ".nuxt" | "coverage" | ".vscode"
    ) || name.starts_with('.')
}

fn extract_maven_modules(content: &str) -> Vec<String> {
    let re = Regex::new(r"<module>([^<]+)</module>").unwrap();
    re.captures_iter(content)
        .filter_map(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

fn extract_gradle_includes(content: &str) -> Vec<String> {
    let mut modules = Vec::new();
    let re = Regex::new(r#"['"](?::)?([a-zA-Z0-9_\-]+)['"]"#).unwrap();
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("include") {
            continue;
        }
        for cap in re.captures_iter(trimmed) {
            if let Some(m) = cap.get(1) {
                modules.push(m.as_str().to_string());
            }
        }
    }
    modules
}

fn detect_maven_multi_module(root: &Path) -> Option<Vec<RunTarget>> {
    let pom_path = root.join("pom.xml");
    if !pom_path.exists() {
        return None;
    }
    let content = fs::read_to_string(&pom_path).unwrap_or_default();
    if !content.contains("<modules>") {
        return None;
    }
    let modules = extract_maven_modules(&content);
    if modules.is_empty() {
        return None;
    }
    let targets: Vec<RunTarget> = modules
        .iter()
        .filter_map(|module| {
            let sub = root.join(module);
            if !sub.is_dir() {
                return None;
            }
            detect_command_for_path(&sub).map(|cmd| RunTarget {
                name: module.clone(),
                cwd: sub.to_string_lossy().to_string(),
                command: cmd,
            })
        })
        .collect();
    if targets.is_empty() { None } else { Some(targets) }
}

fn detect_gradle_multi_project(root: &Path) -> Option<Vec<RunTarget>> {
    let settings = root.join("settings.gradle");
    let settings_kts = root.join("settings.gradle.kts");
    let content = if settings.exists() {
        fs::read_to_string(&settings).unwrap_or_default()
    } else if settings_kts.exists() {
        fs::read_to_string(&settings_kts).unwrap_or_default()
    } else {
        return None;
    };
    if !content.contains("include") {
        return None;
    }
    let modules = extract_gradle_includes(&content);
    if modules.is_empty() {
        return None;
    }
    let targets: Vec<RunTarget> = modules
        .iter()
        .filter_map(|module| {
            let sub = root.join(module);
            if !sub.is_dir() {
                return None;
            }
            detect_command_for_path(&sub).map(|cmd| RunTarget {
                name: module.clone(),
                cwd: sub.to_string_lossy().to_string(),
                command: cmd,
            })
        })
        .collect();
    if targets.is_empty() { None } else { Some(targets) }
}

fn scan_subdirs(root: &Path) -> Vec<RunTarget> {
    let mut targets = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return targets;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_dir(&name) {
            continue;
        }
        if let Some(cmd) = detect_command_for_path(&path) {
            targets.push(RunTarget {
                name,
                cwd: path.to_string_lossy().to_string(),
                command: cmd,
            });
        }
    }
    targets
}

#[tauri::command]
pub fn detect_run_targets(cwd: String) -> Result<Vec<RunTarget>, String> {
    let root = Path::new(&cwd);

    // 1. Maven multi-module parent pom
    if let Some(targets) = detect_maven_multi_module(root) {
        return Ok(targets);
    }
    // 2. Gradle multi-project settings
    if let Some(targets) = detect_gradle_multi_project(root) {
        return Ok(targets);
    }
    // 3. Root-level single project
    if let Some(cmd) = detect_command_for_path(root) {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| cwd.clone());
        return Ok(vec![RunTarget { name, cwd, command: cmd }]);
    }
    // 4. Scan immediate subdirectories as fallback
    Ok(scan_subdirs(root))
}
```

- [ ] **Step 2: Register module in `src-tauri/src/commands/mod.rs`**

Add after `pub mod provider;`:
```rust
pub mod run_configs;
```

- [ ] **Step 3: Register commands in `src-tauri/src/lib.rs`**

Add inside the `invoke_handler!` array after the provider commands block:
```rust
// Run configuration commands
commands::run_configs::list_run_configs,
commands::run_configs::save_run_configs,
commands::run_configs::detect_run_targets,
```

- [ ] **Step 4: Verify Rust compiles**

```powershell
cd src-tauri && cargo check 2>&1
```
Expected: `Finished` with no errors. Fix any type or import errors before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/run_configs.rs \
        src-tauri/src/commands/mod.rs \
        src-tauri/src/commands/filesystem.rs \
        src-tauri/src/lib.rs
git commit -m "feat: add run_configs Rust module with CRUD and multi-module detection"
```

---

## Task 2: Frontend Types & API Bindings

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api.ts`

**Interfaces produced:**
- `RunConfig { id: string; name: string; cwd: string; command: string }`
- `RunTarget { name: string; cwd: string; command: string }`
- `api.listRunConfigs(wsKey)`, `api.saveRunConfigs(wsKey, configs)`, `api.detectRunTargets(cwd)`

- [ ] **Step 1: Add types to `src/types.ts`**

Append before the closing of the file:
```typescript
export interface RunConfig {
  id: string;
  name: string;
  cwd: string;
  command: string;
}

export interface RunTarget {
  name: string;
  cwd: string;
  command: string;
}
```

- [ ] **Step 2: Add API methods to `src/api.ts`**

Add inside the `api` object after `detectRunCommand`:
```typescript
listRunConfigs(wsKey: string): Promise<RunConfig[]> {
  return invoke("list_run_configs", { wsKey });
},
saveRunConfigs(wsKey: string, configs: RunConfig[]): Promise<void> {
  return invoke("save_run_configs", { wsKey, configs });
},
detectRunTargets(cwd: string): Promise<RunTarget[]> {
  return invoke("detect_run_targets", { cwd });
},
```

Also update the import at the top of `api.ts` to include `RunConfig` and `RunTarget`:
```typescript
import type {
  Session, WorkspaceInfo, FileEntry, ChatMessageItem,
  ProjectInfo, DiffEntry, LastEventInfo, ChangeRound, AppSettings,
  GrepMatch, ProviderConfig, RunConfig, RunTarget,
} from "./types";
```

- [ ] **Step 3: Verify TypeScript compiles**

```powershell
pnpm tsc --noEmit 2>&1
```
Expected: no errors on the new types/api lines.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/api.ts
git commit -m "feat: add RunConfig/RunTarget types and API bindings"
```

---

## Task 3: `useRunConfigs` Composable

**Files:**
- Create: `src/composables/useRunConfigs.ts`

**Interfaces consumed:**
- `api.listRunConfigs(wsKey: string): Promise<RunConfig[]>`
- `api.saveRunConfigs(wsKey: string, configs: RunConfig[]): Promise<void>`
- `api.detectRunTargets(cwd: string): Promise<RunTarget[]>`
- Types: `RunConfig`, `RunTarget` from `../types`

**Interfaces produced:**
- `useRunConfigs()` returns: `{ configs, activeId, activeConfig, currentWsKey, load, setActive, add, update, remove, detectAndAdd, addTargets }`

- [ ] **Step 1: Create `src/composables/useRunConfigs.ts`**

```typescript
import { ref, computed } from "vue";
import { api } from "../api";
import type { RunConfig, RunTarget } from "../types";

// Module-level singleton — shared across all callers.
const configs = ref<RunConfig[]>([]);
const activeId = ref<string>("");
const currentWsKey = ref<string>("");

const activeConfig = computed<RunConfig | null>(() =>
  configs.value.find(c => c.id === activeId.value) ?? null
);

function generateId(): string {
  return `rc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function persist() {
  if (!currentWsKey.value) return;
  await api.saveRunConfigs(currentWsKey.value, configs.value).catch(() => {});
}

export function useRunConfigs() {
  // Load configs for a workspace. Auto-detects and saves on first open.
  async function load(wsKey: string, cwd: string) {
    currentWsKey.value = wsKey;
    const saved = await api.listRunConfigs(wsKey).catch(() => [] as RunConfig[]);
    configs.value = saved;

    // Restore activeId if still valid; otherwise default to first config.
    if (!configs.value.find(c => c.id === activeId.value)) {
      activeId.value = configs.value[0]?.id ?? "";
    }

    // First time for this workspace: auto-detect and silently populate.
    if (configs.value.length === 0 && cwd) {
      const targets = await api.detectRunTargets(cwd).catch(() => [] as RunTarget[]);
      if (targets.length > 0) {
        configs.value = targets.map(t => ({
          id: generateId(),
          name: t.name,
          cwd: t.cwd,
          command: t.command,
        }));
        activeId.value = configs.value[0]?.id ?? "";
        await persist();
      }
    }
  }

  function setActive(id: string) {
    activeId.value = id;
  }

  async function add(partial: Omit<RunConfig, "id">): Promise<RunConfig> {
    const config: RunConfig = { id: generateId(), ...partial };
    configs.value = [...configs.value, config];
    if (!activeId.value) activeId.value = config.id;
    await persist();
    return config;
  }

  async function update(updated: RunConfig): Promise<void> {
    configs.value = configs.value.map(c => c.id === updated.id ? updated : c);
    await persist();
  }

  async function remove(id: string): Promise<void> {
    configs.value = configs.value.filter(c => c.id !== id);
    if (activeId.value === id) {
      activeId.value = configs.value[0]?.id ?? "";
    }
    await persist();
  }

  // Returns detected targets without saving (used by dialog for user review).
  async function detectAndAdd(cwd: string): Promise<RunTarget[]> {
    return api.detectRunTargets(cwd).catch(() => [] as RunTarget[]);
  }

  // Adds a list of RunTargets as new RunConfigs and persists.
  async function addTargets(targets: RunTarget[]): Promise<void> {
    const newConfigs: RunConfig[] = targets.map(t => ({
      id: generateId(),
      name: t.name,
      cwd: t.cwd,
      command: t.command,
    }));
    configs.value = [...configs.value, ...newConfigs];
    if (!activeId.value && configs.value.length > 0) {
      activeId.value = configs.value[0].id;
    }
    await persist();
  }

  return {
    configs,
    activeId,
    activeConfig,
    currentWsKey,
    load,
    setActive,
    add,
    update,
    remove,
    detectAndAdd,
    addTargets,
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
pnpm tsc --noEmit 2>&1
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/composables/useRunConfigs.ts
git commit -m "feat: add useRunConfigs module-level singleton composable"
```

---

## Task 4: Refactor `useRunProject`

**Files:**
- Modify: `src/composables/useRunProject.ts`

**Interfaces consumed:**
- `useRunConfigs()` → `activeConfig: ComputedRef<RunConfig | null>`
- `useWorkbenchTerminal()` → `visible`, `createSession(cwd, command?)`
- Types: `RunConfig` from `../types`

**Interfaces produced:**
- `useRunProject()` returns: `{ run, runConfig }`
  - `run(): Promise<void>` — runs the currently active config
  - `runConfig(cfg: RunConfig): Promise<void>` — runs an explicit config

- [ ] **Step 1: Replace `src/composables/useRunProject.ts`**

```typescript
import { useWorkbenchTerminal } from "./useWorkbenchTerminal";
import { useRunConfigs } from "./useRunConfigs";
import type { RunConfig } from "../types";

export function useRunProject() {
  const wb = useWorkbenchTerminal();

  async function runConfig(cfg: RunConfig) {
    wb.visible.value = true;
    // Small delay so the workbench slide-in animation starts before terminal mounts.
    await new Promise<void>(r => setTimeout(r, 80));
    wb.createSession(cfg.cwd, cfg.command);
  }

  async function run() {
    const { activeConfig } = useRunConfigs();
    const cfg = activeConfig.value;
    if (!cfg) return;
    await runConfig(cfg);
  }

  return { run, runConfig };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
pnpm tsc --noEmit 2>&1
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/composables/useRunProject.ts
git commit -m "refactor: useRunProject delegates to useRunConfigs active config"
```

---

## Task 5: TitleBar Config Selector

**Files:**
- Modify: `src/components/titlebar/TitleBar.vue`

**Interfaces consumed:**
- New props: `runConfigs: RunConfig[]`, `activeRunConfig: RunConfig | null`
- Types: `RunConfig` from `../../types`

**Interfaces produced (emits):**
- `"select-run-config": [id: string]` — user picked a config from dropdown
- `"edit-run-configs": []` — user clicked "编辑运行配置…"
- `"run-project": []` — unchanged, fires when ▶ clicked

- [ ] **Step 1: Update script section of `TitleBar.vue`**

Add imports and new props/emits. The full `<script setup>` becomes:

```typescript
<script setup lang="ts">
import { ref, computed } from "vue";
import WindowControls from "./WindowControls.vue";
import type { SessionStatus } from "../../composables/useSessionState";
import type { RunConfig } from "../../types";

interface ActiveSessionInfo {
  id: string;
  name: string;
  status: SessionStatus;
  wsKey: string;
}

const props = defineProps<{
  projectName?: string;
  gitBranch?: string;
  activeSessions?: ActiveSessionInfo[];
  runConfigs?: RunConfig[];
  activeRunConfig?: RunConfig | null;
}>();

const emit = defineEmits<{
  "open-palette": [];
  "select-session": [session: ActiveSessionInfo];
  "run-project": [];
  "select-run-config": [id: string];
  "edit-run-configs": [];
}>();

function onSelectSession(s: ActiveSessionInfo) {
  panelOpen.value = false;
  emit("select-session", s);
}

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  waiting: "已就绪",
  attention: "待确认",
};

const STATUS_CLASS: Record<string, string> = {
  running: "status-running",
  waiting: "status-waiting",
  attention: "status-attention",
};

const panelOpen = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function showPanel() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  panelOpen.value = true;
}
function hidePanel() {
  closeTimer = setTimeout(() => { panelOpen.value = false; }, 150);
}

// Run config dropdown
const configDropOpen = ref(false);
let configCloseTimer: ReturnType<typeof setTimeout> | null = null;

function showConfigDrop() {
  if (configCloseTimer) { clearTimeout(configCloseTimer); configCloseTimer = null; }
  configDropOpen.value = true;
}
function hideConfigDrop() {
  configCloseTimer = setTimeout(() => { configDropOpen.value = false; }, 150);
}
function selectConfig(id: string) {
  configDropOpen.value = false;
  emit("select-run-config", id);
}
function openEditor() {
  configDropOpen.value = false;
  emit("edit-run-configs");
}

const runningCount = computed(() =>
  (props.activeSessions ?? []).filter(s => s.status === "running").length
);
</script>
```

- [ ] **Step 2: Update template — replace the single `titlebar-run-btn` block**

Replace this existing block in the template:
```html
      <button
        v-if="projectName"
        class="titlebar-run-btn"
        v-tooltip="'运行项目'"
        @click.stop="$emit('run-project')"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <polygon points="2,1 9,5 2,9"/>
        </svg>
      </button>
```

With:
```html
      <!-- Run config selector: shown when configs exist for this workspace -->
      <template v-if="projectName && runConfigs && runConfigs.length > 0">
        <div
          class="run-group"
          @mouseenter="showConfigDrop"
          @mouseleave="hideConfigDrop"
        >
          <!-- Config name selector -->
          <button
            class="run-config-sel"
            v-tooltip="'切换运行配置'"
            @click.stop="configDropOpen = !configDropOpen"
          >
            <span class="run-config-name">{{ activeRunConfig?.name ?? '─' }}</span>
            <svg class="run-config-chevron" width="8" height="5" viewBox="0 0 8 5" fill="currentColor">
              <path d="M0.5 0.5L4 4L7.5 0.5"/>
            </svg>
          </button>

          <!-- Run button -->
          <button
            class="run-play-btn"
            v-tooltip="'运行'"
            @click.stop="$emit('run-project')"
          >
            <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor">
              <polygon points="2,1 9,5 2,9"/>
            </svg>
          </button>

          <!-- Config dropdown panel -->
          <Transition name="config-drop">
            <div
              v-if="configDropOpen"
              class="config-drop-panel"
              @mouseenter="showConfigDrop"
              @mouseleave="hideConfigDrop"
            >
              <div
                v-for="cfg in runConfigs"
                :key="cfg.id"
                class="config-drop-item"
                :class="{ active: cfg.id === activeRunConfig?.id }"
                @click="selectConfig(cfg.id)"
              >
                <span class="config-drop-check">{{ cfg.id === activeRunConfig?.id ? '✓' : '' }}</span>
                <span class="config-drop-col">
                  <span class="config-drop-name">{{ cfg.name }}</span>
                  <span class="config-drop-cmd">{{ cfg.command }}</span>
                </span>
              </div>
              <div class="config-drop-sep" />
              <div class="config-drop-action" @click="openEditor">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                编辑运行配置…
              </div>
            </div>
          </Transition>
        </div>
      </template>

      <!-- Fallback run button when no configs detected yet -->
      <button
        v-else-if="projectName"
        class="titlebar-run-btn"
        v-tooltip="'运行项目'"
        @click.stop="$emit('run-project')"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <polygon points="2,1 9,5 2,9"/>
        </svg>
      </button>
```

- [ ] **Step 3: Add CSS at the end of `<style scoped>` in TitleBar.vue**

```css
/* ── Run config group ── */

.run-group {
  position: relative;
  display: flex;
  align-items: center;
  gap: 1px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  overflow: visible;
}

.run-config-sel {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px 3px 8px;
  background: none;
  border: none;
  border-right: 1px solid var(--aide-border);
  border-radius: 0;
  color: var(--aide-text-primary);
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.12s;
  max-width: 130px;
}
.run-config-sel:hover {
  background: var(--aide-surface-hover);
}

.run-config-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100px;
}

.run-config-chevron {
  flex-shrink: 0;
  opacity: 0.5;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.5;
}

.run-play-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: none;
  border: none;
  color: var(--aide-success);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.run-play-btn:hover {
  background: color-mix(in srgb, var(--aide-success) 12%, transparent);
  color: color-mix(in srgb, var(--aide-success) 150%, white);
}

/* ── Config dropdown panel ── */

.config-drop-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 240px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-lg);
  z-index: 950;
  overflow: hidden;
}

.config-drop-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  transition: background 0.1s;
}
.config-drop-item:hover {
  background: var(--aide-surface-default);
}
.config-drop-item.active .config-drop-name {
  color: var(--aide-accent, var(--aide-info));
}

.config-drop-check {
  width: 12px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--aide-accent, var(--aide-info));
  margin-top: 1px;
}

.config-drop-col {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.config-drop-name {
  font-size: 12px;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.config-drop-cmd {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  font-family: 'Consolas', 'Menlo', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.config-drop-sep {
  height: 1px;
  background: var(--aide-border);
  margin: 2px 0;
}

.config-drop-action {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  color: var(--aide-text-muted);
  font-size: 12px;
  transition: background 0.1s, color 0.1s;
}
.config-drop-action:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

/* ── Dropdown transition ── */

.config-drop-enter-active,
.config-drop-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.config-drop-enter-from,
.config-drop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```powershell
pnpm tsc --noEmit 2>&1
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/titlebar/TitleBar.vue
git commit -m "feat: add run config selector pill to TitleBar"
```

---

## Task 6: `RunConfigsDialog` Component

**Files:**
- Create: `src/components/RunConfigsDialog.vue`

**Interfaces consumed:**
- `useRunConfigs()` — `configs`, `activeId`, `activeConfig`, `add`, `update`, `remove`, `detectAndAdd`, `addTargets`, `currentWsKey`
- Types: `RunConfig`, `RunTarget` from `../types`

**Interfaces produced:**
- `<RunConfigsDialog @close="..." />` — emits `close` when dismissed

- [ ] **Step 1: Create `src/components/RunConfigsDialog.vue`**

```vue
<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useRunConfigs } from "../composables/useRunConfigs";
import type { RunConfig, RunTarget } from "../types";

const emit = defineEmits<{ close: [] }>();

const { configs, activeId, add, update, remove, detectAndAdd, addTargets, currentWsKey } =
  useRunConfigs();

// ── List selection ──────────────────────────────────────────────────────────
const selectedId = ref(activeId.value || configs.value[0]?.id || "");
const selected = computed<RunConfig | null>(
  () => configs.value.find(c => c.id === selectedId.value) ?? null
);

watch(
  () => configs.value,
  (list) => {
    if (!list.find(c => c.id === selectedId.value)) {
      selectedId.value = list[0]?.id ?? "";
    }
  }
);

// ── Edit form (local draft) ─────────────────────────────────────────────────
const draft = ref<RunConfig>({ id: "", name: "", cwd: "", command: "" });

watch(
  selected,
  (cfg) => {
    if (cfg) draft.value = { ...cfg };
  },
  { immediate: true }
);

const isDirty = computed(
  () => selected.value && (
    draft.value.name !== selected.value.name ||
    draft.value.cwd !== selected.value.cwd ||
    draft.value.command !== selected.value.command
  )
);

async function save() {
  if (!selected.value) return;
  await update({ ...draft.value });
}

// ── CRUD actions ─────────────────────────────────────────────────────────────
async function addNew() {
  const cfg = await add({ name: "新配置", cwd: currentWsKey.value, command: "" });
  selectedId.value = cfg.id;
}

async function deleteSelected() {
  if (!selected.value) return;
  await remove(selected.value.id);
}

// ── Auto-detect ──────────────────────────────────────────────────────────────
const detecting = ref(false);
const detectedTargets = ref<RunTarget[]>([]);
const selectedTargetIds = ref<Set<string>>(new Set());

async function runDetect() {
  detecting.value = true;
  detectedTargets.value = await detectAndAdd(currentWsKey.value);
  selectedTargetIds.value = new Set(detectedTargets.value.map(t => t.cwd));
  detecting.value = false;
}

function toggleTarget(cwd: string) {
  if (selectedTargetIds.value.has(cwd)) {
    selectedTargetIds.value.delete(cwd);
  } else {
    selectedTargetIds.value.add(cwd);
  }
  selectedTargetIds.value = new Set(selectedTargetIds.value);
}

async function confirmDetected() {
  const chosen = detectedTargets.value.filter(t =>
    selectedTargetIds.value.has(t.cwd)
  );
  await addTargets(chosen);
  detectedTargets.value = [];
  if (configs.value.length > 0) selectedId.value = configs.value[0].id;
}

function closeDetect() {
  detectedTargets.value = [];
}

// ── Close / save-and-close ───────────────────────────────────────────────────
async function close() {
  if (isDirty.value) await save();
  emit("close");
}
</script>

<template>
  <div class="rcd-backdrop" @click.self="close">
    <div class="rcd-dialog">
      <div class="rcd-header">
        <svg width="14" height="14" viewBox="0 0 10 10" fill="var(--aide-success)" style="flex-shrink:0">
          <polygon points="2,1 9,5 2,9"/>
        </svg>
        <span class="rcd-title">运行配置</span>
        <button class="rcd-close" @click="close">✕</button>
      </div>

      <div class="rcd-body">
        <!-- Left: config list -->
        <div class="rcd-left">
          <div class="rcd-toolbar">
            <button class="rcd-tool" title="新建" @click="addNew">＋</button>
            <button
              class="rcd-tool rcd-tool-danger"
              title="删除"
              :disabled="!selected"
              @click="deleteSelected"
            >－</button>
          </div>

          <div class="rcd-list">
            <div
              v-for="cfg in configs"
              :key="cfg.id"
              class="rcd-list-item"
              :class="{ active: cfg.id === selectedId }"
              @click="selectedId = cfg.id"
            >
              <span class="rcd-list-name">{{ cfg.name }}</span>
            </div>
            <div v-if="configs.length === 0" class="rcd-list-empty">暂无配置</div>
          </div>

          <div class="rcd-list-footer">
            <button class="rcd-detect-btn" :disabled="detecting" @click="runDetect">
              <svg v-if="!detecting" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <span v-if="detecting">检测中…</span>
              <span v-else>自动检测</span>
            </button>
          </div>
        </div>

        <!-- Right: edit form -->
        <div class="rcd-right">
          <template v-if="selected">
            <div class="rcd-form-title">{{ draft.name || '(未命名)' }}</div>

            <div class="rcd-field">
              <label>名称</label>
              <input v-model="draft.name" type="text" placeholder="service-auth" />
            </div>

            <div class="rcd-field">
              <label>工作目录</label>
              <input v-model="draft.cwd" type="text" placeholder="/path/to/module" />
            </div>

            <div class="rcd-field">
              <label>命令</label>
              <input v-model="draft.command" type="text" placeholder="mvn spring-boot:run" />
              <span class="rcd-hint">在工作目录中执行的 shell 命令</span>
            </div>

            <div class="rcd-save-row">
              <button class="rcd-btn-primary" :disabled="!isDirty" @click="save">保存更改</button>
            </div>
          </template>
          <div v-else class="rcd-empty-state">选择左侧配置项进行编辑，或点击 ＋ 新建</div>
        </div>
      </div>

      <!-- Auto-detect results overlay -->
      <div v-if="detectedTargets.length > 0" class="rcd-detect-overlay">
        <div class="rcd-detect-header">检测到以下可运行目标</div>
        <div class="rcd-detect-list">
          <label
            v-for="t in detectedTargets"
            :key="t.cwd"
            class="rcd-detect-item"
          >
            <input
              type="checkbox"
              :checked="selectedTargetIds.has(t.cwd)"
              @change="toggleTarget(t.cwd)"
            />
            <span class="rcd-detect-col">
              <span class="rcd-detect-name">{{ t.name }}</span>
              <span class="rcd-detect-cmd">{{ t.command }}</span>
            </span>
          </label>
        </div>
        <div class="rcd-detect-actions">
          <button class="rcd-btn-ghost" @click="closeDetect">取消</button>
          <button class="rcd-btn-primary" @click="confirmDetected">添加选中项</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rcd-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.rcd-dialog {
  position: relative;
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  width: 660px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--aide-shadow-lg);
  overflow: hidden;
}

.rcd-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--aide-border);
  flex-shrink: 0;
}
.rcd-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
  flex: 1;
}
.rcd-close {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 5px;
  border-radius: 3px;
  line-height: 1;
  transition: background 0.1s, color 0.1s;
}
.rcd-close:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.rcd-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* ── Left panel ── */
.rcd-left {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--aide-border);
  display: flex;
  flex-direction: column;
  background: var(--aide-bg-base, var(--aide-bg-deep));
}

.rcd-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--aide-border);
}
.rcd-tool {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.rcd-tool:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.rcd-tool-danger:hover {
  background: color-mix(in srgb, var(--aide-error, #e07a6e) 15%, transparent);
  color: var(--aide-error, #e07a6e);
}
.rcd-tool:disabled {
  opacity: 0.35;
  cursor: default;
}

.rcd-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}
.rcd-list-item {
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.1s;
}
.rcd-list-item:hover {
  background: var(--aide-surface-hover);
}
.rcd-list-item.active {
  background: var(--aide-surface-default);
  color: var(--aide-accent, var(--aide-info));
  font-weight: 500;
}
.rcd-list-name { display: block; }
.rcd-list-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: var(--aide-text-muted);
  text-align: center;
}

.rcd-list-footer {
  padding: 8px;
  border-top: 1px solid var(--aide-border);
}
.rcd-detect-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px;
  border: 1px dashed var(--aide-border);
  background: none;
  border-radius: 6px;
  cursor: pointer;
  color: var(--aide-text-muted);
  font-size: 11.5px;
  font-family: inherit;
  transition: all 0.12s;
}
.rcd-detect-btn:hover {
  border-color: var(--aide-accent, var(--aide-info));
  color: var(--aide-accent, var(--aide-info));
  background: color-mix(in srgb, var(--aide-accent, var(--aide-info)) 8%, transparent);
}
.rcd-detect-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── Right panel ── */
.rcd-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
  overflow-y: auto;
}

.rcd-form-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--aide-text-primary);
  margin-bottom: 4px;
}

.rcd-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.rcd-field label {
  font-size: 11px;
  color: var(--aide-text-muted);
  font-weight: 500;
  letter-spacing: 0.03em;
}
.rcd-field input {
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-primary);
  font-size: 12.5px;
  padding: 7px 10px;
  outline: none;
  font-family: inherit;
  transition: border-color 0.12s;
}
.rcd-field input:focus {
  border-color: var(--aide-accent, var(--aide-info));
}
.rcd-hint {
  font-size: 10.5px;
  color: var(--aide-text-muted);
}

.rcd-save-row {
  margin-top: 4px;
}

.rcd-empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--aide-text-muted);
  text-align: center;
  padding: 20px;
}

/* ── Auto-detect overlay ── */
.rcd-detect-overlay {
  position: absolute;
  inset: 0;
  background: var(--aide-bg-deep);
  display: flex;
  flex-direction: column;
  padding: 20px;
  gap: 12px;
  z-index: 10;
}
.rcd-detect-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.rcd-detect-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  overflow-y: auto;
}
.rcd-detect-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--aide-border);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s;
}
.rcd-detect-item:has(input:checked) {
  background: var(--aide-surface-default);
  border-color: var(--aide-surface-hover);
}
.rcd-detect-item input[type="checkbox"] {
  margin-top: 2px;
  flex-shrink: 0;
  accent-color: var(--aide-accent, var(--aide-info));
}
.rcd-detect-col {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rcd-detect-name {
  font-size: 12px;
  color: var(--aide-text-primary);
  font-weight: 500;
}
.rcd-detect-cmd {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  font-family: 'Consolas', 'Menlo', monospace;
}
.rcd-detect-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* ── Shared buttons ── */
.rcd-btn-primary,
.rcd-btn-ghost {
  padding: 6px 16px;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.12s;
}
.rcd-btn-primary {
  background: var(--aide-accent, var(--aide-info));
  color: var(--aide-bg-deep);
  border: none;
}
.rcd-btn-primary:hover {
  opacity: 0.9;
}
.rcd-btn-primary:disabled {
  opacity: 0.4;
  cursor: default;
}
.rcd-btn-ghost {
  background: transparent;
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
}
.rcd-btn-ghost:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
</style>
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
pnpm tsc --noEmit 2>&1
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/RunConfigsDialog.vue
git commit -m "feat: add RunConfigsDialog component for run config CRUD"
```

---

## Task 7: Wire Everything in `App.vue`

**Files:**
- Modify: `src/App.vue`

**Interfaces consumed:**
- `useRunConfigs()` — `configs`, `activeConfig`, `load`, `setActive`
- `useRunProject()` — `run`
- New TitleBar props: `runConfigs`, `activeRunConfig`
- New TitleBar emits: `select-run-config`, `edit-run-configs`
- `RunConfigsDialog` — `@close`

- [ ] **Step 1: Add imports at top of `<script setup>`**

Add after the existing `useRunProject` import:
```typescript
import { defineAsyncComponent } from "vue"; // already imported — skip if present
import { useRunConfigs } from "./composables/useRunConfigs";
const RunConfigsDialog = defineAsyncComponent(() => import("./components/RunConfigsDialog.vue"));
```

- [ ] **Step 2: Initialize composables and dialog state**

Add after `const { run: runProject } = useRunProject();`:
```typescript
const { configs: runConfigs, activeConfig: activeRunConfig, load: loadRunConfigs, setActive: setActiveRunConfig } = useRunConfigs();
const runConfigsDialogVisible = ref(false);
```

- [ ] **Step 3: Call `loadRunConfigs` inside `onSidebarWsChanged`**

The existing function body:
```typescript
async function onSidebarWsChanged(path: string) {
  workspacePath.value = path;
  projectName.value = path.split(/[\\/]/).filter(Boolean).pop() || path;
  activeSessionId.value = "";
  terminalPanelRef.value?.resetView();
  await fileTreeRef.value?.loadRoot();
  if (rightTab.value === "git") gitPanelRef.value?.reload();
}
```

Change to:
```typescript
async function onSidebarWsChanged(path: string) {
  workspacePath.value = path;
  projectName.value = path.split(/[\\/]/).filter(Boolean).pop() || path;
  activeSessionId.value = "";
  terminalPanelRef.value?.resetView();
  await fileTreeRef.value?.loadRoot();
  if (rightTab.value === "git") gitPanelRef.value?.reload();
  // Load run configurations for this workspace (auto-detects on first open).
  loadRunConfigs(path, path);
}
```

- [ ] **Step 4: Add handler functions**

Add after `function onRunProject()`:
```typescript
function onSelectRunConfig(id: string) {
  setActiveRunConfig(id);
}
```

- [ ] **Step 5: Update TitleBar binding in the template**

Find the `<TitleBar>` element and add the new props and event handlers:
```html
<TitleBar
  ref="titleBarRef"
  :project-name="projectName"
  :git-branch="currentBranch"
  :active-sessions="activeSessionList"
  :run-configs="runConfigs"
  :active-run-config="activeRunConfig"
  @open-palette="paletteOpen = true"
  @select-session="(s) => sidebarRef?.selectSessionFromWorkspace(s.wsKey, s.id)"
  @run-project="onRunProject"
  @select-run-config="onSelectRunConfig"
  @edit-run-configs="runConfigsDialogVisible = true"
/>
```

- [ ] **Step 6: Add RunConfigsDialog to the template**

Add alongside the existing `<SettingsPanel>` element:
```html
<RunConfigsDialog v-if="runConfigsDialogVisible" @close="runConfigsDialogVisible = false" />
```

- [ ] **Step 7: Verify TypeScript compiles**

```powershell
pnpm tsc --noEmit 2>&1
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/App.vue
git commit -m "feat: wire run configurations into App.vue — load on workspace change, dialog toggle"
```

---

## End-to-End Verification

- [ ] Start the app: `pnpm tauri dev`
- [ ] Open a **single-module** workspace (e.g., a Cargo or Node project) → TitleBar should show `[project-name ▾][▶]` with one config auto-detected
- [ ] Click `[▶]` → workbench terminal opens and runs the detected command
- [ ] Click the config name → dropdown lists the one config + "编辑运行配置…"
- [ ] Click "编辑运行配置…" → dialog opens; edit name → save → dropdown shows updated name
- [ ] Open a **Java Maven multi-module** workspace (parent `pom.xml` with `<modules>`) → multiple configs auto-detected; dropdown shows all sub-modules
- [ ] Select a sub-module → click `[▶]` → terminal opens with that module's cwd and command
- [ ] Switch to a different workspace → TitleBar config selector updates to that workspace's configs (or empty)
- [ ] Switch back to original workspace → previous configs restored (activeId remembered)
- [ ] In the dialog, click "自动检测" → see detection results with checkboxes → add selected → new configs appear in list
- [ ] Verify `~/.claude-code-desktop/run_configs/` directory contains per-workspace JSON files
