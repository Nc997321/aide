use crate::commands::marketplace::sources::RawPluginEntry;

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
