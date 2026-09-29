use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

mod impls;
use impls::*;

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

    /// 该探测器认领的项目涉及的 LSP 语言 id 字符串（"rust"/"typescript"/...）。
    /// 默认空——多数探测器不声明（v1 仅项目型探测器覆盖）。不影响 detect_run_targets。
    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        Vec::new()
    }

    // Skeleton -- concrete detectors do not override this.
    fn detect(&self, root: &Path) -> Option<Vec<RunTarget>> {
        if self.matches(root) {
            let targets = self.build_targets(root);
            if !targets.is_empty() {
                return Some(targets);
            }
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
            Box::new(SubdirScanDetector {
                chain: Self::leaf_chain(),
            }),
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

    /// 该目录下**被认领的项目**声明的 LSP 语言（去重）。
    /// 与 `detect_targets` 独立：不要求 targets 非空——一个没有 dev 脚本的 Node 项目
    /// 仍该起 TS server。
    fn languages(&self, root: &Path) -> Vec<&'static str> {
        let mut out: Vec<&'static str> = Vec::new();
        for det in &self.detectors {
            if det.matches(root) {
                for lang in det.languages(root) {
                    if !out.contains(&lang) {
                        out.push(lang);
                    }
                }
            }
        }
        out
    }

    fn detect_command(&self, root: &Path) -> Option<String> {
        self.detect_targets(root)
            .into_iter()
            .next()
            .map(|t| t.command)
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
        if file_exists(root, "gradlew.bat") {
            ".\\gradlew.bat".into()
        } else {
            "gradle".into()
        }
    }
    #[cfg(not(windows))]
    {
        if file_exists(root, "gradlew") {
            "./gradlew".into()
        } else {
            "gradle".into()
        }
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
        if !trimmed.starts_with("include") {
            continue;
        }
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
        "node_modules"
            | ".git"
            | "target"
            | "build"
            | "dist"
            | ".idea"
            | "__pycache__"
            | ".gradle"
            | "out"
            | "vendor"
            | ".next"
            | ".nuxt"
            | "coverage"
            | ".vscode"
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
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            if let Some(cls) = scan_spring_main(&path) {
                return Some(cls);
            }
        } else {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext != "java" && ext != "kt" {
                continue;
            }
            let content = fs::read_to_string(&path).unwrap_or_default();
            if !content.contains("@SpringBootApplication") {
                continue;
            }
            // Java/Kotlin: public class name always equals file stem.
            let class_name = path.file_stem()?.to_str()?.to_string();
            let pkg_re = Regex::new(r"^package\s+([\w.]+)").unwrap();
            let package = content
                .lines()
                .find_map(|l| {
                    pkg_re
                        .captures(l.trim())
                        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
                })
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

// -- Composite: SubdirScanDetector --
// Holds a leaf_chain() to avoid infinite recursion.

struct SubdirScanDetector {
    chain: DetectorChain,
}

/// 遍历**一层**子目录（跳过表 + 文件名排序 = run target 同一份纪律），逐个交给 `f`。
fn for_each_subdir(root: &Path, mut f: impl FnMut(&Path)) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_dir(&name) {
            continue;
        }
        f(&path);
    }
}

impl ProjectDetector for SubdirScanDetector {
    fn priority(&self) -> u8 {
        5
    }
    fn matches(&self, root: &Path) -> bool {
        root.is_dir()
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let mut targets = Vec::new();
        for_each_subdir(root, |path| targets.extend(self.chain.detect_targets(path)));
        targets
    }

    /// 子目录里的项目**也属于这个工作区**：run target 早就下钻一层找它，语言声明同理。
    /// 不下钻的话，`frontend/`（Vite+Vue）、`server/` 这类布局对 LSP 完全隐形
    /// ——2026-09-29 agri-ai-agent 实测只探测出 Java（TS/Vue 全在 `frontend/`）。
    ///
    /// 深度与 run target 同界（一层）且共用跳过表；更深的项目由 `lsp::detector` 的
    /// 有界扩展名计数兜底。
    fn languages(&self, root: &Path) -> Vec<&'static str> {
        let mut out: Vec<&'static str> = Vec::new();
        for_each_subdir(root, |path| {
            for lang in self.chain.languages(path) {
                if !out.contains(&lang) {
                    out.push(lang);
                }
            }
        });
        out
    }
}

/// 走探测器链收集所有 matching 探测器声明的 LSP 语言 id 字符串（去重）。
/// 供 lsp::detector::detect_languages 用。与 detect_run_targets 独立：不要求 targets 非空，
/// 只要 matches 即收 languages（一个无 dev 脚本的 Node 项目仍该起 ts server）。
/// **含一层子目录里的项目**（`SubdirScanDetector::languages`）——`frontend/` 这类布局
/// 与根层项目同等对待。
pub(crate) fn detect_languages_from_markers(root: &Path) -> Vec<&'static str> {
    DetectorChain::default_chain().languages(root)
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

    #[test]
    fn languages_does_not_break_detect_run_targets() {
        let tmp = std::env::temp_dir().join("aide_det_lang_regression");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("src-tauri")).unwrap();
        std::fs::write(tmp.join("package.json"), "{}").unwrap();
        std::fs::write(tmp.join("src-tauri/Cargo.toml"), "").unwrap();
        std::fs::write(tmp.join("pnpm-lock.yaml"), "").unwrap();
        let targets = detect_run_targets(&tmp);
        assert_eq!(targets.len(), 1);
        assert!(
            targets[0].command.contains("tauri dev"),
            "{}",
            targets[0].command
        );
        let langs = detect_languages_from_markers(&tmp);
        assert!(langs.contains(&"rust"));
        std::fs::remove_dir_all(&tmp).ok();
    }
}
