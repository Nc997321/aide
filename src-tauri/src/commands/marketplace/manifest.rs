use serde::Deserialize;

// ── Plugin manifest (for installed plugins) ──

#[derive(Debug, Deserialize)]
pub(crate) struct PluginManifest {
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) description: String,
    #[serde(default)]
    pub(crate) author: String,
}
