use super::*;

// -- Concrete detectors --

// Priority 100 -- Tauri desktop app (package.json + src-tauri/Cargo.toml)
pub(super) struct TauriDetector;
impl ProjectDetector for TauriDetector {
    fn priority(&self) -> u8 {
        100
    }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "package.json") && file_exists(root, "src-tauri/Cargo.toml")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let pm = if file_exists(root, "pnpm-lock.yaml") {
            "pnpm"
        } else if file_exists(root, "bun.lockb") || file_exists(root, "bun.lock") {
            "bun"
        } else if file_exists(root, "yarn.lock") {
            "yarn"
        } else {
            "npm"
        };
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: format!("{} tauri dev", pm),
        }]
    }

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["rust", "typescript", "vue"]
    }
}

// Priority 90 -- Maven parent pom with <modules>
// cwd is set to the ROOT (not submodule) because -pl/-am runs from parent.
pub(super) struct MavenMultiModuleDetector;
impl ProjectDetector for MavenMultiModuleDetector {
    fn priority(&self) -> u8 {
        90
    }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "pom.xml") && read_file(root, "pom.xml").contains("<modules>")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let content = read_file(root, "pom.xml");
        let modules = extract_maven_modules(&content);
        let root_str = root.to_string_lossy().to_string();
        modules
            .iter()
            .filter_map(|module| {
                let sub = root.join(module);
                if !sub.is_dir() {
                    return None;
                }
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
pub(super) struct GradleMultiProjectDetector;
impl ProjectDetector for GradleMultiProjectDetector {
    fn priority(&self) -> u8 {
        90
    }
    fn matches(&self, root: &Path) -> bool {
        let has = file_exists(root, "settings.gradle") || file_exists(root, "settings.gradle.kts");
        if !has {
            return false;
        }
        let content = read_file(root, "settings.gradle") + &read_file(root, "settings.gradle.kts");
        content.contains("include")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let content = read_file(root, "settings.gradle") + &read_file(root, "settings.gradle.kts");
        let modules = extract_gradle_includes(&content);
        let gw = gradlew_cmd(root);
        let root_str = root.to_string_lossy().to_string();
        modules
            .iter()
            .filter_map(|module| {
                let sub = root.join(module);
                if !sub.is_dir() {
                    return None;
                }
                let build = read_file(&sub, "build.gradle") + &read_file(&sub, "build.gradle.kts");
                // Only generate targets for Spring Boot subprojects.
                if !build.contains("spring-boot") {
                    return None;
                }
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
pub(super) struct SpringBootMavenDetector;
impl ProjectDetector for SpringBootMavenDetector {
    fn priority(&self) -> u8 {
        80
    }
    fn matches(&self, root: &Path) -> bool {
        if !file_exists(root, "pom.xml") {
            return false;
        }
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

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["java"]
    }
}

// Priority 75 -- Single Spring Boot Gradle project
pub(super) struct SpringBootGradleDetector;
impl ProjectDetector for SpringBootGradleDetector {
    fn priority(&self) -> u8 {
        75
    }
    fn matches(&self, root: &Path) -> bool {
        let has = file_exists(root, "build.gradle") || file_exists(root, "build.gradle.kts");
        if !has {
            return false;
        }
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

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["java"]
    }
}

// Priority 72 -- Plain Maven project (no spring-boot, no <modules>)
pub(super) struct JavaMavenDetector;
impl ProjectDetector for JavaMavenDetector {
    fn priority(&self) -> u8 {
        72
    }
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

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["java"]
    }
}

// Priority 68 -- Plain Gradle project (no spring-boot)
pub(super) struct JavaGradleDetector;
impl ProjectDetector for JavaGradleDetector {
    fn priority(&self) -> u8 {
        68
    }
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

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["java"]
    }
}

// Priority 70 -- Node.js / frontend (package.json without src-tauri/)
pub(super) struct NodeDetector;
impl ProjectDetector for NodeDetector {
    fn priority(&self) -> u8 {
        70
    }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "package.json") && !file_exists(root, "src-tauri/Cargo.toml")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let json: serde_json::Value = serde_json::from_str(&read_file(root, "package.json"))
            .unwrap_or(serde_json::Value::Null);
        let scripts = json.get("scripts");
        let has = |n: &str| scripts.map(|s| s.get(n).is_some()).unwrap_or(false);
        let pm = if file_exists(root, "pnpm-lock.yaml") {
            "pnpm"
        } else if file_exists(root, "bun.lockb") || file_exists(root, "bun.lock") {
            "bun"
        } else if file_exists(root, "yarn.lock") {
            "yarn"
        } else {
            "npm"
        };
        let script = ["dev", "start", "serve", "preview"]
            .iter()
            .find(|&&s| has(s));
        let Some(script) = script else {
            return vec![];
        };
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: format!("{} run {}", pm, script),
        }]
    }

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["typescript", "javascript"]
    }
}

// Priority 65 -- Rust / Cargo
pub(super) struct CargoDetector;
impl ProjectDetector for CargoDetector {
    fn priority(&self) -> u8 {
        65
    }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "Cargo.toml")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "cargo run".to_string(),
        }]
    }

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["rust"]
    }
}

// Priority 65 -- Go
pub(super) struct GoDetector;
impl ProjectDetector for GoDetector {
    fn priority(&self) -> u8 {
        65
    }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "go.mod")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "go run .".to_string(),
        }]
    }

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["go"]
    }
}

// Priority 60 -- Flutter
pub(super) struct FlutterDetector;
impl ProjectDetector for FlutterDetector {
    fn priority(&self) -> u8 {
        60
    }
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

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["dart"]
    }
}

// Priority 55 -- Pure Dart
pub(super) struct DartDetector;
impl ProjectDetector for DartDetector {
    fn priority(&self) -> u8 {
        55
    }
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

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["dart"]
    }
}

// Priority 60 -- .NET
pub(super) struct DotnetDetector;
impl ProjectDetector for DotnetDetector {
    fn priority(&self) -> u8 {
        60
    }
    fn matches(&self, root: &Path) -> bool {
        fs::read_dir(root)
            .ok()
            .map(|d| {
                d.flatten().any(|e| {
                    let n = e.file_name().to_string_lossy().to_lowercase();
                    n.ends_with(".csproj") || n.ends_with(".sln")
                })
            })
            .unwrap_or(false)
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "dotnet run".to_string(),
        }]
    }

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["csharp"]
    }
}

// Priority 60 -- Django
pub(super) struct DjangoDetector;
impl ProjectDetector for DjangoDetector {
    fn priority(&self) -> u8 {
        60
    }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "manage.py")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: "python manage.py runserver".to_string(),
        }]
    }

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["python"]
    }
}

// Priority 50 -- Generic Python (main.py / app.py)
pub(super) struct PythonDetector;
impl ProjectDetector for PythonDetector {
    fn priority(&self) -> u8 {
        50
    }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "main.py") || file_exists(root, "app.py")
    }
    fn build_targets(&self, root: &Path) -> Vec<RunTarget> {
        let entry = if file_exists(root, "main.py") {
            "main.py"
        } else {
            "app.py"
        };
        vec![RunTarget {
            name: dir_name(root),
            cwd: root.to_string_lossy().to_string(),
            command: format!("python {}", entry),
        }]
    }

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["python"]
    }
}

// Priority 60 -- Ruby on Rails
pub(super) struct RailsDetector;
impl ProjectDetector for RailsDetector {
    fn priority(&self) -> u8 {
        60
    }
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

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["ruby"]
    }
}

// Priority 60 -- Laravel
pub(super) struct LaravelDetector;
impl ProjectDetector for LaravelDetector {
    fn priority(&self) -> u8 {
        60
    }
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

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["php"]
    }
}

// Priority 60 -- Elixir / Phoenix
pub(super) struct ElixirDetector;
impl ProjectDetector for ElixirDetector {
    fn priority(&self) -> u8 {
        60
    }
    fn matches(&self, root: &Path) -> bool {
        file_exists(root, "mix.exs")
    }
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

    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        vec!["elixir"]
    }
}

// Priority 20 -- Makefile fallback
pub(super) struct MakeDetector;
impl ProjectDetector for MakeDetector {
    fn priority(&self) -> u8 {
        20
    }
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
