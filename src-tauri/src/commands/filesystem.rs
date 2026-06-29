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
pub fn detect_run_command(cwd: String) -> Result<Option<String>, String> {
    Ok(super::detectors::detect_command_for_path(Path::new(&cwd)))
}

#[tauri::command]
pub fn list_directory(path: String, show_hidden: Option<bool>) -> Result<Vec<FileEntry>, String> {
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

#[tauri::command]
pub fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub fn write_file_content(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        fs::remove_file(&p).map_err(|e| format!("Failed to delete file: {}", e))
    }
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
pub fn copy_file(src: String, dest: String) -> Result<(), String> {
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
}

#[tauri::command]
pub fn move_file(src: String, dest: String) -> Result<(), String> {
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

#[tauri::command]
pub fn grep_symbol(word: String, cwd: String, source_ext: Option<String>) -> Result<Vec<GrepMatch>, String> {
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
