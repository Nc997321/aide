mod descriptors;
mod migration;
mod schema;
mod secrets;
mod store;

#[cfg(test)]
mod schema_test;
#[cfg(test)]
mod store_test;

#[cfg(test)]
pub(crate) use descriptors::validate_descriptor_entries;
pub use descriptors::{
    all_descriptors, descriptor, descriptor_for_legacy_id, validate_descriptor_catalog,
    SettingDescriptor, SettingValueKind,
};
pub use migration::run_legacy_migration;
pub use schema::{
    PermissionEffect, PermissionSection, SettingsDocument, SettingsScope, StoredPermissionRule,
    SETTINGS_SCHEMA_VERSION,
};
#[cfg(test)]
pub use secrets::MemorySecretStore;
pub use secrets::{KeyringSecretStore, SecretMutation, SecretStore};
pub use store::{
    EffectiveSettings, LayeredDocument, MutationResult, SettingsPaths, SettingsService,
    SettingsStore,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsError {
    NotInitialized,
    Storage(String),
    Secrets(String),
    Validation(String),
    ReadOnlyScope(SettingsScope),
    MissingProjectRoot(SettingsScope),
    ScopeNotWritable {
        scope: SettingsScope,
        path: std::path::PathBuf,
    },
}

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SettingsError::NotInitialized => write!(f, "settings service is not initialized"),
            SettingsError::Storage(message) => write!(f, "settings storage error: {message}"),
            SettingsError::Secrets(message) => write!(f, "settings secret store error: {message}"),
            SettingsError::Validation(message) => write!(f, "settings validation error: {message}"),
            SettingsError::ReadOnlyScope(scope) => {
                write!(f, "settings scope is read-only: {scope:?}")
            }
            SettingsError::MissingProjectRoot(scope) => {
                write!(f, "settings scope requires a project root: {scope:?}")
            }
            SettingsError::ScopeNotWritable { scope, path } => {
                write!(
                    f,
                    "settings scope is not writable: {scope:?} at {}",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for SettingsError {}
