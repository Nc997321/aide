//! Clipboard commands for pasting files / images into the Claude TUI.
//!
//! `clipboard_read_files` reads file paths copied in the OS file manager
//! (Explorer / Finder / Nautilus). `clipboard_write_files` writes file paths
//! in the reverse direction so the file tree's Ctrl+C/X is visible to the OS
//! file manager. `clipboard_read_image` reads a clipboard bitmap (e.g. a
//! screenshot), encodes it as PNG into a temp file, and returns the path.
//!
//! copy / cut semantics by platform:
//! - Windows: `Preferred DropEffect` registered format (little-endian DWORD,
//!   DROPEFFECT_COPY=1 / DROPEFFECT_MOVE=2) written alongside CF_HDROP.
//! - Linux: `x-special/gnome-copied-files` payload whose first line is
//!   `copy` / `cut` (both directions; see read/write impls for the known
//!   trade-off of only publishing the gnome MIME type).
//! - macOS: no standard cut marker on NSPasteboard; reads default to copy and
//!   the write direction is not implemented yet (explicit error, see impl).

use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "linux", test))]
use std::path::PathBuf;
use tauri::command;

/// 文件剪贴板操作语义。封闭 copy/cut 两值（M5：非法值造不出来）；经 IPC
/// 时 serde 序列化成小写字符串，前端 TS 类型为 `"copy" | "cut"`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipboardOp {
    Copy,
    Cut,
}

/// `clipboard_read_files` 的返回 DTO：剪贴板里的文件路径列表 + 操作语义。
/// paths 为空 = 剪贴板没有文件（前端按无文件处理）。
#[derive(Debug, Clone, Serialize)]
pub struct ClipboardFilesRead {
    pub paths: Vec<String>,
    pub op: ClipboardOp,
}

/// `Preferred DropEffect` 的载荷字节（Windows）：DROPEFFECT_COPY=1 /
/// DROPEFFECT_MOVE=2，little-endian DWORD。
#[cfg(any(target_os = "windows", test))]
fn drop_effect_bytes(op: ClipboardOp) -> [u8; 4] {
    match op {
        ClipboardOp::Copy => [1, 0, 0, 0],
        ClipboardOp::Cut => [2, 0, 0, 0],
    }
}

/// 把 `file://` URI（或纯路径文本）解码成本地路径。URI 部分做百分号解码；
/// 无前缀的行按纯路径处理。
///
/// 声明为无条件（并在所有平台测试）以便纯解析逻辑能在 Windows 上单测——
/// `percent-encoding` 是纯 Rust crate 处处可编译。只有 Linux 会调用。
/// **必须留在模块顶层**：Linux 的 `*_impl` 生产代码引用它们，放进
/// `#[cfg(test)]` 会让 Linux 非测试构建 E0425（Windows 全绿纯属 cfg 掩护）。
#[cfg(any(target_os = "linux", test))]
fn decode_file_uri(line: &str) -> PathBuf {
    use percent_encoding::percent_decode_str;
    match line.strip_prefix("file://") {
        Some(rest) => PathBuf::from(percent_decode_str(rest).decode_utf8_lossy().to_string()),
        None => PathBuf::from(line.to_string()),
    }
}

/// Parse a Linux clipboard file payload (`text/uri-list` or
/// `x-special/gnome-copied-files`) into local paths.
///
/// - `text/uri-list`: one `file://` URI per line; lines starting with `#` are
///   comments.
/// - `x-special/gnome-copied-files`: first line is `copy` / `cut`, subsequent
///   lines are `file://` URIs (we drop the leading `copy`/`cut` marker).
#[cfg(any(target_os = "linux", test))]
fn parse_uri_list(raw: &str) -> Vec<PathBuf> {
    raw.lines()
        .map(|l| l.trim())
        .filter(|t| !t.is_empty() && !t.starts_with('#') && *t != "copy" && *t != "cut")
        .map(decode_file_uri)
        .collect()
}

/// 解析 `x-special/gnome-copied-files` 载荷：头 token 决定 op（copy/cut），
/// 其余行是 `file://` URI。头缺失时按 copy 兜底（部分剪贴板管理器剥头）。
#[cfg(any(target_os = "linux", test))]
fn parse_gnome_copied_files(raw: &str) -> (ClipboardOp, Vec<PathBuf>) {
    let mut lines = raw.lines().map(|l| l.trim()).filter(|l| !l.is_empty());
    let op = match lines.next() {
        Some("cut") => ClipboardOp::Cut,
        _ => ClipboardOp::Copy,
    };
    (op, lines.map(decode_file_uri).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_uri_list() {
        let raw = "file:///home/u/a.txt\nfile:///home/u/b%20c.txt\n";
        let v = parse_uri_list(raw);
        assert_eq!(
            v,
            vec![
                PathBuf::from("/home/u/a.txt"),
                PathBuf::from("/home/u/b c.txt")
            ]
        );
    }

    #[test]
    fn parses_gnome_copied_files() {
        let raw = "copy\nfile:///home/u/x.txt\n";
        assert_eq!(parse_uri_list(raw), vec![PathBuf::from("/home/u/x.txt")]);
    }

    #[test]
    fn ignores_comments_and_blank() {
        let raw = "# comment\n\nfile:///tmp/y\n";
        assert_eq!(parse_uri_list(raw), vec![PathBuf::from("/tmp/y")]);
    }

    #[test]
    fn decode_plain_path_without_file_prefix() {
        // 带 None 臂：无 file:// 前缀的行按纯路径处理
        assert_eq!(
            decode_file_uri("/home/u/plain.txt"),
            PathBuf::from("/home/u/plain.txt")
        );
        assert_eq!(
            decode_file_uri("C:\\plain.txt"),
            PathBuf::from("C:\\plain.txt")
        );
    }

    #[test]
    fn drop_effect_bytes_matches_dropeffect_constants() {
        assert_eq!(drop_effect_bytes(ClipboardOp::Copy), [1, 0, 0, 0]);
        assert_eq!(drop_effect_bytes(ClipboardOp::Cut), [2, 0, 0, 0]);
    }

    #[test]
    fn parses_gnome_copied_files_with_op() {
        let (op, paths) = parse_gnome_copied_files("copy\nfile:///home/u/a\nfile:///home/u/b\n");
        assert_eq!(op, ClipboardOp::Copy);
        assert_eq!(
            paths,
            vec![PathBuf::from("/home/u/a"), PathBuf::from("/home/u/b")]
        );
        let (op, paths) = parse_gnome_copied_files("cut\nfile:///home/u/x\n");
        assert_eq!(op, ClipboardOp::Cut);
        assert_eq!(paths, vec![PathBuf::from("/home/u/x")]);
        // 头缺失/未知 → 按 copy 兜底
        let (op, _) = parse_gnome_copied_files("file:///home/u/y\n");
        assert_eq!(op, ClipboardOp::Copy);
    }
}

#[command]
pub fn clipboard_read_files() -> ClipboardFilesRead {
    let _trace = crate::diagnostics::trace_command("clipboard_read_files");
    read_clipboard_files_impl()
}

/// 把若干文件路径写入 OS 剪贴板（文件语义），供文件树 Ctrl+C / Ctrl+X 双写。
/// op 决定资源管理器粘贴时是复制还是移动。
#[command]
pub fn clipboard_write_files(paths: Vec<String>, op: ClipboardOp) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("clipboard_write_files");
    if paths.is_empty() {
        return Err("没有可写入剪贴板的文件".to_string());
    }
    write_clipboard_files_impl(&paths, op)
}

// ── Platform implementations ───────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn read_clipboard_files_impl() -> ClipboardFilesRead {
    // 单会话读：OpenClipboard 有互斥，一次会话内把 CF_HDROP 和 Preferred
    // DropEffect 一并读出，不做两次 get_clipboard（互斥风险，前端
    // ChatInputBox 的「串行读」注释同源）。任一失败按「没有文件」处理。
    use clipboard_win::{formats::FileList, Clipboard, Getter};

    let empty = ClipboardFilesRead {
        paths: vec![],
        op: ClipboardOp::Copy,
    };
    let Ok(_clip) = Clipboard::new_attempts(10) else {
        return empty;
    };
    let mut paths = Vec::new();
    if FileList.read_clipboard(&mut paths).is_err() || paths.is_empty() {
        return empty;
    }
    // Explorer 未写 DropEffect（仅注册文件列表）→ 按 copy 语义。
    let op = preferred_drop_effect().unwrap_or(ClipboardOp::Copy);
    ClipboardFilesRead { paths, op }
}

/// 读 `Preferred DropEffect` 原始字节。必须在已打开的剪贴板会话内调用。
#[cfg(target_os = "windows")]
fn preferred_drop_effect() -> Option<ClipboardOp> {
    use clipboard_win::raw;
    let fmt = raw::register_format("Preferred DropEffect")?;
    let mut buf = Vec::new();
    if raw::get_vec(fmt.get(), &mut buf).is_err() || buf.len() < 4 {
        return None;
    }
    let effect = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if effect & 0x2 != 0 {
        Some(ClipboardOp::Cut)
    } else {
        Some(ClipboardOp::Copy)
    }
}

#[cfg(target_os = "windows")]
fn write_clipboard_files_impl(paths: &[String], op: ClipboardOp) -> Result<(), String> {
    use clipboard_win::{formats::FileList, raw, Clipboard, Setter};
    // 会话模板：open（RAII）→ empty 恰好一次 → FileList（内部 NoClear，不会
    // 丢掉已写内容）→ set_without_clear 追加 DropEffect。绝不能用 raw::set
    // 写第二个格式——它会 EmptyClipboard，把先写的 CF_HDROP 清掉。
    let _clip = Clipboard::new_attempts(10).map_err(|e| format!("打开剪贴板失败: {e}"))?;
    clipboard_win::empty().map_err(|e| format!("清空剪贴板失败: {e}"))?;
    FileList
        .write_clipboard(paths)
        .map_err(|e| format!("写入文件列表失败: {e}"))?;
    // register_format 失败（系统从未注册过该格式名）只降级为 copy 语义，
    // 文件列表本身已可用。
    if let Some(fmt) = clipboard_win::register_format("Preferred DropEffect") {
        let _ = raw::set_without_clear(fmt.get(), &drop_effect_bytes(op));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn read_clipboard_files_impl() -> ClipboardFilesRead {
    // macOS-only — NOT compiled on Windows / Linux。逐个剪贴板条目取 `public.file-url`
    // 字符串（`file:///…`），再经 NSURL 还原成 POSIX 路径（NSURL 负责百分号解码）。
    // 不用 readObjectsForClasses（要拼 Class 数组 + 向下转型，objc2 各版本差异大）。
    // macOS 剪贴板没有标准 cut 标记，一律按 copy 处理（写入方向同见
    // write_clipboard_files_impl 的说明）。
    // 依赖只认 objc2-app-kit / objc2-foundation（0.2.x 同代），objc2 本体由它们传递引入——
    // Cargo.toml 不要再单独声明 objc2（曾写成 0.2 与它们依赖的 0.5 不一致，编译不过）。
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::NSURL;

    let paths = unsafe {
        let pb = NSPasteboard::generalPasteboard();
        let mut out: Vec<String> = Vec::new();
        if let Some(items) = pb.pasteboardItems() {
            for item in items.iter() {
                let Some(raw) = item.stringForType(NSPasteboardTypeFileURL) else {
                    continue;
                };
                let Some(url) = NSURL::URLWithString(&raw) else {
                    continue;
                };
                if !url.isFileURL() {
                    continue;
                }
                if let Some(p) = url.path() {
                    out.push(p.to_string());
                }
            }
        }
        out
    };
    ClipboardFilesRead {
        paths,
        op: ClipboardOp::Copy,
    }
}

#[cfg(target_os = "macos")]
fn write_clipboard_files_impl(_paths: &[String], _op: ClipboardOp) -> Result<(), String> {
    // 未实现（v1）：向 NSPasteboard 写文件 URL 需要构造
    // NSArray<ProtocolObject<dyn NSPasteboardWriting>>，而 objc2 0.2.x 的
    // NSURL 没有 ConformsTo 声明（需 macOS 机器上按 installed objc2 版本
    // 验证指针转换）。读取方向已实现，写入方向返回显式错误——优于盲写不可
    // 验证的 unsafe 指针体操（macOS 构建会直接编译失败）。
    Err("macOS 写入系统剪贴板尚未实现（读取方向可用）".to_string())
}

#[cfg(target_os = "linux")]
fn read_clipboard_files_impl() -> ClipboardFilesRead {
    // Linux-only — NOT compiled on Windows / macOS. Prefer Wayland (wl-paste),
    // fall back to X11 (xclip / xsel). gnome-copied-files 探测必须在 uri-list
    // 之前：只有它带 copy/cut 头，uri-list 永远只能兜底为 copy。
    use std::process::Command;

    let attempts: &[(&[&str], bool)] = &[
        (
            &["wl-paste", "--type", "x-special/gnome-copied-files"],
            true,
        ),
        (
            &[
                "xclip",
                "-selection",
                "clipboard",
                "-o",
                "-t",
                "x-special/gnome-copied-files",
            ],
            true,
        ),
        (&["wl-paste", "--type", "text/uri-list"], false),
        (
            &[
                "xclip",
                "-selection",
                "clipboard",
                "-o",
                "-t",
                "text/uri-list",
            ],
            false,
        ),
        (&["xsel", "--clipboard", "--output"], false),
    ];

    for (argv, is_gnome) in attempts {
        if which::which(argv[0]).is_err() {
            continue;
        }
        let out = Command::new(argv[0]).args(&argv[1..]).output();
        if let Ok(o) = out {
            if o.status.success() {
                let raw = String::from_utf8_lossy(&o.stdout);
                let (op, paths) = if *is_gnome {
                    parse_gnome_copied_files(&raw)
                } else {
                    (ClipboardOp::Copy, parse_uri_list(&raw))
                };
                if !paths.is_empty() {
                    return ClipboardFilesRead {
                        paths: paths
                            .iter()
                            .map(|p| p.to_string_lossy().to_string())
                            .collect(),
                        op,
                    };
                }
            }
        }
    }
    ClipboardFilesRead {
        paths: vec![],
        op: ClipboardOp::Copy,
    }
}

#[cfg(target_os = "linux")]
fn write_clipboard_files_impl(paths: &[String], op: ClipboardOp) -> Result<(), String> {
    // Linux-only — NOT compiled on Windows / macOS.
    //
    // 只发布 x-special/gnome-copied-files（带 copy/cut 头，与读方向的探测顺
    // 序对称）：wl-copy / xclip 一次只能拥有一个 MIME type，第二次写会抢走
    // selection 所有权；纯 uri-list 的消费者（KDE、部分 IDE）因此看不到——
    // 已知代价，Nautilus 往返最佳。
    //
    // wl-copy / xclip 要常驻接管 selection，喂完 stdin 后 spawn 不 wait，
    // 否则 selection 所有权即释放、复制等于没复制。
    use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
    use std::io::Write;
    use std::process::{Command, Stdio};

    const FILE_URI_SET: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'/')
        .remove(b':')
        .remove(b'.')
        .remove(b'-')
        .remove(b'_');

    let mut body = String::from(if op == ClipboardOp::Cut {
        "cut"
    } else {
        "copy"
    });
    for p in paths {
        body.push_str("\nfile://");
        body.push_str(&utf8_percent_encode(p, FILE_URI_SET).to_string());
    }
    body.push('\n');

    let candidates: &[&[&str]] = &[
        &["wl-copy", "--type", "x-special/gnome-copied-files"],
        &[
            "xclip",
            "-selection",
            "clipboard",
            "-t",
            "x-special/gnome-copied-files",
        ],
    ];
    for argv in candidates {
        if which::which(argv[0]).is_err() {
            continue;
        }
        let mut child = Command::new(argv[0])
            .args(&argv[1..])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动 {argv[0]} 失败: {e}"))?;
        // stdin 写失败 = wl-copy/xclip 早已崩死、复制必败——必须上抛，不能
        // 让命令按成功收尾（用户以为复制了，粘贴却是旧内容）。
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(body.as_bytes())
                .map_err(|e| format!("写入剪贴板数据失败: {e}"))?;
        }
        // 不 wait：子进程需常驻接管 selection，wait 会等它退出（即复制丢失）。
        return Ok(());
    }
    Err("未找到 wl-copy 或 xclip，无法写入系统剪贴板".to_string())
}

// A fallback so the file compiles on any other target (e.g. BSD) without
// pulling in platform crates — returns nothing to paste / refuses writes.
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn read_clipboard_files_impl() -> ClipboardFilesRead {
    ClipboardFilesRead {
        paths: vec![],
        op: ClipboardOp::Copy,
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn write_clipboard_files_impl(_paths: &[String], _op: ClipboardOp) -> Result<(), String> {
    Err("unsupported platform".to_string())
}

// ── Image reading (cross-platform via arboard) ──────────────────────────────

#[command]
pub fn clipboard_read_image() -> Option<String> {
    let _trace = crate::diagnostics::trace_command("clipboard_read_image");
    read_clipboard_image_impl()
}

fn read_clipboard_image_impl() -> Option<String> {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    let mut cb = match arboard::Clipboard::new() {
        Ok(c) => c,
        Err(_) => return None,
    };
    let img = match cb.get_image() {
        Ok(i) => i,
        Err(_) => return None,
    };

    let png_bytes = match encode_rgba_png(img.width as u32, img.height as u32, img.bytes.as_ref()) {
        Ok(b) => b,
        Err(_) => return None,
    };

    let tmp_root = std::env::temp_dir().join("aide-clipboard");
    let _ = fs::create_dir_all(&tmp_root);

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = tmp_root.join(format!("img-{}.png", nanos));

    if fs::write(&path, &png_bytes).is_err() {
        return None;
    }
    Some(path.to_string_lossy().to_string())
}

/// Encode raw RGBA pixels as a PNG. arboard delivers RGBA-ordered bytes on
/// Windows/macOS; if a platform returns BGRA the colours will look swapped and
/// a conversion should be added here (see plan Task 8 Step 3).
fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    use png::{BitDepth, ColorType, Encoder};
    let mut buf = Vec::new();
    {
        let mut enc = Encoder::new(&mut buf, width, height);
        enc.set_color(ColorType::Rgba);
        enc.set_depth(BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(buf)
}
