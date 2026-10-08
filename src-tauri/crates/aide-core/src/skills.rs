use serde::{Deserialize, Serialize};
use std::path::Path;

// ── 公共数据类型 ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    /// "user" | "project" | "plugin:superpowers"
    pub source: String,
    /// SKILL.md 绝对路径，前端读取内容时使用
    pub file_path: String,
    /// "claude" | 未来扩展: "codex" | "opencode"
    pub provider: String,
}

// ── Provider trait ────────────────────────────────────────────────────────

pub trait SkillProvider: Send + Sync {
    fn provider_name(&self) -> &str;
    fn scan(&self, cwd: &Path) -> Vec<SkillMeta>;
}

// ── SkillRegistry ─────────────────────────────────────────────────────────

pub struct SkillRegistry {
    providers: Vec<Box<dyn SkillProvider>>,
}

impl SkillRegistry {
    pub fn new() -> Self {
        let mut r = Self { providers: vec![] };
        r.providers.push(Box::new(ClaudeSkillProvider));
        r
    }

    /// provider 为 None 时返回所有已注册 provider 的 skills
    pub fn list(&self, provider: Option<&str>, cwd: &Path) -> Vec<SkillMeta> {
        self.providers
            .iter()
            .filter(|p| provider.map_or(true, |name| p.provider_name() == name))
            .flat_map(|p| p.scan(cwd))
            .collect()
    }
}

// ── ClaudeSkillProvider ───────────────────────────────────────────────────

pub struct ClaudeSkillProvider;

impl SkillProvider for ClaudeSkillProvider {
    fn provider_name(&self) -> &str {
        "claude"
    }

    fn scan(&self, cwd: &Path) -> Vec<SkillMeta> {
        let mut skills = Vec::new();

        // 1. 用户级：<claude_home>/skills/*/SKILL.md（claude_home 指向 Aide 自管理目录
        //    下的 claude/ 子目录，与 customizations.rs 的 skills_dir() 一致）
        let user_skills = crate::paths::claude_home().join("skills");
        skills.extend(scan_dir(&user_skills, "user", "claude"));

        // 2. 项目级：{cwd}/.aide/claude/skills/*/SKILL.md（Aide 约定：项目数据在 .aide/
        //    下，与用户级 ~/.aide/claude/skills 同构）。注：SDK 隔离模式（settingSources:[]）
        //    不自动发现项目 skills，这里仅供 UI 下拉展示与信任门控扫描。
        let project_skills = cwd.join(".aide").join("claude").join("skills");
        skills.extend(scan_dir(&project_skills, "project", "claude"));

        // 3. 插件级：只列会话真实注入的插件。sidecar 经 env AIDE_ENABLED_PLUGINS_FILE
        //    读 enabled-plugins.json 清单加载插件（SDK 不自动扫描任何固定目录），
        //    下拉读同一份清单，保证展示的 == 会话里真实可用的。
        //    不扫 claude_home/plugins/cache：那是 CLI 风格缓存目录，未启用/已卸载
        //    插件的残留文件也在里面，扫它会列出会话中根本不存在的 skills。
        let manifest = crate::commands::marketplace::enabled_plugins_manifest_path();
        skills.extend(scan_enabled_plugins(&manifest, "claude"));

        skills
    }
}

// ── 内部扫描工具函数 ──────────────────────────────────────────────────────

/// 扫描 `skills_dir/*/SKILL.md`，每个子目录一个 skill
fn scan_dir(skills_dir: &Path, source: &str, provider: &str) -> Vec<SkillMeta> {
    let mut result = Vec::new();
    let Ok(entries) = std::fs::read_dir(skills_dir) else {
        return result;
    };
    for entry in entries.flatten() {
        let skill_file = entry.path().join("SKILL.md");
        if !skill_file.is_file() {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&skill_file) else {
            continue;
        };
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let (name, description) = parse_frontmatter(&content);
        result.push(SkillMeta {
            name: name.unwrap_or_else(|| dir_name.clone()),
            description: description.unwrap_or_default(),
            source: source.to_string(),
            file_path: skill_file.to_string_lossy().replace('\\', "/"),
            provider: provider.to_string(),
        });
    }
    result
}

/// 从 enabled-plugins.json 清单扫描插件 skills：清单条目的 path 指向插件版本目录，
/// 扫其下 skills/*/SKILL.md。清单缺失/损坏时返回空——此时会话也不会注入任何插件，
/// 下拉为空正好与会话一致。
fn scan_enabled_plugins(manifest_path: &Path, provider: &str) -> Vec<SkillMeta> {
    #[derive(Deserialize)]
    struct ManifestEntry {
        name: String,
        path: String,
    }
    let Ok(content) = std::fs::read_to_string(manifest_path) else {
        return Vec::new();
    };
    let Ok(entries) = serde_json::from_str::<Vec<ManifestEntry>>(&content) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for entry in entries {
        let source = format!("plugin:{}", entry.name);
        let skills_dir = Path::new(&entry.path).join("skills");
        result.extend(scan_dir(&skills_dir, &source, provider));
    }
    result
}

/// 解析 SKILL.md YAML frontmatter，返回 (name, description)
/// frontmatter 格式：以 `---` 开头，以 `\n---` 结束
pub fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let content = content.trim_start();
    if !content.starts_with("---") {
        return (None, None);
    }
    let after = &content[3..];
    let end = match after.find("\n---") {
        Some(p) => p,
        None => return (None, None),
    };
    let fm = &after[..end];
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    for line in fm.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("name:") {
            let v = v.trim().trim_matches('"').trim_matches('\'');
            name = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("description:") {
            let v = v.trim().trim_matches('"').trim_matches('\'');
            // 截断至 120 字符供 UI 展示
            let v = if v.chars().count() > 120 {
                v.chars().take(120).collect::<String>()
            } else {
                v.to_string()
            };
            description = Some(v);
        }
    }
    (name, description)
}

// ── 单元测试 ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_skill_dir(root: &Path, name: &str, content: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), content).unwrap();
    }

    #[test]
    fn test_parse_frontmatter_basic() {
        let content = "---\nname: my-skill\ndescription: \"Does something useful\"\n---\n# Body";
        let (name, desc) = parse_frontmatter(content);
        assert_eq!(name, Some("my-skill".to_string()));
        assert_eq!(desc, Some("Does something useful".to_string()));
    }

    #[test]
    fn test_parse_frontmatter_missing() {
        let content = "# No frontmatter here";
        let (name, desc) = parse_frontmatter(content);
        assert_eq!(name, None);
        assert_eq!(desc, None);
    }

    #[test]
    fn test_parse_frontmatter_single_quotes() {
        let content = "---\nname: 'quoted'\ndescription: 'single quoted'\n---\n";
        let (name, _) = parse_frontmatter(content);
        assert_eq!(name, Some("quoted".to_string()));
    }

    #[test]
    fn test_parse_frontmatter_truncates_description() {
        let long_desc = "x".repeat(200);
        let content = format!("---\nname: x\ndescription: \"{long_desc}\"\n---\n");
        let (_, desc) = parse_frontmatter(&content);
        assert_eq!(desc.unwrap().chars().count(), 120);
    }

    #[test]
    fn test_scan_dir_finds_skills() {
        let tmp = std::env::temp_dir().join(format!("aide-test-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();

        make_skill_dir(
            &tmp,
            "brainstorming",
            "---\nname: brainstorming\ndescription: \"Brainstorm ideas\"\n---\n# Content",
        );
        make_skill_dir(
            &tmp,
            "debugging",
            "---\nname: systematic-debugging\ndescription: \"Debug issues\"\n---\n",
        );

        let skills = scan_dir(&tmp, "user", "claude");
        assert_eq!(skills.len(), 2);

        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"brainstorming"));
        assert!(names.contains(&"systematic-debugging"));
        assert_eq!(skills[0].provider, "claude");

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn test_scan_dir_empty_on_missing_dir() {
        let skills = scan_dir(Path::new("/nonexistent/path"), "user", "claude");
        assert!(skills.is_empty());
    }

    #[test]
    fn test_scan_dir_uses_dirname_as_fallback_name() {
        let tmp = std::env::temp_dir().join(format!("aide-test-fallback-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        make_skill_dir(&tmp, "my-tool", "# No frontmatter");

        let skills = scan_dir(&tmp, "user", "claude");
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "my-tool");

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn test_scan_enabled_plugins_reads_manifest() {
        let tmp = std::env::temp_dir().join(format!("aide-test-plugins-{}", std::process::id()));
        let plugin_dir = tmp.join("superpowers").join("6.2.0");
        make_skill_dir(
            &plugin_dir.join("skills"),
            "brainstorming",
            "---\nname: brainstorming\ndescription: \"Brainstorm\"\n---\n",
        );
        let manifest = tmp.join("enabled-plugins.json");
        let path_json = plugin_dir.to_string_lossy().replace('\\', "\\\\");
        fs::write(
            &manifest,
            format!(r#"[{{"name":"superpowers","marketplace":"m","path":"{path_json}"}}]"#),
        )
        .unwrap();

        let skills = scan_enabled_plugins(&manifest, "claude");
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "brainstorming");
        assert_eq!(skills[0].source, "plugin:superpowers");

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn test_scan_enabled_plugins_missing_or_malformed_manifest() {
        let tmp =
            std::env::temp_dir().join(format!("aide-test-plugins-bad-{}", std::process::id()));
        // 清单不存在 → 空
        assert!(scan_enabled_plugins(&tmp.join("nope.json"), "claude").is_empty());
        // 清单损坏 → 空
        fs::create_dir_all(&tmp).unwrap();
        let bad = tmp.join("bad.json");
        fs::write(&bad, "not json").unwrap();
        assert!(scan_enabled_plugins(&bad, "claude").is_empty());

        fs::remove_dir_all(&tmp).unwrap();
    }
}
