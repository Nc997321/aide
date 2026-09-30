use serde::{Deserialize, Serialize};

use super::SettingsError;

/// Explicit credential update intent. Absent or empty user input maps to
/// `Unchanged`; deletion is only performed by an explicit `Clear` request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", tag = "action", content = "value")]
pub enum SecretMutation {
    #[default]
    Unchanged,
    Set(String),
    Clear,
}

/// 密钥存储端口。实现在前门：桌面 = OS 钥匙串（`src-tauri/src/settings.rs`，keyring 带 C
/// 依赖，不能进本 crate）；远程 Host = [`MemorySecretStore`]。
pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, SettingsError>;
    fn set(&self, key: &str, value: &str) -> Result<(), SettingsError>;
    fn delete(&self, key: &str) -> Result<(), SettingsError>;
}

/// 进程内密钥存储：测试用；远程 Host 也用它（密钥由桌面钥匙串随连接下发，只在内存里）。
#[derive(Default)]
pub struct MemorySecretStore {
    values: std::sync::Mutex<std::collections::BTreeMap<String, String>>,
}

impl SecretStore for MemorySecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, SettingsError> {
        Ok(self
            .values
            .lock()
            .map_err(|e| SettingsError::Secrets(format!("{key}: {e}")))?
            .get(key)
            .cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SettingsError> {
        self.values
            .lock()
            .map_err(|e| SettingsError::Secrets(format!("{key}: {e}")))?
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), SettingsError> {
        self.values
            .lock()
            .map_err(|e| SettingsError::Secrets(format!("{key}: {e}")))?
            .remove(key);
        Ok(())
    }
}
