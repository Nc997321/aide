use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::registry::Command;
use crate::{command, Core};

use crate::provider::strategy::{
    strategy_for, ActionResult, ConnectionStatus, ProviderStrategy,
};
use crate::provider::{ProviderConfig, ProviderKind, ProviderModelMappings};

pub static COMMANDS: &[Command] = &[
    command!("get_providers", get_providers),
    command!("set_providers", set_providers),
    command!("get_active_provider_id", get_active_provider_id),
    command!("set_active_provider_id", set_active_provider_id),
    command!("test_provider_connection", test_provider_connection),
    command!("cpa_probe_port", cpa_probe_port),
    command!("cpa_open_management", cpa_open_management),
    command!("cpa_login_status", cpa_login_status),
    command!("view_anthropic_quota", view_anthropic_quota),
    command!("refresh_models", refresh_models),
    command!("refresh_system_default_models", refresh_system_default_models),
    command!("get_provider_catalog", get_provider_catalog),
];

fn find_provider(
    service: &crate::settings::SettingsService,
    id: &str,
) -> Result<ProviderConfig, String> {
    if id.is_empty() {
        return service
            .resolve_active_runtime_provider()
            .map_err(|e| e.to_string());
    }
    // resolve_runtime_provider falls back to __system_default__ when id is not found,
    // preserving existing observable behavior.
    service
        .resolve_runtime_provider(id)
        .map_err(|e| e.to_string())
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetProvidersArgs {
}

async fn get_providers(core: Arc<Core>, a: GetProvidersArgs) -> Result<Vec<crate::provider::ProviderConfigView>, String> {
    let _ = a;
    let service = core.settings.clone();
    tokio::task::spawn_blocking(move || {
        service
            .list_provider_views()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProvidersArgs {
    providers: Vec<crate::provider::ProviderConfigInput>,
}

async fn set_providers(core: Arc<Core>, a: SetProvidersArgs) -> Result<(), String> {
    let SetProvidersArgs { providers } = a;
    let service = core.settings.clone();
    tokio::task::spawn_blocking(move || {
        service
            .save_provider_inputs(providers)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetActiveProviderIdArgs {
}

async fn get_active_provider_id(core: Arc<Core>, a: GetActiveProviderIdArgs) -> Result<String, String> {
    let _ = a;
    let service = core.settings.clone();
    tokio::task::spawn_blocking(move || {
        service
            .active_provider_id()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveProviderIdArgs {
    provider_id: String,
}

async fn set_active_provider_id(core: Arc<Core>, a: SetActiveProviderIdArgs) -> Result<(), String> {
    let SetActiveProviderIdArgs { provider_id } = a;
    let service = core.settings.clone();
    tokio::task::spawn_blocking(move || {
        service
            .mutate_scope_blocking(crate::settings::SettingsScope::User, None, |document| {
                document
                    .values
                    .insert("activeProvider".to_string(), Value::String(provider_id));
                Ok(())
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestProviderConnectionArgs {
    provider_id: String,
}

async fn test_provider_connection(core: Arc<Core>, a: TestProviderConnectionArgs) -> Result<ConnectionStatus, String> {
    let TestProviderConnectionArgs { provider_id } = a;
    let service = core.settings.clone();
    tokio::task::spawn_blocking(move || {
        let cfg = find_provider(&service, &provider_id)?;
        strategy_for(cfg.kind).test_connection(&cfg)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaProbePortArgs {
}

async fn cpa_probe_port(core: Arc<Core>, a: CpaProbePortArgs) -> Result<PortProbeResult, String> {
    let _ = a;
    let service = core.settings.clone();
    tokio::task::spawn_blocking(move || {
        let cfg = service
            .list_runtime_providers()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| p.kind == ProviderKind::CpaGpt)
            .unwrap_or_else(|| {
                service
                    .resolve_active_runtime_provider()
                    .unwrap_or_else(|_| crate::provider::system_default_provider())
            });
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "probe_port")? {
            ActionResult::PortProbe { alive, detail } => Ok(PortProbeResult { alive, detail }),
            other => Err(format!("unexpected: {:?}", other)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaOpenManagementArgs {
}

async fn cpa_open_management(core: Arc<Core>, a: CpaOpenManagementArgs) -> Result<String, String> {
    let _ = a;
    let service = core.settings.clone();
    tokio::task::spawn_blocking(move || {
        let cfg = service
            .list_runtime_providers()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| p.kind == ProviderKind::CpaGpt)
            .unwrap_or_else(|| {
                service
                    .resolve_active_runtime_provider()
                    .unwrap_or_else(|_| crate::provider::system_default_provider())
            });
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "open_management")? {
            ActionResult::OpenUrl(u) => Ok(u),
            other => Err(format!("unexpected: {:?}", other)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaLoginStatusArgs {
}

async fn cpa_login_status(core: Arc<Core>, a: CpaLoginStatusArgs) -> Result<LoginStatusResult, String> {
    let _ = a;
    let service = core.settings.clone();
    tokio::task::spawn_blocking(move || {
        let cfg = service
            .list_runtime_providers()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| p.kind == ProviderKind::CpaGpt)
            .unwrap_or_else(|| {
                service
                    .resolve_active_runtime_provider()
                    .unwrap_or_else(|_| crate::provider::system_default_provider())
            });
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "codex_login_status")? {
            ActionResult::LoginStatus { logged_in, detail } => {
                Ok(LoginStatusResult { logged_in, detail })
            }
            other => Err(format!("unexpected: {:?}", other)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewAnthropicQuotaArgs {
}

async fn view_anthropic_quota(core: Arc<Core>, a: ViewAnthropicQuotaArgs) -> Result<serde_json::Value, String> {
    let _ = a;
    let service = core.settings.clone();
    tokio::task::spawn_blocking(move || {
        let cfg = service
            .resolve_active_runtime_provider()
            .map_err(|e| e.to_string())?;
        match strategy_for(ProviderKind::SystemDefault).run_action(&cfg, "view_quota") {
            Ok(ActionResult::Quota(v)) => Ok(v),
            Ok(_) => Ok(serde_json::json!({"note": "v1 未实现"})),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshModelsArgs {
    provider_id: String,
}

async fn refresh_models(core: Arc<Core>, a: RefreshModelsArgs) -> Result<ProviderModelMappings, String> {
    let RefreshModelsArgs { provider_id } = a;
    let service = core.settings.clone();
    tokio::task::spawn_blocking(move || {
        let cfg = find_provider(&service, &provider_id)?;
        let strat: Box<dyn ProviderStrategy> = strategy_for(cfg.kind);
        match strat.run_action(&cfg, "refresh_models") {
            Ok(ActionResult::RefreshedModels(m)) => {
                let id = cfg.id.clone();
                service
                    .save_provider_model_mappings(&id, &m)
                    .map_err(|e| e.to_string())?;
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSystemDefaultModelsArgs {
}

async fn refresh_system_default_models(core: Arc<Core>, a: RefreshSystemDefaultModelsArgs) -> Result<ProviderModelMappings, String> {
    let _ = a;
    refresh_models(
        core,
        RefreshModelsArgs {
            provider_id: "__system_default__".to_string(),
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetProviderCatalogArgs {
}

async fn get_provider_catalog(core: Arc<Core>, a: GetProviderCatalogArgs) -> Result<Vec<crate::provider::catalog::CatalogPreset>, String> {
    let _ = a;
    let _ = core;
    Ok(crate::provider::catalog::catalog().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{MemorySecretStore, SettingsPaths, SettingsService};
    use std::sync::Arc;

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
        service
            .save_provider_input_for_test("__system_default__", "irrelevant")
            .unwrap();

        let mappings = ProviderModelMappings {
            anthropic_model: "claude-sonnet-5".to_string(),
            ..Default::default()
        };
        service
            .save_provider_model_mappings("__system_default__", &mappings)
            .unwrap();

        let resolved = service
            .resolve_runtime_provider("__system_default__")
            .unwrap();
        assert_eq!(resolved.model_mappings.anthropic_model, "claude-sonnet-5");
    }

    #[test]
    fn save_provider_model_mappings_updates_named_provider_entry() {
        let service = test_service("named-entry");
        // Seed two providers at once (save_provider_inputs replaces the entire array)
        use crate::provider::ProviderConfigInput;
        use crate::settings::SecretMutation;
        service
            .save_provider_inputs(vec![
                ProviderConfigInput {
                    id: "cpa".to_string(),
                    kind: ProviderKind::Custom,
                    name: "test".to_string(),
                    icon: String::new(),
                    base_url: String::new(),
                    api_key: SecretMutation::Set("key1".to_string()),
                    auth_token: SecretMutation::Unchanged,
                    model: String::new(),
                    model_mappings: ProviderModelMappings::default(),
                    effort_level: String::new(),
                    auto_compact_window: String::new(),
                    autocompact_pct_override: String::new(),
                    max_context_tokens: String::new(),
                    known_models: Vec::new(),
                },
                ProviderConfigInput {
                    id: "other".to_string(),
                    kind: ProviderKind::Custom,
                    name: "test".to_string(),
                    icon: String::new(),
                    base_url: String::new(),
                    api_key: SecretMutation::Set("key2".to_string()),
                    auth_token: SecretMutation::Unchanged,
                    model: String::new(),
                    model_mappings: ProviderModelMappings::default(),
                    effort_level: String::new(),
                    auto_compact_window: String::new(),
                    autocompact_pct_override: String::new(),
                    max_context_tokens: String::new(),
                    known_models: Vec::new(),
                },
            ])
            .unwrap();

        let mappings = ProviderModelMappings {
            anthropic_model: "gpt-new".to_string(),
            ..Default::default()
        };
        service
            .save_provider_model_mappings("cpa", &mappings)
            .unwrap();

        let cpa = service.resolve_runtime_provider("cpa").unwrap();
        assert_eq!(cpa.model_mappings.anthropic_model, "gpt-new");

        let other = service.resolve_runtime_provider("other").unwrap();
        assert_eq!(
            other.model_mappings.anthropic_model, "",
            "other provider untouched"
        );
    }

    #[test]
    fn save_provider_model_mappings_noop_for_unknown_id() {
        let service = test_service("noop-unknown");
        service
            .save_provider_input_for_test("__system_default__", "irrelevant")
            .unwrap();

        let mappings = ProviderModelMappings {
            anthropic_model: "should-not-appear".to_string(),
            ..Default::default()
        };
        // No panic, no side effect
        service
            .save_provider_model_mappings("nonexistent", &mappings)
            .unwrap();

        let default = service
            .resolve_runtime_provider("__system_default__")
            .unwrap();
        assert_eq!(
            default.model_mappings.anthropic_model, "",
            "system default untouched"
        );
    }

    #[test]
    fn active_provider_snake_case_fallback() {
        let service = test_service("snake-fallback");
        // Seed providers so we can resolve them (save_provider_inputs replaces the entire array)
        use crate::provider::ProviderConfigInput;
        use crate::settings::SecretMutation;
        service
            .save_provider_inputs(vec![
                ProviderConfigInput {
                    id: "cpa-local".to_string(),
                    kind: ProviderKind::Custom,
                    name: "test".to_string(),
                    icon: String::new(),
                    base_url: String::new(),
                    api_key: SecretMutation::Set("sk-test".to_string()),
                    auth_token: SecretMutation::Unchanged,
                    model: String::new(),
                    model_mappings: ProviderModelMappings::default(),
                    effort_level: String::new(),
                    auto_compact_window: String::new(),
                    autocompact_pct_override: String::new(),
                    max_context_tokens: String::new(),
                    known_models: Vec::new(),
                },
                ProviderConfigInput {
                    id: "__system_default__".to_string(),
                    kind: ProviderKind::SystemDefault,
                    name: String::new(),
                    icon: String::new(),
                    base_url: String::new(),
                    api_key: SecretMutation::Unchanged,
                    auth_token: SecretMutation::Unchanged,
                    model: String::new(),
                    model_mappings: ProviderModelMappings::default(),
                    effort_level: String::new(),
                    auto_compact_window: String::new(),
                    autocompact_pct_override: String::new(),
                    max_context_tokens: String::new(),
                    known_models: Vec::new(),
                },
            ])
            .unwrap();

        // Write snake_case key (legacy migration copies keys as-is)
        service
            .mutate_scope_blocking(crate::settings::SettingsScope::User, None, |doc| {
                doc.values.insert(
                    "active_provider".to_string(),
                    serde_json::json!("cpa-local"),
                );
                Ok(())
            })
            .unwrap();

        // active_provider_id must resolve via snake_case fallback
        let id = service.active_provider_id().unwrap();
        assert_eq!(
            id, "cpa-local",
            "snake_case active_provider key must be read"
        );

        // resolve_active_runtime_provider must also follow the fallback
        let provider = service.resolve_active_runtime_provider().unwrap();
        assert_eq!(provider.id, "cpa-local");
        assert_eq!(provider.api_key, "sk-test");
    }

    #[test]
    fn active_provider_camel_case_preferred_over_snake_case() {
        let service = test_service("camel-preferred");
        use crate::provider::ProviderConfigInput;
        use crate::settings::SecretMutation;
        service
            .save_provider_inputs(vec![
                ProviderConfigInput {
                    id: "my-provider".to_string(),
                    kind: ProviderKind::Custom,
                    name: "test".to_string(),
                    icon: String::new(),
                    base_url: String::new(),
                    api_key: SecretMutation::Set("k1".to_string()),
                    auth_token: SecretMutation::Unchanged,
                    model: String::new(),
                    model_mappings: ProviderModelMappings::default(),
                    effort_level: String::new(),
                    auto_compact_window: String::new(),
                    autocompact_pct_override: String::new(),
                    max_context_tokens: String::new(),
                    known_models: Vec::new(),
                },
                ProviderConfigInput {
                    id: "other".to_string(),
                    kind: ProviderKind::Custom,
                    name: "test".to_string(),
                    icon: String::new(),
                    base_url: String::new(),
                    api_key: SecretMutation::Set("k2".to_string()),
                    auth_token: SecretMutation::Unchanged,
                    model: String::new(),
                    model_mappings: ProviderModelMappings::default(),
                    effort_level: String::new(),
                    auto_compact_window: String::new(),
                    autocompact_pct_override: String::new(),
                    max_context_tokens: String::new(),
                    known_models: Vec::new(),
                },
            ])
            .unwrap();

        service
            .mutate_scope_blocking(crate::settings::SettingsScope::User, None, |doc| {
                doc.values.insert(
                    "activeProvider".to_string(),
                    serde_json::json!("my-provider"),
                );
                doc.values
                    .insert("active_provider".to_string(), serde_json::json!("other"));
                Ok(())
            })
            .unwrap();

        let id = service.active_provider_id().unwrap();
        assert_eq!(
            id, "my-provider",
            "camelCase activeProvider takes precedence"
        );
    }
}
