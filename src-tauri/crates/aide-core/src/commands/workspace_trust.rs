//! 信任 / 取消信任工作区：写信任白名单与安全只读规则后，要把新策略**广播给运行中的会话**
//! （`Core::runtime`）。信任数据本身的读写在 `commands::workspace`。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;

use crate::registry::Command as HostCommand;
use crate::{command, Core};


use crate::commands::workspace::{ensure_aide_excluded, trust_in_config, trust_key_from_path, untrust_in_config};
use crate::settings::SettingsScope;

pub static COMMANDS: &[HostCommand] = &[
    command!("trust_workspace", trust_workspace),
    command!("untrust_workspace", untrust_workspace),
];

/// 信任一个工作区（按路径，归一后写入白名单）。信任即把安全只读命令白名单
/// （grep/cat/head…）幂等写入 local scope 并广播给 live 会话，返回新增条数。
/// 规则写入失败仅记日志，不因此拒信任（信任 key 是主动作）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustWorkspaceArgs {
    path: String,
}

async fn trust_workspace(core: Arc<Core>, a: TrustWorkspaceArgs) -> Result<usize, String> {
    let TrustWorkspaceArgs { path } = a;
    let settings = core.settings.clone();
    let runtime = &core.runtime;
    {
    let key = trust_key_from_path(&path);
    let project = PathBuf::from(&path);
    let project_for_write = project.clone();
    let service = settings.clone();
    let service_for_write = service.clone();

    let added = tokio::task::spawn_blocking(
        move || -> Result<usize, String> {
            crate::app_settings::with_state_mut(|config| {
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
}


/// 取消信任一个工作区（按路径）。对称删除自动写入的安全规则并广播，返回删除条数。
/// 清理失败仅记日志，不因此拒取消信任。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UntrustWorkspaceArgs {
    path: String,
}

async fn untrust_workspace(core: Arc<Core>, a: UntrustWorkspaceArgs) -> Result<usize, String> {
    let UntrustWorkspaceArgs { path } = a;
    let settings = core.settings.clone();
    let runtime = &core.runtime;
    {
    let key = trust_key_from_path(&path);
    let project = PathBuf::from(&path);
    let project_for_write = project.clone();
    let service = settings.clone();
    let service_for_write = service.clone();

    let removed = tokio::task::spawn_blocking(
        move || -> Result<usize, String> {
            crate::app_settings::with_state_mut(|config| {
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
}

