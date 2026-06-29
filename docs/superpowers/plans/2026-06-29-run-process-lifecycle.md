# Run Process Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Run feature full process ownership — real start/stop/restart controls, lifecycle-aware TitleBar (▶/■/↺ + status dot), and automatic workbench terminal linkage when a run config is launched.

**Architecture:** A new `spawn_run_command` method on `PtyManager` spawns the user's command via `cmd /c` (Windows) or `sh -c` (Unix) with a deterministic session ID (`run__{config_id}`). A new `useRunProcess` composable owns the lifecycle state (`idle/running/stopped/crashed`) and responds to `pty-exit` events. The TitleBar gains stop/restart buttons and a status dot; App.vue wires everything together.

**Tech Stack:** Tauri v2 (Rust + `portable_pty`), Vue 3 Composition API, TypeScript, xterm.js

## Global Constraints

- All `Command::new` on Windows must use `CREATE_NO_WINDOW (0x08000000)` — this plan uses PTY via `portable_pty` so the flag is not needed here, but any future `std::process::Command` addition must include it.
- TypeScript must pass `pnpm vue-tsc --noEmit` with zero errors after each task.
- Rust must compile with `cargo build --manifest-path src-tauri/Cargo.toml` with zero errors and zero warnings after each Rust task.
- No new `npm`/`cargo` dependencies — reuse `portable_pty`, existing xterm.js, and Tauri APIs already in the project.
- Keep existing fallback run button behavior (no-config case in TitleBar) unchanged.
- `useRunProcess` must be a module-level singleton (same pattern as `useRunConfigs`, `useSettings`).
- Session IDs for run processes use the format `run__{config_id}` (two underscores), e.g. `run__rc_1234567890_abc`.

---

### Task 1: Rust — `spawn_run_command` on PtyManager + two new Tauri commands

**Files:**
- Modify: `src-tauri/src/pty.rs` — add `pub fn spawn_run_command(...)` method
- Create: `src-tauri/src/commands/run_process.rs` — `run_process_start`, `run_process_stop`
- Modify: `src-tauri/src/commands/mod.rs` — add `pub mod run_process;`
- Modify: `src-tauri/src/lib.rs` — register two new commands

**Interfaces:**
- Produces:
  - `run_process_start(config_id: String, cwd: String, command: String) -> Result<String, String>` — returns `session_id` (`"run__{config_id}"`)
  - `run_process_stop(config_id: String) -> Result<(), String>`
  - `pty-exit` event payload changes from `{"session_id":"..."}` to `{"session_id":"...","success":bool}` **only for sessions spawned by `spawn_run_command`**. The two existing methods (`spawn_command`, `spawn_shell`) keep their current payloads unchanged.

- [ ] **Step 1: Add `spawn_run_command` to `src-tauri/src/pty.rs`**

  Add the following method to `impl PtyManager`, after the existing `spawn_shell` method (around line 200):

  ```rust
  /// Spawn a user run-config command in a PTY via the system shell.
  /// On Windows: `cmd /c <command>`. On Unix: `sh -c <command>`.
  /// The waiter thread emits `pty-exit` with `{"session_id":"...","success":bool}`.
  pub fn spawn_run_command(
      &self,
      session_id: &str,
      cwd: &PathBuf,
      command: &str,
      rows: u16,
      cols: u16,
      app_handle: AppHandle,
  ) -> Result<(), String> {
      self.kill_session(session_id);

      let pty_system = native_pty_system();
      let pty_pair = pty_system
          .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
          .map_err(|e| format!("Failed to open PTY: {}", e))?;

      #[cfg(target_os = "windows")]
      let (shell_bin, shell_args): (String, Vec<String>) = (
          std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
          vec!["/c".into(), command.into()],
      );
      #[cfg(not(target_os = "windows"))]
      let (shell_bin, shell_args): (String, Vec<String>) = (
          "/bin/sh".into(),
          vec!["-c".into(), command.into()],
      );

      let mut cmd = CommandBuilder::new(&shell_bin);
      cmd.args(&shell_args);
      cmd.cwd(cwd);

      let mut child = pty_pair
          .slave
          .spawn_command(cmd)
          .map_err(|e| format!("Failed to spawn '{}': {}", command, e))?;

      drop(pty_pair.slave);

      let master = pty_pair.master;
      let writer = master
          .take_writer()
          .map_err(|e| format!("Failed to take writer: {}", e))?;
      let mut reader = master
          .try_clone_reader()
          .map_err(|e| format!("Failed to clone reader: {}", e))?;

      let output_buffer = Arc::new(Mutex::new(String::new()));

      {
          let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
          sessions.insert(
              session_id.to_string(),
              PtySession { master, writer, output_buffer: output_buffer.clone() },
          );
      }

      let sid = session_id.to_string();
      let sessions_clone = self.sessions.clone();
      let app_waiter = app_handle.clone();
      let buf_for_reader = output_buffer.clone();

      thread::spawn(move || {
          let mut buf = [0u8; 65536];
          loop {
              match reader.read(&mut buf) {
                  Ok(0) | Err(_) => break,
                  Ok(n) => {
                      let data = String::from_utf8_lossy(&buf[..n]);
                      if let Ok(mut out) = buf_for_reader.lock() {
                          out.push_str(&data);
                      }
                  }
              }
          }
      });

      thread::spawn(move || {
          let exit_status = child.wait().ok();
          let success = exit_status.map(|s| s.success()).unwrap_or(false);
          if let Ok(mut map) = sessions_clone.lock() {
              map.remove(&sid);
          }
          let payload = serde_json::json!({ "session_id": &sid, "success": success });
          let _ = app_waiter.emit("pty-exit", payload.to_string());
      });

      Ok(())
  }
  ```

- [ ] **Step 2: Verify `src-tauri/src/pty.rs` compiles**

  Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | head -30`

  Expected: no errors related to pty.rs (there may be warnings from unchanged code — those are pre-existing).

- [ ] **Step 3: Create `src-tauri/src/commands/run_process.rs`**

  ```rust
  use std::path::PathBuf;
  use tauri::{AppHandle, State};
  use crate::pty::PtyManager;

  fn run_session_id(config_id: &str) -> String {
      format!("run__{}", config_id)
  }

  #[tauri::command]
  pub fn run_process_start(
      config_id: String,
      cwd: String,
      command: String,
      pty_manager: State<'_, PtyManager>,
      app: AppHandle,
  ) -> Result<String, String> {
      let session_id = run_session_id(&config_id);
      let cwd_path = PathBuf::from(&cwd);
      pty_manager.spawn_run_command(&session_id, &cwd_path, &command, 24, 80, app)?;
      Ok(session_id)
  }

  #[tauri::command]
  pub fn run_process_stop(
      config_id: String,
      pty_manager: State<'_, PtyManager>,
  ) -> Result<(), String> {
      let session_id = run_session_id(&config_id);
      pty_manager.kill_session(&session_id);
      Ok(())
  }
  ```

- [ ] **Step 4: Register the module in `src-tauri/src/commands/mod.rs`**

  Add `pub mod run_process;` in alphabetical order. The file currently has:
  ```
  pub mod pty;
  pub mod filesystem;
  pub mod git;
  pub mod session;
  pub mod workspace;
  pub mod settings;
  pub mod customizations;
  pub mod detectors;
  pub mod marketplace;
  pub mod provider;
  pub mod run_configs;
  ```

  Add after `run_configs`:
  ```rust
  pub mod run_process;
  ```

- [ ] **Step 5: Register new commands in `src-tauri/src/lib.rs`**

  In the `invoke_handler!` macro block, add after the run_configs lines:
  ```rust
  // Run process lifecycle commands
  commands::run_process::run_process_start,
  commands::run_process::run_process_stop,
  ```

  The current run_configs block (around line 191) looks like:
  ```rust
  // Run configuration commands
  commands::run_configs::list_run_configs,
  commands::run_configs::save_run_configs,
  commands::run_configs::detect_run_targets,
  ```

  After those three lines add:
  ```rust
  // Run process lifecycle commands
  commands::run_process::run_process_start,
  commands::run_process::run_process_stop,
  ```

- [ ] **Step 6: Build and verify zero errors**

  Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1`

  Expected: `Finished` line, zero errors, zero new warnings (pre-existing warnings are acceptable if they existed before this task).

- [ ] **Step 7: Commit**

  ```bash
  git add src-tauri/src/pty.rs src-tauri/src/commands/run_process.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
  git commit -m "feat: add run process lifecycle commands (start/stop via shell PTY)"
  ```

---

### Task 2: Frontend API + `attachSession` in WorkbenchTerminal

**Files:**
- Modify: `src/api.ts` — add `runProcessStart`, `runProcessStop`
- Modify: `src/composables/useWorkbenchTerminal.ts` — add `attachSession` method and export it

**Interfaces:**
- Consumes: Task 1's `run_process_start` and `run_process_stop` Tauri commands
- Produces:
  - `api.runProcessStart(configId, cwd, command): Promise<string>` — returns `session_id`
  - `api.runProcessStop(configId): Promise<void>`
  - `useWorkbenchTerminal()` now also returns `attachSession(id: string, label: string, clearFirst?: boolean): void`

- [ ] **Step 1: Add two methods to `src/api.ts`**

  Find the run config section in `api.ts` (around line 51 where `listRunConfigs` is defined). After `detectRunTargets`, add:

  ```typescript
  runProcessStart(configId: string, cwd: string, command: string): Promise<string> {
    return invoke("run_process_start", { configId, cwd, command });
  },
  runProcessStop(configId: string): Promise<void> {
    return invoke("run_process_stop", { configId });
  },
  ```

  Note: Tauri converts `camelCase` JS param names to `snake_case` automatically for the invocation. The command parameter names in Rust are `config_id`, `cwd`, `command`, and Tauri's `#[tauri::command]` maps these. The JS object keys `configId`, `cwd`, `command` work correctly — Tauri maps `configId` → `config_id`.

- [ ] **Step 2: Add `attachSession` to `src/composables/useWorkbenchTerminal.ts`**

  The existing `createSession` function creates a shell PTY and creates the terminal DOM. `attachSession` creates just the terminal DOM for a PTY that already exists on the Rust side.

  Add this function **inside the module scope** (not inside `useWorkbenchTerminal()`), after `spawnShell`:

  ```typescript
  function attachSession(id: string, label: string, clearFirst = false): void {
    ensureSettingsWatchers();

    const existing = sessions.get(id);
    if (existing) {
      // Restart case: PTY was re-spawned with same ID; reset terminal state
      existing.exited = false;
      if (clearFirst) existing.terminal.clear();
      syncTabs();
      switchTo(id);
      ensurePolling();
      return;
    }

    if (!containerEl) return;
    const s = settingsRef!;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: s.fontSize,
      fontFamily: s.fontFamily,
      theme: catppuccinMochaTheme,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const div = document.createElement("div");
    div.className = "wb-term-pane";
    containerEl.appendChild(div);
    div.style.display = "";
    terminal.open(div);
    fitAddon.fit();

    terminal.onData((data) => {
      api.ptyWrite(id, data).catch(() => {});
    });

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      api.ptyResize(id, terminal.rows, terminal.cols).catch(() => {});
    });
    observer.observe(div);

    const session: WbSession = {
      id,
      label,
      terminal,
      fitAddon,
      div,
      observer,
      spawned: true,   // PTY already running on Rust side
      exited: false,
      shellName: "",
    };
    sessions.set(id, session);
    syncTabs();
    switchTo(id);
    ensurePolling();
    ensureExitListener();

    // Correct the PTY dimensions to match the actual terminal
    nextTick(() => {
      api.ptyResize(id, terminal.rows, terminal.cols).catch(() => {});
    });
  }
  ```

  Then add `nextTick` import — it's already imported from `"vue"` in the file. If not, add it to the existing import line:
  ```typescript
  import { ref, watch, computed, nextTick } from "vue";
  ```

- [ ] **Step 3: Export `attachSession` from `useWorkbenchTerminal()`**

  In the `return` statement of `useWorkbenchTerminal()` (around line 292), add `attachSession` to the returned object:

  ```typescript
  return {
    visible,
    tabs,
    activeId,
    activeExited,
    init,
    createSession,
    attachSession,   // ← add this
    switchTo,
    closeSession,
    show,
    hide,
    toggle,
    clear,
    changeCwd,
    restart,
    dispose,
  };
  ```

- [ ] **Step 4: Verify TypeScript**

  Run: `pnpm vue-tsc --noEmit`

  Expected: zero errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/api.ts src/composables/useWorkbenchTerminal.ts
  git commit -m "feat: add runProcess API + attachSession to WorkbenchTerminal"
  ```

---

### Task 3: New composable `useRunProcess.ts`

**Files:**
- Create: `src/composables/useRunProcess.ts`

**Interfaces:**
- Consumes:
  - `api.runProcessStart(configId, cwd, command): Promise<string>` (Task 2)
  - `api.runProcessStop(configId): Promise<void>` (Task 2)
  - `useWorkbenchTerminal().attachSession(id, label, clearFirst?)` (Task 2)
  - `RunConfig` from `"../types"`
- Produces (module-level singleton via `useRunProcess()`):
  - `runStatus: Ref<RunStatus>` — `"idle" | "running" | "stopped" | "crashed"`
  - `runningConfigId: Ref<string>` — id of the currently running (or last ran) config
  - `start(config: RunConfig): Promise<void>`
  - `stop(): Promise<void>`
  - `restart(config: RunConfig): Promise<void>`

- [ ] **Step 1: Write the failing type-check test**

  This project has no unit test framework. The "test" for this task is `vue-tsc --noEmit` after creation. Write the file first, then verify.

- [ ] **Step 2: Create `src/composables/useRunProcess.ts`**

  ```typescript
  import { ref } from "vue";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { api } from "../api";
  import { useWorkbenchTerminal } from "./useWorkbenchTerminal";
  import type { RunConfig } from "../types";

  export type RunStatus = "idle" | "running" | "stopped" | "crashed";

  // Module-level singleton state
  const runStatus = ref<RunStatus>("idle");
  const runningConfigId = ref<string>("");
  const activeSessionId = ref<string>("");

  let unlistenExit: UnlistenFn | null = null;
  let isRestarting = false;

  async function ensureExitListener(): Promise<void> {
    if (unlistenExit) return;
    unlistenExit = await listen<string>("pty-exit", (event) => {
      try {
        const p = JSON.parse(event.payload) as { session_id: string; success?: boolean };
        if (p.session_id === activeSessionId.value && !isRestarting) {
          runStatus.value = p.success ? "stopped" : "crashed";
        }
      } catch (_) { /* ignore malformed events */ }
    });
  }

  export function useRunProcess() {
    const wb = useWorkbenchTerminal();

    async function start(config: RunConfig): Promise<void> {
      await ensureExitListener();
      const sessionId = await api.runProcessStart(config.id, config.cwd, config.command);
      runningConfigId.value = config.id;
      activeSessionId.value = sessionId;
      runStatus.value = "running";

      // Show workbench and attach a terminal tab for the spawned PTY
      wb.visible.value = true;
      await new Promise<void>(r => setTimeout(r, 80));
      wb.attachSession(sessionId, config.name);
    }

    async function stop(): Promise<void> {
      if (!runningConfigId.value) return;
      await api.runProcessStop(runningConfigId.value);
      // pty-exit event will update runStatus asynchronously
    }

    async function restart(config: RunConfig): Promise<void> {
      isRestarting = true;
      await api.runProcessStop(config.id).catch(() => {});
      // Brief pause to let the old PTY flush before reopening with the same ID
      await new Promise<void>(r => setTimeout(r, 150));
      const sessionId = await api.runProcessStart(config.id, config.cwd, config.command);
      runningConfigId.value = config.id;
      activeSessionId.value = sessionId;
      runStatus.value = "running";
      isRestarting = false;

      wb.visible.value = true;
      wb.attachSession(sessionId, config.name, true /* clearFirst */);
    }

    return {
      runStatus,
      runningConfigId,
      start,
      stop,
      restart,
    };
  }
  ```

- [ ] **Step 3: Verify TypeScript**

  Run: `pnpm vue-tsc --noEmit`

  Expected: zero errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/composables/useRunProcess.ts
  git commit -m "feat: add useRunProcess composable (idle/running/stopped/crashed lifecycle)"
  ```

---

### Task 4: TitleBar.vue — stop/restart buttons and status dot

**Files:**
- Modify: `src/components/titlebar/TitleBar.vue`

**Interfaces:**
- Consumes:
  - `RunStatus` type from `useRunProcess` — import it here as a local type alias (do NOT import `useRunProcess` into TitleBar; the type is passed via prop)
  - New prop: `runStatus?: "idle" | "running" | "stopped" | "crashed"`
- Produces:
  - New emit: `"stop-project": []`
  - New emit: `"restart-project": []`
  - Visual changes: status dot next to config name, ■ stop button, ↺ restart button

**Design spec:**
- When `runStatus === "running"`: run group shows `[● name ▼] [■] [↺]` — green dot, stop+restart
- When `runStatus === "stopped"`: run group shows `[● name ▼] [▶] [↺]` — gray dot, play+restart
- When `runStatus === "crashed"`: run group shows `[● name ▼] [▶] [↺]` — red dot, play+restart
- When `runStatus === "idle"` or undefined: run group shows `[name ▼] [▶]` — no dot, play only

- [ ] **Step 1: Add `runStatus` prop and new emits to `<script setup>`**

  Find the existing `defineProps` block (lines 14–20 of TitleBar.vue) and add `runStatus`:

  ```typescript
  const props = defineProps<{
    projectName?: string;
    gitBranch?: string;
    activeSessions?: ActiveSessionInfo[];
    runConfigs?: RunConfig[];
    activeRunConfig?: RunConfig | null;
    runStatus?: "idle" | "running" | "stopped" | "crashed";
  }>();
  ```

  Find the existing `defineEmits` block (lines 22–28) and add two new emits:

  ```typescript
  const emit = defineEmits<{
    "open-palette": [];
    "select-session": [session: ActiveSessionInfo];
    "run-project": [];
    "select-run-config": [id: string];
    "edit-run-configs": [];
    "stop-project": [];
    "restart-project": [];
  }>();
  ```

- [ ] **Step 2: Add computed helpers for run state in `<script setup>`**

  After the `runningCount` computed (around line 78), add:

  ```typescript
  const isRunning = computed(() => props.runStatus === "running");
  const showRestartBtn = computed(() =>
    props.runStatus === "running" || props.runStatus === "stopped" || props.runStatus === "crashed"
  );
  const runDotClass = computed(() => {
    switch (props.runStatus) {
      case "running":  return "run-dot run-dot-running";
      case "stopped":  return "run-dot run-dot-stopped";
      case "crashed":  return "run-dot run-dot-crashed";
      default:         return "";
    }
  });
  ```

- [ ] **Step 3: Update the run group template**

  Find the `.run-group` section in the template (around line 108–168). Replace the interior of the `<template v-if="...">` wrapper so the config selector shows the dot, and the action buttons are conditional:

  Replace the existing `<!-- Config name selector -->` button with:

  ```html
  <!-- Config name selector — includes status dot -->
  <button
    class="run-config-sel"
    v-tooltip="'切换运行配置'"
    @click.stop="configDropOpen = !configDropOpen"
  >
    <span v-if="runDotClass" :class="runDotClass" />
    <span class="run-config-name">{{ activeRunConfig?.name ?? '─' }}</span>
    <svg class="run-config-chevron" width="8" height="5" viewBox="0 0 8 5" fill="currentColor">
      <path d="M0.5 0.5L4 4L7.5 0.5"/>
    </svg>
  </button>
  ```

  Replace the existing `<!-- Run button -->` button with the conditional play/stop/restart buttons:

  ```html
  <!-- Stop button (only when running) -->
  <button
    v-if="isRunning"
    class="run-stop-btn"
    v-tooltip="'停止'"
    @click.stop="$emit('stop-project')"
  >
    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
      <rect x="1" y="1" width="6" height="6" rx="0.5"/>
    </svg>
  </button>

  <!-- Play button (when idle / stopped / crashed) -->
  <button
    v-else
    class="run-play-btn"
    v-tooltip="'运行'"
    @click.stop="$emit('run-project')"
  >
    <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor">
      <polygon points="2,1 9,5 2,9"/>
    </svg>
  </button>

  <!-- Restart button (visible when process has been started at least once) -->
  <button
    v-if="showRestartBtn"
    class="run-restart-btn"
    v-tooltip="'重启'"
    @click.stop="$emit('restart-project')"
  >
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 .49-3.13"/>
    </svg>
  </button>
  ```

- [ ] **Step 4: Add CSS for new buttons and dot in `<style scoped>`**

  Append to the end of the scoped style block, before the closing `</style>`:

  ```css
  /* ── Run status dot ── */

  .run-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .run-dot-running {
    background: var(--aide-success);
    box-shadow: 0 0 5px color-mix(in srgb, var(--aide-success) 60%, transparent);
    animation: run-dot-pulse 2s ease-in-out infinite;
  }

  .run-dot-stopped {
    background: var(--aide-text-muted);
  }

  .run-dot-crashed {
    background: var(--aide-error, #f38ba8);
  }

  @keyframes run-dot-pulse {
    0%, 100% { opacity: 0.7; }
    50% { opacity: 1; }
  }

  /* ── Stop button ── */

  .run-stop-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    background: none;
    border: none;
    color: var(--aide-error, #f38ba8);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.12s, color 0.12s;
  }
  .run-stop-btn:hover {
    background: color-mix(in srgb, var(--aide-error, #f38ba8) 12%, transparent);
  }

  /* ── Restart button ── */

  .run-restart-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    background: none;
    border: none;
    border-left: 1px solid var(--aide-border);
    color: var(--aide-text-muted);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.12s, color 0.12s;
  }
  .run-restart-btn:hover {
    background: var(--aide-surface-hover);
    color: var(--aide-text-primary);
  }
  ```

- [ ] **Step 5: Verify TypeScript**

  Run: `pnpm vue-tsc --noEmit`

  Expected: zero errors.

- [ ] **Step 6: Commit**

  ```bash
  git add src/components/titlebar/TitleBar.vue
  git commit -m "feat: TitleBar run controls — stop/restart buttons + status dot"
  ```

---

### Task 5: App.vue — wire `useRunProcess` into TitleBar and session lifecycle

**Files:**
- Modify: `src/App.vue`

**Interfaces:**
- Consumes:
  - `useRunProcess()` from `"./composables/useRunProcess"` (Task 3)
  - `useRunConfigs().activeConfig` (already imported)
  - TitleBar's new `run-status` prop and `stop-project`/`restart-project` emits (Task 4)
- Produces: end-to-end feature — clicking ▶/■/↺ in TitleBar drives process lifecycle

- [ ] **Step 1: Import `useRunProcess` in `src/App.vue`**

  Find the existing run-related imports (around line 31–32):
  ```typescript
  import { useRunProject } from "./composables/useRunProject";
  import { useRunConfigs } from "./composables/useRunConfigs";
  ```

  Add the new import after `useRunProject`:
  ```typescript
  import { useRunProcess } from "./composables/useRunProcess";
  ```

- [ ] **Step 2: Instantiate `useRunProcess` and destructure in the script setup**

  Find the line that instantiates `useRunProject` (around line 104):
  ```typescript
  const { run: runProject } = useRunProject();
  ```

  After that line, add:
  ```typescript
  const { runStatus, start: startRunProcess, stop: stopRunProcess, restart: restartRunProcess } = useRunProcess();
  ```

- [ ] **Step 3: Replace `onRunProject` and add `onStopProject`/`onRestartProject`**

  Find the existing `onRunProject` function (around line 242):
  ```typescript
  function onRunProject() {
    runProject();
  }
  ```

  Replace it with:
  ```typescript
  async function onRunProject() {
    const cfg = activeRunConfig.value;
    if (cfg) {
      await startRunProcess(cfg);
    } else {
      // Fallback: no config detected, use legacy workbench send
      runProject();
    }
  }

  async function onStopProject() {
    await stopRunProcess();
  }

  async function onRestartProject() {
    const cfg = activeRunConfig.value;
    if (!cfg) return;
    await restartRunProcess(cfg);
  }
  ```

- [ ] **Step 4: Pass `runStatus` prop and new emit handlers to `<TitleBar>` in the template**

  Find the `<TitleBar>` usage in the template (around line 350):
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

  Replace with:
  ```html
  <TitleBar
    ref="titleBarRef"
    :project-name="projectName"
    :git-branch="currentBranch"
    :active-sessions="activeSessionList"
    :run-configs="runConfigs"
    :active-run-config="activeRunConfig"
    :run-status="runStatus"
    @open-palette="paletteOpen = true"
    @select-session="(s) => sidebarRef?.selectSessionFromWorkspace(s.wsKey, s.id)"
    @run-project="onRunProject"
    @stop-project="onStopProject"
    @restart-project="onRestartProject"
    @select-run-config="onSelectRunConfig"
    @edit-run-configs="runConfigsDialogVisible = true"
  />
  ```

- [ ] **Step 5: Verify TypeScript**

  Run: `pnpm vue-tsc --noEmit`

  Expected: zero errors.

- [ ] **Step 6: Smoke test — launch the app**

  Run: `pnpm tauri dev`

  Verify:
  1. App opens, TitleBar shows run config name (e.g. `pnpm tauri dev`) with ▶ button
  2. Click ▶ → workbench terminal opens, shows `pnpm tauri dev` output, dot turns green, ■ and ↺ buttons appear
  3. Click ■ → process stops, dot turns gray, ■ → ▶, ↺ remains
  4. Click ↺ → process restarts, terminal clears, dot turns green again
  5. Click ▶ on a crashed config → new process starts

- [ ] **Step 7: Commit**

  ```bash
  git add src/App.vue
  git commit -m "feat: wire useRunProcess into App.vue — stop/restart TitleBar controls"
  ```

---

## Self-Review

**Spec coverage:**
- ✅ Process lifecycle tracking — `spawn_run_command` owns the child, waiter thread fires `pty-exit` with `success`
- ✅ Stop control — ■ button → `run_process_stop` → `pty.kill_session`
- ✅ Restart control — ↺ button → `restartRunProcess` → stop + start + `attachSession(id, label, true)`
- ✅ Visual state — `runStatus` drives dot color + button display in TitleBar
- ✅ Linkage — `start()` sets `wb.visible.value = true` then calls `attachSession`; workbench auto-focuses run tab
- ✅ Crash detection — `success: false` in `pty-exit` → `runStatus = "crashed"` → red dot
- ✅ No-config fallback — unchanged (still uses `useRunProject`)
- ✅ Restart race condition — `isRestarting` flag prevents `pty-exit` from overwriting `runStatus = "running"` mid-restart

**Placeholder scan:** No TBDs, no vague error handling instructions, all code blocks are complete.

**Type consistency:**
- `RunStatus = "idle" | "running" | "stopped" | "crashed"` defined in `useRunProcess.ts`, copied verbatim to TitleBar prop type (no import needed — inlined)
- `session_id` format `run__{config_id}` used in both `run_process.rs` (`run_session_id` helper) and `useRunProcess.ts` (`activeSessionId.value`)
- `attachSession(id: string, label: string, clearFirst?: boolean)` signature consistent across all call sites

**Risk / follow-up:**
- On Windows, killing the PTY (`cmd.exe`) may leave grandchild processes (e.g. `node`, `java`) running. A future improvement would use `taskkill /f /t /pid` to kill the whole process tree. Not blocking for this plan.
- If `--aide-error` CSS var is not defined globally, the crashed dot falls back to the hardcoded `#f38ba8` (Catppuccin red). Check theme tokens if the color appears wrong.

---

## Follow-up: restart session-id 复用竞态（已记录，暂不修）

**来源**：整体代码评审（35b3f20..f6a5f3c），评审员标 Critical，经裁决降为已知限制。

**现象**：`restart()` 复用同一个 `run__{config_id}` session_id。老进程被 `kill_session`（仅从 HashMap 移除并 drop master，不显式 kill child）后，其 waiter 线程的 `child.wait()` 仍可能晚于 150ms pause 才返回，emit 的 `pty-exit`（同 session_id）会在 `isRestarting=false` 之后到达 → 触发一次假的 stopped/crashed 状态闪烁。

**为什么暂不修**：
- 概率低（ConPTY 关闭通常在毫秒级杀掉子进程，老 exit 落在 `isRestarting=true` 窗口内被正确忽略）。
- 影响仅外观（状态点短暂闪烁），新进程真正退出时自纠正。
- 评审员提议的"5 秒忽略窗口"会屏蔽 5 秒内所有 `pty-exit`，若新进程在此期间崩溃，用户看到 running 而非 crashed —— **用崩溃检测延迟换外观闪烁，不可取**。
- 唯一完全正确的修法是 restart 不复用 session_id（每次 spawn 唯一 ID，`run_process_stop` 改传 session_id，workbench tab 不再复用、每次 restart 关旧 tab 开新 tab），改动 4-5 文件且 tab 闪烁 UX 更差，与外观级 bug 不成比例。

**后续正确修法（如需彻底解决）**：
1. Rust：`run_process_start` 生成唯一 session_id（如 `run__{config_id}__{nonce}`）并返回；`run_process_stop` 改为接收 session_id 而非 config_id。
2. 前端：`stop/restart` 传 `activeSessionId.value`；workbench 在 restart 时关闭旧 tab、attach 新 tab（或改为按 config_id 稳定 tab key、session_id 仅作 PTY 句柄）。
3. 可选增强：`kill_session` 显式终止子进程树（Windows `taskkill /f /t`），保证老进程即时退出、老 exit 即时触发。
