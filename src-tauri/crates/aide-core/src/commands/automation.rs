//! 自动化命令面。服务本体住 `Core::automation`；碰磁盘的一律经 `blocking` 离开异步线程。

use std::sync::Arc;

use serde::Deserialize;

use crate::registry::{blocking, Command as HostCommand};
use crate::{command, Core};

use crate::automation::{AutomationTask, AutomationTaskInput, PlaybookState, RunRecord, RunStats, RunTrigger};

pub static COMMANDS: &[HostCommand] = &[
    command!("list_automations", list_automations),
    command!("get_automation", get_automation),
    command!("create_automation", create_automation),
    command!("update_automation", update_automation),
    command!("delete_automation", delete_automation),
    command!("set_automation_enabled", set_automation_enabled),
    command!("list_automation_runs", list_automation_runs),
    command!("automation_run_stats", automation_run_stats),
    command!("run_automation_now", run_automation_now),
    command!("get_automation_playbook", get_automation_playbook),
    command!("redistill_automation", redistill_automation),
];


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAutomationsArgs {
}

async fn list_automations(core: Arc<Core>, a: ListAutomationsArgs) -> Result<Vec<AutomationTask>, String> {
    let _ = a;
    let svc = core.automation.clone();
    blocking(move || -> Result<Vec<AutomationTask>, String> {
    Ok(svc.list_tasks())
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAutomationArgs {
    id: String,
}

async fn get_automation(core: Arc<Core>, a: GetAutomationArgs) -> Result<AutomationTask, String> {
    let GetAutomationArgs { id } = a;
    let svc = core.automation.clone();
    blocking(move || -> Result<AutomationTask, String> {
    svc.get_task(&id)
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAutomationArgs {
    input: AutomationTaskInput,
}

async fn create_automation(core: Arc<Core>, a: CreateAutomationArgs) -> Result<AutomationTask, String> {
    let CreateAutomationArgs { input } = a;
    let svc = core.automation.clone();
    let svc = svc.clone();
    tokio::task::spawn_blocking(move || svc.create_task(input))
        .await
        .map_err(|e| format!("create_automation task panicked: {e}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAutomationArgs {
    id: String,
    input: AutomationTaskInput,
}

async fn update_automation(core: Arc<Core>, a: UpdateAutomationArgs) -> Result<AutomationTask, String> {
    let UpdateAutomationArgs { id, input } = a;
    let svc = core.automation.clone();
    let svc = svc.clone();
    tokio::task::spawn_blocking(move || svc.update_task(&id, input))
        .await
        .map_err(|e| format!("update_automation task panicked: {e}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAutomationArgs {
    id: String,
}

async fn delete_automation(core: Arc<Core>, a: DeleteAutomationArgs) -> Result<(), String> {
    let DeleteAutomationArgs { id } = a;
    let svc = core.automation.clone();
    let svc = svc.clone();
    tokio::task::spawn_blocking(move || svc.delete_task(&id))
        .await
        .map_err(|e| format!("delete_automation task panicked: {e}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAutomationEnabledArgs {
    id: String,
    enabled: bool,
}

async fn set_automation_enabled(core: Arc<Core>, a: SetAutomationEnabledArgs) -> Result<AutomationTask, String> {
    let SetAutomationEnabledArgs { id, enabled } = a;
    let svc = core.automation.clone();
    let svc = svc.clone();
    tokio::task::spawn_blocking(move || svc.set_enabled(&id, enabled))
        .await
        .map_err(|e| format!("set_automation_enabled task panicked: {e}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAutomationRunsArgs {
    id: String,
    #[serde(default)]
    limit: Option<u32>,
}

async fn list_automation_runs(core: Arc<Core>, a: ListAutomationRunsArgs) -> Result<Vec<RunRecord>, String> {
    let ListAutomationRunsArgs { id, limit } = a;
    let svc = core.automation.clone();
    let svc = svc.clone();
    tokio::task::spawn_blocking(move || svc.list_runs(&id, limit.unwrap_or(100) as usize))
        .await
        .map_err(|e| format!("list_automation_runs task panicked: {e}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunStatsArgs {
    id: String,
}

async fn automation_run_stats(core: Arc<Core>, a: AutomationRunStatsArgs) -> Result<RunStats, String> {
    let AutomationRunStatsArgs { id } = a;
    let svc = core.automation.clone();
    let svc = svc.clone();
    tokio::task::spawn_blocking(move || svc.run_stats(&id))
        .await
        .map_err(|e| format!("automation_run_stats task panicked: {e}"))?
}

/// 立即运行一次（不碰调度网格）。返回运行中的记录；正在运行返回 Err。
/// start_run 内部做小文件落盘（元数据/运行记录）+ async send，不开 blocking。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAutomationNowArgs {
    id: String,
}

async fn run_automation_now(core: Arc<Core>, a: RunAutomationNowArgs) -> Result<RunRecord, String> {
    let RunAutomationNowArgs { id } = a;
    let svc = core.automation.clone();
    let svc = svc.clone();
    svc.start_run(&id, RunTrigger::Manual).await
}

/// 读执行手册内容（None = 尚未生成，前端显示空态）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAutomationPlaybookArgs {
    id: String,
}

async fn get_automation_playbook(core: Arc<Core>, a: GetAutomationPlaybookArgs) -> Result<Option<String>, String> {
    let GetAutomationPlaybookArgs { id } = a;
    let svc = core.automation.clone();
    let svc = svc.clone();
    tokio::task::spawn_blocking(move || svc.read_playbook(&id))
        .await
        .map_err(|e| format!("get_automation_playbook task panicked: {e}"))?
}

/// 标记手册待重新提炼：下次运行按探索模式执行并重新蒸馏。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedistillAutomationArgs {
    id: String,
}

async fn redistill_automation(core: Arc<Core>, a: RedistillAutomationArgs) -> Result<AutomationTask, String> {
    let RedistillAutomationArgs { id } = a;
    let svc = core.automation.clone();
    let svc = svc.clone();
    tokio::task::spawn_blocking(move || svc.set_playbook_state(&id, PlaybookState::Stale))
        .await
        .map_err(|e| format!("redistill_automation task panicked: {e}"))?
}
