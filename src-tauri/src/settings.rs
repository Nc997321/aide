//! 设置体系住在 aide-core（`aide_core::settings`，Host 自持），这里整体 re-export 保持既有
//! 调用路径；本文件只放桌面的密钥端口实现——OS 钥匙串（keyring 带 C 依赖，不能进 core）。

pub use aide_core::settings::*;

const KEYRING_SERVICE: &str = "io.aide.desktop";
const ACCOUNT_PREFIX: &str = "aide/settings/";

pub struct KeyringSecretStore;

impl KeyringSecretStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(key: &str) -> Result<keyring::Entry, SettingsError> {
        keyring::Entry::new(KEYRING_SERVICE, &format!("{ACCOUNT_PREFIX}{key}"))
            .map_err(|e| SettingsError::Secrets(format!("{key}: {e}")))
    }
}

impl Default for KeyringSecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for KeyringSecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, SettingsError> {
        match Self::entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SettingsError::Secrets(format!("{key}: {e}"))),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SettingsError> {
        Self::entry(key)?
            .set_password(value)
            .map_err(|e| SettingsError::Secrets(format!("{key}: {e}")))
    }

    fn delete(&self, key: &str) -> Result<(), SettingsError> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SettingsError::Secrets(format!("{key}: {e}"))),
        }
    }
}
