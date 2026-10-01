//! 工作区：显式注册表（侧栏列表的数据源）、活动工作区、信任白名单、每工作区开关（LSP /
//! 索引 / JDK）、@目录授权裁定、日常工作区。全部是 Host 数据（state.json + 项目目录）。

use std::path::PathBuf;

use serde::Serialize;

use crate::paths::claude_projects_dir;
#[allow(unused_imports)]
use crate::registry::{blocking, Command as HostCommand};
use crate::{command, Core};
use serde::Deserialize;
use std::sync::Arc;

pub static COMMANDS: &[HostCommand] = &[
    command!("workspace_get_jdk", workspace_get_jdk),
    command!("workspace_set_jdk", workspace_set_jdk),
    command!("list_workspaces", list_workspaces),
    command!("daily_workspace", daily_workspace),
    command!("get_active_workspace", get_active_workspace),
    command!("set_workspace", set_workspace),
    command!("create_workspace", create_workspace),
    command!("remove_workspace", remove_workspace),
    command!("unhide_workspace", unhide_workspace),
    command!("is_workspace_trusted", is_workspace_trusted),
    command!("workspace_set_lsp_enabled", workspace_set_lsp_enabled),
    command!("workspace_set_lsp_excludes", workspace_set_lsp_excludes),
    command!("workspace_get_lsp_excludes", workspace_get_lsp_excludes),
    command!("workspace_get_codegraph_enabled", workspace_get_codegraph_enabled),
    command!("workspace_set_codegraph_enabled", workspace_set_codegraph_enabled),
];


#[derive(Debug, Serialize, Clone)]
pub struct WorkspaceInfo {
    pub key: String,
    pub name: String,
    pub missing: bool,
}


// ── 子实现层 ──
// git_exclude：信任 / 索引激活时把 `.aide/` 幂等写入仓库 .git/info/exclude，
// 防 Aide 本地状态污染 git status。设计取舍见子模块头部注释。
mod git_exclude;
pub use git_exclude::ensure_aide_excluded;

// registry：显式注册表（list_workspaces 的数据源）。纯核心只吃 Value + &str，
// IO 谓词/时钟由外壳注入。设计取舍全记录：
// docs/superpowers/plans/2026-09-07-workspace-explicit-registry.md
mod registry;
// 包外公面只暴露真实消费者（M4）：delete_transcript_dirs / RegisteredWorkspace /
// registered 仅本模块树内部消费，走 registry:: 直呼，不再 re-export。
pub use registry::{
    ensure_registry_migrated, ensure_workspace_registered, infos_from_registry,
    normalize_registration_path, register_in_config, registered_path_for_key, unregister_in_config,
};

// attach：@目录 授权的裁定（只认已注册工作区本身或其子目录）。纯核心
// `resolve_with_registry` 直喂注册表单测，IO 外壳 `resolve_attach_dirs` 读 state.json。
// 落位与判据见 docs/superpowers/plans/2026-09-17-cross-directory-session.md
pub mod attach;

// daily：「日常」模式的底层工作区（内部目录，对 UI 隐身）。纯路径逻辑与 IO 外壳
// 分开，理由见子模块头。设计取舍见
// docs/superpowers/specs/2026-09-20-daily-mode-design.md
pub mod daily;



// 路径 → 项目目录编码 key 与多目录解析：Claude CLI 的转录目录规则，桌面与远程 aide-host
// 共用 aide-workspace 里的同一份（远程会话的转录在目标机上按同一规则落盘）。
pub use aide_workspace::transcripts::{path_to_key, resolve_project_dirs};

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
    trusted_keys(&crate::app_settings::load_state()).contains(&trust_key_from_path(path))
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
    let config = crate::app_settings::load_state();
    config
        .get("lsp_workspaces")
        .and_then(|w| w.get(key))
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// 设某工作区 LSP 开关。写 state JSON 的 lsp_workspaces[key].enabled。
pub fn set_lsp_enabled(key: &str, enabled: bool) -> Result<(), String> {
    crate::app_settings::with_state_mut(|config| {
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
    crate::app_settings::with_state_mut(|config| {
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
    crate::app_settings::load_state()
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
    crate::app_settings::with_state_mut(|config| {
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
    let config = crate::app_settings::load_state();
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
    crate::app_settings::with_state_mut(|config| {
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGetJdkArgs {
    workspace_root: String,
}

async fn workspace_get_jdk(_core: Arc<Core>, a: WorkspaceGetJdkArgs) -> Result<String, String> {
    let WorkspaceGetJdkArgs { workspace_root } = a;
    let key = path_to_key(&workspace_root);
    Ok(workspace_jdk(&key).unwrap_or_default())
}

/// 设某工作区 JDK（空 = 系统默认）。前端选择器改动即调，run 进程启动时
/// 由前端读回合入 env（JAVA_HOME → shell.rs 前置 bin 到 PATH）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSetJdkArgs {
    workspace_root: String,
    jdk_home: String,
}

async fn workspace_set_jdk(_core: Arc<Core>, a: WorkspaceSetJdkArgs) -> Result<(), String> {
    let WorkspaceSetJdkArgs { workspace_root, jdk_home } = a;
    let key = path_to_key(&workspace_root);
    set_workspace_jdk(&key, &jdk_home)
}

/// 工作区列表 = 显式注册表（state.json `registeredWorkspaces`，见子模块
/// registry）。登记制下内部目录在结构上不可能混进侧栏；name 恒为注册的真实
/// 路径，missing = 路径磁盘不存在（准确信号）。扫描 + hiddenWorkspaces 过滤
/// + try_decode 反向解码随旧机制一并退役（hiddenWorkspaces 仅存于迁移跳过
/// 与 remove-hide 的降级兼容写）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspacesArgs {
}

async fn list_workspaces(_core: Arc<Core>, a: ListWorkspacesArgs) -> Result<Vec<WorkspaceInfo>, String> {
    let _ = a;
    tokio::task::spawn_blocking(|| {
        let config = crate::app_settings::load_state();
        let daily = daily::daily_path_in(&crate::paths::our_config_dir());
        let mut infos = infos_from_registry(&config, |p| {
            crate::workspace::present(std::path::Path::new(p))
        });
        // 日常目录存在且已注册（它是 cwd / 信任 / 记忆目录的锚），但它不是用户要管理
        // 的项目：从所有工作区列表（侧栏分区、WorkspacePicker）里剔除。唯一过滤点，
        // 渲染期不要再滤一次。设计见 docs/superpowers/specs/2026-09-20-daily-mode-design.md
        infos.retain(|w| !daily::is_daily_path(&daily, &w.name));
        Ok(infos)
    })
    .await
    .map_err(|e| format!("list_workspaces panicked: {}", e))?
}

/// 日常模式的归属（key + path）。给前端做「这个会话是不是日常」的判定与落点绑定用。
///
/// 纯计算无 IO：路径由配置目录推出，key 与注册时走同一条链（normalize → path_to_key），
/// 故无需读 state、也无需 spawn_blocking（同步命令不碰 IO，不触发 check:sync-io 守卫）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyWorkspaceArgs {
}

async fn daily_workspace(_core: Arc<Core>, a: DailyWorkspaceArgs) -> Result<DailyWorkspace, String> {
    let _ = a;
    blocking(move || -> Result<DailyWorkspace, String> { Ok((|| -> DailyWorkspace {
    let dir = daily::daily_path_in(&crate::paths::our_config_dir());
    let path = normalize_registration_path(&dir.to_string_lossy());
    let key = path_to_key(&path);
    DailyWorkspace { key, path }
})()) }).await
}

#[derive(serde::Serialize)]
pub struct DailyWorkspace {
    pub key: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkspaceArgs {
    key: String,
    path: String,
}

async fn set_workspace(core: Arc<Core>, a: SetWorkspaceArgs) -> Result<(), String> {
    let SetWorkspaceArgs { key, path } = a;
    let workspace_state = core.workspace.clone();
    blocking(move || -> Result<(), String> {
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
}).await
}

/// 登记一个磁盘目录为工作区并立即切换（显式注册的主入口）。
/// 幂等：dup-key 再登记不动既有条目（path 主人是先登记者），仅补激活。
/// 注册不伪造目录（删旧 create_dir_all）：SDK 实际写的是横杠形态编码目录，
/// sessions 扫描对缺失目录已有容错（计划 D7）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceArgs {
    path: String,
}

async fn create_workspace(core: Arc<Core>, a: CreateWorkspaceArgs) -> Result<WorkspaceInfo, String> {
    let CreateWorkspaceArgs { path } = a;
    let workspace_state = core.workspace.clone();
    blocking(move || -> Result<WorkspaceInfo, String> {
    // normalize 先行：注册表条目、激活 key、返回的 WorkspaceInfo 三者同源
    let path = normalize_registration_path(&path);
    let p = std::path::Path::new(&path);
    // 远程路径（WSL / SSH）的存在性由目录选择器经目标机确认过，这里不做本机 stat
    if !crate::workspace::present(p) {
        return Err(format!("目录不存在: {}", path));
    }
    let key = path_to_key(&path);
    // 登记（幂等）+ 重新登记 = 自动从黑名单移除（降级兼容清理）。登记后校验
    // 条目确实在表：register false 的段损坏分支如实报错（激活一个未注册的
    // 工作区会让侧栏静默缺失），dup 竞态良性放行（rust-reviewer 违反项 2 同形）。
    crate::app_settings::with_state_mut(|config| {
        register_in_config(config, &path, registry::now_ms());
        if registered_path_for_key(config, &key).is_none() {
            return Err(format!(
                "登记失败：registeredWorkspaces 段损坏（非数组）？path={path}"
            ));
        }
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
}).await
}

pub fn load_workspace_state() -> Option<String> {
    let config = crate::app_settings::load_state();
    config
        .get("workspace")
        .and_then(|w| w.as_str())
        .map(|s| s.to_string())
}

fn save_workspace_state(path: &str) -> Result<(), String> {
    crate::app_settings::with_state_mut(|config| {
        config["workspace"] = serde_json::Value::String(path.to_string());
        Ok(())
    })
}

/// 移除工作区：hide = 摘出注册表（转录保留）+ 黑名单兼容写（降级容忍 D5）；
/// delete = 摘出注册表 + 变体转录目录全删（D8 加固）。若移除的是当前激活
/// 工作区，清空激活态。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWorkspaceArgs {
    key: String,
    mode: String,
}

async fn remove_workspace(core: Arc<Core>, a: RemoveWorkspaceArgs) -> Result<(), String> {
    let RemoveWorkspaceArgs { key, mode } = a;
    let workspace_state = core.workspace.clone();
    match mode.as_str() {
        "hide" => {
            crate::app_settings::with_state_mut(|config| {
                unregister_in_config(config, &key);
                hide_in_config(config, &key);
                Ok(())
            })?;
        }
        "delete" => {
            let key_clone = key.clone();
            tokio::task::spawn_blocking(move || -> std::io::Result<usize> {
                registry::delete_transcript_dirs(&claude_projects_dir(), &key_clone)
            })
            .await
            .map_err(|e| format!("删除任务失败: {}", e))?
            .map_err(|e| format!("删除目录失败: {}", e))?;
            // 已摘表，从黑名单移除（若曾被隐藏）
            crate::app_settings::with_state_mut(|config| {
                unregister_in_config(config, &key);
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
        crate::app_settings::with_state_mut(|config| {
            clear_active_in_config(config);
            Ok(())
        })?;
    }
    Ok(())
}

/// 重新显示（重登记）一个工作区：按 key 解码回真实 path 后登记；顺带清
/// 黑名单兼容位。解码失败（目标已不存在）静默 ok——list 不再读黑名单，
/// 此命令仅服务降级窗口，尽力而为语义不变。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnhideWorkspaceArgs {
    key: String,
}

async fn unhide_workspace(_core: Arc<Core>, a: UnhideWorkspaceArgs) -> Result<(), String> {
    let UnhideWorkspaceArgs { key } = a;
    blocking(move || -> Result<(), String> {
    crate::app_settings::with_state_mut(|config| {
        match resolve_path_from_key(&key) {
            Some(path) => {
                register_in_config(config, &path, registry::now_ms());
                // 段损坏时登记被拒：尽力而为语义下不报错，但留痕（降级窗口命令）
                if registered_path_for_key(config, &path_to_key(&path)).is_none() {
                    tracing::warn!(key = %key, "unhide_workspace: 登记被拒（registeredWorkspaces 段损坏？）");
                }
            }
            None => {
                tracing::warn!(key = %key, "unhide_workspace: key 解码失败，仅清兼容位");
            }
        }
        unhide_in_config(config, &key);
        Ok(())
    })
}).await
}

// ── 工作区信任（Trusted Workspace）Tauri 命令 ──
//
// 路径入参：前端始终拿得到路径（侧栏 ws.name、CodeGraph root），用路径作
// 身份可彻底回避前端侧的 key 编码问题；Rust 内部 trust_key_from_path 归一。
// 命令体只做轻量 state.json 读写，走 spawn_blocking 避免在 Tauri 主线程上
// 做文件 IO（与 list_workspaces / remove_workspace 的 async + spawn_blocking
// 一致）。

/// 当前路径的工作区是否已信任。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsWorkspaceTrustedArgs {
    path: String,
}

async fn is_workspace_trusted(_core: Arc<Core>, a: IsWorkspaceTrustedArgs) -> Result<bool, String> {
    let IsWorkspaceTrustedArgs { path } = a;
    tokio::task::spawn_blocking(move || is_path_trusted(&path))
        .await
        .map_err(|e| format!("is_workspace_trusted panicked: {}", e))
}

// ── 工作区 LSP 开关 Tauri 命令 ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSetLspEnabledArgs {
    workspace_root: String,
    enabled: bool,
}

async fn workspace_set_lsp_enabled(_core: Arc<Core>, a: WorkspaceSetLspEnabledArgs) -> Result<(), String> {
    let WorkspaceSetLspEnabledArgs { workspace_root, enabled } = a;
    // 信任门：未信任工作区拒开 LSP（LSP 跑外部二进制 + 索引工作区，本就该走信任门）
    if enabled && !is_path_trusted(&workspace_root) {
        return Err("untrusted workspace".into());
    }
    let key = path_to_key(&workspace_root);
    set_lsp_enabled(&key, enabled)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSetLspExcludesArgs {
    workspace_root: String,
    dirs: Vec<String>,
}

async fn workspace_set_lsp_excludes(_core: Arc<Core>, a: WorkspaceSetLspExcludesArgs) -> Result<(), String> {
    let WorkspaceSetLspExcludesArgs { workspace_root, dirs } = a;
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGetLspExcludesArgs {
    workspace_root: String,
}

async fn workspace_get_lsp_excludes(_core: Arc<Core>, a: WorkspaceGetLspExcludesArgs) -> Result<Vec<String>, String> {
    let WorkspaceGetLspExcludesArgs { workspace_root } = a;
    let key = path_to_key(&workspace_root);
    Ok(lsp_workspace_config(&key).exclude_dirs)
}

// ── 工作区代码索引开关 Tauri 命令 ──

/// 读某工作区索引开关（桌面右栏「代码索引」面板渲染用）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGetCodegraphEnabledArgs {
    workspace_root: String,
}

async fn workspace_get_codegraph_enabled(_core: Arc<Core>, a: WorkspaceGetCodegraphEnabledArgs) -> Result<bool, String> {
    let WorkspaceGetCodegraphEnabledArgs { workspace_root } = a;
    // state.json 读轻量，但与 is_workspace_trusted 同款走 spawn_blocking，
    // 命令体不碰文件 IO。
    tokio::task::spawn_blocking(move || is_codegraph_enabled_for_path(&workspace_root))
        .await
        .map_err(|e| format!("workspace_get_codegraph_enabled panicked: {e}"))
}

/// 设某工作区索引开关。**不设信任门**：开关只是「意向」记录，信任把关在
/// 建索引的门（gate::skip_reason + 前端 ensureIndex）——未信任工作区开了
/// 开关也能安全落盘，等信任后索引自然建起来（沿用既有 untrusted 通知流）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSetCodegraphEnabledArgs {
    workspace_root: String,
    enabled: bool,
}

async fn workspace_set_codegraph_enabled(_core: Arc<Core>, a: WorkspaceSetCodegraphEnabledArgs) -> Result<(), String> {
    let WorkspaceSetCodegraphEnabledArgs { workspace_root, enabled } = a;
    tokio::task::spawn_blocking(move || {
        set_codegraph_enabled(&trust_key_from_path(&workspace_root), enabled)
    })
    .await
    .map_err(|e| format!("workspace_set_codegraph_enabled panicked: {e}"))?
}

/// 编码 key → 真实路径（`path_to_key` 的逆，旧数据回退用）。编码把分隔符与 `:` 都变成 `-`，
/// 有歧义（目录名本身可含 `-`），故逐段试探磁盘上真实存在的前缀。两种形态：
/// - Windows：`C--Users-me-proj` → `C:\Users\me\proj`
/// - Unix：`-home-me-proj` → `/home/me/proj`（远程 Host 跑在 Linux 上，必须认得）
pub fn resolve_path_from_key(key: &str) -> Option<String> {
    if let Some(rest) = key.strip_prefix('-') {
        return if rest.is_empty() {
            Some("/".to_string())
        } else {
            try_decode("/", rest, '/')
        };
    }
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
    try_decode(&format!("{}:\\", drive), &rest, '\\')
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── filter_hidden 随扫描机制退役（list 换注册表源，唯一调用方消失，死代码删除）──
    // hiddenWorkspaces 纯函数（hidden_keys/hide_in_config/unhide_in_config）保留：
    // 迁移跳过与 remove-hide 降级兼容写仍在消费。

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
    fn resolve_path_from_key_decodes_unix_keys() {
        let dir = std::env::temp_dir().join("aide-decode-unix-probe");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();
        if path.starts_with('/') {
            assert_eq!(resolve_path_from_key(&path_to_key(&path)).as_deref(), Some(path.as_str()));
        }
        let _ = std::fs::remove_dir_all(&dir);
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
        let config = crate::app_settings::load_state();
        let still_there = config
            .get("workspace_jdks")
            .and_then(|w| w.get(key))
            .is_some();
        assert!(
            !still_there,
            "empty set must remove the key from workspace_jdks"
        );
    }
}

fn try_decode(prefix: &str, remaining: &str, sep: char) -> Option<String> {
    for (i, ch) in remaining.char_indices() {
        if ch == '-' {
            let component = &remaining[..i];
            let candidate = format!("{}{}", prefix, component);
            if !component.is_empty() && PathBuf::from(&candidate).exists() {
                let next_prefix = format!("{prefix}{component}{sep}");
                if let Some(result) = try_decode(&next_prefix, &remaining[i + 1..], sep) {
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

/// 活动工作区快照：key 与 `list_workspaces` 的 key 同源（编码键），path 为解码路径；未设置工作区
/// 序列化为 null。纯状态读取、无 IO。远程客户端（手机）据此给「跟随桌面」槽位解析真名——
/// 只读不写，活动工作区仍由 Host 自己管理。
#[derive(serde::Serialize)]
pub struct ActiveWorkspace {
    pub key: String,
    pub path: String,
}

async fn get_active_workspace(core: Arc<Core>, _: crate::commands::NoArgs) -> Result<Option<ActiveWorkspace>, String> {
    let key = core.workspace.key.lock().map_err(|e| e.to_string())?.clone();
    let path = core.workspace.path.lock().map_err(|e| e.to_string())?.clone();
    Ok(match (key, path) {
        (Some(key), Some(path)) => Some(ActiveWorkspace { key, path: path.to_string_lossy().to_string() }),
        _ => None,
    })
}
