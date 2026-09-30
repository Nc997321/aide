//! 文件系统操作：全部是**阻塞**函数（调用方负责 `spawn_blocking`——桌面的 Tauri
//! 包装与 aide-host 各自搬线程）。路径一律是本机原生路径；远程路径翻译在桌面侧做。

use std::fs;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use regex::Regex;

use crate::{FileEntry, GrepMatch};

pub fn list_directory_blocking(
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

/// 以编码感知方式读取文本文件。
///
/// `fs::read_to_string` 严格要求合法 UTF-8，GBK/GB18030 的中文 `.properties`/`.java`
/// 会以 "stream did not contain valid UTF-8" 失败 → 文件查看器/变更卡/skill 读取全打不开。
/// IO 与解码分离：磁盘读取后交给纯函数 [`decode_text_bytes`]，便于单测。
pub fn read_text_file_with_encoding(path: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
    decode_text_bytes(&bytes)
}

/// 按优先级把原始字节解码为文本（纯函数，无 IO）：
/// 1. BOM 判定：UTF-16 LE/BE → 对应 UTF-16；UTF-8 BOM → 剥 BOM 后 UTF-8
/// 2. 无 BOM 先严格 UTF-8（覆盖绝大多数现代文件，且不误伤）
/// 3. UTF-8 失败 → 若含 NUL 字节判为二进制，返回错误（保留原 read_to_string 的失败语义，
///    避免把二进制读成满屏 U+FFFD 的乱码文本）
/// 4. 否则按 GB18030 兜底（GBK/GB2312 超集，覆盖中文 Windows 文件；对任意字节几乎不失败）
pub fn decode_text_bytes(bytes: &[u8]) -> Result<String, String> {
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

/// 整文件读成 base64（图片附件等）。
pub fn read_file_base64(path: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// 以原始字节读取文件，供前端通过 Blob URL 预览图片等二进制资源。
///
/// 文本预览走 `read_file_content`，但 `fs::read_to_string` 要求合法 UTF-8，
/// 二进制图片（PNG/JPG/GIF/WEBP…）会以 "stream did not contain valid UTF-8" 失败。
/// 桌面把字节包成 `ipc::Response`（前端 `new Blob(...)` + `URL.createObjectURL`）。
pub const IMAGE_PREVIEW_MAX_BYTES: u64 = 20_000_000;

pub fn read_file_binary(path: &str) -> Result<Vec<u8>, String> {
    let p = PathBuf::from(path);
    let meta = fs::metadata(&p).map_err(|e| format!("Failed to read file: {}", e))?;
    if meta.len() > IMAGE_PREVIEW_MAX_BYTES {
        return Err(format!(
            "File too large to preview ({} bytes > {} limit)",
            meta.len(),
            IMAGE_PREVIEW_MAX_BYTES
        ));
    }
    fs::read(&p).map_err(|e| format!("Failed to read file: {}", e))
}

pub fn write_file_content(path: &str, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| format!("Failed to write file: {}", e))
}

pub fn delete_file(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        fs::remove_file(&p).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

pub fn create_file(parent_path: &str, name: &str) -> Result<(), String> {
    let file_path = PathBuf::from(parent_path).join(name);
    if file_path.exists() {
        return Err(format!("Already exists: {}", name));
    }
    fs::write(&file_path, "").map_err(|e| format!("Failed to create file: {}", e))
}

pub fn create_dir(parent_path: &str, name: &str) -> Result<(), String> {
    let dir_path = PathBuf::from(parent_path).join(name);
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

pub fn copy_file(src: &str, dest: &str) -> Result<(), String> {
    let src_path = PathBuf::from(src);
    let dest_path = PathBuf::from(dest);
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
}

pub fn move_file(src: &str, dest: &str) -> Result<(), String> {
    let src_path = PathBuf::from(src);
    let dest_path = PathBuf::from(dest);
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
        fs::remove_dir_all(&src_path).map_err(|e| format!("Failed to remove source dir: {}", e))?;
    } else {
        fs::copy(&src_path, &dest_path).map_err(|e| format!("Failed to copy: {}", e))?;
        fs::remove_file(&src_path).map_err(|e| format!("Failed to remove source: {}", e))?;
    }
    Ok(())
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

pub fn grep_symbol(
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

pub fn file_exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// 批量探测路径类型，逐项返回 `"file"` / `"dir"` / `"none"`。
pub fn path_types(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|p| match fs::metadata(p) {
            Ok(m) if m.is_dir() => "dir",
            Ok(_) => "file",
            Err(_) => "none",
        })
        .map(String::from)
        .collect()
}

/// 按文件名（或带目录段的路径片段）在工作区内搜索匹配文件，返回绝对路径列表。
///
/// 聊天里的文件链接常常只给出部分路径（相对某个子目录、或仅文件名），直接拼到
/// 工作区根下打不开。这里遵守 .gitignore 遍历，先收集 basename 完全相等的结果
/// （若查询含目录段，rel 路径以查询结尾的排在最前），再补 basename 包含查询的
/// 模糊结果，供前端在 0/1/多 命中时分别处理（多命中弹选择框）。
/// 同 grep_symbol：遍历必须离开主线程（聊天里点一个文件链接就会触发一次搜索，
/// 大仓库上同步跑等于点一下卡死一次）。
pub fn find_files_by_name(
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

    #[test]
    fn read_file_base64_roundtrip() {
        let dir = std::env::temp_dir().join("aide_ws_test_b64");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("test.png");
        let bytes: &[u8] = &[137, 80, 78, 71, 13, 10, 26, 10]; // PNG magic bytes
        fs::write(&path, bytes).unwrap();

        let result = read_file_base64(&path.to_string_lossy()).unwrap();
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&result)
            .unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn read_file_base64_missing_file() {
        assert!(read_file_base64("/nonexistent/path/img.png").is_err());
    }
}
