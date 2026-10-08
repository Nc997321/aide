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
/// 依赖，不能进本 crate）；远程 Host = [`FileSecretStore`]（2026-09-30 定：供应商按 Host 自持，
/// 密钥落 Host 的 0600 文件，与 `~/.aws/credentials` 同一口径）。
pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, SettingsError>;
    fn set(&self, key: &str, value: &str) -> Result<(), SettingsError>;
    fn delete(&self, key: &str) -> Result<(), SettingsError>;
}

/// 进程内密钥存储（测试用）。
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

/// 文件密钥存储：一个仅属主可读写（0600）的 JSON 文件。远程 Host 用它——那台机器上没有
/// 桌面钥匙串可用，而供应商是 Host 自持的（每个 Host 一份，桌面可显式「复制过去」）。
///
/// 写入 = 临时文件（创建即 0600）+ 原子改名，任何时刻文件要么是旧版要么是新版，权限从不
/// 短暂放宽。读写同一把进程内锁，同进程并发写不丢更新。
pub struct FileSecretStore {
    path: std::path::PathBuf,
    lock: std::sync::Mutex<()>,
}

impl FileSecretStore {
    pub fn new(path: std::path::PathBuf) -> Self {
        Self {
            path,
            lock: std::sync::Mutex::new(()),
        }
    }

    fn load(&self) -> Result<std::collections::BTreeMap<String, String>, SettingsError> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) if text.trim().is_empty() => Ok(Default::default()),
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| SettingsError::Secrets(format!("{}: {e}", self.path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(e) => Err(SettingsError::Secrets(format!("{}: {e}", self.path.display()))),
        }
    }

    fn store(&self, values: &std::collections::BTreeMap<String, String>) -> Result<(), SettingsError> {
        use std::io::Write;
        let err = |e: std::io::Error| SettingsError::Secrets(format!("{}: {e}", self.path.display()));
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        let tmp = self.path.with_extension("tmp");
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(err)?;
        let json = serde_json::to_vec_pretty(values)
            .map_err(|e| SettingsError::Secrets(e.to_string()))?;
        f.write_all(&json).map_err(err)?;
        f.sync_all().map_err(err)?;
        drop(f);
        std::fs::rename(&tmp, &self.path).map_err(err)
    }

    fn update(
        &self,
        key: &str,
        change: impl FnOnce(&mut std::collections::BTreeMap<String, String>),
    ) -> Result<(), SettingsError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|e| SettingsError::Secrets(format!("{key}: {e}")))?;
        let mut values = self.load()?;
        change(&mut values);
        self.store(&values)
    }
}

impl SecretStore for FileSecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, SettingsError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|e| SettingsError::Secrets(format!("{key}: {e}")))?;
        Ok(self.load()?.remove(key))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SettingsError> {
        self.update(key, |v| {
            v.insert(key.to_string(), value.to_string());
        })
    }

    fn delete(&self, key: &str) -> Result<(), SettingsError> {
        self.update(key, |v| {
            v.remove(key);
        })
    }
}

#[cfg(test)]
mod file_store_tests {
    use super::*;

    fn store() -> (FileSecretStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "aide-secrets-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("secrets.json");
        (FileSecretStore::new(path.clone()), path)
    }

    #[test]
    fn round_trips_and_deletes() {
        let (s, _) = store();
        assert_eq!(s.get("a").unwrap(), None);
        s.set("a", "1").unwrap();
        s.set("b", "2").unwrap();
        assert_eq!(s.get("a").unwrap().as_deref(), Some("1"));
        s.delete("a").unwrap();
        assert_eq!(s.get("a").unwrap(), None);
        assert_eq!(s.get("b").unwrap().as_deref(), Some("2"));
    }

    #[cfg(unix)]
    #[test]
    fn file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let (s, path) = store();
        s.set("k", "v").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
