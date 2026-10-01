//! Link 的密钥 / 配对状态落在 Host 自己的密钥库里：桌面 = OS 钥匙串，远程 Host = `~/.aide/secrets.json`
//! （0600）。Host 的私钥与已配对的手机公钥都在这里——**不进普通设置文件**。

use std::sync::Arc;

use aide_link::Vault;

use crate::settings::SettingsService;

pub struct SecretVault(pub Arc<SettingsService>);

impl Vault for SecretVault {
    fn get(&self, key: &str) -> Option<String> {
        self.0.secrets().get(key).ok().flatten()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.secrets().set(key, value).map_err(|e| e.to_string())
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        self.0.secrets().delete(key).map_err(|e| e.to_string())
    }
}
