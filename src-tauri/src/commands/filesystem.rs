use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::{detect_git_branch, FileEntry, GrepMatch, ProjectInfo, WorkspaceState};
use aide_workspace::fs_ops;

#[tauri::command]
pub fn get_project_info(workspace_state: State<'_, WorkspaceState>) -> Result<ProjectInfo, String> {
    let _trace = crate::diagnostics::trace_command("get_project_info");
    // 无显式工作区 = 显式空（root/name/branch 全 ""），绝不回退到家目录。
    // project_root_for_commands 的家目录回退只服务「进程 cwd」类消费者
    // （chat 会话、git 命令——那里家目录是合理的兜底 cwd）；而本命令的消费
    // 方是**展示与索引**（FileTree 渲染、CodeGraph ensureIndex），它们必须
    // 能区分「没打开项目」，否则 FileTree 会把整个家目录渲染出来、CodeGraph
    // 会索引它（2026-08-01 实锤：405 万符号 / 3GB shard / 每次启动全量
    // 重扫的永动机）。
    let root = {
        let guard = workspace_state.path.lock().map_err(|e| e.to_string())?;
        guard.as_ref().filter(|p| p.exists()).cloned()
    };
    match root {
        Some(root) => Ok(ProjectInfo {
            root: root.to_string_lossy().to_string(),
            name: root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            branch: detect_git_branch(&root),
        }),
        None => Ok(ProjectInfo {
            root: String::new(),
            name: String::new(),
            branch: String::new(),
        }),
    }
}

#[tauri::command]
pub fn file_open(path: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("file_open");
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "start", "", &path]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.spawn().map_err(|e| format!("Failed to open: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open: {}", e))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_in_explorer(path: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("show_in_explorer");
    let p = PathBuf::from(&path);
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer");
        if p.is_dir() {
            cmd.arg(&path);
        } else {
            cmd.arg(format!("/select,{}", path));
        };
        cmd.creation_flags(0x08000000);
        cmd.spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let target = if p.is_dir() {
            path.clone()
        } else {
            p.parent()
                .map(|pa| pa.to_string_lossy().into_owned())
                .unwrap_or(path)
        };
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open: {}", e))?;
    }
    Ok(())
}

// ── Project run-command detection ──────────────────────────────────────────

#[tauri::command]
pub async fn detect_run_command(cwd: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        Ok(super::detectors::detect_command_for_path(Path::new(&cwd)))
    })
    .await
    .map_err(|e| format!("detect_run_command task panicked: {}", e))?
}

/// 列目录。
///
/// 两个过滤维度刻意分开（`show_hidden` / `include_ignored`），因为它们服务的场景不同：
/// - `show_hidden`：点开头的文件/目录（`.git` / `.vscode` / `.env` …）。选择目录时需要
///   看见它们（否则 `.vscode`、`.config` 这类目录在「打开目录」里根本点不到）。
/// - `include_ignored`：构建噪音目录（`node_modules` / `target` / `dist`）。它们不是隐藏
///   文件，条目量却极大（node_modules 常伴数千子目录），在目录选择器里只会淹没结果并
///   拖慢列目录，所以默认仍过滤。
///
/// 历史实现把两者绑在同一个 `show_hidden` 上，导致「想看见隐藏目录」必须连带吞下
/// node_modules；文件树那边沿用旧语义（两个开关同值）以保持行为不变。
#[tauri::command]
pub async fn list_directory(
    path: String,
    show_hidden: Option<bool>,
    include_ignored: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    // IPC 边界保留 Option（前端可省略）；None 与 false 等价，进实现前归一成 bool。
    let show_hidden = show_hidden.unwrap_or(false);
    let include_ignored = include_ignored.unwrap_or(false);
    blocking("list_directory", move || {
        fs_ops::list_directory_blocking(path, show_hidden, include_ignored)
    })
    .await
}

#[tauri::command]
pub async fn list_fs_roots() -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(|| {
        let mut roots = Vec::new();
        #[cfg(target_os = "windows")]
        {
            // Home 快速入口置顶，方便直达用户项目目录
            if let Some(home) = super::user_home() {
                let hp = home.to_string_lossy().into_owned();
                if std::path::Path::new(&hp).is_dir() {
                    roots.push(FileEntry {
                        name: "Home".to_string(),
                        path: hp,
                        is_dir: true,
                        children: None,
                    });
                }
            }
            for b in b'A'..=b'Z' {
                let drive = format!("{}:\\", b as char);
                if std::path::Path::new(&drive).is_dir() {
                    roots.push(FileEntry {
                        name: format!("{}:", b as char),
                        path: drive,
                        is_dir: true,
                        children: None,
                    });
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            roots.push(FileEntry {
                name: "/".to_string(),
                path: "/".to_string(),
                is_dir: true,
                children: None,
            });
            if let Some(home) = super::user_home() {
                let hp = home.to_string_lossy().into_owned();
                roots.push(FileEntry {
                    name: "Home".to_string(),
                    path: hp,
                    is_dir: true,
                    children: None,
                });
            }
        }
        Ok(roots)
    })
    .await
    .map_err(|e| format!("list_fs_roots panicked: {}", e))?
}

/// 文件读取/写入/复制/删除一律 async + spawn_blocking：大文件 / 大目录 / 跨盘复制 /
/// 递归删除是同步重 IO，跑在 Tauri 主线程上会被杀软实时扫描或磁盘争抢拖到秒级，
/// 把窗口整卡成「未响应」（2026-07-08 两轮真实冻结实锤同类反模式
/// `session_jsonl_size` / `save_session_changes`）。见 CLAUDE.md「同步 command 禁止
/// 重 IO / 重 CPU」。实现都在 [`aide_workspace::fs_ops`]（与远程 aide-host 共用）。
async fn blocking<T, F>(name: &'static str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("{name} task panicked: {e}"))?
}

#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    blocking("read_file_content", move || fs_ops::read_text_file_with_encoding(&path)).await
}

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    blocking("read_file_base64", move || fs_ops::read_file_base64(&path)).await
}

/// 原始字节（图片预览）：前端 `new Blob(...)` + `URL.createObjectURL` 喂给 `<img>`。
#[tauri::command]
pub async fn read_file_binary(path: String) -> Result<tauri::ipc::Response, String> {
    blocking("read_file_binary", move || {
        fs_ops::read_file_binary(&path).map(tauri::ipc::Response::new)
    })
    .await
}

#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    blocking("write_file_content", move || fs_ops::write_file_content(&path, &content)).await
}

#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    blocking("delete_file", move || fs_ops::delete_file(&path)).await
}

#[tauri::command]
pub fn create_file(parent_path: String, name: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("create_file");
    fs_ops::create_file(&parent_path, &name)
}

#[tauri::command]
pub fn create_dir(parent_path: String, name: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("create_dir");
    fs_ops::create_dir(&parent_path, &name)
}

#[tauri::command]
pub async fn copy_file(src: String, dest: String) -> Result<(), String> {
    blocking("copy_file", move || fs_ops::copy_file(&src, &dest)).await
}

#[tauri::command]
pub async fn move_file(src: String, dest: String) -> Result<(), String> {
    blocking("move_file", move || fs_ops::move_file(&src, &dest)).await
}

/// 全工作区遍历是重 IO，必须离开主线程（同步命令会把窗口卡成"未响应"）。
#[tauri::command]
pub async fn grep_symbol(
    word: String,
    cwd: String,
    source_ext: Option<String>,
) -> Result<Vec<GrepMatch>, String> {
    blocking("grep_symbol", move || fs_ops::grep_symbol(word, cwd, source_ext)).await
}

/// 单次 stat，保留同步；埋 trace——网络盘 / 杀软扫描下 stat 也会卡，冻结报告要能点名。
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    let _trace = crate::diagnostics::trace_command("file_exists");
    fs_ops::file_exists(&path)
}

/// 批量探测路径类型，逐项返回 `"file"` / `"dir"` / `"none"`（输入框 `@path` 芯片用）。
#[tauri::command]
pub async fn path_types(paths: Vec<String>) -> Result<Vec<String>, String> {
    blocking("path_types", move || Ok(fs_ops::path_types(&paths))).await
}

/// 按文件名（或带目录段的路径片段）在工作区内搜索匹配文件，返回绝对路径列表。
/// 聊天里点一个文件链接就会触发一次，大仓库上同步跑等于点一下卡死一次。
#[tauri::command]
pub async fn find_files_by_name(
    query: String,
    cwd: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    blocking("find_files_by_name", move || {
        fs_ops::find_files_by_name(query, cwd, limit)
    })
    .await
}
