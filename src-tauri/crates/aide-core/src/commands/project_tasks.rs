use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{registry::blocking, Core};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TaskDetails {
    pub package_command: String,
    pub clean_command: String,
    pub env_file: String,
    pub required_env: Vec<String>,
    pub sources: Vec<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(in crate::commands) struct TaskEnvironment {
    pub env_file: String,
    pub required_env: Vec<String>,
}

fn valid_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn valid_command(command: &str) -> bool {
    !command.trim().is_empty() && command.len() <= 8192 && !command.chars().any(char::is_control)
}

fn explicit_env<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    if cfg!(windows) {
        env.iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
            .map(|(_, value)| value.as_str())
    } else {
        env.get(key).map(String::as_str)
    }
}

fn set_env(env: &mut BTreeMap<String, String>, key: String, value: String) {
    let key = if cfg!(windows) {
        key.to_ascii_uppercase()
    } else {
        key
    };
    env.insert(key, value);
}

pub(in crate::commands) fn resolve_task_env(
    cwd: &Path,
    command: &str,
    explicit: BTreeMap<String, String>,
    options: TaskEnvironment,
) -> Result<BTreeMap<String, String>, String> {
    if !cwd.is_dir() {
        return Err("任务工作目录不存在".into());
    }
    if !valid_command(command) {
        return Err("任务需要一条有效的单行命令".into());
    }
    let mut env = BTreeMap::new();
    if !options.env_file.trim().is_empty() {
        let path = cwd.join(options.env_file.trim());
        let content = read_text(&path, 256 * 1024).ok_or("无法读取环境文件，或文件超过 256 KiB")?;
        for (index, line) in content.trim_start_matches('\u{feff}').lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let invalid = || format!("环境文件第 {} 行需要 KEY=VALUE", index + 1);
            let (key, value) = line
                .strip_prefix("export ")
                .unwrap_or(line)
                .split_once('=')
                .ok_or_else(invalid)?;
            let key = key.trim();
            if !valid_key(key) || value.contains('\0') {
                return Err(invalid());
            }
            let value = value.trim();
            let value = if value.starts_with(['\'', '"']) {
                let quote = value.chars().next().unwrap();
                value
                    .get(1..)
                    .and_then(|body| body.strip_suffix(quote))
                    .ok_or_else(invalid)?
            } else {
                value
                    .split_once(" #")
                    .map_or(value, |(value, _)| value.trim_end())
            };
            set_env(&mut env, key.to_owned(), value.to_owned());
        }
    }
    for (key, value) in explicit {
        if !valid_key(&key) || value.contains('\0') {
            return Err("环境变量名称或值无效".into());
        }
        set_env(&mut env, key, value);
    }
    let missing: Vec<_> = options
        .required_env
        .into_iter()
        .filter(|key| {
            !valid_key(key)
                || explicit_env(&env, key)
                    .map(str::to_owned)
                    .or_else(|| std::env::var(key).ok())
                    .is_none_or(|value| value.trim().is_empty())
        })
        .collect();
    if !missing.is_empty() {
        return Err(format!("缺少必填环境变量：{}", missing.join("、")));
    }
    Ok(env)
}

#[derive(Deserialize)]
pub(super) struct CheckArgs {
    cwd: String,
    command: String,
    env: BTreeMap<String, String>,
    #[serde(flatten)]
    options: TaskEnvironment,
}

pub(super) async fn check(_core: Arc<Core>, args: CheckArgs) -> Result<(), String> {
    blocking(move || {
        resolve_task_env(Path::new(&args.cwd), &args.command, args.env, args.options).map(drop)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiscoverArgs {
    cwd: String,
    subdirectory: Option<String>,
}

#[derive(Serialize)]
pub(super) struct Candidate {
    name: String,
    cwd: String,
    command: String,
    #[serde(flatten)]
    tasks: TaskDetails,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Discovery {
    candidates: Vec<Candidate>,
    warning: Option<String>,
    scan_limited: bool,
    pending_directories: Vec<String>,
}

#[derive(Clone, Serialize)]
struct EvidenceFile {
    path: String,
    content: String,
}

#[derive(Serialize)]
struct ModuleEvidence {
    cwd: String,
    files: Vec<EvidenceFile>,
}

const MANIFESTS: &[&str] = &[
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "package.json",
    "pnpm-workspace.yaml",
    "pyproject.toml",
    "requirements.txt",
    "Pipfile",
    "Cargo.toml",
    "go.mod",
    "compose.yaml",
    "compose.yml",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Makefile",
    "Dockerfile",
    "Procfile",
    "Taskfile.yml",
    "Taskfile.yaml",
    "Justfile",
    "justfile",
    ".vscode/tasks.json",
    ".vscode/launch.json",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "uv.lock",
    "poetry.lock",
];
const SUPPORT: &[&str] = &["README.md", ".env.example", ".env.sample", ".env.template"];

fn read_text(path: &Path, limit: usize) -> Option<String> {
    if !fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= limit)
        .then(|| String::from_utf8(bytes).ok())
        .flatten()
}

fn relative(root: &Path, path: &Path) -> String {
    let path = path.strip_prefix(root).unwrap_or(path);
    if path.as_os_str().is_empty() {
        ".".into()
    } else {
        path.to_string_lossy().replace('\\', "/")
    }
}

fn declared_tasks(files: &[EvidenceFile], cwd: &str) -> (String, TaskDetails) {
    let file = |name: &str| {
        let path = if cwd == "." {
            name.to_owned()
        } else {
            format!("{cwd}/{name}")
        };
        files.iter().find(|file| file.path == path)
    };
    let Some(manifest) = file("package.json") else {
        return (String::new(), TaskDetails::default());
    };
    let Ok(package) = serde_json::from_str::<serde_json::Value>(&manifest.content) else {
        return (String::new(), TaskDetails::default());
    };
    let declared_pm = package["packageManager"]
        .as_str()
        .and_then(|entry| entry.split_once('@').map(|(name, _)| name))
        .filter(|name| matches!(*name, "npm" | "pnpm" | "yarn" | "bun"));
    let pm = declared_pm.unwrap_or_else(|| {
        if file("pnpm-lock.yaml").is_some() {
            "pnpm"
        } else if file("yarn.lock").is_some() {
            "yarn"
        } else if file("bun.lock").is_some() || file("bun.lockb").is_some() {
            "bun"
        } else {
            "npm"
        }
    });
    let script = |names: &[&str]| {
        names
            .iter()
            .find(|name| {
                package["scripts"][**name]
                    .as_str()
                    .is_some_and(|command| !command.trim().is_empty())
            })
            .map_or_else(String::new, |name| format!("{pm} run {name}"))
    };
    let run = script(&["dev", "start", "serve", "preview"]);
    let mut tasks = TaskDetails {
        package_command: script(&["build", "package"]),
        clean_command: script(&["clean"]),
        ..TaskDetails::default()
    };
    if !run.is_empty() || !tasks.package_command.is_empty() || !tasks.clean_command.is_empty() {
        tasks.sources.push(manifest.path.clone());
    }
    (run, tasks)
}

fn task_scan_entry(path: &Path, is_dir: bool) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if is_dir {
        return (name == ".vscode" || !name.starts_with('.'))
            && !matches!(
                name,
                "node_modules"
                    | "target"
                    | "build"
                    | "dist"
                    | "vendor"
                    | "venv"
                    | "__pycache__"
                    | "test"
                    | "tests"
                    | "fixtures"
                    | "coverage"
                    | "src"
                    | "datasets"
                    | "training_data"
                    | "training-data"
                    | "checkpoints"
            );
    }
    MANIFESTS.contains(&name)
        || (matches!(name, "tasks.json" | "launch.json")
            && path
                .parent()
                .is_some_and(|parent| parent.ends_with(".vscode")))
        || SUPPORT.contains(&name)
        || is_task_script(path)
}

fn is_task_script(path: &Path) -> bool {
    path.parent()
        .is_some_and(|parent| parent.ends_with("scripts") || parent.ends_with("bin"))
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| matches!(ext, "sh" | "ps1" | "cmd" | "bat"))
}

struct ScanLimits {
    entry_cap_reached: bool,
    pending_directories: BTreeSet<PathBuf>,
}

fn collect(root: &Path) -> (Vec<ModuleEvidence>, Vec<Candidate>, ScanLimits, bool) {
    let mut indexed = BTreeSet::new();
    let mut dirs = BTreeSet::from([root.to_owned()]);
    let mut limits = ScanLimits {
        entry_cap_reached: false,
        pending_directories: BTreeSet::new(),
    };
    let walk = aide_workspace::fs_ops::walk_project_files(root, |entry| {
        if entry.depth() == 0 {
            return true;
        }
        let Some(kind) = entry.file_type() else {
            return false;
        };
        !kind.is_symlink() && task_scan_entry(entry.path(), kind.is_dir())
    });
    for (index, path) in walk.enumerate() {
        if index >= 4000 {
            limits.entry_cap_reached = true;
            if let Some(scope) = task_owner(&path).filter(|scope| *scope != root) {
                limits.pending_directories.insert(scope.to_owned());
            }
            break;
        }
        if let Some(owner) = task_owner(&path) {
            if owner.starts_with(root) {
                dirs.insert(owner.to_owned());
            }
        }
        indexed.insert(path);
    }
    let mut evidence = Vec::new();
    let mut candidates = BTreeMap::new();
    let mut evidence_limited = false;
    let mut dirs: Vec<_> = dirs.into_iter().collect();
    dirs.sort_by_key(|dir| dir.components().count());
    for dir in dirs {
        let depth = dir
            .strip_prefix(root)
            .map_or(0, |path| path.components().count());
        let manifests: Vec<_> = MANIFESTS
            .iter()
            .copied()
            .filter(|name| indexed.contains(&dir.join(name)))
            .collect();
        let scripts: Vec<_> = ["scripts", "bin"]
            .into_iter()
            .flat_map(|name| {
                let folder = dir.join(name);
                indexed
                    .range(folder.clone()..)
                    .take_while(move |path| path.starts_with(&folder))
                    .filter(|path| {
                        path.parent()
                            .is_some_and(|parent| parent.parent() == Some(dir.as_path()))
                    })
                    .take(6)
                    .cloned()
            })
            .collect();
        if !manifests.is_empty() || !scripts.is_empty() || depth == 0 {
            let rel = relative(root, &dir);
            let name = dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| rel.clone());
            let mut files = Vec::new();
            let paths = manifests
                .iter()
                .map(|name| dir.join(name))
                .chain(SUPPORT.iter().map(|name| dir.join(name)))
                .chain(scripts.iter().cloned());
            for path in paths {
                if !indexed.contains(&path) {
                    continue;
                }
                if !path.canonicalize().is_ok_and(|canonical| {
                    canonical.starts_with(root) && canonical.file_name() == path.file_name()
                }) {
                    continue;
                }
                let mut content = if path.parent().is_some_and(|parent| {
                    parent == dir.join("scripts") || parent == dir.join("bin")
                }) {
                    "Project script exists. Contents were not inspected.".to_owned()
                } else if path.file_name().is_some_and(|name| {
                    matches!(
                        name.to_str(),
                        Some(
                            "package-lock.json"
                                | "pnpm-lock.yaml"
                                | "yarn.lock"
                                | "uv.lock"
                                | "poetry.lock"
                                | "bun.lock"
                                | "bun.lockb"
                        )
                    )
                }) {
                    "Present".to_owned()
                } else {
                    let Some(content) = read_text(&path, 64 * 1024) else {
                        evidence_limited = true;
                        continue;
                    };
                    content
                };
                if path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(".env."))
                {
                    content = content
                        .lines()
                        .filter_map(|line| {
                            let (key, _) = line
                                .trim()
                                .strip_prefix("export ")
                                .unwrap_or(line.trim())
                                .split_once('=')?;
                            valid_key(key.trim()).then_some(key.trim())
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                }
                let mut end = content.len().min(2200);
                while !content.is_char_boundary(end) {
                    end -= 1;
                }
                if end == 0 {
                    continue;
                }
                if path.file_name().is_none_or(|name| name != "package.json") {
                    content.truncate(end);
                } else {
                    let Ok(package) = serde_json::from_str::<serde_json::Value>(&content) else {
                        evidence_limited = true;
                        continue;
                    };
                    content = serde_json::json!({
                        "packageManager": package["packageManager"],
                        "scripts": package["scripts"],
                        "workspaces": package["workspaces"],
                    })
                    .to_string();
                    if content.len() > 16_000 {
                        evidence_limited = true;
                        continue;
                    }
                }
                files.push(EvidenceFile {
                    path: relative(root, &path),
                    content,
                });
            }
            let (command, tasks) = declared_tasks(&files, &rel);
            evidence.push(ModuleEvidence {
                cwd: rel.clone(),
                files,
            });
            if !manifests.is_empty() || !command.is_empty() || !scripts.is_empty() {
                candidates.insert(
                    rel,
                    Candidate {
                        name,
                        cwd: dunce::simplified(&dir).to_string_lossy().into_owned(),
                        command,
                        tasks,
                    },
                );
            }
        }
    }
    (
        evidence,
        candidates.into_values().collect(),
        limits,
        evidence_limited,
    )
}

fn task_owner(path: &Path) -> Option<&Path> {
    let parent = path.parent()?;
    if parent.ends_with(".vscode") || is_task_script(path) {
        parent.parent()
    } else {
        Some(parent)
    }
}

#[derive(Deserialize)]
struct ModelTask {
    cwd: String,
    #[serde(default)]
    command: String,
    #[serde(flatten)]
    tasks: TaskDetails,
}

fn apply_analysis(
    root: &Path,
    evidence: &[ModuleEvidence],
    candidates: &mut Vec<Candidate>,
    raw: &str,
) -> Result<(), String> {
    let raw = raw.trim();
    let raw = raw
        .strip_prefix("```json")
        .or_else(|| raw.strip_prefix("```"))
        .and_then(|text| text.trim_end().strip_suffix("```"))
        .unwrap_or(raw)
        .trim();
    if raw.len() > 64 * 1024 {
        return Err("模型结果过长".into());
    }
    let tasks: Vec<ModelTask> = serde_json::from_str(raw).map_err(|_| "模型结果格式无效")?;
    let known_sources: BTreeSet<_> = evidence
        .iter()
        .flat_map(|m| m.files.iter().map(|f| f.path.as_str()))
        .collect();
    let mut seen = BTreeSet::new();
    for model in tasks {
        let Some(module) = evidence.iter().find(|module| module.cwd == model.cwd) else {
            continue;
        };
        if !seen.insert(model.cwd.clone())
            || model.tasks.sources.is_empty()
            || !model
                .tasks
                .sources
                .iter()
                .all(|source| known_sources.contains(source.as_str()))
        {
            continue;
        }
        let dir = root.join(&module.cwd);
        let cwd = dunce::simplified(&dir).to_string_lossy().into_owned();
        let candidate = match candidates.iter_mut().find(|item| item.cwd == cwd) {
            Some(item) => item,
            None => {
                candidates.push(Candidate {
                    name: dir
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| model.cwd.clone()),
                    cwd,
                    command: String::new(),
                    tasks: TaskDetails::default(),
                });
                candidates.last_mut().unwrap()
            }
        };
        if valid_command(&model.command) {
            candidate.command = model.command;
        }
        let mut tasks = model.tasks;
        tasks.env_file.clear();
        if !valid_command(&tasks.package_command) {
            tasks.package_command.clear();
        }
        if !valid_command(&tasks.clean_command) {
            tasks.clean_command.clear();
        }
        tasks.required_env.retain(|key| valid_key(key));
        tasks.required_env.sort();
        tasks.required_env.dedup();
        if !tasks.package_command.is_empty() {
            candidate.tasks.package_command = tasks.package_command;
        }
        if !tasks.clean_command.is_empty() {
            candidate.tasks.clean_command = tasks.clean_command;
        }
        candidate.tasks.required_env.extend(tasks.required_env);
        candidate.tasks.required_env.sort();
        candidate.tasks.required_env.dedup();
        candidate.tasks.sources.extend(tasks.sources);
        candidate.tasks.sources.sort();
        candidate.tasks.sources.dedup();
    }
    Ok(())
}

fn evidence_batches(evidence: &[ModuleEvidence]) -> Result<Vec<Vec<ModuleEvidence>>, String> {
    const BUDGET: usize = 34_000;
    let mut batches = Vec::new();
    let mut batch: Vec<ModuleEvidence> = Vec::new();
    let mut bytes = 2;
    for module in evidence {
        for file in &module.files {
            let size = serde_json::to_vec(file)
                .map_err(|error| error.to_string())?
                .len()
                + module.cwd.len() * 6
                + 32;
            if !batch.is_empty() && bytes + size > BUDGET {
                batches.push(std::mem::take(&mut batch));
                bytes = 2;
            }
            if batch.last().is_none_or(|last| last.cwd != module.cwd) {
                batch.push(ModuleEvidence {
                    cwd: module.cwd.clone(),
                    files: Vec::new(),
                });
            }
            batch.last_mut().unwrap().files.push(file.clone());
            bytes += size;
        }
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    Ok(batches)
}

pub(super) async fn discover(core: Arc<Core>, args: DiscoverArgs) -> Result<Discovery, String> {
    let (root, evidence, mut candidates, limits, pending_directories, unreadable) =
        blocking(move || {
            let root = PathBuf::from(args.cwd)
                .canonicalize()
                .map_err(|_| "工作区目录不存在")?;
            if !root.is_dir() {
                return Err("工作区目录不存在".into());
            }
            let scan_root =
                if let Some(scope) = args.subdirectory.filter(|scope| !scope.trim().is_empty()) {
                    let target = root
                        .join(scope.trim())
                        .canonicalize()
                        .map_err(|_| "子目录不存在")?;
                    if target == root || !target.starts_with(&root) || !target.is_dir() {
                        return Err("请选择工作区内的子目录".into());
                    }
                    if target
                        .ancestors()
                        .take_while(|dir| *dir != root)
                        .any(|dir| !task_scan_entry(dir, true))
                    {
                        return Err("该子目录属于项目任务排除范围".into());
                    }
                    target
                } else {
                    root.clone()
                };
            let (evidence, candidates, limits, unreadable) = collect(&scan_root);
            let pending_directories = limits
                .pending_directories
                .iter()
                .map(|dir| relative(&root, dir))
                .collect();
            Ok((
                scan_root,
                evidence,
                candidates,
                limits,
                pending_directories,
                unreadable,
            ))
        })
        .await?;
    let mut warnings = Vec::new();
    if limits.entry_cap_reached {
        warnings
            .push("启动相关文件达到识别上限。可补扫已定位的目录，也可指定其他模块。".to_owned());
    }
    if unreadable {
        warnings.push("部分启动文件无法读取或超过单文件读取上限".to_owned());
    }
    let batches = evidence_batches(&evidence)?;
    if !batches.is_empty() {
        let result = async {
            let settings = core.settings.clone();
            let env = blocking(move || {
                let provider = settings
                    .resolve_active_runtime_provider()
                    .map_err(|error| error.to_string())?;
                Ok(crate::runtime::env::build_runtime_env_vars(
                    &provider,
                    &crate::app_settings::public_settings(&settings)?.proxy,
                ))
            })
            .await
            .map_err(|_| "无法读取当前供应商配置".to_owned())?;
            crate::runtime::start(&core)
                .await
                .map_err(|_| "无法启动模型运行时".to_owned())?;
            let mut invalid_batches = 0;
            for batch in batches {
                let raw = core
                    .runtime
                    .suggest_terminal_command(json!({
                        "cmd": "analyze_project_tasks",
                        "env": env,
                        "evidence": { "os": std::env::consts::OS, "modules": batch },
                    }))
                    .await
                    .map_err(|error| {
                        if error.starts_with("Haiku ") {
                            error
                        } else {
                            "模型运行时未返回结果，请检查运行时版本或连接".to_owned()
                        }
                    })?;
                if apply_analysis(&root, &batch, &mut candidates, &raw).is_err() {
                    invalid_batches += 1;
                }
            }
            if invalid_batches == 0 {
                Ok(())
            } else {
                Err(format!("Haiku 有 {invalid_batches} 批结果格式无效"))
            }
        }
        .await;
        if let Err(reason) = result {
            warnings.push(format!("{reason}，已保留本地检测和已完成批次的结果"));
        }
    }
    Ok(Discovery {
        candidates,
        scan_limited: limits.entry_cap_reached || !limits.pending_directories.is_empty(),
        pending_directories,
        warning: (!warnings.is_empty()).then(|| warnings.join("。")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_nested_configuration_without_counting_unrelated_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let pending = root.join("a/b/c/d/e/f/g");
        fs::create_dir_all(&pending).unwrap();
        fs::write(
            pending.join("package.json"),
            r#"{"scripts":{"start":"node app.js"}}"#,
        )
        .unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir_all(root.join("ignored/a/b/c/d/e/f/g/h")).unwrap();
        let unrelated = root.join("assets");
        fs::create_dir(&unrelated).unwrap();
        for index in 0..4100 {
            fs::create_dir(unrelated.join(index.to_string())).unwrap();
        }

        let (_, candidates, limits, _) = collect(&root);
        assert!(!limits.entry_cap_reached);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].command, "npm run start");
        assert!(limits.pending_directories.is_empty());
    }

    #[test]
    fn model_batches_keep_all_files_even_for_one_large_module() {
        let files = (0..30)
            .map(|i| EvidenceFile {
                path: format!("scripts/{i}.sh"),
                content: "x".repeat(2200),
            })
            .collect();
        let batches = evidence_batches(&[ModuleEvidence {
            cwd: "backend".into(),
            files,
        }])
        .unwrap();
        assert!(batches.len() > 1);
        assert!(batches
            .iter()
            .all(|batch| serde_json::to_vec(batch).unwrap().len() <= 34_000));
        assert_eq!(
            batches
                .iter()
                .flatten()
                .map(|module| module.files.len())
                .sum::<usize>(),
            30
        );
    }

    #[test]
    fn discovery_keeps_siblings_and_sends_only_env_template_keys() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for module in ["backend", "frontend", "ai-service/app"] {
            fs::create_dir_all(root.join(module)).unwrap();
        }
        fs::write(root.join("backend/pom.xml"), "<project/>").unwrap();
        fs::write(
            root.join("frontend/package.json"),
            r#"{"scripts":{"dev:web":"vite"}}"#,
        )
        .unwrap();
        fs::write(root.join("ai-service/app/main.py"), "app = FastAPI()").unwrap();
        fs::create_dir_all(root.join("ai-service/scripts")).unwrap();
        fs::write(
            root.join("ai-service/scripts/start.sh"),
            "script-body-marker",
        )
        .unwrap();
        fs::write(
            root.join("ai-service/requirements.txt"),
            "fastapi\nuvicorn[standard]>=0.30",
        )
        .unwrap();
        fs::write(root.join("ai-service/.env"), "TOKEN=actual-secret").unwrap();
        fs::write(root.join("ai-service/.env.example"), "TOKEN=example-secret").unwrap();
        fs::write(
            root.join(".gitignore"),
            "local-corpus/\nfrontend/private/\n",
        )
        .unwrap();
        for path in [
            "local-corpus",
            "frontend/private",
            "node_modules/tool",
            "dist",
            "training_data",
        ] {
            fs::create_dir_all(root.join(path)).unwrap();
            fs::write(
                root.join(path).join("package.json"),
                r#"{"scripts":{"start":"ignored-command"}}"#,
            )
            .unwrap();
        }

        let (evidence, mut candidates, _, _) = collect(&root);
        assert_eq!(
            candidates
                .iter()
                .find(|candidate| candidate.name == "ai-service")
                .unwrap()
                .command,
            ""
        );
        assert!(["backend", "frontend", "ai-service"]
            .iter()
            .all(|name| { candidates.iter().any(|candidate| candidate.name == *name) }));
        let evidence_json = serde_json::to_string(&evidence).unwrap();
        assert!(!evidence_json.contains("ignored-command"));
        assert!(candidates
            .iter()
            .all(|candidate| !candidate.command.contains("ignored-command")));
        assert!(evidence_json.contains("TOKEN"));
        assert!(!evidence_json.contains("secret"));
        assert!(!evidence_json.contains("FastAPI"));
        assert!(!evidence_json.contains("app/main.py"));
        assert!(evidence_json.contains("ai-service/scripts/start.sh"));
        assert!(!evidence_json.contains("script-body-marker"));
        apply_analysis(
            &root,
            &evidence,
            &mut candidates,
            r#"[
            {"cwd":"frontend","command":"pnpm run dev:web","sources":["frontend/package.json"]},
            {"cwd":"../elsewhere","command":"echo unsafe","sources":["frontend/package.json"]}
        ]"#,
        )
        .unwrap();
        assert_eq!(
            candidates
                .iter()
                .find(|item| item.name == "frontend")
                .unwrap()
                .command,
            "pnpm run dev:web"
        );
        assert!(!candidates.iter().any(|item| item.command == "echo unsafe"));
    }

    #[test]
    fn environment_is_reread_and_explicit_values_override_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".env");
        let resolve = |env| {
            resolve_task_env(
                dir.path(),
                "echo ready",
                env,
                TaskEnvironment {
                    env_file: ".env".into(),
                    required_env: vec!["AIDE_TEST_PROJECT_ENDPOINT".into()],
                },
            )
        };
        fs::write(&path, "AIDE_TEST_PROJECT_ENDPOINT='first value'").unwrap();
        assert_eq!(
            resolve(BTreeMap::new()).unwrap()["AIDE_TEST_PROJECT_ENDPOINT"],
            "first value"
        );
        fs::write(&path, "AIDE_TEST_PROJECT_ENDPOINT=second").unwrap();
        assert_eq!(
            resolve(BTreeMap::new()).unwrap()["AIDE_TEST_PROJECT_ENDPOINT"],
            "second"
        );
        let empty = BTreeMap::from([("AIDE_TEST_PROJECT_ENDPOINT".into(), String::new())]);
        assert!(resolve(empty).unwrap_err().contains("缺少必填环境变量"));
    }
}
