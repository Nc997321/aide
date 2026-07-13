use serde::Serialize;
use serde_json::Value;

// ── SourceInfo for fixed marketplace sources ──

#[derive(Debug, Serialize, Clone)]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub enabled: bool,
}

/// 固定预置市场源（不可自加）。(source_id, owner/repo, 默认市场名, 默认启用)
pub const FIXED_SOURCES: &[(&str, &str, &str, bool)] = &[
    ("claude-plugins-official", "anthropics/claude-plugins-official", "claude-plugins-official", true),
    ("claude-community", "anthropics/claude-plugins-community", "claude-community", true),
];

pub fn default_market_name(source_id: &str) -> Option<&'static str> {
    FIXED_SOURCES.iter().find(|(id, _, _, _)| *id == source_id).map(|(_, _, n, _)| *n)
}
pub fn fixed_repo(source_id: &str) -> Option<&'static str> {
    FIXED_SOURCES.iter().find(|(id, _, _, _)| *id == source_id).map(|(_, r, _, _)| *r)
}

// ── Raw deserialization types for official marketplace.json ──
// source can be:
//   { source: "github",     repo: "o/r", ref: "v1", sha: "..." }     — GitHub repo
//   { source: "url",        url: "https://gitlab.com/x/y.git" }       — arbitrary git URL
//   { source: "git-subdir", url: "o/r", path: "p/d", sha: "..." }    — subdir of another repo
//   { source: "npm",        package: "@o/e", version: "^1.0" }       — npm package
//   "./relative/path"                                                  — bundled in marketplace

/// 5 种 plugin source（官方 marketplace.json schema）
#[derive(Debug)]
pub enum RawSource {
    Relative(String),
    Github { repo: String, r#ref: Option<String>, sha: Option<String> },
    Url { url: String, r#ref: Option<String>, sha: Option<String> },
    GitSubdir { url: String, path: String, r#ref: Option<String>, sha: Option<String> },
    Npm { package: String, version: Option<String> },
    /// 未知源类型：marketplace.json 出现了 schema 未覆盖的 source.kind。
    /// 列表期照常展示（可用性按内联组件字段判定），安装期以 SOURCE_TYPE_UNSUPPORTED 拒绝。
    Unknown,
}

#[derive(Debug, Default)]
pub struct RawPluginEntry {
    pub name: String,
    pub source: Option<RawSource>,
    // 元数据
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub author: Option<Value>,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub default_enabled: Option<bool>,
    // 内联组件字段（仅判断有无，内容透传给详情页）
    pub skills: Option<Value>,
    pub commands: Option<Value>,
    pub agents: Option<Value>,
    pub hooks: Option<Value>,
    pub mcp_servers: Option<Value>,
    pub lsp_servers: Option<Value>,
    pub output_styles: Option<Value>,
    pub themes: Option<Value>,
    pub monitors: Option<Value>,
}

#[derive(Debug, Default)]
pub struct MarketplaceMetadata {
    pub plugin_root: Option<String>,
}

#[derive(Debug, Default)]
pub struct MarketplaceManifest {
    pub name: String,
    pub owner: Option<Value>,
    pub plugins: Vec<RawPluginEntry>,
    pub metadata: Option<MarketplaceMetadata>,
}

pub fn parse_marketplace_json(content: &str) -> Result<MarketplaceManifest, String> {
    let v: Value = serde_json::from_str(content).map_err(|e| format!("Failed to parse marketplace JSON: {e}"))?;
    let name = v["name"].as_str().unwrap_or("").to_string();
    let owner = v.get("owner").cloned();
    let metadata = v.get("metadata").map(|m| MarketplaceMetadata {
        plugin_root: m["pluginRoot"].as_str().map(|s| s.to_string()),
    });
    let mut plugins = Vec::new();
    if let Some(arr) = v["plugins"].as_array() {
        for p in arr {
            plugins.push(parse_entry(p));
        }
    }
    Ok(MarketplaceManifest { name, owner, plugins, metadata })
}

fn parse_entry(p: &Value) -> RawPluginEntry {
    let src = p.get("source").map(|s| parse_source(s));
    RawPluginEntry {
        name: p["name"].as_str().unwrap_or("").to_string(),
        source: src,
        display_name: p.get("displayName").and_then(|v| v.as_str()).map(|s| s.to_string()),
        description: p.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
        version: p.get("version").and_then(|v| v.as_str()).map(|s| s.to_string()),
        author: p.get("author").cloned(),
        homepage: p.get("homepage").and_then(|v| v.as_str()).map(|s| s.to_string()),
        repository: p.get("repository").and_then(|v| v.as_str()).map(|s| s.to_string()),
        category: p.get("category").and_then(|v| v.as_str()).map(|s| s.to_string()),
        tags: p.get("tags").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()),
        default_enabled: p.get("defaultEnabled").and_then(|v| v.as_bool()),
        skills: p.get("skills").cloned(),
        commands: p.get("commands").cloned(),
        agents: p.get("agents").cloned(),
        hooks: p.get("hooks").cloned(),
        mcp_servers: p.get("mcpServers").cloned(),
        lsp_servers: p.get("lspServers").cloned(),
        output_styles: p.get("outputStyles").cloned(),
        themes: p.get("themes").cloned(),
        monitors: p.get("monitors").cloned(),
    }
}

fn parse_source(s: &Value) -> RawSource {
    if let Some(str_path) = s.as_str() {
        return RawSource::Relative(str_path.to_string());
    }
    let kind = s["source"].as_str().unwrap_or("");
    match kind {
        "github" => RawSource::Github {
            repo: s["repo"].as_str().unwrap_or("").to_string(),
            r#ref: s["ref"].as_str().map(String::from),
            sha: s["sha"].as_str().map(String::from),
        },
        "url" => RawSource::Url {
            url: s["url"].as_str().unwrap_or("").to_string(),
            r#ref: s["ref"].as_str().map(String::from),
            sha: s["sha"].as_str().map(String::from),
        },
        "git-subdir" => RawSource::GitSubdir {
            url: s["url"].as_str().unwrap_or("").to_string(),
            path: s["path"].as_str().unwrap_or("").to_string(),
            r#ref: s["ref"].as_str().map(String::from),
            sha: s["sha"].as_str().map(String::from),
        },
        "npm" => RawSource::Npm {
            package: s["package"].as_str().unwrap_or("").to_string(),
            version: s["version"].as_str().map(String::from),
        },
        _ => RawSource::Unknown, // 未知源类型：安装期报 SOURCE_TYPE_UNSUPPORTED（见 resolve_and_install）
    }
}

/// 相对源拼 pluginRoot 前缀（已是 ./x 则原样返回）
pub fn resolve_relative(source: &str, plugin_root: Option<&str>) -> String {
    if source.starts_with("./") || source.is_empty() {
        return source.to_string();
    }
    match plugin_root {
        Some(root) => {
            let root = root.trim_end_matches('/');
            format!("{}/{}", root, source)
        }
        None => source.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_five_source_types() {
        let j = r#"{
          "name":"m","owner":{"name":"o"},
          "metadata":{"pluginRoot":"./plugins"},
          "plugins":[
            {"name":"a","source":"./plugins/a"},
            {"name":"b","source":{"source":"github","repo":"o/r","ref":"v1","sha":"0123456789abcdef0123456789abcdef01234567"}},
            {"name":"c","source":{"source":"url","url":"https://gitlab.com/x/y.git"}},
            {"name":"d","source":{"source":"git-subdir","url":"o/r","path":"p/d","sha":"0123456789abcdef0123456789abcdef01234567"}},
            {"name":"e","source":{"source":"npm","package":"@o/e","version":"^1.0"}}
          ]
        }"#;
        let m = parse_marketplace_json(j).unwrap();
        assert_eq!(m.name, "m");
        assert_eq!(m.plugins.len(), 5);
        assert!(matches!(m.plugins[0].source.as_ref().unwrap(), RawSource::Relative(s) if s=="./plugins/a"));
        assert!(matches!(m.plugins[1].source.as_ref().unwrap(), RawSource::Github{repo,..} if repo=="o/r"));
        assert!(matches!(m.plugins[2].source.as_ref().unwrap(), RawSource::Url{url,..} if url.contains("gitlab")));
        assert!(matches!(m.plugins[3].source.as_ref().unwrap(), RawSource::GitSubdir{path,..} if path=="p/d"));
        assert!(matches!(m.plugins[4].source.as_ref().unwrap(), RawSource::Npm{package,..} if package=="@o/e"));
        assert_eq!(m.metadata.as_ref().unwrap().plugin_root.as_deref(), Some("./plugins"));
    }

    #[test]
    fn plugin_root_prepended_to_relative_short_source() {
        assert_eq!(resolve_relative("a", Some("./plugins")), "./plugins/a");
        assert_eq!(resolve_relative("./plugins/a", Some("./plugins")), "./plugins/a");
        assert_eq!(resolve_relative("a", None), "a");
    }

    #[test]
    fn reads_inlined_component_fields() {
        let j = r#"{"name":"m","owner":{"name":"o"},"plugins":[
          {"name":"lsp","source":{"source":"github","repo":"o/l"},"lspServers":{"go":{"command":"gopls","extensionToLanguage":{".go":"go"}}}},
          {"name":"mix","source":{"source":"github","repo":"o/x"},"skills":["./s/"],"lspServers":{"x":{"command":"x","extensionToLanguage":{".x":"x"}}}}
        ]}"#;
        let m = parse_marketplace_json(j).unwrap();
        assert!(m.plugins[0].lsp_servers.is_some());
        assert!(m.plugins[0].skills.is_none());
        assert!(m.plugins[1].skills.is_some() && m.plugins[1].lsp_servers.is_some());
    }

    #[test]
    fn parses_real_official_entry_shape() {
        let j = r#"{"name":"claude-plugins-official","owner":{"name":"Anthropic"},"plugins":[
          {"name":"agent-sdk-dev","source":"./plugins/agent-sdk-dev","category":"development","homepage":"x"}]}"#;
        let m = parse_marketplace_json(j).unwrap();
        assert_eq!(m.plugins[0].category.as_deref(), Some("development"));
        assert!(matches!(m.plugins[0].source.as_ref().unwrap(), RawSource::Relative(s) if s=="./plugins/agent-sdk-dev"));
    }

    #[test]
    fn unknown_source_kind_parses_to_unknown_not_relative() {
        // 未知 source.kind 不应静默退化为空 Relative（会触发整目录 copy），而应保留为 Unknown，
        // 安装期由 resolve_and_install 以 SOURCE_TYPE_UNSUPPORTED 拒绝。列表期照常展示。
        let j = r#"{"name":"m","owner":{"name":"o"},"plugins":[
          {"name":"weird","source":{"source":"future-kind","repo":"o/r"}}]}"#;
        let m = parse_marketplace_json(j).unwrap();
        assert!(matches!(m.plugins[0].source.as_ref().unwrap(), RawSource::Unknown));
    }
}
