use serde_json::Value;

use super::settings::{load_config, with_config_mut};
use crate::runtime::provider::{
    active_provider_or_system_default, load_system_default_mappings, migrate_provider_model,
    ProviderConfig, ProviderKind, ProviderModelMappings,
};
use crate::runtime::provider::strategy::{strategy_for, ActionResult};

#[tauri::command]
pub fn get_providers() -> Result<Vec<ProviderConfig>, String> {
    let _trace = crate::diagnostics::trace_command("get_providers");
    let config = load_config();
    if let Some(arr) = config.get("providers").and_then(|v| v.as_array()) {
        let mut out = Vec::new();
        for item in arr {
            if let Ok(mut p) = serde_json::from_value::<ProviderConfig>(item.clone()) {
                migrate_provider_model(&mut p);
                out.push(p);
            }
        }
        Ok(out)
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn set_providers(providers: Vec<ProviderConfig>) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_providers");
    with_config_mut(move |config| {
        config["providers"] =
            serde_json::to_value(&providers).map_err(|e| format!("Serialize error: {}", e))?;
        Ok(())
    })
}

#[tauri::command]
pub fn get_active_provider_id() -> Result<String, String> {
    let _trace = crate::diagnostics::trace_command("get_active_provider_id");
    let config = load_config();
    let id = config
        .get("active_provider")
        .and_then(|v| v.as_str())
        .unwrap_or("__system_default__")
        .to_string();
    Ok(id)
}

#[tauri::command]
pub fn set_active_provider_id(provider_id: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_active_provider_id");
    with_config_mut(move |config| {
        config["active_provider"] = Value::String(provider_id);
        Ok(())
    })
}

#[tauri::command]
pub fn get_system_default_model_mappings() -> Result<ProviderModelMappings, String> {
    let _trace = crate::diagnostics::trace_command("get_system_default_model_mappings");
    Ok(load_system_default_mappings())
}

#[tauri::command]
pub fn set_system_default_model_mappings(mappings: ProviderModelMappings) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_system_default_model_mappings");
    let mappings_val =
        serde_json::to_value(&mappings).map_err(|e| format!("Serialize error: {}", e))?;
    with_config_mut(move |config| {
        config["system_default_model_mappings"] = mappings_val;
        Ok(())
    })
}

// ── 启动时拉最新模型覆盖"系统默认" ──
//
// Task 8 临时委托：command 层直接调 SystemDefaultStrategy.run_action("refresh_models")，
// 返回新 mappings 但**不持久化**——持久化由 Task 11/12 在 strategy 调用后统一写回。
// 这是计划接受的临时回归，避免 Task 8 同时改动配置写入路径。
//
// async + spawn_blocking：CLAUDE.md 规矩——重 IO 命令一律 async + spawn_blocking，
// 同步 ureq 调用放 blocking 闭包不阻塞 tokio worker。**不埋 trace_command**——
// async 命令的 guard 在 dispatch 后立刻 drop，埋了也抓不到（CLAUDE.md 红线）。

/// 启动时（和点"手动刷新"时）调 Anthropic `GET /v1/models` 拉最新模型列表并返回 mappings。
/// Task 8 不持久化；Task 11/12 恢复写回 config。
#[tauri::command]
pub async fn refresh_system_default_models() -> Result<ProviderModelMappings, String> {
    let cfg = active_provider_or_system_default();
    // 临时：强制 SystemDefault strategy 跑 refresh_models（Task 12 泛化为 refresh_models(id)）
    let strat = strategy_for(ProviderKind::SystemDefault);
    let res = tokio::task::spawn_blocking(move || strat.run_action(&cfg, "refresh_models"))
        .await
        .map_err(|e| e.to_string())??;
    match res {
        ActionResult::RefreshedModels(m) => Ok(m),
        other => Err(format!("unexpected action result: {:?}", other)),
    }
}

#[tauri::command]
pub fn get_provider_catalog() -> Result<Vec<crate::runtime::provider::catalog::CatalogPreset>, String> {
    Ok(crate::runtime::provider::catalog::catalog().to_vec())
}

