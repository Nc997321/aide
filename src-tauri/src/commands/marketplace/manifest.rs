use serde::{Deserialize, Serialize};

use crate::commands::marketplace::sources::RawPluginEntry;

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

// ── Availability classification (list-time) ──

const UNSUPPORTED: &[&str] = &["lsp_servers", "output_styles", "themes", "monitors"];
const SUPPORTED: &[&str] = &["skills", "commands", "agents", "hooks", "mcp_servers"];

fn has(entry: &RawPluginEntry, field: &str) -> bool {
    match field {
        "skills" => entry.skills.is_some(),
        "commands" => entry.commands.is_some(),
        "agents" => entry.agents.is_some(),
        "hooks" => entry.hooks.is_some(),
        "mcp_servers" => entry.mcp_servers.is_some(),
        "lsp_servers" => entry.lsp_servers.is_some(),
        "output_styles" => entry.output_styles.is_some(),
        "themes" => entry.themes.is_some(),
        "monitors" => entry.monitors.is_some(),
        _ => false,
    }
}

/// List-time availability: based solely on inline component fields.
pub fn classify_availability(entry: &RawPluginEntry) -> (String, Vec<String>) {
    let any_supported = SUPPORTED.iter().any(|f| has(entry, f));
    let unsupported_present: Vec<String> = UNSUPPORTED
        .iter()
        .filter(|f| has(entry, f))
        .map(|s| s.to_string())
        .collect();
    if unsupported_present.is_empty() {
        return ("available".into(), vec![]);
    }
    if any_supported {
        return ("mixed".into(), unsupported_present);
    }
    ("unavailable".into(), unsupported_present)
}

// ── Detail structs (detail-time) ──

#[derive(Serialize)]
pub struct PluginComponent {
    #[serde(rename = "type")]
    pub r#type: String,
    pub available: bool,
}

#[derive(Serialize)]
pub struct PluginDetails {
    pub name: String,
    pub components: Vec<PluginComponent>,
}

/// Detail-time component list from a marketplace entry's inline fields.
/// available = type is in the SDK-supported set.
pub fn build_details_from_entry(entry: &RawPluginEntry) -> PluginDetails {
    let fields = [
        "skills", "commands", "agents", "hooks", "mcp_servers",
        "lsp_servers", "output_styles", "themes", "monitors",
    ];
    let components = fields.into_iter()
        .filter(|f| has(entry, f))
        .map(|f| PluginComponent {
            r#type: f.to_string(),
            available: SUPPORTED.contains(&f),
        })
        .collect();
    PluginDetails { name: entry.name.clone(), components }
}
