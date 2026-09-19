use crate::commands::marketplace::sources::RawPluginEntry;

// ── Availability classification (list-time) ──

const UNSUPPORTED: &[&str] = &["output_styles", "themes", "monitors"];
const SUPPORTED: &[&str] = &[
    "skills",
    "commands",
    "agents",
    "hooks",
    "mcp_servers",
    "lsp_servers",
];

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

/// 这个插件声明了语言服务器吗（marketplace.json 的 `lspServers` 字段）。
///
/// 判据走 `has()`，与 classify_availability 共用同一张组件表——「lsp_servers 算哪个
/// 字段」只在这一个地方写。前端据此给插件卡加一行「已由 Aide 接管」说明：C3 起
/// aide-lsp 会在受信任工作区退役这些插件（运行时抑制，见 spec § C3），卡片上却仍
/// 显示「已启用」，不说明用户无从理解「我开着它为什么没有」。
pub fn provides_lsp(entry: &RawPluginEntry) -> bool {
    has(entry, "lsp_servers")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::marketplace::sources::RawPluginEntry;

    fn entry(field: &str) -> RawPluginEntry {
        let mut e = RawPluginEntry {
            name: "t".into(),
            ..RawPluginEntry::default()
        };
        match field {
            "lsp_servers" => e.lsp_servers = Some(serde_json::json!({})),
            "skills" => e.skills = Some(serde_json::json!({})),
            "output_styles" => e.output_styles = Some(serde_json::json!({})),
            "themes" => e.themes = Some(serde_json::json!({})),
            _ => unreachable!("测试未覆盖的组件字段"),
        }
        e
    }

    #[test]
    fn lsp_only_plugin_is_available() {
        let (avail, unsup) = classify_availability(&entry("lsp_servers"));
        assert_eq!(avail, "available");
        assert!(unsup.is_empty());
    }

    #[test]
    fn lsp_plus_skills_is_available_not_mixed() {
        let mut e = entry("lsp_servers");
        e.skills = Some(serde_json::json!({}));
        let (avail, unsup) = classify_availability(&e);
        assert_eq!(avail, "available");
        assert!(unsup.is_empty());
    }

    #[test]
    fn provides_lsp_tracks_the_lsp_servers_field() {
        assert!(provides_lsp(&entry("lsp_servers")));
        // 别的组件不算——否则插件卡会给一堆无关插件挂「已由 Aide 接管」。
        // 只取 entry() 覆盖到的字段（它的 unreachable 是刻意的守卫，不在这里扩表）。
        for other in ["skills", "themes", "output_styles"] {
            assert!(!provides_lsp(&entry(other)), "{other} 不该被判成提供 LSP");
        }
        assert!(!provides_lsp(&RawPluginEntry {
            name: "bare".into(),
            ..RawPluginEntry::default()
        }));
    }

    #[test]
    fn unsupported_only_is_unavailable() {
        let (avail, unsup) = classify_availability(&entry("output_styles"));
        assert_eq!(avail, "unavailable");
        assert_eq!(unsup, vec!["output_styles".to_string()]);
    }

    #[test]
    fn supported_plus_unsupported_is_mixed() {
        let mut e = entry("skills");
        e.themes = Some(serde_json::json!({}));
        let (avail, unsup) = classify_availability(&e);
        assert_eq!(avail, "mixed");
        assert_eq!(unsup, vec!["themes".to_string()]);
    }
}
