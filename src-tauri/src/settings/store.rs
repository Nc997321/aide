use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use serde_json::{Map, Value};

use super::descriptors::{
    all_descriptors, validate_descriptor_catalog, SettingDescriptor, SettingValueKind,
};
use super::migration::run_legacy_migration;
use super::schema::{SettingsDocument, SettingsScope, SETTINGS_SCHEMA_VERSION};
use super::secrets::SecretStore;
use super::SettingsError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsPaths {
    managed_document: PathBuf,
    user_document: PathBuf,
    project_file_name: String,
    local_file_name: String,
    legacy_config: PathBuf,
    legacy_backup: PathBuf,
    state: PathBuf,
}

impl SettingsPaths {
    pub fn new() -> Result<Self, SettingsError> {
        let user_config = crate::commands::our_config_dir();
        let managed_root = managed_settings_root()?;
        Ok(Self {
            managed_document: managed_root.join("settings.json"),
            user_document: user_config.join("settings.json"),
            project_file_name: ".aide/settings.json".to_string(),
            local_file_name: ".aide/settings.local.json".to_string(),
            legacy_config: crate::commands::config_path(),
            legacy_backup: user_config.join("config.json.migrated.bak"),
            state: crate::commands::state_path(),
        })
    }

    #[cfg(test)]
    pub fn for_test(root: PathBuf) -> Self {
        Self {
            managed_document: root.join("managed").join("settings.json"),
            user_document: root.join("user").join("settings.json"),
            project_file_name: ".aide/settings.json".to_string(),
            local_file_name: ".aide/settings.local.json".to_string(),
            legacy_config: root.join("config.json"),
            legacy_backup: root.join("config.json.migrated.bak"),
            state: root.join("state.json"),
        }
    }

    pub fn managed(&self) -> &Path {
        &self.managed_document
    }

    pub fn user(&self) -> &Path {
        &self.user_document
    }

    pub fn project_shared(&self, project_root: Option<&Path>) -> Option<PathBuf> {
        project_root.map(|root| root.join(&self.project_file_name))
    }

    pub fn project_local(&self, project_root: Option<&Path>) -> Option<PathBuf> {
        project_root.map(|root| root.join(&self.local_file_name))
    }

    pub fn legacy_config(&self) -> &Path {
        &self.legacy_config
    }

    pub fn legacy_backup(&self) -> &Path {
        &self.legacy_backup
    }

    /// `state.json`——非设置体系运行时状态的家（state 播种的写入目标）。
    pub fn state(&self) -> &Path {
        &self.state
    }
}

#[cfg(windows)]
fn managed_settings_root() -> Result<PathBuf, SettingsError> {
    std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .map(|root| root.join("Aide"))
        .ok_or_else(|| SettingsError::Storage("PROGRAMDATA is not set".to_string()))
}

#[cfg(target_os = "macos")]
fn managed_settings_root() -> Result<PathBuf, SettingsError> {
    Ok(PathBuf::from("/Library/Application Support/Aide"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn managed_settings_root() -> Result<PathBuf, SettingsError> {
    Ok(PathBuf::from("/etc/aide"))
}

#[derive(Debug, Clone, PartialEq)]
pub struct LayeredDocument {
    pub scope: SettingsScope,
    pub path: Option<PathBuf>,
    pub document: SettingsDocument,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveSettings {
    pub documents: Vec<LayeredDocument>,
    pub values: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationResult {
    pub scope: SettingsScope,
    pub path: PathBuf,
    pub revision: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct SettingsState {
    initialized: bool,
    revision: u64,
    user_document: SettingsDocument,
}

pub struct SettingsStore {
    paths: SettingsPaths,
    fail_next_persist: AtomicBool,
}

impl SettingsStore {
    pub fn new(paths: SettingsPaths) -> Self {
        Self {
            paths,
            fail_next_persist: AtomicBool::new(false),
        }
    }

    pub fn paths(&self) -> &SettingsPaths {
        &self.paths
    }

    pub fn read(
        &self,
        path: &Path,
        scope: SettingsScope,
    ) -> Result<Option<SettingsDocument>, SettingsError> {
        if !path.exists() {
            return Ok(None);
        }
        let text = fs::read_to_string(path)
            .map_err(|e| SettingsError::Storage(format!("{}: {e}", path.display())))?;
        let document = serde_json::from_str(&text)
            .map_err(|e| SettingsError::Validation(format!("{}: {e}", path.display())))?;
        validate_document(&document, scope)?;
        Ok(Some(document))
    }

    pub fn write_atomic(
        &self,
        path: &Path,
        document: &SettingsDocument,
        scope: SettingsScope,
    ) -> Result<(), SettingsError> {
        validate_document(document, scope)?;
        let value = serde_json::to_value(document)
            .map_err(|e| SettingsError::Storage(format!("{}: {e}", path.display())))?;
        self.write_json_atomic(path, &value)
    }

    pub fn write_json_atomic(&self, path: &Path, value: &Value) -> Result<(), SettingsError> {
        if self.fail_next_persist.swap(false, Ordering::SeqCst) {
            return Err(SettingsError::Storage(format!(
                "{}: injected persist failure",
                path.display()
            )));
        }
        let dir = path
            .parent()
            .ok_or_else(|| SettingsError::Storage(format!("{} has no parent", path.display())))?;
        fs::create_dir_all(dir)
            .map_err(|e| SettingsError::Storage(format!("{}: {e}", dir.display())))?;
        let json = serde_json::to_string_pretty(value)
            .map_err(|e| SettingsError::Storage(format!("{}: {e}", path.display())))?;
        let tmp = path.with_extension(format!(
            "tmp-{}-{}",
            std::process::id(),
            NEXT_TMP.fetch_add(1, Ordering::Relaxed)
        ));
        let write_result = (|| -> Result<(), SettingsError> {
            let mut file = File::create(&tmp)
                .map_err(|e| SettingsError::Storage(format!("{}: {e}", tmp.display())))?;
            file.write_all(json.as_bytes())
                .map_err(|e| SettingsError::Storage(format!("{}: {e}", tmp.display())))?;
            file.sync_all()
                .map_err(|e| SettingsError::Storage(format!("{}: {e}", tmp.display())))?;
            drop(file);
            replace_file(&tmp, path).map_err(|e| {
                SettingsError::Storage(format!(
                    "{}: failed to atomically replace from {}: {e}",
                    path.display(),
                    tmp.display()
                ))
            })?;
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        write_result
    }

    #[cfg(test)]
    pub fn fail_next_persist(&self) {
        self.fail_next_persist.store(true, Ordering::SeqCst);
    }
}

#[cfg(not(windows))]
fn replace_file(tmp: &Path, path: &Path) -> std::io::Result<()> {
    fs::rename(tmp, path)
}

#[cfg(windows)]
fn replace_file(tmp: &Path, path: &Path) -> std::io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut c_void,
            reserved: *mut c_void,
        ) -> i32;
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    let tmp_wide = wide(tmp);
    let path_wide = wide(path);
    let replaced = if path.exists() {
        unsafe {
            ReplaceFileW(
                path_wide.as_ptr(),
                tmp_wide.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        }
    } else {
        unsafe {
            MoveFileExW(
                tmp_wide.as_ptr(),
                path_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING,
            )
        }
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

static NEXT_TMP: AtomicU64 = AtomicU64::new(1);

pub struct SettingsService {
    store: SettingsStore,
    secrets: Arc<dyn SecretStore>,
    state: RwLock<SettingsState>,
}

impl SettingsService {
    pub fn new(paths: SettingsPaths, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            store: SettingsStore::new(paths),
            secrets,
            state: RwLock::new(SettingsState::default()),
        }
    }

    pub fn initialize_blocking(&self) -> Result<(), SettingsError> {
        validate_descriptor_catalog().map_err(SettingsError::Validation)?;
        run_legacy_migration(&self.store, self.secrets.as_ref())?;
        let user_document = self
            .store
            .read(self.store.paths().user(), SettingsScope::User)?
            .unwrap_or_default();
        let mut state = self
            .state
            .write()
            .map_err(|e| SettingsError::Storage(e.to_string()))?;
        state.initialized = true;
        state.user_document = user_document;
        state.revision = state.revision.saturating_add(1);
        Ok(())
    }

    pub fn effective_document_blocking(
        &self,
        project_root: Option<&Path>,
    ) -> Result<EffectiveSettings, SettingsError> {
        let state = self
            .state
            .read()
            .map_err(|e| SettingsError::Storage(e.to_string()))?;
        if !state.initialized {
            return Err(SettingsError::NotInitialized);
        }
        let user = state.user_document.clone();
        drop(state);

        let mut documents = Vec::new();
        if let Some(document) = self
            .store
            .read(self.store.paths().managed(), SettingsScope::Managed)?
        {
            documents.push(LayeredDocument {
                scope: SettingsScope::Managed,
                path: Some(self.store.paths().managed().to_path_buf()),
                document,
            });
        }
        documents.push(LayeredDocument {
            scope: SettingsScope::User,
            path: Some(self.store.paths().user().to_path_buf()),
            document: user,
        });

        if let Some(path) = self.store.paths().project_shared(project_root) {
            if let Some(document) = self.store.read(&path, SettingsScope::Project)? {
                documents.push(LayeredDocument {
                    scope: SettingsScope::Project,
                    path: Some(path),
                    document,
                });
            }
        }
        if let Some(path) = self.store.paths().project_local(project_root) {
            if let Some(document) = self.store.read(&path, SettingsScope::Local)? {
                documents.push(LayeredDocument {
                    scope: SettingsScope::Local,
                    path: Some(path),
                    document,
                });
            }
        }

        let mut values = Value::Object(Map::new());
        for layer in &documents {
            merge_values(&mut values, &Value::Object(layer.document.values.clone()));
        }
        Ok(EffectiveSettings { documents, values })
    }

    pub fn mutate_scope_blocking<F>(
        &self,
        scope: SettingsScope,
        project: Option<&Path>,
        f: F,
    ) -> Result<MutationResult, SettingsError>
    where
        F: FnOnce(&mut SettingsDocument) -> Result<(), SettingsError>,
    {
        let path = self.path_for_mutable_scope(scope, project)?;
        let mut candidate = self.store.read(&path, scope)?.unwrap_or_default();
        validate_document(&candidate, scope)?;
        f(&mut candidate)?;
        validate_document(&candidate, scope)?;
        self.store.write_atomic(&path, &candidate, scope)?;

        let mut state = self
            .state
            .write()
            .map_err(|e| SettingsError::Storage(e.to_string()))?;
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        if scope == SettingsScope::User {
            state.user_document = candidate;
            state.initialized = true;
        }
        Ok(MutationResult {
            scope,
            path,
            revision,
        })
    }

    fn path_for_mutable_scope(
        &self,
        scope: SettingsScope,
        project: Option<&Path>,
    ) -> Result<PathBuf, SettingsError> {
        match scope {
            SettingsScope::User => Ok(self.store.paths().user().to_path_buf()),
            SettingsScope::Project => self
                .store
                .paths()
                .project_shared(project)
                .ok_or(SettingsError::MissingProjectRoot(SettingsScope::Project))
                .and_then(|path| ensure_scope_writable(scope, path)),
            SettingsScope::Local => self
                .store
                .paths()
                .project_local(project)
                .ok_or(SettingsError::MissingProjectRoot(SettingsScope::Local))
                .and_then(|path| ensure_scope_writable(scope, path)),
            SettingsScope::Managed | SettingsScope::Session => {
                Err(SettingsError::ReadOnlyScope(scope))
            }
        }
    }

    pub fn paths(&self) -> &SettingsPaths {
        self.store.paths()
    }

    pub fn secrets(&self) -> &Arc<dyn SecretStore> {
        &self.secrets
    }

    // Test-only assertion helper (used by store_test to verify the in-memory
    // cache survives atomic-write failures / idempotent migration).
    #[cfg(test)]
    pub fn cached_theme(&self) -> String {
        self.state
            .read()
            .ok()
            .and_then(|state| {
                state
                    .user_document
                    .values
                    .get("settings")
                    .and_then(Value::as_object)
                    .and_then(|settings| settings.get("theme"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "warm-dark".to_string())
    }

    /// Current monotonic settings revision. Bumped on every successful
    /// `mutate_scope_blocking`; used as the `PermissionPolicySnapshot.revision`
    /// so the sidecar can reject stale snapshots.
    pub fn current_revision(&self) -> Result<u64, SettingsError> {
        let state = self
            .state
            .read()
            .map_err(|e| SettingsError::Storage(e.to_string()))?;
        Ok(state.revision)
    }

    #[cfg(test)]
    pub fn fail_next_persist_for_test(&self) {
        self.store.fail_next_persist();
    }
}

fn ensure_scope_writable(scope: SettingsScope, path: PathBuf) -> Result<PathBuf, SettingsError> {
    let parent = path
        .parent()
        .ok_or_else(|| SettingsError::Storage(format!("{} has no parent", path.display())))?;
    fs::create_dir_all(parent).map_err(|_| SettingsError::ScopeNotWritable {
        scope,
        path: path.clone(),
    })?;
    if !parent.is_dir() {
        return Err(SettingsError::ScopeNotWritable { scope, path });
    }

    let probe = parent.join(format!(
        ".aide-write-probe-{}-{}.tmp",
        std::process::id(),
        NEXT_TMP.fetch_add(1, Ordering::Relaxed)
    ));
    let probe_result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?;
        file.write_all(b"probe")?;
        file.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(&probe);
    if probe_result.is_err() {
        return Err(SettingsError::ScopeNotWritable { scope, path });
    }

    Ok(path)
}

pub fn validate_document(
    document: &SettingsDocument,
    scope: SettingsScope,
) -> Result<(), SettingsError> {
    if document.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err(SettingsError::Validation(format!(
            "unsupported settings schema version: {}",
            document.schema_version
        )));
    }

    let values = Value::Object(document.values.clone());
    for descriptor in all_descriptors() {
        validate_descriptor_value(&values, descriptor, scope)?;
    }
    validate_permission_rules(document, scope)
}

fn validate_descriptor_value(
    root: &Value,
    descriptor: &SettingDescriptor,
    scope: SettingsScope,
) -> Result<(), SettingsError> {
    fn walk(
        value: &Value,
        parts: &[&str],
        descriptor: &SettingDescriptor,
        scope: SettingsScope,
    ) -> Result<(), SettingsError> {
        if parts.is_empty() {
            if scope != SettingsScope::Managed && !descriptor.scopes.contains(&scope) {
                return Err(SettingsError::Validation(format!(
                    "setting is not allowed in {scope:?} scope: {}",
                    descriptor.id
                )));
            }
            let valid_kind = match descriptor.kind {
                SettingValueKind::String => value.is_string(),
                SettingValueKind::Number => value.is_number(),
                SettingValueKind::Boolean => value.is_boolean(),
                SettingValueKind::Array => value.is_array(),
                SettingValueKind::Object => value.is_object(),
                SettingValueKind::Secret => value.is_null(),
            };
            if !valid_kind {
                return Err(SettingsError::Validation(format!(
                    "invalid value type for setting: {}",
                    descriptor.id
                )));
            }
            return Ok(());
        }

        let part = parts[0];
        if let Some(array_key) = part.strip_suffix("[]") {
            let Some(items) = value.get(array_key) else {
                return Ok(());
            };
            let Some(items) = items.as_array() else {
                return Err(SettingsError::Validation(format!(
                    "invalid value type for setting: {}",
                    descriptor.id
                )));
            };
            for item in items {
                walk(item, &parts[1..], descriptor, scope)?;
            }
            Ok(())
        } else if let Some(next) = value.get(part) {
            walk(next, &parts[1..], descriptor, scope)
        } else {
            Ok(())
        }
    }

    walk(
        root,
        &descriptor.id.split('.').collect::<Vec<_>>(),
        descriptor,
        scope,
    )
}

fn validate_permission_rules(
    document: &SettingsDocument,
    scope: SettingsScope,
) -> Result<(), SettingsError> {
    let descriptor = all_descriptors()
        .iter()
        .find(|entry| entry.id == "permissions.rules")
        .expect("permission descriptor must exist");
    if scope != SettingsScope::Managed && !descriptor.scopes.contains(&scope) {
        return Err(SettingsError::Validation(format!(
            "permissions are not allowed in {scope:?} scope"
        )));
    }

    let mut ids = std::collections::BTreeSet::new();
    let mut orders = std::collections::BTreeSet::new();
    for rule in &document.permissions.rules {
        if !is_uuid(&rule.id) {
            return Err(SettingsError::Validation(
                "permission rule id must be a UUID".to_string(),
            ));
        }
        if !ids.insert(&rule.id) {
            return Err(SettingsError::Validation(
                "permission rule ids must be unique".to_string(),
            ));
        }
        if rule.tool.trim().is_empty() {
            return Err(SettingsError::Validation(
                "permission rule tool must not be empty".to_string(),
            ));
        }
        if !rule.matcher.is_object() {
            return Err(SettingsError::Validation(
                "permission rule matcher must be an object".to_string(),
            ));
        }
        if !orders.insert(rule.order) {
            return Err(SettingsError::Validation(
                "permission rule order must be unique".to_string(),
            ));
        }
    }
    Ok(())
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|&index| bytes[index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

pub fn validate_legacy_config(value: &Value) -> Result<(), SettingsError> {
    if !value.is_object() && !value.is_null() {
        return Err(SettingsError::Validation(
            "legacy settings root must be an object".to_string(),
        ));
    }
    Ok(())
}

fn merge_values(target: &mut Value, source: &Value) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                merge_values(target.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (target, source) => *target = source.clone(),
    }
}
