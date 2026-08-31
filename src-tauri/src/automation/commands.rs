//! 自动化命令面。约定（CLAUDE.md 同步命令红线）：
//! - `list_automations` / `get_automation` 是纯内存读 → 保持同步轻命令（不埋 trace_command，埋了是噪音）
//! - 其余全部碰磁盘 → async + spawn_blocking；State 是 Arc，clone 后 move 进闭包
//! - async 命令带 State 引用参数，按 Tauri v2 约束必须返回 Result

use std::sync::Arc;

use tauri::State;

use super::scheduler::AutomationService;
use super::{AutomationTask, AutomationTaskInput, PlaybookState, RunRecord, RunStats, RunTrigger};

#[tauri::command]
pub fn list_automations(
    svc: State<'_, Arc<AutomationService>>,
) -> Result<Vec<AutomationTask>, String> {
    Ok(svc.list_tasks())
}

#[tauri::command]
pub fn get_automation(
    svc: State<'_, Arc<AutomationService>>,
    id: String,
) -> Result<AutomationTask, String> {
    svc.get_task(&id)
}

#[tauri::command]
pub async fn create_automation(
    svc: State<'_, Arc<AutomationService>>,
    input: AutomationTaskInput,
) -> Result<AutomationTask, String> {
    let svc = svc.inner().clone();
    tokio::task::spawn_blocking(move || svc.create_task(input))
        .await
        .map_err(|e| format!("create_automation task panicked: {e}"))?
}

#[tauri::command]
pub async fn update_automation(
    svc: State<'_, Arc<AutomationService>>,
    id: String,
    input: AutomationTaskInput,
) -> Result<AutomationTask, String> {
    let svc = svc.inner().clone();
    tokio::task::spawn_blocking(move || svc.update_task(&id, input))
        .await
        .map_err(|e| format!("update_automation task panicked: {e}"))?
}

#[tauri::command]
pub async fn delete_automation(
    svc: State<'_, Arc<AutomationService>>,
    id: String,
) -> Result<(), String> {
    let svc = svc.inner().clone();
    tokio::task::spawn_blocking(move || svc.delete_task(&id))
        .await
        .map_err(|e| format!("delete_automation task panicked: {e}"))?
}

#[tauri::command]
pub async fn set_automation_enabled(
    svc: State<'_, Arc<AutomationService>>,
    id: String,
    enabled: bool,
) -> Result<AutomationTask, String> {
    let svc = svc.inner().clone();
    tokio::task::spawn_blocking(move || svc.set_enabled(&id, enabled))
        .await
        .map_err(|e| format!("set_automation_enabled task panicked: {e}"))?
}

#[tauri::command]
pub async fn list_automation_runs(
    svc: State<'_, Arc<AutomationService>>,
    id: String,
    limit: Option<u32>,
) -> Result<Vec<RunRecord>, String> {
    let svc = svc.inner().clone();
    tokio::task::spawn_blocking(move || svc.list_runs(&id, limit.unwrap_or(100) as usize))
        .await
        .map_err(|e| format!("list_automation_runs task panicked: {e}"))?
}

#[tauri::command]
pub async fn automation_run_stats(
    svc: State<'_, Arc<AutomationService>>,
    id: String,
) -> Result<RunStats, String> {
    let svc = svc.inner().clone();
    tokio::task::spawn_blocking(move || svc.run_stats(&id))
        .await
        .map_err(|e| format!("automation_run_stats task panicked: {e}"))?
}

/// 立即运行一次（不碰调度网格）。返回运行中的记录；正在运行返回 Err。
/// start_run 内部做小文件落盘（元数据/运行记录）+ async send，不开 blocking。
#[tauri::command]
pub async fn run_automation_now(
    svc: State<'_, Arc<AutomationService>>,
    id: String,
) -> Result<RunRecord, String> {
    let svc = svc.inner().clone();
    svc.start_run(&id, RunTrigger::Manual).await
}

/// 读执行手册内容（None = 尚未生成，前端显示空态）。
#[tauri::command]
pub async fn get_automation_playbook(
    svc: State<'_, Arc<AutomationService>>,
    id: String,
) -> Result<Option<String>, String> {
    let svc = svc.inner().clone();
    tokio::task::spawn_blocking(move || svc.read_playbook(&id))
        .await
        .map_err(|e| format!("get_automation_playbook task panicked: {e}"))?
}

/// 标记手册待重新提炼：下次运行按探索模式执行并重新蒸馏。
#[tauri::command]
pub async fn redistill_automation(
    svc: State<'_, Arc<AutomationService>>,
    id: String,
) -> Result<AutomationTask, String> {
    let svc = svc.inner().clone();
    tokio::task::spawn_blocking(move || svc.set_playbook_state(&id, PlaybookState::Stale))
        .await
        .map_err(|e| format!("redistill_automation task panicked: {e}"))?
}
