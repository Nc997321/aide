use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use super::{claude_projects_dir, WorkspaceInfo, WorkspaceState};
use crate::runtime::AgentRuntimeManager;
use crate::settings::{SettingsScope, SettingsService};

// ── 子实现层 ──
// git_exclude：信任 / 索引激活时把 `.aide/` 幂等写入仓库 .git/info/exclude，
// 防 Aide 本地状态污染 git status。设计取舍见子模块头部注释。
mod git_exclude;
pub use git_exclude::ensure_aide_excluded;

/// 路径 → 编码 key：把 : \ / 替换为 -，与 Claude CLI
/// `~/.aide/claude/projects/` 目录命名一致。
pub fn path_to_key(path: &str) -> String {
    path.chars()
        .map(|c| match c {
            ':' | '\\' | '/' => '-',
            other => other,
        })
        .collect()
}

/// 按编码 key 解析实际的项目目录（可能命中多个）。
///
/// 新版 Agent SDK / claude.exe 编码 cwd 时把 `.` 也替换为 `-`
/// （`C--...-chennong4-0`），而 `path_to_key` 保留点号（`C--...-chennong4.0`），
/// 同一工作区因此可能分裂成两个目录（2026-07-24 实锤：chennong4.0 的新会话
/// 全部写进 `chennong4-0`，按 `path_to_key` 算出的目录去列会话自然读不到；
/// 同一案例此前已在 `find_session_jsonl_in` 的注释中记载）。这里按
/// 「`.` 归一成 `-` 后相等」匹配所有候选目录，调用方合并扫描。
pub fn resolve_project_dirs(projects_dir: &std::path::Path, key: &str) -> Vec<PathBuf> {
    let normalized = key.replace('.', "-");
    let mut dirs = Vec::new();
    if let Ok(entries) = fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if entry.file_name().to_string_lossy().replace('.', "-") == normalized {
                dirs.push(entry.path());
            }
        }
    }
    dirs
}

/// 从工作区列表里滤掉黑名单中的 key（隐藏语义）。
pub fn filter_hidden(infos: Vec<WorkspaceInfo>, hidden: &[String]) -> Vec<WorkspaceInfo> {
    infos
        .into_iter()
        .filter(|w| !hidden.contains(&w.key))
        .collect()
}

/// 读 state 里的 hiddenWorkspaces 黑名单。
pub fn hidden_keys(config: &serde_json::Value) -> Vec<String> {
    config
        .get("hiddenWorkspaces")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// 把 key 加入黑名单（幂等）。state 缺字段时自动创建。
pub fn hide_in_config(config: &mut serde_json::Value, key: &str) {
    if !config.is_object() {
        // null or corrupted (string/array/etc.) — normalize to an empty object
        *config = serde_json::json!({});
    }
    if let Some(map) = config.as_object_mut() {
        let arr = map
            .entry("hiddenWorkspaces".to_string())
            .or_insert_with(|| serde_json::json!([]));
        if let serde_json::Value::Array(a) = arr {
            if !a.iter().any(|v| v.as_str() == Some(key)) {
                a.push(serde_json::json!(key));
            }
        }
    }
}

/// 把 key 从黑名单移除（不存在则 noop）。
pub fn unhide_in_config(config: &mut serde_json::Value, key: &str) {
    if let Some(serde_json::Value::Array(a)) = config.get_mut("hiddenWorkspaces") {
        a.retain(|v| v.as_str() != Some(key));
    }
}

// ── 工作区信任白名单（trustedWorkspaces）── 与 hiddenWorkspaces 同构 ──

/// 读 state 里的 trustedWorkspaces 白名单。
pub fn trusted_keys(config: &serde_json::Value) -> Vec<String> {
    config
        .get("trustedWorkspaces")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// 把 key 加入信任白名单（幂等）。state 缺字段时自动创建。
pub fn trust_in_config(config: &mut serde_json::Value, key: &str) {
    if !config.is_object() {
        *config = serde_json::json!({});
    }
    if let Some(map) = config.as_object_mut() {
        let arr = map
            .entry("trustedWorkspaces".to_string())
            .or_insert_with(|| serde_json::json!([]));
        if let serde_json::Value::Array(a) = arr {
            if !a.iter().any(|v| v.as_str() == Some(key)) {
                a.push(serde_json::json!(key));
            }
        }
    }
}

/// 把 key 从信任白名单移除（不存在则 noop）。
pub fn untrust_in_config(config: &mut serde_json::Value, key: &str) {
    if let Some(serde_json::Value::Array(a)) = config.get_mut("trustedWorkspaces") {
        a.retain(|v| v.as_str() != Some(key));
    }
}

// ── 信任键归一：点号 → 横杠 ──
//
// 同一工作区磁盘上可能是两种编码目录：Aide 的 path_to_key 保留点号
// (chennong4.0)，SDK 编码把点号也替换成横杠 (chennong4-0)——见
// resolve_project_dirs 的 dot 归一匹配。信任白名单统一按「点号归一成横杠」
// 存与查，两种形态塌缩成同一个键，避免「用 ws.key 存、用 path_to_key(cwd)
// 查」时因编码差异对不上。

/// 路径 → 归一信任键：path_to_key 后再把点号替换成横杠。
pub fn trust_key_from_path(path: &str) -> String {
    path_to_key(path).replace('.', "-")
}

/// 已编码 key → 归一信任键：把点号替换成横杠。
///
/// codegraph_workspaces 的读写都先过这里：同一工作区的「带点号 key（path_to_key
/// 形态）/ 横杠 key / 路径版 trust_key_from_path」塌缩成同一键。幂等——横杠形态
/// 再归一不变。`trust_key_path_and_key_collapse_same_workspace` 据此验证。
pub fn trust_key_from_key(key: &str) -> String {
    key.replace('.', "-")
}

/// 路径是否在信任白名单内（按归一键比对）。供 CodeGraph / send_message
/// 等 Rust 侧门控点调用；读 state.json 是轻量 IO，调用方已在 spawn_blocking
/// 或命令体里。
pub fn is_path_trusted(path: &str) -> bool {
    trusted_keys(&super::settings::load_state()).contains(&trust_key_from_path(path))
}

/// 清掉 state 的 workspace（激活）字段。
pub fn clear_active_in_config(config: &mut serde_json::Value) {
    if let Some(obj) = config.as_object_mut() {
        obj.remove("workspace");
    }
}

// ── 工作区 LSP 配置（lsp_workspaces）──

/// 单工作区的 LSP 配置（存 state JSON，按 workspace key 索引）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct WorkspaceLspConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub exclude_dirs: Vec<String>,
}

/// 读某工作区的 LSP 配置（不存在 → 默认：关闭、无排除）。
pub fn lsp_workspace_config(key: &str) -> WorkspaceLspConfig {
    let config = super::settings::load_state();
    config
        .get("lsp_workspaces")
        .and_then(|w| w.get(key))
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// 设某工作区 LSP 开关。写 state JSON 的 lsp_workspaces[key].enabled。
pub fn set_lsp_enabled(key: &str, enabled: bool) -> Result<(), String> {
    super::settings::with_state_mut(|config| {
        let entry = config
            .as_object_mut()
            .ok_or("state not object")?
            .entry("lsp_workspaces")
            .or_insert(serde_json::json!({}));
        let obj = entry.as_object_mut().ok_or("lsp_workspaces not object")?;
        let mut cfg: WorkspaceLspConfig = obj
            .get(key)
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        cfg.enabled = enabled;
        obj.insert(
            key.to_string(),
            serde_json::to_value(&cfg).map_err(|e| e.to_string())?,
        );
        Ok(())
    })
}

/// 设某工作区排除目录列表。写 state JSON 的 lsp_workspaces[key].exclude_dirs。
pub fn set_lsp_excludes(key: &str, dirs: Vec<String>) -> Result<(), String> {
    super::settings::with_state_mut(|config| {
        let entry = config
            .as_object_mut()
            .ok_or("state not object")?
            .entry("lsp_workspaces")
            .or_insert(serde_json::json!({}));
        let obj = entry.as_object_mut().ok_or("lsp_workspaces not object")?;
        let mut cfg: WorkspaceLspConfig = obj
            .get(key)
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        cfg.exclude_dirs = dirs;
        obj.insert(
            key.to_string(),
            serde_json::to_value(&cfg).map_err(|e| e.to_string())?,
        );
        Ok(())
    })
}

// ── 工作区代码索引开关（codegraph_workspaces）──
//
// 按工作区键控的代码索引开关（取代旧的全局 settings.codegraphEnabled——每
// 工作区默认关，用户显式开启某工作区才建索引）。注意 key 用 trust_key_from_path
// 而非 lsp 在用的 path_to_key：信任白名单已实证同一工作区存在「带点号(4.0) /
// 横杠(4-0)」双编码形态，须归一塌缩（见 trust_key_from_path 上方注释）；
// lsp 用 path_to_key 是历史遗留，独立 section 互不串，不做顺手统一。

/// 读某工作区索引开关（缺省 false = 每工作区默认关；解析失败同样按关，安全侧）。
/// 入参必须是**已编码 key**（path_to_key / trust_key 任一形态均可，点号在此归一
/// 塌缩）；裸路径请走 `is_codegraph_enabled_for_path`，勿直接喂路径——
/// 路径分隔符不在归一范围，会算出不存在的键而静默按关。
pub fn codegraph_workspace_enabled(key: &str) -> bool {
    super::settings::load_state()
        .get("codegraph_workspaces")
        .and_then(|w| w.get(trust_key_from_key(key)))
        .and_then(|v| v.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// gate / chat.rs 下发 sidecar 共用的路径入口。
pub fn is_codegraph_enabled_for_path(path: &str) -> bool {
    codegraph_workspace_enabled(&trust_key_from_path(path))
}

/// 设某工作区索引开关。写 state JSON 的 codegraph_workspaces[key].enabled，
/// key 同样先过归一（幂等：横杠形态再归一不变）。
pub fn set_codegraph_enabled(key: &str, enabled: bool) -> Result<(), String> {
    let key = trust_key_from_key(key);
    super::settings::with_state_mut(|config| {
        let entry = config
            .as_object_mut()
            .ok_or("state not object")?
            .entry("codegraph_workspaces")
            .or_insert(serde_json::json!({}));
        entry
            .as_object_mut()
            .ok_or("codegraph_workspaces not object")?
            .insert(key, serde_json::json!({ "enabled": enabled }));
        Ok(())
    })
}

// ── 工作区 JDK（workspace_jdks）──
//
// 一个工作区 = 一个 JDK：Maven/Gradle 多模块项目是一次反应堆构建，只有启动
// mvn/gradle 的那一个 JDK，per-module 选 JDK 是错误粒度（2026-08-08 用户拍板）。
// 存 state JSON 的 workspace_jdks[key] = JDK home 路径；缺省 = 系统默认（PATH
// 里的 java，不注入）。key 与 lsp_workspaces 同为 path_to_key；run_configs.rs
// 的 encode_key 是同一变换，run 配置文件键与此处天然对齐。

/// 读某工作区选中的 JDK home（未选 → None = 系统默认）。
pub fn workspace_jdk(key: &str) -> Option<String> {
    let config = super::settings::load_state();
    config
        .get("workspace_jdks")
        .and_then(|w| w.get(key))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// 设某工作区 JDK。空路径 = 清除（回到系统默认），并把键从 map 里摘掉——
/// 不留空串死数据。
pub fn set_workspace_jdk(key: &str, jdk_home: &str) -> Result<(), String> {
    super::settings::with_state_mut(|config| {
        let entry = config
            .as_object_mut()
            .ok_or("state not object")?
            .entry("workspace_jdks")
            .or_insert(serde_json::json!({}));
        let obj = entry.as_object_mut().ok_or("workspace_jdks not object")?;
        if jdk_home.is_empty() {
            obj.remove(key);
        } else {
            obj.insert(
                key.to_string(),
                serde_json::Value::String(jdk_home.to_string()),
            );
        }
        Ok(())
    })
}

/// 读某工作区选中的 JDK home（未选 → 空串 = 系统默认）。轻量 state 读，
/// 与 workspace_get_lsp_excludes 同形（async + Result，无 spawn_blocking）。
#[tauri::command]
pub async fn workspace_get_jdk(workspace_root: String) -> Result<String, String> {
    let key = path_to_key(&workspace_root);
    Ok(workspace_jdk(&key).unwrap_or_default())
}

/// 设某工作区 JDK（空 = 系统默认）。前端选择器改动即调，run 进程启动时
/// 由前端读回合入 env（JAVA_HOME → shell.rs 前置 bin 到 PATH）。
#[tauri::command]
pub async fn workspace_set_jdk(workspace_root: String, jdk_home: String) -> Result<(), String> {
    let key = path_to_key(&workspace_root);
    set_workspace_jdk(&key, &jdk_home)
}

#[tauri::command]
pub async fn list_workspaces() -> Result<Vec<WorkspaceInfo>, String> {
    tokio::task::spawn_blocking(|| {
        let dir = claude_projects_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut workspaces = Vec::new();
        let read_dir =
            fs::read_dir(&dir).map_err(|e| format!("Failed to read projects dir: {}", e))?;
        for entry in read_dir {
            let Ok(entry) = entry else {
                continue;
            };
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let key = entry.file_name().to_string_lossy().to_string();
                let resolved = resolve_path_from_key(&key);
                let missing = resolved.is_none();
                let name = resolved.unwrap_or_else(|| key.clone());
                workspaces.push(WorkspaceInfo { key, name, missing });
            }
        }
        let hidden = hidden_keys(&super::settings::load_state());
        Ok(filter_hidden(workspaces, &hidden))
    })
    .await
    .map_err(|e| format!("list_workspaces panicked: {}", e))?
}

#[tauri::command]
pub fn set_workspace(
    workspace_state: State<'_, WorkspaceState>,
    key: String,
    path: String,
) -> Result<(), String> {
    {
        let mut k = workspace_state.key.lock().map_err(|e| e.to_string())?;
        *k = Some(key.clone());
    }
    {
        let mut p = workspace_state.path.lock().map_err(|e| e.to_string())?;
        *p = Some(PathBuf::from(path));
    }
    let _ = save_workspace_state(&key);
    Ok(())
}

#[tauri::command]
pub fn create_workspace(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<WorkspaceInfo, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("目录不存在: {}", path));
    }
    let key = path_to_key(&path);
    // 建编码目录（幂等：已存在不报错）
    let dir = claude_projects_dir().join(&key);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建工作区目录失败: {}", e))?;
    // 重新登记 = 自动从黑名单移除
    super::settings::with_state_mut(|config| {
        unhide_in_config(config, &key);
        Ok(())
    })?;
    // 激活（与 set_workspace 等价）
    {
        let mut k = workspace_state.key.lock().map_err(|e| e.to_string())?;
        *k = Some(key.clone());
    }
    {
        let mut pp = workspace_state.path.lock().map_err(|e| e.to_string())?;
        *pp = Some(PathBuf::from(path.clone()));
    }
    let _ = save_workspace_state(&key);
    Ok(WorkspaceInfo {
        key,
        name: path,
        missing: false,
    })
}

pub fn load_workspace_state() -> Option<String> {
    let config = super::settings::load_state();
    config
        .get("workspace")
        .and_then(|w| w.as_str())
        .map(|s| s.to_string())
}

fn save_workspace_state(path: &str) -> Result<(), String> {
    super::settings::with_state_mut(|config| {
        config["workspace"] = serde_json::Value::String(path.to_string());
        Ok(())
    })
}

#[tauri::command]
pub async fn remove_workspace(
    workspace_state: State<'_, WorkspaceState>,
    key: String,
    mode: String,
) -> Result<(), String> {
    match mode.as_str() {
        "hide" => {
            super::settings::with_state_mut(|config| {
                hide_in_config(config, &key);
                Ok(())
            })?;
        }
        "delete" => {
            let key_clone = key.clone();
            tokio::task::spawn_blocking(move || -> std::io::Result<()> {
                let dir = claude_projects_dir().join(&key_clone);
                if dir.exists() {
                    std::fs::remove_dir_all(&dir)?;
                }
                Ok(())
            })
            .await
            .map_err(|e| format!("删除任务失败: {}", e))?
            .map_err(|e| format!("删除目录失败: {}", e))?;
            // 已删，从黑名单移除（若曾被隐藏）
            super::settings::with_state_mut(|config| {
                unhide_in_config(config, &key);
                Ok(())
            })?;
        }
        _ => return Err(format!("invalid mode: {}", mode)),
    }
    // 若移除的是当前激活工作区，清空激活
    let is_active = workspace_state
        .key
        .lock()
        .map_err(|e| e.to_string())?
        .as_deref()
        == Some(&key);
    if is_active {
        {
            let mut k = workspace_state.key.lock().map_err(|e| e.to_string())?;
            *k = None;
        }
        {
            let mut p = workspace_state.path.lock().map_err(|e| e.to_string())?;
            *p = None;
        }
        super::settings::with_state_mut(|config| {
            clear_active_in_config(config);
            Ok(())
        })?;
    }
    Ok(())
}

#[tauri::command]
pub fn unhide_workspace(key: String) -> Result<(), String> {
    super::settings::with_state_mut(|config| {
        unhide_in_config(config, &key);
        Ok(())
    })
}

// ── 工作区信任（Trusted Workspace）Tauri 命令 ──
//
// 路径入参：前端始终拿得到路径（侧栏 ws.name、CodeGraph root），用路径作
// 身份可彻底回避前端侧的 key 编码问题；Rust 内部 trust_key_from_path 归一。
// 命令体只做轻量 state.json 读写，走 spawn_blocking 避免在 Tauri 主线程上
// 做文件 IO（与 list_workspaces / remove_workspace 的 async + spawn_blocking
// 一致）。

/// 当前路径的工作区是否已信任。
#[tauri::command]
pub async fn is_workspace_trusted(path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || is_path_trusted(&path))
        .await
        .map_err(|e| format!("is_workspace_trusted panicked: {}", e))
}

/// 信任一个工作区（按路径，归一后写入白名单）。信任即把安全只读命令白名单
/// （grep/cat/head…）幂等写入 local scope 并广播给 live 会话，返回新增条数。
/// 规则写入失败仅记日志，不因此拒信任（信任 key 是主动作）。
#[tauri::command]
pub async fn trust_workspace(
    path: String,
    settings: State<'_, Arc<SettingsService>>,
    runtime: State<'_, AgentRuntimeManager>,
) -> Result<usize, String> {
    let key = trust_key_from_path(&path);
    let project = PathBuf::from(&path);
    let project_for_write = project.clone();
    let service = settings.inner().clone();
    let service_for_write = service.clone();

    let added = tokio::task::spawn_blocking(
        move || -> Result<usize, String> {
            super::settings::with_state_mut(|config| {
                trust_in_config(config, &key);
                Ok(())
            })?;
            // 信任即备好 git 忽略（幂等，失败仅记日志，不因此拒信任）。
            ensure_aide_excluded(&project_for_write);
            // 信任即写入安全只读命令白名单（幂等）。失败仅记日志，按 0 处理。
            match super::permissions::ensure_safe_rules(&service_for_write, &project_for_write) {
                Ok(n) => Ok(n),
                Err(e) => {
                    tracing::warn!(?e, path = %project_for_write.display(), "trust_workspace: ensure_safe_rules failed");
                    Ok(0)
                }
            }
        },
    )
    .await
    .map_err(|e| format!("trust_workspace panicked: {e}"))??;

    runtime
        .broadcast_policy_change(SettingsScope::Local, Some(project.as_path()), &service)
        .await;
    Ok(added)
}

/// 取消信任一个工作区（按路径）。对称删除自动写入的安全规则并广播，返回删除条数。
/// 清理失败仅记日志，不因此拒取消信任。
#[tauri::command]
pub async fn untrust_workspace(
    path: String,
    settings: State<'_, Arc<SettingsService>>,
    runtime: State<'_, AgentRuntimeManager>,
) -> Result<usize, String> {
    let key = trust_key_from_path(&path);
    let project = PathBuf::from(&path);
    let project_for_write = project.clone();
    let service = settings.inner().clone();
    let service_for_write = service.clone();

    let removed = tokio::task::spawn_blocking(
        move || -> Result<usize, String> {
            super::settings::with_state_mut(|config| {
                untrust_in_config(config, &key);
                Ok(())
            })?;
            match super::permissions::remove_safe_rules(&service_for_write, &project_for_write) {
                Ok(n) => Ok(n),
                Err(e) => {
                    tracing::warn!(?e, path = %project_for_write.display(), "untrust_workspace: remove_safe_rules failed");
                    Ok(0)
                }
            }
        },
    )
    .await
    .map_err(|e| format!("untrust_workspace panicked: {e}"))??;

    runtime
        .broadcast_policy_change(SettingsScope::Local, Some(project.as_path()), &service)
        .await;
    Ok(removed)
}

// ── 工作区 LSP 开关 Tauri 命令 ──

#[tauri::command]
pub async fn workspace_set_lsp_enabled(
    workspace_root: String,
    enabled: bool,
) -> Result<(), String> {
    // 信任门：未信任工作区拒开 LSP（LSP 跑外部二进制 + 索引工作区，本就该走信任门）
    if enabled && !is_path_trusted(&workspace_root) {
        return Err("untrusted workspace".into());
    }
    let key = path_to_key(&workspace_root);
    set_lsp_enabled(&key, enabled)
}

#[tauri::command]
pub async fn workspace_set_lsp_excludes(
    workspace_root: String,
    dirs: Vec<String>,
) -> Result<(), String> {
    let key = path_to_key(&workspace_root);
    set_lsp_excludes(&key, dirs)?;
    // 改排除集 → 触发该工作区 server 重拉（init exclude 不支持热改）
    // 由前端调 lsp_shutdown_workspace 后下次 did_open 自然重拉；
    // 或在此 emit 信号。v1：返回 OK，前端 disable→enable LSP 完成重拉。
    Ok(())
}

/// 读某工作区 LSP 排除目录列表（spec T15 读路径补齐：UI 不再 write-only）。
/// 纯 config 读取，与 workspace_set_lsp_excludes 对称；async + Result 与其它
/// workspace_set_lsp_* 命令保持一致。
#[tauri::command]
pub async fn workspace_get_lsp_excludes(workspace_root: String) -> Result<Vec<String>, String> {
    let key = path_to_key(&workspace_root);
    Ok(lsp_workspace_config(&key).exclude_dirs)
}

// ── 工作区代码索引开关 Tauri 命令 ──

/// 读某工作区索引开关（桌面右栏「代码索引」面板渲染用）。
#[tauri::command]
pub async fn workspace_get_codegraph_enabled(workspace_root: String) -> Result<bool, String> {
    // state.json 读轻量，但与 is_workspace_trusted 同款走 spawn_blocking，
    // 命令体不碰文件 IO。
    tokio::task::spawn_blocking(move || is_codegraph_enabled_for_path(&workspace_root))
        .await
        .map_err(|e| format!("workspace_get_codegraph_enabled panicked: {e}"))
}

/// 设某工作区索引开关。**不设信任门**：开关只是「意向」记录，信任把关在
/// 建索引的门（gate::skip_reason + 前端 ensureIndex）——未信任工作区开了
/// 开关也能安全落盘，等信任后索引自然建起来（沿用既有 untrusted 通知流）。
#[tauri::command]
pub async fn workspace_set_codegraph_enabled(
    workspace_root: String,
    enabled: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        set_codegraph_enabled(&trust_key_from_path(&workspace_root), enabled)
    })
    .await
    .map_err(|e| format!("workspace_set_codegraph_enabled panicked: {e}"))?
}

pub fn resolve_path_from_key(key: &str) -> Option<String> {
    let mut chars = key.chars();
    let drive = chars.next()?;
    chars.next()?;
    chars.next()?;
    let rest: String = chars.collect();
    if rest.is_empty() {
        let path = format!("{}:\\", drive);
        return if PathBuf::from(&path).exists() {
            Some(path)
        } else {
            None
        };
    }
    try_decode(&format!("{}:\\", drive), &rest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::WorkspaceInfo;

    #[test]
    fn path_to_key_windows_path() {
        assert_eq!(path_to_key(r"C:\Users\yangx\proj"), "C--Users-yangx-proj");
    }

    #[test]
    fn path_to_key_unix_path() {
        assert_eq!(path_to_key("/Users/x/proj"), "-Users-x-proj");
    }

    #[test]
    fn path_to_key_preserves_other_chars() {
        // 空格、中文、点不替换
        assert_eq!(
            path_to_key(r"C:\my project\文档.git"),
            "C--my project-文档.git"
        );
    }

    // ── resolve_project_dirs：dot 归一匹配 ──

    #[test]
    fn resolve_project_dirs_matches_dot_normalized_variants() {
        let root = std::env::temp_dir().join("aide_ws_test_resolve_project_dirs");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // 同一工作区的两种编码：Aide 保留点号 / SDK 把点编码成横杠（chennong4.0 实锤案例）
        fs::create_dir_all(root.join("C--proj-chennong4.0")).unwrap();
        fs::create_dir_all(root.join("C--proj-chennong4-0")).unwrap();
        fs::create_dir_all(root.join("C--proj-other")).unwrap();

        let mut dirs = resolve_project_dirs(&root, "C--proj-chennong4.0");
        dirs.sort();
        assert_eq!(
            dirs,
            vec![
                root.join("C--proj-chennong4-0"),
                root.join("C--proj-chennong4.0")
            ]
        );

        // 反向 key（横杠版）同样命中两个目录
        assert_eq!(resolve_project_dirs(&root, "C--proj-chennong4-0").len(), 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_project_dirs_missing_projects_dir_returns_empty() {
        let root = std::env::temp_dir().join("aide_ws_test_resolve_missing");
        let _ = fs::remove_dir_all(&root);
        assert!(resolve_project_dirs(&root, "whatever").is_empty());
    }

    #[test]
    fn resolve_project_dirs_ignores_files() {
        let root = std::env::temp_dir().join("aide_ws_test_resolve_files");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("C--proj-x.0"), b"not a dir").unwrap();

        assert!(resolve_project_dirs(&root, "C--proj-x.0").is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn filter_hidden_empty_passthrough() {
        let infos = vec![sample("k1"), sample("k2")];
        let hidden: Vec<String> = vec![];
        assert_eq!(filter_hidden(infos, &hidden).len(), 2);
    }

    #[test]
    fn filter_hidden_filters_matching() {
        let infos = vec![sample("k1"), sample("k2"), sample("k3")];
        let hidden = vec!["k2".to_string()];
        let out = filter_hidden(infos, &hidden);
        assert_eq!(
            out.iter().map(|w| w.key.clone()).collect::<Vec<_>>(),
            vec!["k1", "k3"]
        );
    }

    #[test]
    fn filter_hidden_multiple() {
        let infos = vec![sample("a"), sample("b"), sample("c")];
        let hidden = vec!["a".to_string(), "c".to_string()];
        let out = filter_hidden(infos, &hidden);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].key, "b");
    }

    // ── Task 2: hiddenWorkspaces config 纯函数 ──

    #[test]
    fn hidden_keys_missing_field_returns_empty() {
        let cfg = serde_json::json!({});
        assert!(hidden_keys(&cfg).is_empty());
    }

    #[test]
    fn hidden_keys_reads_array() {
        let cfg = serde_json::json!({ "hiddenWorkspaces": ["a", "b"] });
        assert_eq!(hidden_keys(&cfg), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn hide_in_config_adds_key() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a"] });
        hide_in_config(&mut cfg, "b");
        assert_eq!(hidden_keys(&cfg), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn hide_in_config_idempotent() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a"] });
        hide_in_config(&mut cfg, "a");
        assert_eq!(hidden_keys(&cfg).len(), 1);
    }

    #[test]
    fn hide_in_config_creates_field_if_absent() {
        let mut cfg = serde_json::json!({});
        hide_in_config(&mut cfg, "x");
        assert_eq!(hidden_keys(&cfg), vec!["x".to_string()]);
    }

    #[test]
    fn unhide_in_config_removes_key() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a", "b"] });
        unhide_in_config(&mut cfg, "a");
        assert_eq!(hidden_keys(&cfg), vec!["b".to_string()]);
    }

    #[test]
    fn unhide_in_config_missing_key_noop() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a"] });
        unhide_in_config(&mut cfg, "zzz");
        assert_eq!(hidden_keys(&cfg), vec!["a".to_string()]);
    }

    #[test]
    fn clear_active_in_config_removes_workspace_field() {
        let mut cfg = serde_json::json!({ "workspace": "k1", "other": 1 });
        clear_active_in_config(&mut cfg);
        assert!(cfg.get("workspace").is_none());
        assert_eq!(cfg.get("other").and_then(|v| v.as_i64()), Some(1));
    }

    // ── 信任白名单 trustedWorkspaces 纯函数 ──

    #[test]
    fn trusted_keys_missing_field_returns_empty() {
        let cfg = serde_json::json!({});
        assert!(trusted_keys(&cfg).is_empty());
    }

    #[test]
    fn trusted_keys_reads_array() {
        let cfg = serde_json::json!({ "trustedWorkspaces": ["a", "b"] });
        assert_eq!(trusted_keys(&cfg), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn trust_in_config_adds_key() {
        let mut cfg = serde_json::json!({ "trustedWorkspaces": ["a"] });
        trust_in_config(&mut cfg, "b");
        assert_eq!(trusted_keys(&cfg), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn trust_in_config_idempotent() {
        let mut cfg = serde_json::json!({ "trustedWorkspaces": ["a"] });
        trust_in_config(&mut cfg, "a");
        assert_eq!(trusted_keys(&cfg).len(), 1);
    }

    #[test]
    fn trust_in_config_creates_field_if_absent() {
        let mut cfg = serde_json::json!({});
        trust_in_config(&mut cfg, "x");
        assert_eq!(trusted_keys(&cfg), vec!["x".to_string()]);
    }

    #[test]
    fn trust_in_config_preserves_other_state_fields() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["h"], "workspace": "k" });
        trust_in_config(&mut cfg, "x");
        assert_eq!(trusted_keys(&cfg), vec!["x".to_string()]);
        assert_eq!(hidden_keys(&cfg), vec!["h".to_string()]);
        assert_eq!(cfg.get("workspace").and_then(|v| v.as_str()), Some("k"));
    }

    #[test]
    fn untrust_in_config_removes_key() {
        let mut cfg = serde_json::json!({ "trustedWorkspaces": ["a", "b"] });
        untrust_in_config(&mut cfg, "a");
        assert_eq!(trusted_keys(&cfg), vec!["b".to_string()]);
    }

    #[test]
    fn untrust_in_config_missing_key_noop() {
        let mut cfg = serde_json::json!({ "trustedWorkspaces": ["a"] });
        untrust_in_config(&mut cfg, "zzz");
        assert_eq!(trusted_keys(&cfg), vec!["a".to_string()]);
    }

    // ── 信任键归一：点号 → 横杠 ──

    #[test]
    fn trust_key_from_path_dots_normalized() {
        // path_to_key 保留点号，trust_key_from_path 再把点号归一成横杠
        assert_eq!(
            trust_key_from_path(r"C:\proj\chennong4.0"),
            "C--proj-chennong4-0"
        );
    }

    #[test]
    fn trust_key_from_key_dots_normalized() {
        // 前端传来的 ws.key 可能是带点号的 path_to_key 版本
        assert_eq!(
            trust_key_from_key("C--proj-chennong4.0"),
            "C--proj-chennong4-0"
        );
    }

    #[test]
    fn trust_key_path_and_key_collapse_same_workspace() {
        // 同一工作区的「带点号 key」与「横杠版 key」归一后相等——dot 归一的核心
        // 保证：用 ws.key（任一形态）存、用 path_to_key(cwd) 查能对上。
        let via_path = trust_key_from_path(r"C:\proj\chennong4.0");
        let via_key_dashed = trust_key_from_key("C--proj-chennong4-0");
        let via_key_dotted = trust_key_from_key("C--proj-chennong4.0");
        assert_eq!(via_path, "C--proj-chennong4-0");
        assert_eq!(via_path, via_key_dashed);
        assert_eq!(via_path, via_key_dotted);
    }

    // ── LSP 工作区配置 ──

    #[test]
    fn lsp_workspace_config_defaults_when_absent() {
        let cfg = lsp_workspace_config("aide_test_nonexistent_key_xyz");
        assert!(!cfg.enabled);
        assert!(cfg.exclude_dirs.is_empty());
    }

    #[test]
    fn set_lsp_enabled_round_trips() {
        let key = "aide_test_set_enabled_xyz";
        set_lsp_enabled(key, true).unwrap();
        let cfg = lsp_workspace_config(key);
        assert!(cfg.enabled);
        // 清理
        set_lsp_enabled(key, false).unwrap();
    }

    #[test]
    fn set_lsp_excludes_round_trips() {
        let key = "aide_test_set_excludes_xyz";
        set_lsp_excludes(key, vec!["generated".into(), "vendor".into()]).unwrap();
        let cfg = lsp_workspace_config(key);
        assert_eq!(
            cfg.exclude_dirs,
            vec!["generated".to_string(), "vendor".to_string()]
        );
        // 清理
        set_lsp_excludes(key, vec![]).unwrap();
    }

    // ── 工作区代码索引开关 ──

    #[test]
    fn codegraph_workspace_enabled_defaults_false() {
        // 新语义核心：未设置的工作区默认关（每工作区显式开启才建索引）
        assert!(!codegraph_workspace_enabled("aide_test_cg_nonexistent_xyz"));
        assert!(!is_codegraph_enabled_for_path(
            r"C:\aide_test_cg_nonexistent_xyz"
        ));
    }

    #[test]
    fn set_codegraph_enabled_round_trips() {
        let key = "aide_test_cg_set_enabled_xyz";
        set_codegraph_enabled(key, true).unwrap();
        assert!(codegraph_workspace_enabled(key));
        // 关（显式 false，非缺席缺省）
        set_codegraph_enabled(key, false).unwrap();
        assert!(!codegraph_workspace_enabled(key));
    }

    #[test]
    fn set_codegraph_enabled_collapses_dotted_and_dashed_keys() {
        // 同一工作区双编码形态塌缩到同一信任键（用路径开、用带点号 key 查对得上）
        let root = r"C:\aide_test_cg_collapse\chennong4.0";
        let dotted = "C--aide_test_cg_collapse-chennong4.0";
        set_codegraph_enabled(&trust_key_from_path(root), true).unwrap();
        assert!(codegraph_workspace_enabled(dotted));
        set_codegraph_enabled(dotted, false).unwrap();
    }

    // ── 工作区 JDK ──

    #[test]
    fn workspace_jdk_absent_defaults_to_none() {
        assert_eq!(workspace_jdk("aide_test_jdk_nonexistent_xyz"), None);
    }

    #[test]
    fn set_workspace_jdk_round_trips_and_empty_clears() {
        let key = "aide_test_set_jdk_xyz";
        set_workspace_jdk(key, r"C:\Program Files\Java\jdk-21").unwrap();
        assert_eq!(
            workspace_jdk(key).as_deref(),
            Some(r"C:\Program Files\Java\jdk-21")
        );
        // 空 = 清除回系统默认，且键从 map 摘掉（不留空串死数据）
        set_workspace_jdk(key, "").unwrap();
        assert_eq!(workspace_jdk(key), None);
        let config = crate::commands::settings::load_state();
        let still_there = config
            .get("workspace_jdks")
            .and_then(|w| w.get(key))
            .is_some();
        assert!(
            !still_there,
            "empty set must remove the key from workspace_jdks"
        );
    }

    fn sample(key: &str) -> WorkspaceInfo {
        WorkspaceInfo {
            key: key.to_string(),
            name: key.to_string(),
            missing: false,
        }
    }
}

fn try_decode(prefix: &str, remaining: &str) -> Option<String> {
    for (i, ch) in remaining.char_indices() {
        if ch == '-' {
            let component = &remaining[..i];
            let candidate = format!("{}{}", prefix, component);
            if !component.is_empty() && PathBuf::from(&candidate).exists() {
                let next_prefix = format!("{}{}\\", prefix, component);
                if let Some(result) = try_decode(&next_prefix, &remaining[i + 1..]) {
                    return Some(result);
                }
            }
        }
    }
    let final_path = format!("{}{}", prefix, remaining);
    if PathBuf::from(&final_path).exists() {
        Some(final_path)
    } else {
        None
    }
}
