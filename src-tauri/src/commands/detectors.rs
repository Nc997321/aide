use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

// -- Shared type (moved from run_configs.rs) --

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunTarget {
    pub name: String,
    pub cwd: String,
    pub command: String,
}

// -- Template Method trait --

pub(crate) trait ProjectDetector: Send + Sync {
    fn priority(&self) -> u8;
    fn matches(&self, root: &Path) -> bool;
    fn build_targets(&self, root: &Path) -> Vec<RunTarget>;

    // Skeleton -- concrete detectors do not override this.
    fn detect(&self, root: &Path) -> Option<Vec<RunTarget>> {
        if self.matches(root) {
            let targets = self.build_targets(root);
            if !targets.is_empty() { return Some(targets); }
        }
        None
    }
}

// -- Chain of Responsibility --

struct DetectorChain {
    detectors: Vec<Box<dyn ProjectDetector>>,
}

impl DetectorChain {
    fn build(mut detectors: Vec<Box<dyn ProjectDetector>>) -> Self {
        detectors.sort_by(|a, b| b.priority().cmp(&a.priority()));
        Self { detectors }
    }

    /// Leaf chain: single-directory detectors only. Used by SubdirScanDetector
    /// to avoid infinite recursion (no SubdirScanDetector inside itself).
    fn leaf_chain() -> Self {
        Self::build(vec![
            Box::new(TauriDetector),
            Box::new(SpringBootMavenDetector),
            Box::new(SpringBootGradleDetector),
            Box::new(JavaMavenDetector),
            Box::new(JavaGradleDetector),
            Box::new(NodeDetector),
            Box::new(CargoDetector),
            Box::new(GoDetector),
            Box::new(FlutterDetector),
            Box::new(DartDetector),
            Box::new(DotnetDetector),
            Box::new(DjangoDetector),
            Box::new(PythonDetector),
            Box::new(RailsDetector),
            Box::new(LaravelDetector),
            Box::new(ElixirDetector),
            Box::new(MakeDetector),
        ])
    }

    /// Full chain: includes multi-module detectors and subdir scan.
    /// Use as the main entry point.
    fn default_chain() -> Self {
        Self::build(vec![
            Box::new(TauriDetector),
            Box::new(MavenMultiModuleDetector),
            Box::new(GradleMultiProjectDetector),
            Box::new(SpringBootMavenDetector),
            Box::new(SpringBootGradleDetector),
            Box::new(JavaMavenDetector),
            Box::new(JavaGradleDetector),
            Box::new(NodeDetector),
            Box::new(CargoDetector),
            Box::new(GoDetector),
            Box::new(FlutterDetector),
            Box::new(DartDetector),
            Box::new(DotnetDetector),
            Box::new(DjangoDetector),
            Box::new(PythonDetector),
            Box::new(RailsDetector),
            Box::new(LaravelDetector),
            Box::new(ElixirDetector),
            Box::new(MakeDetector),
            Box::new(SubdirScanDetector { chain: Self::leaf_chain() }),
        ])
    }

    fn detect_targets(&self, root: &Path) -> Vec<RunTarget> {
        for detector in &self.detectors {
            if let Some(targets) = detector.detect(root) {
                return targets;
            }
        }
        Vec::new()
    }

    fn detect_command(&self, root: &Path) -> Option<String> {
        self.detect_targets(root).into_iter().next().map(|t| t.command)
    }
}

// -- Public interface (called by filesystem.rs and run_configs.rs) --

/// Returns all run targets for the given workspace root.
/// Tries multi-module detectors first, then single-root, then subdir scan.
pub(crate) fn detect_run_targets(root: &Path) -> Vec<RunTarget> {
    DetectorChain::default_chain().detect_targets(root)
}

/// Returns the single best run command for a leaf directory.
/// Used by filesystem.rs (detect_run_command Tauri command).
pub(crate) fn detect_command_for_path(root: &Path) -> Option<String> {
    DetectorChain::leaf_chain().detect_command(root)
}

// -- Shared helpers --

fn file_exists(root: &Path, name: &str) -> bool {
    root.join(name).exists()
}

fn read_file(root: &Path, name: &str) -> String {
    fs::read_to_string(root.join(name)).unwrap_or_default()
}

fn dir_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn gradlew_cmd(root: &Path) -> String {
    #[cfg(windows)]
    {
        if file_exists(root, "gradlew.bat") { ".\\gradlew.bat".into() }
        else { "gradle".into() }
    }
    #[cfg(not(windows))]
    {
        if file_exists(root, "gradlew") { "./gradlew".into() }
        else { "gradle".into() }
    }
}

fn extract_maven_modules(content: &str) -> Vec<String> {
    let re = Regex::new(r"<module>([^<]+)</module>").unwrap();
    re.captures_iter(content)
        .filter_map(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

fn extract_gradle_includes(content: &str) -> Vec<String> {
    let mut modules = Vec::new();
    let re = Regex::new(r#"['"](?::)?([a-zA-Z0-9_\-]+)['"]"#).unwrap();
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("include") { continue; }
        for cap in re.captures_iter(trimmed) {
            if let Some(m) = cap.get(1) {
                modules.push(m.as_str().to_string());
            }
        }
    }
    modules
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | "target" | "build" | "dist"
            | ".idea" | "__pycache__" | ".gradle" | "out" | "vendor"
            | ".next" | ".nuxt" | "coverage" | ".vscode"
    ) || name.starts_with('.')
}

// -- Concrete detectors --

// Priority 100 -- Tauri desktop app (package.json + src-tauri/Cargo.toml)
struct TauriDetector;
impl ProjectDetector for TauriDetector {
    fn priority(&self) -> u8 { 100 }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "package.json") && file_exists(root, "src-tauri/Cargo.toml")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let pm = if file_exists(root, "pnpm-lock.yaml") { "pnpm" }
            else if file_exists(root, "bun.lockb") || file_exists(root, "bun.lock") { "bun" }
            else if file_exists(root, "yarn.lock") { "yarn" }
            else { "npm" };
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: format!("{} tauri dev", pm),
        }]
    }
}

// Priority 90 -- Maven parent pom with <modules>
// cwd is set to the ROOT (not submodule) because -pl/-am runs from parent.
struct MavenMultiModuleDetector;
impl ProjectDetector for MavenMultiModuleDetector {
    fn priority(&self) -> u8 { 90 }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "pom.xml") && read_file(root, "pom.xml").contains("<modules>")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let content = read_file(root, "pom.xml");
        let modules = extract_maven_modules(&content);
        let root_str = root.to_string_lossy().to_string();
        modules.iter()
            .filter_map(|module| {
                let sub = root.join(module);
                if !sub.is_dir() { return None; }
                let sub_pom = read_file(&sub, "pom.xml");
                // Only generate targets for runnable modules.
                let cmd = if sub_pom.contains("spring-boot") {
                    format!("mvn -pl {} -am spring-boot:run", module)
                } else if sub_pom.contains("exec-maven-plugin") {
                    format!("mvn -pl {} -am exec:java", module)
                } else {
                    return None;
                };
                Some(RunTarget {
                    name: module.clone(),
                    cwd: root_str.clone(),
                    command: cmd,
                })
            })
            .collect()
    }
}

// Priority 90 -- Gradle settings.gradle with include
// cwd is set to the ROOT; command uses :<module>:bootRun notation.
struct GradleMultiProjectDetector;
impl ProjectDetector for GradleMultiProjectDetector {
    fn priority(&self) -> u8 { 90 }
    fn matches(&self, root: &Path) -> bool {
        let has = file_exists(root, "settings.gradle") || file_exists(root, "settings.gradle.kts");
        if !has { return false; }
        let content = read_file(root, "settings.gradle") + &read_file(root, "settings.gradle.kts");
        content.contains("include")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let content = read_file(root, "settings.gradle") + &read_file(root, "settings.gradle.kts");
        let modules = extract_gradle_includes(&content);
        let gw = gradlew_cmd(root);
        let root_str = root.to_string_lossy().to_string();
        modules.iter()
            .filter_map(|module| {
                let sub = root.join(module);
                if !sub.is_dir() { return None; }
                let build = read_file(&sub, "build.gradle") + &read_file(&sub, "build.gradle.kts");
                // Only generate targets for Spring Boot subprojects.
                if !build.contains("spring-boot") { return None; }
                Some(RunTarget {
                    name: module.clone(),
                    cwd: root_str.clone(),
                    command: format!("{} :{}:bootRun", gw, module),
                })
            })
            .collect()
    }
}

// Priority 80 -- Single-module Spring Boot Maven project
struct SpringBootMavenDetector;
impl ProjectDetector for SpringBootMavenDetector {
    fn priority(&self) -> u8 { 80 }
    fn matches(&self, root: &Path) -> bool {
        if !file_exists(root, "pom.xml") { return false; }
        let content = read_file(root, "pom.xml");
        content.contains("spring-boot") && !content.contains("<modules>")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "mvn spring-boot:run".to_string(),
        }]
    }
}

// Priority 75 -- Single Spring Boot Gradle project
struct SpringBootGradleDetector;
impl ProjectDetector for SpringBootGradleDetector {
    fn priority(&self) -> u8 { 75 }
    fn matches(&self, root: &Path) -> bool {
        let has = file_exists(root, "build.gradle") || file_exists(root, "build.gradle.kts");
        if !has { return false; }
        let content = read_file(root, "build.gradle") + &read_file(root, "build.gradle.kts");
        content.contains("spring-boot")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let gw = gradlew_cmd(root);
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: format!("{} bootRun", gw),
        }]
    }
}

// Priority 72 -- Plain Maven project (no spring-boot, no <modules>)
struct JavaMavenDetector;
impl ProjectDetector for JavaMavenDetector {
    fn priority(&self) -> u8 { 72 }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "pom.xml")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "mvn compile exec:java".to_string(),
        }]
    }
}

// Priority 68 -- Plain Gradle project (no spring-boot)
struct JavaGradleDetector;
impl ProjectDetector for JavaGradleDetector {
    fn priority(&self) -> u8 { 68 }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "build.gradle") || file_exists(root, "build.gradle.kts")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let gw = gradlew_cmd(root);
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: format!("{} run", gw),
        }]
    }
}

// Priority 70 -- Node.js / frontend (package.json without src-tauri/)
struct NodeDetector;
impl ProjectDetector for NodeDetector {
    fn priority(&self) -> u8 { 70 }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "package.json") && !file_exists(root, "src-tauri/Cargo.toml")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let json: serde_json::Value =
            serde_json::from_str(&read_file(root, "package.json")).unwrap_or(serde_json::Value::Null);
        let scripts = json.get("scripts");
        let has = |n: &str| scripts.map(|s| s.get(n).is_some()).unwrap_or(false);
        let pm = if file_exists(root, "pnpm-lock.yaml") { "pnpm" }
            else if file_exists(root, "bun.lockb") || file_exists(root, "bun.lock") { "bun" }
            else if file_exists(root, "yarn.lock") { "yarn" }
            else { "npm" };
        let script = ["dev", "start", "serve", "preview"].iter().find(|&&s| has(s));
        let Some(script) = script else { return vec![]; };
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: format!("{} run {}", pm, script),
        }]
    }
}

// Priority 65 -- Rust / Cargo
struct CargoDetector;
impl ProjectDetector for CargoDetector {
    fn priority(&self) -> u8 { 65 }
    fn matches(&self, root: &Path) -> bool { file_exists(root, "Cargo.toml") }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "cargo run".to_string(),
        }]
    }
}

// Priority 65 -- Go
struct GoDetector;
impl ProjectDetector for GoDetector {
    fn priority(&self) -> u8 { 65 }
    fn matches(&self, root: &Path) -> bool { file_exists(root, "go.mod") }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "go run .".to_string(),
        }]
    }
}

// Priority 60 -- Flutter
struct FlutterDetector;
impl ProjectDetector for FlutterDetector {
    fn priority(&self) -> u8 { 60 }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "pubspec.yaml") && read_file(root, "pubspec.yaml").contains("flutter:")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "flutter run".to_string(),
        }]
    }
}

// Priority 55 -- Pure Dart
struct DartDetector;
impl ProjectDetector for DartDetector {
    fn priority(&self) -> u8 { 55 }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "pubspec.yaml") && !read_file(root, "pubspec.yaml").contains("flutter:")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "dart run".to_string(),
        }]
    }
}

// Priority 60 -- .NET
struct DotnetDetector;
impl ProjectDetector for DotnetDetector {
    fn priority(&self) -> u8 { 60 }
    fn matches(&self, root: &Path) -> bool {
        fs::read_dir(root).ok()
            .map(|d| d.flatten().any(|e| {
                let n = e.file_name().to_string_lossy().to_lowercase();
                n.ends_with(".csproj") || n.ends_with(".sln")
            }))
            .unwrap_or(false)
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "dotnet run".to_string(),
        }]
    }
}

// Priority 60 -- Django
struct DjangoDetector;
impl ProjectDetector for DjangoDetector {
    fn priority(&self) -> u8 { 60 }
    fn matches(&self, root: &Path) -> bool { file_exists(root, "manage.py") }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "python manage.py runserver".to_string(),
        }]
    }
}

// Priority 50 -- Generic Python (main.py / app.py)
struct PythonDetector;
impl ProjectDetector for PythonDetector {
    fn priority(&self) -> u8 { 50 }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "main.py") || file_exists(root, "app.py")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let entry = if file_exists(root, "main.py") { "main.py" } else { "app.py" };
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: format!("python {}", entry),
        }]
    }
}

// Priority 60 -- Ruby on Rails
struct RailsDetector;
impl ProjectDetector for RailsDetector {
    fn priority(&self) -> u8 { 60 }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "Gemfile") && file_exists(root, "config/application.rb")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "rails server".to_string(),
        }]
    }
}

// Priority 60 -- Laravel
struct LaravelDetector;
impl ProjectDetector for LaravelDetector {
    fn priority(&self) -> u8 { 60 }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "composer.json") && file_exists(root, "artisan")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "php artisan serve".to_string(),
        }]
    }
}

// Priority 60 -- Elixir / Phoenix
struct ElixirDetector;
impl ProjectDetector for ElixirDetector {
    fn priority(&self) -> u8 { 60 }
    fn matches(&self, root: &Path) -> bool { file_exists(root, "mix.exs") }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let content = read_file(root, "mix.exs");
        let cmd = if content.contains(":phoenix") || content.contains("Phoenix") {
            "mix phx.server"
        } else {
            "mix run"
        };
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: cmd.to_string(),
        }]
    }
}

// Priority 20 -- Makefile fallback
struct MakeDetector;
impl ProjectDetector for MakeDetector {
    fn priority(&self) -> u8 { 20 }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "Makefile") || file_exists(root, "makefile")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "make".to_string(),
        }]
    }
}

// -- Composite: SubdirScanDetector --
// Holds a leaf_chain() to avoid infinite recursion.

struct SubdirScanDetector {
    chain: DetectorChain,
}

impl ProjectDetector for SubdirScanDetector {
    fn priority(&self) -> u8 { 5 }
    fn matches(&self, root: &Path) -> bool { root.is_dir() }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let Ok(entries) = fs::read_dir(root) else { return Vec::new(); };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        let mut targets = Vec::new();
        for entry in entries {
            let path = entry.path();
            if !path.is_dir() { continue; }
            let name = entry.file_name().to_string_lossy().to_string();
            if should_skip_dir(&name) { continue; }
            targets.extend(self.chain.detect_targets(&path));
        }
        targets
    }
}
