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

const KEYRING_SERVICE: &str = "io.aide.desktop";
const ACCOUNT_PREFIX: &str = "aide/settings/";

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, SettingsError>;
    fn set(&self, key: &str, value: &str) -> Result<(), SettingsError>;
    fn delete(&self, key: &str) -> Result<(), SettingsError>;
}

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

#[cfg(test)]
#[derive(Default)]
pub struct MemorySecretStore {
    values: std::sync::Mutex<std::collections::BTreeMap<String, String>>,
}

#[cfg(test)]
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
