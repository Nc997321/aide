# Provider 切换后连接漂移修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复"切换供应商后发消息 404 (model not found)"的 bug：让每个会话的 sidecar 子进程在连接身份（base_url/api_key/auth_token/代理）漂移时自动透明重启并 resume，而不是终身沿用 spawn 那一刻快照的旧配置。

**Architecture:** 在 `send_message` 每次发消息前，都重新计算当前 provider 应该对应的 env_vars，并跟该 session 存活子进程 **spawn 时的快照** 比较"连接身份"子集（不含 model——model 已经有专门的运行时 `set_model` 通道）。一旦这个子集出现漂移，就 kill 掉旧进程，带着已有的 `resume_id` 用新配置重新拉起，SDK 侧的会话历史通过 resume 无缝续上。纯决策逻辑（"要不要重启"）与 Tauri/进程管理粘合代码分离，前者可单测。

**Tech Stack:** Rust (Tauri v2 commands)，不涉及前端、不涉及 agent-sidecar（Claude 专属逻辑层），不新增 IPC 协议字段。

## Global Constraints

- 不修改 `ChatEvent`/`SidecarCommand` IPC 协议，不新增 Tauri command——完全在 Rust 内部的 `send_message` 决策逻辑里解决，前端零改动。
- 不触碰 `agent-sidecar/`（Claude 专属逻辑边界，见 CLAUDE.md 架构红线）。
- 决策规则里 **必须排除** `ANTHROPIC_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` / `CLAUDE_CODE_EFFORT_LEVEL`：模型切换有独立的运行时 `set_model` 通道，混进"连接身份"比较会导致单纯切模型（同供应商）也触发不必要的整进程重启。
- 所有新增纯函数放 `src-tauri/src/commands/provider.rs`（供应商语义的自然归属），Tauri 粘合代码放 `src-tauri/src/sidecar.rs` / `src-tauri/src/commands/chat.rs`。
- 遵循仓库既有测试模式：`#[cfg(test)] mod tests { use super::*; ... }` 追加在文件末尾（参考 `src-tauri/src/commands/settings.rs:172-`）。跑 Rust 测试统一用 `cargo test --lib`（仓库怪癖：默认 `cargo test` 会被集成测试软锁绕杀，见项目记忆 `aide-repo-quirks.md`）。

---

### Task 1: `should_respawn` 纯决策函数 + `connection_fingerprint`

**Files:**
- Modify: `src-tauri/src/commands/provider.rs`
- Test: 同文件内 `#[cfg(test)] mod tests`（新建）

**Interfaces:**
- Produces:
  - `pub fn should_respawn(existing_env: Option<&HashMap<String, String>>, desired_env: &HashMap<String, String>) -> bool`
  - （内部使用，非 pub）`fn connection_fingerprint(env: &HashMap<String, String>) -> BTreeMap<&str, &str>`
  - （内部使用，非 pub）`const CONNECTION_ENV_KEYS: &[&str]`
- Consumes: 无（纯函数，只依赖 `std::collections::{HashMap, BTreeMap}`）

- [ ] **Step 1: 写失败的测试**

在 `src-tauri/src/commands/provider.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// 会话第一次发消息、还没有存活进程时，必须重新拉起。
    #[test]
    fn should_respawn_when_no_existing_session() {
        let desired = env(&[("ANTHROPIC_BASE_URL", "https://api.anthropic.com")]);
        assert!(should_respawn(None, &desired));
    }

    /// bug 复现场景：切换供应商后 base_url 变了，必须重启子进程。
    #[test]
    fn should_respawn_when_base_url_drifts() {
        let old = env(&[
            ("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            ("ANTHROPIC_API_KEY", "key-a"),
        ]);
        let desired = env(&[
            ("ANTHROPIC_BASE_URL", "https://provider-b.example.com"),
            ("ANTHROPIC_API_KEY", "key-b"),
        ]);
        assert!(should_respawn(Some(&old), &desired));
    }

    /// 连接身份完全没变，不该重启（否则每条消息都会重开进程）。
    #[test]
    fn should_not_respawn_when_connection_unchanged() {
        let old = env(&[
            ("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            ("ANTHROPIC_API_KEY", "key-a"),
        ]);
        let desired = old.clone();
        assert!(!should_respawn(Some(&old), &desired));
    }

    /// 关键回归用例：只切模型（同供应商，ANTHROPIC_MODEL 变了但 base_url/api_key
    /// 不变）不该触发重启——模型切换走运行时 set_model 通道。
    #[test]
    fn should_not_respawn_when_only_model_changes() {
        let old = env(&[
            ("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            ("ANTHROPIC_API_KEY", "key-a"),
            ("ANTHROPIC_MODEL", "claude-sonnet-5"),
        ]);
        let desired = env(&[
            ("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            ("ANTHROPIC_API_KEY", "key-a"),
            ("ANTHROPIC_MODEL", "claude-opus-5"),
        ]);
        assert!(!should_respawn(Some(&old), &desired));
    }

    /// 代理配置变化也算连接身份漂移，需要重启。
    #[test]
    fn should_respawn_when_proxy_drifts() {
        let old = env(&[("HTTP_PROXY", "http://127.0.0.1:7890")]);
        let desired = env(&[("HTTP_PROXY", "http://127.0.0.1:8888")]);
        assert!(should_respawn(Some(&old), &desired));
    }
}
```

- [ ] **Step 2: 运行测试确认失败（编译错误，函数不存在）**

Run: `cd src-tauri && cargo test --lib provider::tests -- --nocapture`
Expected: FAIL — `error[E0425]: cannot find function `should_respawn` in this scope`（以及 `connection_fingerprint`/`CONNECTION_ENV_KEYS` 未使用等编译期错误，属预期）

- [ ] **Step 3: 实现最小代码**

在 `src-tauri/src/commands/provider.rs` 顶部把：

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
```

改成：

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
```

然后在 `provider_to_env_vars` 函数（第 42-58 行）之后、`load_active_provider` 函数之前插入：

```rust
/// 决定子进程是否需要因连接身份变化而重启的字段白名单：base_url / api_key /
/// auth_token / 配置目录 / 代理。故意不含 ANTHROPIC_MODEL 等模型相关字段——
/// 模型切换有专门的运行时 `set_model` 通道，不该触发整进程重启（见
/// `chat.rs::set_model`）。
const CONNECTION_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
];

/// 从完整环境变量表里只摘出「连接身份」相关字段并按 key 排序，用于比较两次
/// env 快照是不是同一个供应商连接。
fn connection_fingerprint(env: &HashMap<String, String>) -> BTreeMap<&str, &str> {
    CONNECTION_ENV_KEYS
        .iter()
        .filter_map(|&k| env.get(k).map(|v| (k, v.as_str())))
        .collect()
}

/// `send_message` 每次发消息前都会重新读取 provider 配置算出 `desired_env`；
/// `existing_env` 是该 session 存活子进程 spawn 时留下的快照（`None` 表示
/// 没有存活进程）。两者在「连接身份」字段上不一致，就说明用户切换了供应商
/// （或代理），已存活的子进程还在用旧 base_url/api_key 发请求——必须重启
/// 才能生效，这正是「切换供应商后 404」bug 的根因。
pub fn should_respawn(
    existing_env: Option<&HashMap<String, String>>,
    desired_env: &HashMap<String, String>,
) -> bool {
    match existing_env {
        None => true,
        Some(old) => connection_fingerprint(old) != connection_fingerprint(desired_env),
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test --lib provider::tests -- --nocapture`
Expected: PASS — 5 个测试全绿（`should_respawn_when_no_existing_session`、`should_respawn_when_base_url_drifts`、`should_not_respawn_when_connection_unchanged`、`should_not_respawn_when_only_model_changes`、`should_respawn_when_proxy_drifts`）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/provider.rs
git commit -m "$(cat <<'EOF'
feat(provider): 新增 should_respawn 连接身份漂移检测

纯函数，判断 session 的 env 快照与当前 provider 配置相比，base_url/
api_key/auth_token/代理是否发生漂移。为下一步修复"切换供应商后 404"
做准备——不含此 commit 的行为改动，仅新增未接线的纯函数。
EOF
)"
```

---

### Task 2: `SidecarManager` 记录 spawn 快照 + `needs_respawn` 粘合方法

**Files:**
- Modify: `src-tauri/src/sidecar.rs:1-30`（struct 定义 + import）
- Modify: `src-tauri/src/sidecar.rs:163-167`（spawn 插入快照）
- Modify: `src-tauri/src/sidecar.rs:195-198`（has_session 旁新增 needs_respawn）
- Test: 同文件内 `#[cfg(test)] mod tests`（新建）

**Interfaces:**
- Consumes: `should_respawn` from Task 1（`crate::commands::provider::should_respawn`）
- Produces: `pub fn needs_respawn(&self, session_id: &str, env_vars: &HashMap<String, String>) -> bool`（`chat.rs` Task 3 会调用）

- [ ] **Step 1: 写失败的测试**

在 `src-tauri/src/sidecar.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// 全新 session（sessions 表里没有）必须判定需要重启——这是 spawn 分支
    /// 依赖的基础用例，不需要真的起子进程也能验证。
    #[test]
    fn needs_respawn_true_for_unknown_session() {
        let mgr = SidecarManager::new();
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_BASE_URL".to_string(), "https://api.anthropic.com".to_string());
        assert!(mgr.needs_respawn("no-such-session", &env));
    }
}
```

- [ ] **Step 2: 运行测试确认失败（编译错误，方法不存在）**

Run: `cd src-tauri && cargo test --lib sidecar::tests -- --nocapture`
Expected: FAIL — `error[E0599]: no method named `needs_respawn` found for struct `SidecarManager``

- [ ] **Step 3: 实现最小代码**

在 `src-tauri/src/sidecar.rs` 顶部导入区（第 1-10 行）添加一行：

```rust
use crate::commands::provider::should_respawn;
```

把 `SidecarSession` 结构体（第 13-20 行）：

```rust
struct SidecarSession {
    stdin: Arc<TokioMutex<ChildStdin>>,
    /// Arc 化：reader 看门狗任务与 kill() 都需要收割进程，共享同一句柄。
    child: Arc<TokioMutex<Child>>,
    killed: Arc<AtomicBool>,
    /// 会话 ID 共享句柄：rename 后 reader 任务发出的事件立刻携带新 ID
    sid: Arc<Mutex<String>>,
}
```

改成：

```rust
struct SidecarSession {
    stdin: Arc<TokioMutex<ChildStdin>>,
    /// Arc 化：reader 看门狗任务与 kill() 都需要收割进程，共享同一句柄。
    child: Arc<TokioMutex<Child>>,
    killed: Arc<AtomicBool>,
    /// 会话 ID 共享句柄：rename 后 reader 任务发出的事件立刻携带新 ID
    sid: Arc<Mutex<String>>,
    /// spawn 时使用的完整 env_vars 快照，供 `needs_respawn` 检测连接身份漂移
    /// （供应商切换后 base_url/api_key 是否还跟这次 spawn 时一致）。
    env_vars: HashMap<String, String>,
}
```

把 `spawn()` 里的插入语句（第 163-166 行）：

```rust
        self.sessions.lock().unwrap().insert(
            session_id,
            SidecarSession { stdin, child, killed, sid: sid_shared },
        );
        Ok(())
```

改成：

```rust
        self.sessions.lock().unwrap().insert(
            session_id,
            SidecarSession { stdin, child, killed, sid: sid_shared, env_vars },
        );
        Ok(())
```

（`env_vars` 参数此前只在 `for (k, v) in &env_vars { cmd.env(k, v); }` 里被借用，函数体内没有其他消费点，这里 move 进结构体是最后一次使用，编译器不会报 borrow 冲突。）

在 `has_session`（第 195-197 行）后面插入新方法：

```rust
    pub fn has_session(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(session_id)
    }

    /// 判断该 session 是否需要重启子进程：没有存活进程，或者存活进程 spawn
    /// 时的 env 快照跟当前 provider 配置算出来的 env_vars 相比，连接身份
    /// （base_url/api_key/auth_token/代理）发生了漂移。纯决策委托给
    /// `provider::should_respawn`，这里只负责从会话表里取快照，粘合逻辑。
    pub fn needs_respawn(&self, session_id: &str, env_vars: &HashMap<String, String>) -> bool {
        let sessions = self.sessions.lock().unwrap();
        should_respawn(sessions.get(session_id).map(|s| &s.env_vars), env_vars)
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test --lib sidecar::tests -- --nocapture`
Expected: PASS

再跑一次 Task 1 的测试确认没有被这次改动破坏：

Run: `cd src-tauri && cargo test --lib -- --nocapture`
Expected: PASS（全部测试，包括 `provider::tests::*` 和 `sidecar::tests::*`）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sidecar.rs
git commit -m "$(cat <<'EOF'
feat(sidecar): SidecarSession 记录 spawn 快照，新增 needs_respawn

为每个存活子进程保存 spawn 时的 env_vars 快照，新增 needs_respawn
粘合方法委托给 provider::should_respawn 做连接身份漂移判断。仍未接入
send_message，行为不变。
EOF
)"
```

---

### Task 3: `send_message` 接线——漂移时透明重启并 resume

**Files:**
- Modify: `src-tauri/src/commands/chat.rs:11-66`

**Interfaces:**
- Consumes: `SidecarManager::needs_respawn`（Task 2）、`SidecarManager::kill`（已存在）、`SidecarManager::has_session`（已存在）、`SidecarManager::spawn`（已存在）
- Produces: 无新接口——`send_message` 对外签名不变，前端零改动

- [ ] **Step 1: 修改 `send_message`（无独立单测——原因见下方"验证"）**

把 `src-tauri/src/commands/chat.rs` 第 22-66 行：

```rust
    if !sidecar_mgr.has_session(&session_id) {
        let cwd = project_root_for_commands(&workspace_state);
        let mut env_vars: HashMap<String, String> = if let Some(provider) = load_active_provider() {
            provider_to_env_vars(&provider)
        } else {
            HashMap::new()
        };

        // 会话面板里对话开始前选的模型，只在这里（新建 sidecar 进程）生效一次，
        // 覆盖 provider 配置的默认值；之后切模型走运行时的 set_model 命令。
        apply_initial_model_override(&mut env_vars, initial_model);

        // 从系统全局环境变量读取认证信息和代理
        for var in &[
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CONFIG_DIR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            if !env_vars.contains_key(*var) {
                if let Ok(val) = std::env::var(var) {
                    if !val.is_empty() {
                        env_vars.insert(var.to_string(), val);
                    }
                }
            }
        }

        if let Ok(s) = get_settings() {
            if !s.proxy.is_empty() {
                env_vars.insert("HTTP_PROXY".to_string(), s.proxy.clone());
                env_vars.insert("HTTPS_PROXY".to_string(), s.proxy.clone());
                env_vars.insert("http_proxy".to_string(), s.proxy.clone());
                env_vars.insert("https_proxy".to_string(), s.proxy);
            }
        }
        sidecar_mgr.spawn(session_id.clone(), cwd, env_vars, app_handle)?;
    }
```

改成：

```rust
    // env_vars 每次发消息前都无条件重新计算（provider 配置只是读一次 JSON 文件，
    // 代价可忽略）：这是修复"切换供应商后已存活进程还在用旧 base_url"这个 bug
    // 的关键——旧代码只在 `!has_session` 分支里算一次，进程活着就再也不会重新
    // 读取 provider 配置，导致切换供应商对已存活会话形同虚设。
    let mut env_vars: HashMap<String, String> = if let Some(provider) = load_active_provider() {
        provider_to_env_vars(&provider)
    } else {
        HashMap::new()
    };

    // 从系统全局环境变量读取认证信息和代理（provider 未覆盖的字段兜底）
    for var in &[
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CONFIG_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if !env_vars.contains_key(*var) {
            if let Ok(val) = std::env::var(var) {
                if !val.is_empty() {
                    env_vars.insert(var.to_string(), val);
                }
            }
        }
    }

    if let Ok(s) = get_settings() {
        if !s.proxy.is_empty() {
            env_vars.insert("HTTP_PROXY".to_string(), s.proxy.clone());
            env_vars.insert("HTTPS_PROXY".to_string(), s.proxy.clone());
            env_vars.insert("http_proxy".to_string(), s.proxy.clone());
            env_vars.insert("https_proxy".to_string(), s.proxy);
        }
    }

    // 连接身份（base_url/api_key/auth_token/代理）相对存活进程 spawn 时的快照
    // 漂移了，或者该 session 压根没有存活进程：都需要（重新）拉起子进程。
    // 已有进程会先被 kill——kill() 内部先置 killed=true 再杀，reader 任务的
    // EOF 不会误报 session_dead（跟用户主动点"停止"走的是同一条静默路径）。
    // 新进程沿用已有的 resume_id（前端对非 pending 会话恒定带 sid 作为
    // resume_id）续上 SDK 侧的会话历史，对用户透明。
    if sidecar_mgr.needs_respawn(&session_id, &env_vars) {
        if sidecar_mgr.has_session(&session_id) {
            sidecar_mgr.kill(&session_id).await;
        }
        let cwd = project_root_for_commands(&workspace_state);
        // 会话面板里当前选中的模型，覆盖 provider 配置的默认值；之后切模型走
        // 运行时的 set_model 命令。首次 spawn 和「漂移触发的重新 spawn」都走
        // 这一行——后者天然会带上用户切换供应商时刚选的新模型（前端每条消息
        // 都带 initialModel，只是旧代码只在首次 spawn 时用到）。
        apply_initial_model_override(&mut env_vars, initial_model);
        sidecar_mgr.spawn(session_id.clone(), cwd, env_vars, app_handle)?;
    }
```

- [ ] **Step 2: 编译确认无误**

Run: `cd src-tauri && cargo check`
Expected: 编译通过，无 warning（尤其确认 `initial_model` 参数没有被判定为"移动后又使用"之类的借用错误——它现在只在 `if` 块内被消费一次，跟原来一样）

- [ ] **Step 3: 跑一遍全部 Rust 测试确认没有破坏 Task 1/2 的测试**

Run: `cd src-tauri && cargo test --lib -- --nocapture`
Expected: PASS（全部测试，无新增测试文件，但要确认这次重构没有意外改坏 provider.rs/sidecar.rs 的签名导致编译期测试失败）

- [ ] **Step 4: 手动验证（无法用单元测试覆盖真实子进程 + 真实 SDK 网络请求，走真机复现）**

这一步不是自动化测试——`send_message` 会真的 spawn Node 子进程并让 Claude Agent SDK 发起真实 HTTP 请求，仓库里也没有针对这层的集成测试基础设施（`src-tauri/src/commands/chat.rs` 之前没有 `#[cfg(test)]`），照搬会是无意义的假测试。改用可执行、可验证的手动复现步骤：

1. `pnpm tauri dev` 启动应用。
2. 设置 → 供应商：确认/新建两个 provider——
   - Provider A：`baseUrl` 留空或指向官方 `https://api.anthropic.com`（走系统默认能通的配置）。
   - Provider B：`baseUrl` 指向一个第三方中转（复现截图里的场景），`model` 填一个 A 不认识的第三方模型 id（如 `mimo-v2.5-pro`）。
3. 激活 Provider A，新建会话，发一条"你好"，确认正常回复（对应截图第一次能通）。
4. **不新建会话**，直接在侧栏/设置里把 active provider 切成 Provider B。
5. 回到刚才那个会话，再发一条消息（比如"你现在用的是哪个供应商？"）。
6. 预期：**不再出现 `HTTP 404 model not found`**。请求应该打到 Provider B 的 `baseUrl`，用 Provider B 的 model/api_key——如果 Provider B 配置本身有效，应该正常回复；如果 Provider B 配置无效（比如 api_key 错），应该报 Provider B 侧的错误（如 401/鉴权失败），而不是"模型不存在"这种"打到了错误 endpoint"的特征性错误。
7. 打开浏览器/应用日志（或临时在 `sidecar.rs::spawn` 里加一行 `eprintln!` 打印 `env_vars.get("ANTHROPIC_BASE_URL")`，验证完删掉）确认新 spawn 的子进程环境变量里 `ANTHROPIC_BASE_URL` 确实是 Provider B 的地址。
8. 额外回归：只切模型（同一个 provider 内，比如从 A 的默认模型切到 A 的另一个 `knownModels`），确认不会触发进程重启（可以在 `sidecar.rs::spawn` 里临时加日志观察 spawn 有没有被多余调用一次；验证完删除）。
9. 额外回归：会话历史在步骤 4-5 的切换后仍然可见、没有断层（resume 生效）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/chat.rs
git commit -m "$(cat <<'EOF'
fix(chat): 切换供应商后已存活会话仍用旧 base_url 导致 404

send_message 之前只在会话第一次 spawn 子进程时读取 provider 配置，
进程活着之后永远不会感知供应商切换，导致新模型请求打到旧 base_url
返回 404 model not found。现在每次发消息都重新计算 env_vars 并跟
spawn 时的快照比较连接身份（base_url/api_key/auth_token/代理），
漂移时静默 kill 旧进程、带 resume_id 用新配置重新拉起，对用户透明；
纯模型切换（同供应商）不受影响，仍走运行时 set_model。
EOF
)"
```

---

## Self-Review Notes

- **Spec 覆盖**：根因（env_vars 只在 spawn 时读一次）→ Task 3 的重构直接解决；决策规则需排除 model 字段 → Task 1 的 `CONNECTION_ENV_KEYS` 白名单 + 专门的回归测试 `should_not_respawn_when_only_model_changes`；不改 IPC/前端 → 三个 Task 都只碰 `src-tauri`，已核对。
- **Placeholder 扫描**：三个 Task 的代码块均为完整可编译代码，无 TBD/"类似 Task N"/无实现的测试描述。
- **类型一致性**：`should_respawn(Option<&HashMap<String,String>>, &HashMap<String,String>) -> bool`（Task 1 定义）与 `needs_respawn` 内部调用（Task 2）、`chat.rs` 调用 `needs_respawn(&session_id, &env_vars)`（Task 3）三处签名核对一致；`SidecarSession.env_vars: HashMap<String,String>` 字段名在 Task 2 定义与 spawn() 插入语句里保持一致。
