use serde_json::Value;

use crate::runtime::provider::{
    ProviderConfig, ProviderKind, ProviderModelMappings,
};
use crate::runtime::provider::strategy::{strategy_for, ActionResult, ConnectionStatus, ProviderStrategy};

fn find_provider(service: &crate::settings::SettingsService, id: &str) -> Result<ProviderConfig, String> {
    if id.is_empty() {
        return service.resolve_active_runtime_provider().map_err(|e| e.to_string());
    }
    // resolve_runtime_provider falls back to __system_default__ when id is not found,
    // preserving existing observable behavior.
    service.resolve_runtime_provider(id).map_err(|e| e.to_string())
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
pub async fn get_providers(
    service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<Vec<crate::runtime::provider::ProviderConfigView>, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || service.list_provider_views().map_err(|error| error.to_string()))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_providers(
    providers: Vec<crate::runtime::provider::ProviderConfigInput>,
    service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || service.save_provider_inputs(providers).map_err(|error| error.to_string()))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_active_provider_id(
    service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<String, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || service.active_provider_id().map_err(|error| error.to_string()))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_active_provider_id(
    provider_id: String,
    service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || service.mutate_scope_blocking(crate::settings::SettingsScope::User, None, |document| {
        document.values.insert("activeProvider".to_string(), Value::String(provider_id));
        Ok(())
    }).map(|_| ()).map_err(|error| error.to_string()))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn test_provider_connection(
    provider_id: String,
    service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<ConnectionStatus, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        let cfg = find_provider(&service, &provider_id)?;
        strategy_for(cfg.kind).test_connection(&cfg)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cpa_probe_port(
    service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<PortProbeResult, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        let cfg = service.list_runtime_providers()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| p.kind == ProviderKind::CpaGpt)
            .unwrap_or_else(|| {
                service.resolve_active_runtime_provider().unwrap_or_else(|_| crate::runtime::provider::system_default_provider())
            });
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "probe_port")? {
            ActionResult::PortProbe { alive, detail } => Ok(PortProbeResult { alive, detail }),
            other => Err(format!("unexpected: {:?}", other)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cpa_open_management(
    service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<String, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        let cfg = service.list_runtime_providers()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| p.kind == ProviderKind::CpaGpt)
            .unwrap_or_else(|| {
                service.resolve_active_runtime_provider().unwrap_or_else(|_| crate::runtime::provider::system_default_provider())
            });
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "open_management")? {
            ActionResult::OpenUrl(u) => Ok(u),
            other => Err(format!("unexpected: {:?}", other)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cpa_login_status(
    service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<LoginStatusResult, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        let cfg = service.list_runtime_providers()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| p.kind == ProviderKind::CpaGpt)
            .unwrap_or_else(|| {
                service.resolve_active_runtime_provider().unwrap_or_else(|_| crate::runtime::provider::system_default_provider())
            });
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "codex_login_status")? {
            ActionResult::LoginStatus { logged_in, detail } => Ok(LoginStatusResult { logged_in, detail }),
            other => Err(format!("unexpected: {:?}", other)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn view_anthropic_quota(
    service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<serde_json::Value, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        let cfg = service.resolve_active_runtime_provider().map_err(|e| e.to_string())?;
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
pub async fn refresh_models(
    provider_id: String,
    service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<ProviderModelMappings, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        let cfg = find_provider(&service, &provider_id)?;
        let strat: Box<dyn ProviderStrategy> = strategy_for(cfg.kind);
        match strat.run_action(&cfg, "refresh_models") {
            Ok(ActionResult::RefreshedModels(m)) => {
                let id = cfg.id.clone();
                service.save_provider_model_mappings(&id, &m).map_err(|e| e.to_string())?;
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
pub async fn refresh_system_default_models(
    service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<ProviderModelMappings, String> {
    refresh_models("__system_default__".to_string(), service).await
}

#[tauri::command]
pub fn get_provider_catalog() -> Result<Vec<crate::runtime::provider::catalog::CatalogPreset>, String> {
    Ok(crate::runtime::provider::catalog::catalog().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::settings::{MemorySecretStore, SettingsPaths, SettingsService};

    fn test_service(suffix: &str) -> Arc<SettingsService> {
        let root = std::env::temp_dir().join(format!("aide-provider-cmd-test-{}", suffix));
        let _ = std::fs::remove_dir_all(&root);
        let secrets = Arc::new(MemorySecretStore::default());
        let service = SettingsService::new(SettingsPaths::for_test(root), secrets);
        service.initialize_blocking().unwrap();
        Arc::new(service)
    }

    #[test]
    fn save_provider_model_mappings_updates_system_default_entry() {
        let service = test_service("sd-entry");
        // Seed a __system_default__ provider
        service.save_provider_input_for_test("__system_default__", "irrelevant").unwrap();

        let mappings = ProviderModelMappings {
            anthropic_model: "claude-sonnet-5".to_string(),
            ..Default::default()
        };
        service.save_provider_model_mappings("__system_default__", &mappings).unwrap();

        let resolved = service.resolve_runtime_provider("__system_default__").unwrap();
        assert_eq!(resolved.model_mappings.anthropic_model, "claude-sonnet-5");
    }

    #[test]
    fn save_provider_model_mappings_updates_named_provider_entry() {
        let service = test_service("named-entry");
        // Seed two providers at once (save_provider_inputs replaces the entire array)
        use crate::settings::SecretMutation;
        use crate::runtime::provider::ProviderConfigInput;
        service.save_provider_inputs(vec![
            ProviderConfigInput {
                id: "cpa".to_string(), kind: ProviderKind::Custom, name: "test".to_string(),
                icon: String::new(), base_url: String::new(),
                api_key: SecretMutation::Set("key1".to_string()),
                auth_token: SecretMutation::Unchanged,
                model: String::new(), model_mappings: ProviderModelMappings::default(),
                effort_level: String::new(), auto_compact_window: String::new(),
                autocompact_pct_override: String::new(), known_models: Vec::new(),
            },
            ProviderConfigInput {
                id: "other".to_string(), kind: ProviderKind::Custom, name: "test".to_string(),
                icon: String::new(), base_url: String::new(),
                api_key: SecretMutation::Set("key2".to_string()),
                auth_token: SecretMutation::Unchanged,
                model: String::new(), model_mappings: ProviderModelMappings::default(),
                effort_level: String::new(), auto_compact_window: String::new(),
                autocompact_pct_override: String::new(), known_models: Vec::new(),
            },
        ]).unwrap();

        let mappings = ProviderModelMappings {
            anthropic_model: "gpt-new".to_string(),
            ..Default::default()
        };
        service.save_provider_model_mappings("cpa", &mappings).unwrap();

        let cpa = service.resolve_runtime_provider("cpa").unwrap();
        assert_eq!(cpa.model_mappings.anthropic_model, "gpt-new");

        let other = service.resolve_runtime_provider("other").unwrap();
        assert_eq!(other.model_mappings.anthropic_model, "", "other provider untouched");
    }

    #[test]
    fn save_provider_model_mappings_noop_for_unknown_id() {
        let service = test_service("noop-unknown");
        service.save_provider_input_for_test("__system_default__", "irrelevant").unwrap();

        let mappings = ProviderModelMappings {
            anthropic_model: "should-not-appear".to_string(),
            ..Default::default()
        };
        // No panic, no side effect
        service.save_provider_model_mappings("nonexistent", &mappings).unwrap();

        let default = service.resolve_runtime_provider("__system_default__").unwrap();
        assert_eq!(default.model_mappings.anthropic_model, "", "system default untouched");
    }

    #[test]
    fn active_provider_snake_case_fallback() {
        let service = test_service("snake-fallback");
        // Seed providers so we can resolve them (save_provider_inputs replaces the entire array)
        use crate::settings::SecretMutation;
        use crate::runtime::provider::ProviderConfigInput;
        service.save_provider_inputs(vec![
            ProviderConfigInput {
                id: "cpa-local".to_string(), kind: ProviderKind::Custom, name: "test".to_string(),
                icon: String::new(), base_url: String::new(),
                api_key: SecretMutation::Set("sk-test".to_string()),
                auth_token: SecretMutation::Unchanged,
                model: String::new(), model_mappings: ProviderModelMappings::default(),
                effort_level: String::new(), auto_compact_window: String::new(),
                autocompact_pct_override: String::new(), known_models: Vec::new(),
            },
            ProviderConfigInput {
                id: "__system_default__".to_string(), kind: ProviderKind::SystemDefault, name: String::new(),
                icon: String::new(), base_url: String::new(),
                api_key: SecretMutation::Unchanged,
                auth_token: SecretMutation::Unchanged,
                model: String::new(), model_mappings: ProviderModelMappings::default(),
                effort_level: String::new(), auto_compact_window: String::new(),
                autocompact_pct_override: String::new(), known_models: Vec::new(),
            },
        ]).unwrap();

        // Write snake_case key (legacy migration copies keys as-is)
        service.mutate_scope_blocking(crate::settings::SettingsScope::User, None, |doc| {
            doc.values.insert("active_provider".to_string(), serde_json::json!("cpa-local"));
            Ok(())
        }).unwrap();

        // active_provider_id must resolve via snake_case fallback
        let id = service.active_provider_id().unwrap();
        assert_eq!(id, "cpa-local", "snake_case active_provider key must be read");

        // resolve_active_runtime_provider must also follow the fallback
        let provider = service.resolve_active_runtime_provider().unwrap();
        assert_eq!(provider.id, "cpa-local");
        assert_eq!(provider.api_key, "sk-test");
    }

    #[test]
    fn active_provider_camel_case_preferred_over_snake_case() {
        let service = test_service("camel-preferred");
        use crate::settings::SecretMutation;
        use crate::runtime::provider::ProviderConfigInput;
        service.save_provider_inputs(vec![
            ProviderConfigInput {
                id: "my-provider".to_string(), kind: ProviderKind::Custom, name: "test".to_string(),
                icon: String::new(), base_url: String::new(),
                api_key: SecretMutation::Set("k1".to_string()),
                auth_token: SecretMutation::Unchanged,
                model: String::new(), model_mappings: ProviderModelMappings::default(),
                effort_level: String::new(), auto_compact_window: String::new(),
                autocompact_pct_override: String::new(), known_models: Vec::new(),
            },
            ProviderConfigInput {
                id: "other".to_string(), kind: ProviderKind::Custom, name: "test".to_string(),
                icon: String::new(), base_url: String::new(),
                api_key: SecretMutation::Set("k2".to_string()),
                auth_token: SecretMutation::Unchanged,
                model: String::new(), model_mappings: ProviderModelMappings::default(),
                effort_level: String::new(), auto_compact_window: String::new(),
                autocompact_pct_override: String::new(), known_models: Vec::new(),
            },
        ]).unwrap();

        service.mutate_scope_blocking(crate::settings::SettingsScope::User, None, |doc| {
            doc.values.insert("activeProvider".to_string(), serde_json::json!("my-provider"));
            doc.values.insert("active_provider".to_string(), serde_json::json!("other"));
            Ok(())
        }).unwrap();

        let id = service.active_provider_id().unwrap();
        assert_eq!(id, "my-provider", "camelCase activeProvider takes precedence");
    }
}