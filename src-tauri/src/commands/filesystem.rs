use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

use ignore::WalkBuilder;
use regex::Regex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::{detect_git_branch, FileEntry, GrepMatch, ProjectInfo, WorkspaceState};

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
    tokio::task::spawn_blocking(move || list_directory_blocking(path, show_hidden, include_ignored))
        .await
        .map_err(|e| format!("list_directory task panicked: {}", e))?
}

fn list_directory_blocking(
    path: String,
    show_hidden: bool,
    include_ignored: bool,
) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("Failed to read dir: {}", e))?;

    for entry in read_dir {
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();

        if !show_hidden && name.starts_with('.') {
            continue;
        }
        if !include_ignored && (name == "node_modules" || name == "target" || name == "dist") {
            continue;
        }

        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

        entries.push(FileEntry {
            name: name.clone(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            children: if is_dir { Some(Vec::new()) } else { None },
        });
    }

    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(entries)
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
/// 重 IO / 重 CPU」。
#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || read_text_file_with_encoding(&path))
        .await
        .map_err(|e| format!("read_file_content task panicked: {}", e))?
}

/// 以编码感知方式读取文本文件。
///
/// `fs::read_to_string` 严格要求合法 UTF-8，GBK/GB18030 的中文 `.properties`/`.java`
/// 会以 "stream did not contain valid UTF-8" 失败 → 文件查看器/变更卡/skill 读取全打不开。
/// IO 与解码分离：磁盘读取后交给纯函数 [`decode_text_bytes`]，便于单测。
fn read_text_file_with_encoding(path: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
    decode_text_bytes(&bytes)
}

/// 按优先级把原始字节解码为文本（纯函数，无 IO）：
/// 1. BOM 判定：UTF-16 LE/BE → 对应 UTF-16；UTF-8 BOM → 剥 BOM 后 UTF-8
/// 2. 无 BOM 先严格 UTF-8（覆盖绝大多数现代文件，且不误伤）
/// 3. UTF-8 失败 → 若含 NUL 字节判为二进制，返回错误（保留原 read_to_string 的失败语义，
///    避免把二进制读成满屏 U+FFFD 的乱码文本）
/// 4. 否则按 GB18030 兜底（GBK/GB2312 超集，覆盖中文 Windows 文件；对任意字节几乎不失败）
fn decode_text_bytes(bytes: &[u8]) -> Result<String, String> {
    // 1. BOM 判定
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        // UTF-8 BOM：剥掉 BOM，剩余按 UTF-8 解码（带 BOM 的 UTF-8 一定合法）
        let s = encoding_rs::UTF_8
            .decode_without_bom_handling(&bytes[3..])
            .0;
        return Ok(s.into_owned());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let s = encoding_rs::UTF_16LE.decode(&bytes[2..]).0;
        return Ok(s.into_owned());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let s = encoding_rs::UTF_16BE.decode(&bytes[2..]).0;
        return Ok(s.into_owned());
    }

    // 2. 无 BOM 先严格 UTF-8：std::str::from_utf8 失败说明不是 UTF-8
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(s.to_string()),
        Err(_) => {
            // 3. 二进制兜底：含 NUL 字节 → 视为二进制，保留原 read_to_string 的失败语义
            if bytes.contains(&0x00u8) {
                return Err(
                    "Failed to read file: stream did not contain valid UTF-8 (binary file)"
                        .to_string(),
                );
            }
            // 4. GB18030 兜底（GBK/GB2312 超集）。encoding_rs 的 decode 对任意字节序列
            //    几乎不失败（无效字节以 U+FFFD 替代），返回 Cow<str>。
            let s = encoding_rs::GB18030.decode_without_bom_handling(bytes).0;
            Ok(s.into_owned())
        }
    }
}

#[cfg(test)]
mod encoding_tests {
    use super::decode_text_bytes;

    #[test]
    fn utf8_passthrough() {
        let s = decode_text_bytes("中文 abc\n".as_bytes()).unwrap();
        assert_eq!(s, "中文 abc\n");
    }

    #[test]
    fn utf8_bom_stripped() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("中文".as_bytes());
        let s = decode_text_bytes(&bytes).unwrap();
        assert_eq!(s, "中文");
    }

    #[test]
    fn gbk_falls_back_to_gb18030() {
        // "使用空间数据类型" 的 GBK 字节（取自真实 application-dev.properties）
        let gbk_bytes = [
            0xCA, 0xB9, 0xD3, 0xC3, 0xBF, 0xD5, 0xBC, 0xE4, 0xCA, 0xFD, 0xBE, 0xDD, 0xC0, 0xE0,
            0xD0, 0xCD,
        ];
        let s = decode_text_bytes(&gbk_bytes).unwrap();
        assert_eq!(s, "使用空间数据类型");
    }

    #[test]
    fn utf16le_with_bom() {
        let mut bytes = vec![0xFF, 0xFE];
        // '中' U+4E2D / '文' U+6587 按 UTF-16LE 小端拼字节
        for u in ['中' as u32, '文' as u32] {
            let u = u as u16;
            bytes.push(u as u8);
            bytes.push((u >> 8) as u8);
        }
        let s = decode_text_bytes(&bytes).unwrap();
        assert_eq!(s, "中文");
    }

    #[test]
    fn binary_with_nul_errors() {
        // 含 NUL 字节且非 UTF-8 → 视为二进制，返回错误而非乱码
        let bytes = [0x00u8, 0xFF, 0xFE, 0x80];
        assert!(decode_text_bytes(&bytes).is_err());
    }
}

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine;
        let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
        Ok::<String, String>(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| format!("read_file_base64 task panicked: {}", e))?
}

/// 以原始字节读取文件，供前端通过 Blob URL 预览图片等二进制资源。
///
/// 文本预览走 `read_file_content`，但 `fs::read_to_string` 要求合法 UTF-8，
/// 二进制图片（PNG/JPG/GIF/WEBP…）会以 "stream did not contain valid UTF-8" 失败。
/// 这里返回 `ipc::Response`（原始字节），前端用 `new Blob(...)` + `URL.createObjectURL`
/// 直接喂给 `<img>`，无需 base64、无需新增依赖、无需 asset 协议 scope 配置。
const IMAGE_PREVIEW_MAX_BYTES: u64 = 20_000_000;

#[tauri::command]
pub async fn read_file_binary(path: String) -> Result<tauri::ipc::Response, String> {
    tokio::task::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let meta = fs::metadata(&p).map_err(|e| format!("Failed to read file: {}", e))?;
        if meta.len() > IMAGE_PREVIEW_MAX_BYTES {
            return Err(format!(
                "File too large to preview ({} bytes > {} limit)",
                meta.len(),
                IMAGE_PREVIEW_MAX_BYTES
            ));
        }
        let bytes = fs::read(&p).map_err(|e| format!("Failed to read file: {}", e))?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| format!("read_file_binary task panicked: {}", e))?
}

#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
    })
    .await
    .map_err(|e| format!("write_file_content task panicked: {}", e))?
}

#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Ok(());
        }
        if p.is_dir() {
            fs::remove_dir_all(&p).map_err(|e| format!("Failed to delete directory: {}", e))
        } else {
            fs::remove_file(&p).map_err(|e| format!("Failed to delete file: {}", e))
        }
    })
    .await
    .map_err(|e| format!("delete_file task panicked: {}", e))?
}

#[tauri::command]
pub fn create_file(parent_path: String, name: String) -> Result<(), String> {
    let file_path = PathBuf::from(&parent_path).join(&name);
    if file_path.exists() {
        return Err(format!("Already exists: {}", name));
    }
    fs::write(&file_path, "").map_err(|e| format!("Failed to create file: {}", e))
}

#[tauri::command]
pub fn create_dir(parent_path: String, name: String) -> Result<(), String> {
    let dir_path = PathBuf::from(&parent_path).join(&name);
    if dir_path.exists() {
        return Err(format!("Already exists: {}", name));
    }
    fs::create_dir_all(&dir_path).map_err(|e| format!("Failed to create directory: {}", e))
}

fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create dir: {}", e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read dir: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_child = entry.path();
        let dest_child = dest.join(entry.file_name());
        if src_child.is_dir() {
            copy_dir_recursive(&src_child, &dest_child)?;
        } else {
            fs::copy(&src_child, &dest_child)
                .map_err(|e| format!("Failed to copy {}: {}", src_child.display(), e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn copy_file(src: String, dest: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let src_path = PathBuf::from(&src);
        let dest_path = PathBuf::from(&dest);
        if dest_path.exists() {
            let name = dest_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            return Err(format!("EXISTS:{}", name));
        }
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)
        } else {
            fs::copy(&src_path, &dest_path)
                .map(|_| ())
                .map_err(|e| format!("Failed to copy: {}", e))
        }
    })
    .await
    .map_err(|e| format!("copy_file task panicked: {}", e))?
}

#[tauri::command]
pub async fn move_file(src: String, dest: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let src_path = PathBuf::from(&src);
        let dest_path = PathBuf::from(&dest);
        if dest_path.exists() {
            let name = dest_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            return Err(format!("EXISTS:{}", name));
        }
        // 同盘快速路径
        if fs::rename(&src_path, &dest_path).is_ok() {
            return Ok(());
        }
        // 跨盘 fallback：复制后删除源
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
            fs::remove_dir_all(&src_path)
                .map_err(|e| format!("Failed to remove source dir: {}", e))?;
        } else {
            fs::copy(&src_path, &dest_path).map_err(|e| format!("Failed to copy: {}", e))?;
            fs::remove_file(&src_path).map_err(|e| format!("Failed to remove source: {}", e))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("move_file task panicked: {}", e))?
}

// ── grep_symbol: project-wide symbol search for code navigation ──

fn code_family(ext: &str) -> Option<&'static [&'static str]> {
    match ext {
        "java" | "kt" | "kts" | "scala" | "groovy" => {
            Some(&["java", "kt", "kts", "scala", "groovy"])
        }
        "js" | "jsx" | "ts" | "tsx" | "vue" | "svelte" | "mjs" | "cjs" | "mts" | "cts" => Some(&[
            "js", "jsx", "ts", "tsx", "vue", "svelte", "mjs", "cjs", "mts", "cts",
        ]),
        "py" | "pyi" => Some(&["py", "pyi"]),
        "rs" => Some(&["rs"]),
        "go" => Some(&["go"]),
        "c" | "h" | "cpp" | "hpp" | "cc" | "cxx" | "hxx" => {
            Some(&["c", "h", "cpp", "hpp", "cc", "cxx", "hxx"])
        }
        "cs" => Some(&["cs"]),
        "rb" | "erb" => Some(&["rb", "erb"]),
        "php" => Some(&["php"]),
        "swift" => Some(&["swift"]),
        "dart" => Some(&["dart"]),
        _ => None,
    }
}

/// 同步（非 async）command 在 Tauri 里跑在主线程上——全工作区遍历这种重 IO
/// 会把窗口整个卡成"未响应"。这里只做线程搬运，真正的遍历在 blocking 线程池。
#[tauri::command]
pub async fn grep_symbol(
    word: String,
    cwd: String,
    source_ext: Option<String>,
) -> Result<Vec<GrepMatch>, String> {
    tokio::task::spawn_blocking(move || grep_symbol_blocking(word, cwd, source_ext))
        .await
        .map_err(|e| format!("grep_symbol task panicked: {}", e))?
}

fn grep_symbol_blocking(
    word: String,
    cwd: String,
    source_ext: Option<String>,
) -> Result<Vec<GrepMatch>, String> {
    if word.trim().is_empty() {
        return Ok(Vec::new());
    }

    let escaped = regex::escape(word.trim());
    let fn_pat = format!(r"^(pub\s+)?(async\s+)?fn\s+{}", escaped);
    let func_pat = format!(r"^(export\s+)?(async\s+)?function\s+{}", escaped);
    let class_pat = format!(r"^(export\s+)?class\s+{}", escaped);
    let def_pat = format!(r"^def\s+{}", escaped);
    let const_pat = format!(r"^(export\s+)?const\s+{}", escaped);
    let patterns: Vec<(&str, &str)> = vec![
        (&fn_pat, "fn"),
        (&func_pat, "function"),
        (&class_pat, "class"),
        (&def_pat, "def"),
        (&const_pat, "const"),
    ];

    // Compile regexes once
    let compiled: Vec<(Regex, &str)> = patterns
        .iter()
        .filter_map(|(pat, mtype)| Regex::new(pat).ok().map(|re| (re, *mtype)))
        .collect();

    // Fallback: any line containing the word
    let fallback = match Regex::new(&escaped) {
        Ok(re) => re,
        Err(_) => return Ok(Vec::new()),
    };

    let allowed_exts: Option<&[&str]> = source_ext.as_deref().and_then(|e| code_family(e));

    let mut results: Vec<GrepMatch> = Vec::new();

    let walker = WalkBuilder::new(&cwd)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .max_depth(Some(20))
        .build();

    for entry in walker {
        let Ok(entry) = entry else { continue };
        let path = entry.path();

        // Skip non-files and huge files
        if !path.is_file() {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > 1_000_000 {
                continue;
            }
        }
        let file_ext = path.extension().and_then(|e| e.to_str());
        // Skip binary-ish extensions
        if let Some(ext) = file_ext {
            let skip = matches!(
                ext,
                "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "ico"
                    | "svg"
                    | "woff"
                    | "woff2"
                    | "ttf"
                    | "eot"
                    | "mp3"
                    | "mp4"
                    | "wav"
                    | "ogg"
                    | "zip"
                    | "tar"
                    | "gz"
                    | "rar"
                    | "7z"
                    | "exe"
                    | "dll"
                    | "so"
                    | "dylib"
                    | "wasm"
                    | "bin"
                    | "dat"
            );
            if skip {
                continue;
            }
        }
        // Filter by language family
        if let Some(family) = allowed_exts {
            match file_ext {
                Some(ext) if family.contains(&ext) => {}
                _ => continue,
            }
        }

        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };

        let rel_path = path
            .strip_prefix(&cwd)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        // Try definition patterns first
        for (re, mtype) in &compiled {
            for (line_num, line_content) in content.lines().enumerate() {
                if re.is_match(line_content) {
                    results.push(GrepMatch {
                        file: rel_path.clone(),
                        line: (line_num + 1) as u32,
                        content: line_content.trim().to_string(),
                        match_type: mtype.to_string(),
                    });
                    if results.len() >= 50 {
                        break;
                    }
                }
            }
            if results.len() >= 50 {
                break;
            }
        }

        // Fallback: general reference search (only if few definition results)
        if results.len() < 5 {
            for (line_num, line_content) in content.lines().enumerate() {
                if fallback.is_match(line_content) {
                    // Skip if already matched as a definition
                    let already = results
                        .iter()
                        .any(|r| r.file == rel_path && r.line == (line_num + 1) as u32);
                    if !already {
                        results.push(GrepMatch {
                            file: rel_path.clone(),
                            line: (line_num + 1) as u32,
                            content: line_content.trim().to_string(),
                            match_type: "reference".to_string(),
                        });
                        if results.len() >= 50 {
                            break;
                        }
                    }
                }
            }
        }

        if results.len() >= 50 {
            break;
        }
    }

    // Sort: definitions before references
    results.sort_by(|a, b| {
        let a_def = a.match_type != "reference";
        let b_def = b.match_type != "reference";
        b_def
            .cmp(&a_def)
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.line.cmp(&b.line))
    });

    Ok(results)
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// 批量探测路径类型，逐项返回 `"file"` / `"dir"` / `"none"`。
///
/// 输入框的 `@path `→mention 芯片转换层用它一次 IPC 拿到多个候选路径的存在性
/// 与类型（芯片需要 isDir 区分文件/文件夹图标）。`file_exists` 只回 bool 且单个，
/// 这里批量 + 返回类型。metadata 是 IO，走 `spawn_blocking` 不堵 Tauri 主线程
/// （CLAUDE.md 红线：同步命令禁重 IO）。
#[tauri::command]
pub async fn path_types(paths: Vec<String>) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| match std::fs::metadata(p) {
                Ok(m) => {
                    if m.is_dir() {
                        "dir"
                    } else {
                        "file"
                    }
                }
                Err(_) => "none",
            })
            .map(String::from)
            .collect::<Vec<String>>()
    })
    .await
    .map_err(|e| format!("path_types task panicked: {}", e))
}

/// 按文件名（或带目录段的路径片段）在工作区内搜索匹配文件，返回绝对路径列表。
///
/// 聊天里的文件链接常常只给出部分路径（相对某个子目录、或仅文件名），直接拼到
/// 工作区根下打不开。这里遵守 .gitignore 遍历，先收集 basename 完全相等的结果
/// （若查询含目录段，rel 路径以查询结尾的排在最前），再补 basename 包含查询的
/// 模糊结果，供前端在 0/1/多 命中时分别处理（多命中弹选择框）。
/// 同 grep_symbol：遍历必须离开主线程（聊天里点一个文件链接就会触发一次搜索，
/// 大仓库上同步跑等于点一下卡死一次）。
#[tauri::command]
pub async fn find_files_by_name(
    query: String,
    cwd: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || find_files_by_name_blocking(query, cwd, limit))
        .await
        .map_err(|e| format!("find_files_by_name task panicked: {}", e))?
}

fn find_files_by_name_blocking(
    query: String,
    cwd: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let q = query.trim().replace('\\', "/");
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let q_lower = q.to_lowercase();
    let q_base = q_lower.rsplit('/').next().unwrap_or(&q_lower).to_string();
    let has_dir = q_lower.contains('/');
    let cap = limit.unwrap_or(50).min(500);

    let walker = WalkBuilder::new(&cwd)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .max_depth(Some(20))
        .build();

    // exact_suffix: basename 相等且 rel 路径以查询结尾（最强匹配）
    // exact: 仅 basename 相等
    // partial: basename 包含查询片段
    let mut exact_suffix: Vec<String> = Vec::new();
    let mut exact: Vec<String> = Vec::new();
    let mut partial: Vec<String> = Vec::new();

    for entry in walker {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let base = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if base.is_empty() {
            continue;
        }
        let full = path.to_string_lossy().to_string();

        if base == q_base {
            if has_dir {
                let rel = path
                    .strip_prefix(&cwd)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_lowercase();
                if rel.ends_with(&q_lower) {
                    exact_suffix.push(full);
                } else {
                    exact.push(full);
                }
            } else {
                exact.push(full);
            }
        } else if base.contains(&q_base) {
            partial.push(full);
        }

        if exact_suffix.len() + exact.len() >= cap {
            break;
        }
    }

    let mut results = exact_suffix;
    results.extend(exact);
    results.extend(partial);
    results.truncate(cap);
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn test_read_file_base64_roundtrip() {
        let dir = std::env::temp_dir().join("aide_test_b64");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("test.png");
        let bytes: &[u8] = &[137, 80, 78, 71, 13, 10, 26, 10]; // PNG magic bytes
        fs::write(&path, bytes).unwrap();

        let result = read_file_base64(path.to_string_lossy().to_string())
            .await
            .unwrap();
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&result)
            .unwrap();
        assert_eq!(decoded, bytes);
    }

    #[tokio::test]
    async fn test_read_file_base64_missing_file() {
        let result = read_file_base64("/nonexistent/path/img.png".to_string()).await;
        assert!(result.is_err());
    }
}
