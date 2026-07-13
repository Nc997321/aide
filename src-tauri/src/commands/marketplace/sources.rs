use serde::Deserialize;

use super::PluginEntry;

// ── Raw deserialization types for official marketplace.json ──
// source can be:
//   { source: "url",        url: "https://github.com/..." }         — external plugin
//   { source: "git-subdir", url: "owner/repo", path: "...", ... }   — subdir of another repo
//   "./relative/path"                                                — bundled in marketplace

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum RawSource {
    Object {
        #[serde(default)]
        source: String,
        #[serde(default)]
        url: String,
        #[serde(default)]
        #[allow(dead_code)]
        path: String,
    },
    Bundled(String),       // "./relative/path" string
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawPluginEntry {
    name: String,
    #[serde(default)]
    description: String,
    source: Option<RawSource>,
    #[serde(default)]
    homepage: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RegistryManifest {
    pub(crate) plugins: Vec<RawPluginEntry>,
}

// ── Conversion ──

impl From<RawPluginEntry> for PluginEntry {
    fn from(raw: RawPluginEntry) -> Self {
        let repo = match raw.source {
            Some(RawSource::Object { ref url, path: _, ref source, .. }) => {
                // "url" type: url is the full git clone URL
                // "git-subdir" type: url is "owner/repo", construct full GitHub URL
                if source == "git-subdir" && !url.starts_with("http") {
                    // url looks like "owner/repo" — prepend github.com
                    format!("https://github.com/{}.git", url.trim_end_matches('/'))
                } else {
                    url.clone()
                }
            }
            Some(RawSource::Bundled(path)) => path,
            None => String::new(),
        };
        PluginEntry {
            name: raw.name,
            description: raw.description,
            repo,
            homepage: raw.homepage,
        }
    }
}
