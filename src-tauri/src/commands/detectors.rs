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

/// Read the first `<tag>value</tag>` occurrence from a pom fragment.
fn pom_field(content: &str, tag: &str) -> Option<String> {
    let re = Regex::new(&format!(r"<{tag}>([^<]+)</{tag}>")).ok()?;
    re.captures(content)
        .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .filter(|s| !s.is_empty())
}

/// Remove the `<parent>...</parent>` block so that a top-level `<artifactId>`
/// lookup does not accidentally pick up the parent's artifactId (e.g.
/// `spring-boot-starter-parent`). Returns the stripped body plus the parent's
/// version (if any) so a module without its own `<version>` can inherit it.
fn strip_parent(content: &str) -> (String, Option<String>) {
    let parent_re = Regex::new(r"(?s)<parent>.*?</parent>").unwrap();
    let parent_block = parent_re.find(content).map(|m| m.as_str().to_string());
    let body = parent_re.replace_all(content, "").to_string();
    let parent_version = parent_block.as_ref().and_then(|b| pom_field(b, "version"));
    (body, parent_version)
}

/// Predict the Spring Boot fat-jar file name produced by `mvn package`.
/// Priority: `<finalName>` > `<artifactId>-<version>` (version inherited from
/// `<parent>` when absent). Returns `None` only when no `<artifactId>` can be
/// located at all — caller should fall back to `mvn spring-boot:run` then.
fn spring_boot_jar_name(pom_content: &str) -> Option<String> {
    if let Some(final_name) = pom_field(pom_content, "finalName") {
        return Some(final_name);
    }
    let (body, parent_version) = strip_parent(pom_content);
    let artifact_id = pom_field(&body, "artifactId")?;
    let version = pom_field(&body, "version").or(parent_version);
    Some(match version {
        Some(v) => format!("{artifact_id}-{v}"),
        None => artifact_id,
    })
}

/// Build the legacy `mvn spring-boot:run[ -Dspring-boot.run.main-class=<cls>]`
/// command. Used as the fallback when the fat-jar approach is not applicable
/// (no `spring-boot-maven-plugin`, or jar name cannot be predicted).
fn spring_boot_run_fallback(root: &Path) -> String {
    let main_flag = find_spring_boot_main_class(root)
        .map(|cls| format!(" -Dspring-boot.run.main-class={}", cls))
        .unwrap_or_default();
    format!("mvn spring-boot:run{}", main_flag)
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

/// Walk src/main/java (and src/main/kotlin) inside a Maven/Gradle module
/// looking for the class annotated with @SpringBootApplication.
/// Returns the fully-qualified class name, e.g. "com.example.MyApp".
fn find_spring_boot_main_class(module_root: &Path) -> Option<String> {
    for src_dir in &["src/main/java", "src/main/kotlin"] {
        let src = module_root.join(src_dir);
        if src.is_dir() {
            if let Some(cls) = scan_spring_main(&src) {
                return Some(cls);
            }
        }
    }
    None
}

fn scan_spring_main(dir: &Path) -> Option<String> {
    let Ok(entries) = fs::read_dir(dir) else { return None; };
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            if let Some(cls) = scan_spring_main(&path) { return Some(cls); }
        } else {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext != "java" && ext != "kt" { continue; }
            let content = fs::read_to_string(&path).unwrap_or_default();
            if !content.contains("@SpringBootApplication") { continue; }
            // Java/Kotlin: public class name always equals file stem.
            let class_name = path.file_stem()?.to_str()?.to_string();
            let pkg_re = Regex::new(r"^package\s+([\w.]+)").unwrap();
            let package = content.lines()
                .find_map(|l| pkg_re.captures(l.trim()).and_then(|c| c.get(1).map(|m| m.as_str().to_string())))
                .unwrap_or_default();
            return Some(if package.is_empty() {
                class_name
            } else {
                format!("{}.{}", package, class_name)
            });
        }
    }
    None
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
                    if sub_pom.contains("spring-boot-maven-plugin") {
                        // Fat-jar launch: build the submodule jar, then run it
                        // from the parent root with `java -jar`. cwd = root.
                        match spring_boot_jar_name(&sub_pom) {
                            // No quotes around the jar path — see SpringBootMavenDetector
                            // for why quoting breaks `java -jar` under cmd /c.
                            Some(jar) => format!(
                                "mvn -pl {} -am -DskipTests package && java -jar {}/target/{}.jar",
                                module, module, jar
                            ),
                            None => {
                                let main_flag = find_spring_boot_main_class(&sub)
                                    .map(|cls| format!(" -Dspring-boot.run.main-class={}", cls))
                                    .unwrap_or_default();
                                format!("mvn -pl {} -am spring-boot:run{}", module, main_flag)
                            }
                        }
                    } else {
                        // spring-boot dependency but NO spring-boot-maven-plugin:
                        // only runnable if a @SpringBootApplication main class
                        // exists. Shared SDK / common modules merely depend on
                        // spring-boot and have no main class — skip them so they
                        // don't pollute the run list with a command that can't
                        // start (mvn spring-boot:run would fail with no main class).
                        match find_spring_boot_main_class(&sub) {
                            Some(cls) => format!(
                                "mvn -pl {} -am spring-boot:run -Dspring-boot.run.main-class={}",
                                module, cls
                            ),
                            None => return None,
                        }
                    }
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
        let pom = read_file(root, "pom.xml");
        // Fat-jar launch: build a self-contained Spring Boot jar, then run it
        // with `java -jar`. The fat jar's JarLauncher resolves the classpath
        // from BOOT-INF/lib, so no -cp is needed. Only applies when the
        // spring-boot-maven-plugin (repackage) is configured; otherwise fall
        // back to `mvn spring-boot:run`.
        let command = if pom.contains("spring-boot-maven-plugin") {
            match spring_boot_jar_name(&pom) {
                // No quotes around the jar path: Maven artifactId/version/
                // finalName never contain spaces, and quoting breaks `java -jar`
                // because cmd.exe's /c quote-stripping + portable_pty's arg
                // escaping leave the launcher (JLI) with a malformed path
                // ("Unable to access jarfile"). See test reproducing the bug.
                Some(jar) => format!("mvn -DskipTests package && java -jar target/{}.jar", jar),
                None => spring_boot_run_fallback(root),
            }
        } else {
            spring_boot_run_fallback(root)
        };
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command,
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

#[cfg(test)]
mod tests {
    use super::*;

    const POM_WITH_PARENT: &str = r#"<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>"#;

    const POM_INHERIT_VERSION: &str = r#"<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <dependencies></dependencies>
</project>"#;

    const POM_FINAL_NAME: &str = r#"<project>
  <parent>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
  </parent>
  <artifactId>demo</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <build><finalName>myapp</finalName></build>
</project>"#;

    #[test]
    fn strip_parent_then_field_skips_parent_artifact_id() {
        // After stripping <parent>, the first <artifactId> is the project's own.
        let (body, parent_ver) = strip_parent(POM_WITH_PARENT);
        assert_eq!(pom_field(&body, "artifactId"), Some("demo".into()));
        assert_eq!(parent_ver, Some("3.2.0".into()));
    }

    #[test]
    fn spring_boot_jar_name_uses_artifact_and_version() {
        assert_eq!(
            spring_boot_jar_name(POM_WITH_PARENT),
            Some("demo-0.0.1-SNAPSHOT".into())
        );
    }

    #[test]
    fn spring_boot_jar_name_inherits_parent_version() {
        assert_eq!(
            spring_boot_jar_name(POM_INHERIT_VERSION),
            Some("demo-3.2.0".into())
        );
    }

    #[test]
    fn spring_boot_jar_name_prefers_final_name() {
        assert_eq!(spring_boot_jar_name(POM_FINAL_NAME), Some("myapp".into()));
    }

    fn write_pom(dir: &Path, content: &str) {
        fs::write(dir.join("pom.xml"), content).unwrap();
    }

    #[test]
    fn spring_boot_detector_uses_fat_jar_when_plugin_present() {
        let tmp = std::env::temp_dir().join("aide_det_test_fatjar");
        fs::remove_dir_all(&tmp).ok();
        fs::create_dir_all(&tmp).unwrap();
        let pom = format!(
            r#"<project>
  <parent>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
  </parent>
  <artifactId>demo</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <build>
    <plugins><plugin>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-maven-plugin</artifactId>
    </plugin></plugins>
  </build>
</project>"#
        );
        write_pom(&tmp, &pom);

        let targets = SpringBootMavenDetector.build_targets(&tmp);
        assert_eq!(targets.len(), 1);
        // No quotes around the jar path: quoting breaks `java -jar` under
        // cmd.exe /c (portable_pty escapes + cmd strip -> JLI malformed path).
        assert_eq!(
            targets[0].command,
            "mvn -DskipTests package && java -jar target/demo-0.0.1-SNAPSHOT.jar"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn spring_boot_detector_falls_back_without_plugin() {
        let tmp = std::env::temp_dir().join("aide_det_test_fallback");
        fs::remove_dir_all(&tmp).ok();
        fs::create_dir_all(&tmp).unwrap();
        // spring-boot dependency but no spring-boot-maven-plugin.
        let pom = r#"<project>
  <artifactId>demo</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <dependencies>
    <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
  </dependencies>
</project>"#;
        write_pom(&tmp, pom);

        let targets = SpringBootMavenDetector.build_targets(&tmp);
        assert_eq!(targets.len(), 1);
        assert!(
            targets[0].command.starts_with("mvn spring-boot:run"),
            "expected fallback, got {}",
            targets[0].command
        );
        fs::remove_dir_all(&tmp).ok();
    }

    fn write_java_main(dir: &Path, pkg: &str, class: &str) {
        // dir = the module root; writes src/main/java/<pkg path>/<class>.java
        let mut pkg_dir = dir.join("src/main/java");
        for seg in pkg.split('.') {
            pkg_dir = pkg_dir.join(seg);
        }
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(
            pkg_dir.join(format!("{class}.java")),
            format!("package {pkg};\n@SpringBootApplication\npublic class {class} {{}}\n"),
        )
        .unwrap();
    }

    #[test]
    fn multi_module_skips_library_without_main_class() {
        let tmp = std::env::temp_dir().join("aide_det_test_multi_skip");
        fs::remove_dir_all(&tmp).ok();
        fs::create_dir_all(&tmp).unwrap();
        // Root aggregator pom listing two modules: a runnable app + a common SDK.
        write_pom(
            &tmp,
            r#"<project>
  <artifactId>iotPlatform</artifactId>
  <version>1.0-SNAPSHOT</version>
  <packaging>pom</packaging>
  <modules><module>app</module><module>common</module></modules>
</project>"#,
        );
        // app: real Spring Boot app with the repackage plugin -> fat-jar target.
        let app = tmp.join("app");
        fs::create_dir_all(&app).unwrap();
        write_pom(
            &app,
            r#"<project>
  <artifactId>app</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <build><plugins><plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
  </plugin></plugins></build>
</project>"#,
        );
        // common: only depends on spring-boot, no plugin, no main class -> MUST be skipped.
        let common = tmp.join("common");
        fs::create_dir_all(&common).unwrap();
        write_pom(
            &common,
            r#"<project>
  <artifactId>common</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <dependencies>
    <dependency><artifactId>spring-boot-starter</artifactId></dependency>
  </dependencies>
</project>"#,
        );

        let targets = MavenMultiModuleDetector.build_targets(&tmp);
        // Only `app` should appear; `common` is a library and must be filtered out.
        assert_eq!(targets.len(), 1, "got {targets:?}");
        assert_eq!(targets[0].name, "app");
        assert!(targets[0].command.contains("java -jar app/target/"));
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn multi_module_spring_boot_run_when_main_class_but_no_plugin() {
        let tmp = std::env::temp_dir().join("aide_det_test_multi_mainclass");
        fs::remove_dir_all(&tmp).ok();
        fs::create_dir_all(&tmp).unwrap();
        write_pom(
            &tmp,
            r#"<project>
  <artifactId>iotPlatform</artifactId>
  <version>1.0-SNAPSHOT</version>
  <packaging>pom</packaging>
  <modules><module>app</module></modules>
</project>"#,
        );
        let app = tmp.join("app");
        fs::create_dir_all(&app).unwrap();
        // spring-boot dependency, NO spring-boot-maven-plugin, but has a main class.
        write_pom(
            &app,
            r#"<project>
  <artifactId>app</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <dependencies>
    <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
  </dependencies>
</project>"#,
        );
        write_java_main(&app, "com.example", "App");

        let targets = MavenMultiModuleDetector.build_targets(&tmp);
        assert_eq!(targets.len(), 1, "got {targets:?}");
        assert_eq!(
            targets[0].command,
            "mvn -pl app -am spring-boot:run -Dspring-boot.run.main-class=com.example.App"
        );
        fs::remove_dir_all(&tmp).ok();
    }
}
