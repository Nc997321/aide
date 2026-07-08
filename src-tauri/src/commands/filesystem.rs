use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

use ignore::WalkBuilder;
use regex::Regex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::{FileEntry, GrepMatch, WorkspaceState, project_root_for_commands, detect_git_branch, ProjectInfo};

#[tauri::command]
pub fn get_project_info(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<ProjectInfo, String> {
    let root = project_root_for_commands(&workspace_state);

    Ok(ProjectInfo {
        root: root.to_string_lossy().to_string(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        branch: detect_git_branch(&root),
    })
}

#[tauri::command]
pub fn file_open(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "start", "", &path]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.spawn()
            .map_err(|e| format!("Failed to open: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
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
        cmd.spawn().map_err(|e| format!("Failed to open explorer: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let target = if p.is_dir() { path.clone() } else {
            p.parent().map(|pa| pa.to_string_lossy().into_owned()).unwrap_or(path)
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
    tokio::task::spawn_blocking(move || Ok(super::detectors::detect_command_for_path(Path::new(&cwd))))
        .await
        .map_err(|e| format!("detect_run_command task panicked: {}", e))?
}

#[tauri::command]
pub async fn list_directory(path: String, show_hidden: Option<bool>) -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(move || list_directory_blocking(path, show_hidden))
        .await
        .map_err(|e| format!("list_directory task panicked: {}", e))?
}

fn list_directory_blocking(path: String, show_hidden: Option<bool>) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("Failed to read dir: {}", e))?;

    for entry in read_dir {
        let Ok(entry) = entry else { continue; };
        let name = entry.file_name().to_string_lossy().to_string();

        if !show_hidden.unwrap_or(false) {
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
                continue;
            }
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

/// 文件读取/写入/复制/删除一律 async + spawn_blocking：大文件 / 大目录 / 跨盘复制 /
/// 递归删除是同步重 IO，跑在 Tauri 主线程上会被杀软实时扫描或磁盘争抢拖到秒级，
/// 把窗口整卡成「未响应」（2026-07-08 两轮真实冻结实锤同类反模式
/// `session_jsonl_size` / `save_session_changes`）。见 CLAUDE.md「同步 command 禁止
/// 重 IO / 重 CPU」。
#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e)))
        .await
        .map_err(|e| format!("read_file_content task panicked: {}", e))?
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
    tokio::task::spawn_blocking(move || fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e)))
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
            let name = dest_path.file_name().unwrap_or_default().to_string_lossy().to_string();
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
            let name = dest_path.file_name().unwrap_or_default().to_string_lossy().to_string();
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
            fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("Failed to copy: {}", e))?;
            fs::remove_file(&src_path)
                .map_err(|e| format!("Failed to remove source: {}", e))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("move_file task panicked: {}", e))?
}

// ── grep_symbol: project-wide symbol search for code navigation ──

fn code_family(ext: &str) -> Option<&'static [&'static str]> {
    match ext {
        "java" | "kt" | "kts" | "scala" | "groovy" =>
            Some(&["java", "kt", "kts", "scala", "groovy"]),
        "js" | "jsx" | "ts" | "tsx" | "vue" | "svelte" | "mjs" | "cjs" | "mts" | "cts" =>
            Some(&["js", "jsx", "ts", "tsx", "vue", "svelte", "mjs", "cjs", "mts", "cts"]),
        "py" | "pyi" =>
            Some(&["py", "pyi"]),
        "rs" =>
            Some(&["rs"]),
        "go" =>
            Some(&["go"]),
        "c" | "h" | "cpp" | "hpp" | "cc" | "cxx" | "hxx" =>
            Some(&["c", "h", "cpp", "hpp", "cc", "cxx", "hxx"]),
        "cs" =>
            Some(&["cs"]),
        "rb" | "erb" =>
            Some(&["rb", "erb"]),
        "php" =>
            Some(&["php"]),
        "swift" =>
            Some(&["swift"]),
        "dart" =>
            Some(&["dart"]),
        _ => None,
    }
}

/// 同步（非 async）command 在 Tauri 里跑在主线程上——全工作区遍历这种重 IO
/// 会把窗口整个卡成"未响应"。这里只做线程搬运，真正的遍历在 blocking 线程池。
#[tauri::command]
pub async fn grep_symbol(word: String, cwd: String, source_ext: Option<String>) -> Result<Vec<GrepMatch>, String> {
    tokio::task::spawn_blocking(move || grep_symbol_blocking(word, cwd, source_ext))
        .await
        .map_err(|e| format!("grep_symbol task panicked: {}", e))?
}

fn grep_symbol_blocking(word: String, cwd: String, source_ext: Option<String>) -> Result<Vec<GrepMatch>, String> {
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
        .filter_map(|(pat, mtype)| {
            Regex::new(pat).ok().map(|re| (re, *mtype))
        })
        .collect();

    // Fallback: any line containing the word
    let fallback = match Regex::new(&escaped) {
        Ok(re) => re,
        Err(_) => return Ok(Vec::new()),
    };

    let allowed_exts: Option<&[&str]> = source_ext
        .as_deref()
        .and_then(|e| code_family(e));

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
                "png" | "jpg" | "jpeg" | "gif" | "ico" | "svg"
                    | "woff" | "woff2" | "ttf" | "eot"
                    | "mp3" | "mp4" | "wav" | "ogg"
                    | "zip" | "tar" | "gz" | "rar" | "7z"
                    | "exe" | "dll" | "so" | "dylib"
                    | "wasm" | "bin" | "dat"
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
                    let already = results.iter().any(|r| {
                        r.file == rel_path && r.line == (line_num + 1) as u32
                    });
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
        b_def.cmp(&a_def)
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.line.cmp(&b.line))
    });

    Ok(results)
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
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
pub async fn find_files_by_name(query: String, cwd: String, limit: Option<usize>) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || find_files_by_name_blocking(query, cwd, limit))
        .await
        .map_err(|e| format!("find_files_by_name task panicked: {}", e))?
}

fn find_files_by_name_blocking(query: String, cwd: String, limit: Option<usize>) -> Result<Vec<String>, String> {
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

        let result = read_file_base64(path.to_string_lossy().to_string()).await.unwrap();
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD.decode(&result).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[tokio::test]
    async fn test_read_file_base64_missing_file() {
        let result = read_file_base64("/nonexistent/path/img.png".to_string()).await;
        assert!(result.is_err());
    }
}
