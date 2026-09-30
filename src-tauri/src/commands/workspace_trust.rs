//! 信任 / 取消信任工作区：写信任白名单与安全只读规则后，要把新策略**广播给运行中的会话**
//! （`AgentRuntimeManager`）。runtime 在 Host 模型 P0-4 迁入 aide-core 前，这两条命令留在桌面；
//! 信任数据本身的读写都在 `aide_core::commands::workspace`。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use crate::commands::workspace::{ensure_aide_excluded, trust_in_config, trust_key_from_path, untrust_in_config};
use crate::runtime::AgentRuntimeManager;
use crate::settings::{SettingsScope, SettingsService};

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
            crate::commands::settings::with_state_mut(|config| {
                trust_in_config(config, &key);
                Ok(())
            })?;
            // 信任即备好 git 忽略（幂等，失败仅记日志，不因此拒信任）。
            ensure_aide_excluded(&project_for_write);
            // 信任即写入安全只读命令白名单（幂等）。失败仅记日志，按 0 处理。
            match crate::commands::permissions::ensure_safe_rules(&service_for_write, &project_for_write) {
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
            crate::commands::settings::with_state_mut(|config| {
                untrust_in_config(config, &key);
                Ok(())
            })?;
            match crate::commands::permissions::remove_safe_rules(&service_for_write, &project_for_write) {
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

