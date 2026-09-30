use std::fs;

use serde_json::{json, Value};

use super::schema::{SettingsDocument, SettingsScope, SETTINGS_SCHEMA_VERSION};
use super::secrets::SecretStore;
use super::store::{validate_document, validate_legacy_config, SettingsStore};
use super::SettingsError;

pub fn run_legacy_migration(
    store: &SettingsStore,
    secrets: &dyn SecretStore,
) -> Result<(), SettingsError> {
    let paths = store.paths();
    if paths.user().exists() {
        cleanup_legacy_after_new_document_exists(store);
        return Ok(());
    }
    if !paths.legacy_config().exists() {
        return Ok(());
    }

    let legacy_text = fs::read_to_string(paths.legacy_config())
        .map_err(|e| SettingsError::Storage(format!("{}: {e}", paths.legacy_config().display())))?;
    let legacy: Value = serde_json::from_str(&legacy_text).map_err(|e| {
        SettingsError::Validation(format!("{}: {e}", paths.legacy_config().display()))
    })?;
    validate_legacy_config(&legacy)?;

    let mut sanitized_values = legacy.clone();
    let secret_writes = collect_secrets(&mut sanitized_values);
    let document = SettingsDocument {
        schema_version: SETTINGS_SCHEMA_VERSION,
        values: sanitized_values.as_object().cloned().unwrap_or_default(),
        ..SettingsDocument::default()
    };
    validate_document(&document, SettingsScope::User)?;

    persist_secrets(secrets, secret_writes)?;
    store.write_atomic(paths.user(), &document, SettingsScope::User)?;
    best_effort_cleanup_legacy(store, legacy);
    Ok(())
}

fn cleanup_legacy_after_new_document_exists(store: &SettingsStore) {
    let paths = store.paths();
    if !paths.legacy_config().exists() {
        return;
    }
    let legacy_text = match fs::read_to_string(paths.legacy_config()) {
        Ok(text) => text,
        Err(error) => {
            tracing::warn!(
                path = %paths.legacy_config().display(),
                error = %error,
                "failed to read stale legacy settings file for retryable cleanup"
            );
            return;
        }
    };
    let legacy = match serde_json::from_str(&legacy_text) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(
                path = %paths.legacy_config().display(),
                error = %error,
                "failed to parse stale legacy settings file for retryable cleanup"
            );
            return;
        }
    };
    best_effort_cleanup_legacy(store, legacy);
}

fn best_effort_cleanup_legacy(store: &SettingsStore, legacy: Value) {
    let paths = store.paths();
    // 备份只写一次：保留最完整的首次迁移快照（否则每次启动的重试清理会用残留
    // 内容覆盖掉它）。备份失败则不碰原文件，下次启动重试。
    if !paths.legacy_backup().exists() {
        let redacted_backup = redact_legacy_for_backup(legacy);
        if let Err(error) = store.write_json_atomic(paths.legacy_backup(), &redacted_backup) {
            tracing::warn!(
                path = %paths.legacy_backup().display(),
                error = %error,
                "failed to write redacted legacy settings backup after settings migration"
            );
            return;
        }
    }
    // legacy 里仍住着非设置体系的 live key（workspace / claudeMigrationDone /
    // hiddenWorkspaces / openWithExtensions 等）——先搬到 state.json（missing-only），
    // 搬成功才删文件。曾直接整删，导致迁移完成标记每次启动被抹掉、迁移引导
    // 弹窗每次重启复现。播种失败则保留 legacy 文件，下次启动重试。
    if let Err(error) =
        crate::app_settings::seed_state_from_legacy(paths.legacy_config(), paths.state())
    {
        tracing::warn!(
            path = %paths.state().display(),
            error = %error,
            "failed to seed state.json from legacy config; keeping legacy file for retry"
        );
        return;
    }
    if let Err(error) = fs::remove_file(paths.legacy_config()) {
        tracing::warn!(
            path = %paths.legacy_config().display(),
            error = %error,
            "failed to delete legacy settings file after settings migration"
        );
    }
}

fn collect_secrets(value: &mut Value) -> Vec<(String, String)> {
    let mut writes = Vec::new();
    if let Some(api_key) = take_nested_string(value, &["settings", "codegraphEmbedder", "apiKey"]) {
        writes.push(("codegraph/default/apiKey".to_string(), api_key));
    }

    if let Some(providers) = value.get_mut("providers").and_then(Value::as_array_mut) {
        for (index, provider) in providers.iter_mut().enumerate() {
            let stable_ref = provider
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("index-{index}"));
            if let Some(secret) = take_direct_string(provider, "apiKey") {
                writes.push((format!("provider/{stable_ref}/apiKey"), secret));
            }
            if let Some(secret) = take_direct_string(provider, "api_key") {
                writes.push((format!("provider/{stable_ref}/apiKey"), secret));
            }
            if let Some(secret) = take_direct_string(provider, "authToken") {
                writes.push((format!("provider/{stable_ref}/authToken"), secret));
            }
            if let Some(secret) = take_direct_string(provider, "auth_token") {
                writes.push((format!("provider/{stable_ref}/authToken"), secret));
            }
        }
    }
    writes
}

fn persist_secrets(
    secrets: &dyn SecretStore,
    writes: Vec<(String, String)>,
) -> Result<(), SettingsError> {
    for (key, value) in writes {
        secrets.set(&key, &value)?;
    }
    Ok(())
}

fn take_nested_string(value: &mut Value, path: &[&str]) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    let mut current = value;
    for part in &path[..path.len() - 1] {
        current = current.get_mut(*part)?;
    }
    take_direct_string(current, path[path.len() - 1])
}

fn take_direct_string(value: &mut Value, key: &str) -> Option<String> {
    value
        .as_object_mut()?
        .remove(key)?
        .as_str()
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

fn redact_legacy_for_backup(mut value: Value) -> Value {
    redact_nested(&mut value, &["settings", "codegraphEmbedder", "apiKey"]);
    if let Some(providers) = value.get_mut("providers").and_then(Value::as_array_mut) {
        for provider in providers {
            redact_direct(provider, "apiKey");
            redact_direct(provider, "api_key");
            redact_direct(provider, "authToken");
            redact_direct(provider, "auth_token");
        }
    }
    value
}

fn redact_nested(value: &mut Value, path: &[&str]) {
    if path.is_empty() {
        return;
    }
    let mut current = value;
    for part in &path[..path.len() - 1] {
        match current.get_mut(*part) {
            Some(next) => current = next,
            None => return,
        }
    }
    redact_direct(current, path[path.len() - 1]);
}

fn redact_direct(value: &mut Value, key: &str) {
    if let Some(object) = value.as_object_mut() {
        if object.contains_key(key) {
            object.insert(key.to_string(), json!({ "configured": true }));
        }
    }
}
