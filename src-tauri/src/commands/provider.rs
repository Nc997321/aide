use serde_json::Value;

use super::settings::{load_config, with_config_mut};
use crate::runtime::provider::{
    active_provider_or_system_default, load_providers, load_system_default_mappings,
    ProviderConfig, ProviderKind, ProviderModelMappings,
};
use crate::runtime::provider::strategy::{strategy_for, ActionResult, ConnectionStatus, ProviderStrategy};

fn find_provider(id: &str) -> ProviderConfig {
    if id.is_empty() {
        return active_provider_or_system_default();
    }
    load_providers()
        .into_iter()
        .find(|p| p.id == id)
        .unwrap_or_else(active_provider_or_system_default)
}

/// In-place: update the `model_mappings` of the providers[] entry whose id matches.
/// Pure (no I/O) — caller wraps in with_config_mut. Used by refresh_models persistence.
fn write_model_mappings(config: &mut serde_json::Value, id: &str, m_val: &serde_json::Value) {
    if let Some(arr) = config.get_mut("providers").and_then(|v| v.as_array_mut()) {
        for p in arr.iter_mut() {
            if p.get("id").and_then(|v| v.as_str()) == Some(id) {
                p["model_mappings"] = m_val.clone();
                break;
            }
        }
    }
}

#[derive(serde::Serialize)]
pub struct PortProbeResult {
    pub alive: bool,
    pub detail: String,
}

#[derive(serde::Serialize)]
pub struct LoginStatusResult {
    pub logged_in: bool,
    pub detail: String,
}

#[tauri::command]
pub fn get_providers() -> Result<Vec<ProviderConfig>, String> {
    let _trace = crate::diagnostics::trace_command("get_providers");
    Ok(crate::runtime::provider::load_providers())
}

#[tauri::command]
pub fn set_providers(providers: Vec<ProviderConfig>) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_providers");
    crate::runtime::provider::persist_providers(&providers)
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

#[tauri::command]
pub async fn test_provider_connection(provider_id: String) -> Result<ConnectionStatus, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = find_provider(&provider_id);
        strategy_for(cfg.kind).test_connection(&cfg)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cpa_probe_port() -> Result<PortProbeResult, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = load_providers()
            .into_iter()
            .find(|p| p.kind == ProviderKind::CpaGpt)
            .unwrap_or_else(|| find_provider(""));
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "probe_port")? {
            ActionResult::PortProbe { alive, detail } => Ok(PortProbeResult { alive, detail }),
            other => Err(format!("unexpected: {:?}", other)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cpa_open_management() -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = load_providers()
            .into_iter()
            .find(|p| p.kind == ProviderKind::CpaGpt)
            .unwrap_or_else(|| find_provider(""));
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "open_management")? {
            ActionResult::OpenUrl(u) => Ok(u),
            other => Err(format!("unexpected: {:?}", other)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cpa_login_status() -> Result<LoginStatusResult, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = load_providers()
            .into_iter()
            .find(|p| p.kind == ProviderKind::CpaGpt)
            .unwrap_or_else(|| find_provider(""));
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "codex_login_status")? {
            ActionResult::LoginStatus { logged_in, detail } => Ok(LoginStatusResult { logged_in, detail }),
            other => Err(format!("unexpected: {:?}", other)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn view_anthropic_quota() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = active_provider_or_system_default();
        match strategy_for(ProviderKind::SystemDefault).run_action(&cfg, "view_quota") {
            Ok(ActionResult::Quota(v)) => Ok(v),
            Ok(_) => Ok(serde_json::json!({"note": "v1 未实现"})),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn refresh_models(provider_id: String) -> Result<ProviderModelMappings, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = find_provider(&provider_id);
        let strat: Box<dyn ProviderStrategy> = strategy_for(cfg.kind);
        match strat.run_action(&cfg, "refresh_models") {
            Ok(ActionResult::RefreshedModels(m)) => {
                let id = cfg.id.clone();
                let m_val = serde_json::to_value(&m).map_err(|e| e.to_string())?;
                with_config_mut(move |config| {
                    write_model_mappings(config, &id, &m_val);
                    Ok(())
                })?;
                Ok(m)
            }
            Ok(other) => Err(format!("unexpected: {:?}", other)),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// deprecated：用 refresh_models("__system_default__") 代替。
#[tauri::command]
pub async fn refresh_system_default_models() -> Result<ProviderModelMappings, String> {
    refresh_models("__system_default__".to_string()).await
}

#[tauri::command]
pub fn get_provider_catalog() -> Result<Vec<crate::runtime::provider::catalog::CatalogPreset>, String> {
    Ok(crate::runtime::provider::catalog::catalog().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_model_mappings_updates_system_default_entry_not_top_level() {
        // Regression guard for the Important #2 fix: SystemDefault mappings live in providers[]
        // (id __system_default__), NOT the dead top-level system_default_model_mappings field.
        let mut config = serde_json::json!({
            "providers": [
                {"id":"__system_default__","kind":"system_default","model_mappings":{"anthropic_model":"old"}},
                {"id":"cpa","kind":"cpa_gpt","model_mappings":{}}
            ]
        });
        let m_val = serde_json::json!({"anthropic_model":"new-model"});
        write_model_mappings(&mut config, "__system_default__", &m_val);
        assert_eq!(config["providers"][0]["model_mappings"]["anthropic_model"], "new-model");
        // other entry untouched
        assert_eq!(config["providers"][1]["model_mappings"], serde_json::json!({}));
        // top-level dead field NOT written
        assert!(config.get("system_default_model_mappings").is_none());
    }

    #[test]
    fn write_model_mappings_updates_named_provider_entry() {
        let mut config = serde_json::json!({
            "providers": [
                {"id":"__system_default__","kind":"system_default","model_mappings":{}},
                {"id":"cpa","kind":"cpa_gpt","model_mappings":{"anthropic_model":"old"}}
            ]
        });
        let m_val = serde_json::json!({"anthropic_model":"gpt-new"});
        write_model_mappings(&mut config, "cpa", &m_val);
        assert_eq!(config["providers"][1]["model_mappings"]["anthropic_model"], "gpt-new");
        assert_eq!(config["providers"][0]["model_mappings"], serde_json::json!({}));
    }
}
