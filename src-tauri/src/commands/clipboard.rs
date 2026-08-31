//! Clipboard commands for pasting files / images into the Claude TUI.
//!
//! `clipboard_read_files` reads file paths copied in the OS file manager
//! (Explorer / Finder / Nautilus). `clipboard_read_image` reads a clipboard
//! bitmap (e.g. a screenshot), encodes it as PNG into a temp file, and returns
//! the path. Both are consumed by the frontend on Ctrl+V / Cmd+V.

#[cfg(any(target_os = "linux", test))]
use std::path::PathBuf;
use tauri::command;

/// Parse a Linux clipboard file payload (`text/uri-list` or
/// `x-special/gnome-copied-files`) into local paths.
///
/// - `text/uri-list`: one `file://` URI per line; lines starting with `#` are
///   comments.
/// - `x-special/gnome-copied-files`: first line is `copy` / `cut`, subsequent
///   lines are `file://` URIs (we drop the leading `copy`/`cut` marker).
///
/// Declared unconditionally (and tested on every platform) so the pure parsing
/// logic can be unit-tested on Windows too — `percent-encoding` is a pure-Rust
/// crate that compiles everywhere. The function is only *called* on Linux.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_uri_list(raw: &str) -> Vec<PathBuf> {
    use percent_encoding::percent_decode_str;
    raw.lines()
        .map(|l| l.trim())
        .filter(|t| !t.is_empty() && !t.starts_with('#') && *t != "copy" && *t != "cut")
        .filter_map(|t| {
            let path_str = if let Some(rest) = t.strip_prefix("file://") {
                percent_decode_str(rest).decode_utf8_lossy().to_string()
            } else {
                t.to_string()
            };
            Some(PathBuf::from(path_str))
        })
        .collect()
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
}

#[command]
pub fn clipboard_read_files() -> Vec<String> {
    let _trace = crate::diagnostics::trace_command("clipboard_read_files");
    read_clipboard_files_impl()
}

// ── Platform implementations ───────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn read_clipboard_files_impl() -> Vec<String> {
    // clipboard-win 5.x: `get_clipboard` opens the clipboard (with retries) and
    // reads the HDROP file list via the FileList Getter. Any failure (clipboard
    // locked by another app, no files present) is silent — nothing to paste.
    use clipboard_win::{formats::FileList, get_clipboard};
    match get_clipboard::<Vec<String>, _>(FileList) {
        Ok(paths) => paths,
        Err(_) => Vec::new(),
    }
}

#[cfg(target_os = "macos")]
fn read_clipboard_files_impl() -> Vec<String> {
    // macOS-only — NOT compiled on Windows / Linux. Must be built on macOS to
    // verify against the installed objc2 versions; adjust the API calls per
    // `cargo doc` and the compiler. Reads `public.file-url` (NSURL) entries
    // from the general pasteboard.
    use objc2::rc::Retained;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSDictionary, NSURL};

    let pb = unsafe { NSPasteboard::generalPasteboard() };
    let classes = unsafe { NSArray::from_slice(&[&*NSURL::class() as *const _ as *const _]) };
    let opts = unsafe {
        NSDictionary::<objc2_foundation::NSString, objc2::rc::Retained<objc2_foundation::NSString>>::new()
    };
    let objects: Option<Retained<NSArray>> =
        unsafe { pb.readObjectsForClasses_options(&classes, Some(&opts)) };

    objects
        .into_iter()
        .flatten()
        .filter_map(|obj| {
            let url: Retained<NSURL> = obj.downcast::<NSURL>().ok()?;
            if unsafe { url.isFileURL() } {
                Some(unsafe { url.path().to_string() })
            } else {
                None
            }
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn read_clipboard_files_impl() -> Vec<String> {
    // Linux-only — NOT compiled on Windows / macOS. Prefer Wayland (wl-paste),
    // fall back to X11 (xclip / xsel). Probe each target's common MIME types.
    // `which` is already a project dependency.
    use std::process::Command;

    let candidates: &[&[&str]] = &[
        &["wl-paste", "--type", "text/uri-list"],
        &["wl-paste", "--type", "x-special/gnome-copied-files"],
        &[
            "xclip",
            "-selection",
            "clipboard",
            "-o",
            "-t",
            "text/uri-list",
        ],
        &[
            "xclip",
            "-selection",
            "clipboard",
            "-o",
            "-t",
            "x-special/gnome-copied-files",
        ],
        &["xsel", "--clipboard", "--input"],
    ];

    for argv in candidates {
        if which::which(argv[0]).is_err() {
            continue;
        }
        let out = Command::new(argv[0]).args(&argv[1..]).output();
        if let Ok(o) = out {
            if o.status.success() {
                let raw = String::from_utf8_lossy(&o.stdout);
                let paths = parse_uri_list(&raw);
                if !paths.is_empty() {
                    return paths
                        .into_iter()
                        .map(|p| p.to_string_lossy().to_string())
                        .collect();
                }
            }
        }
    }
    Vec::new()
}

// A fallback so the file compiles on any other target (e.g. BSD) without
// pulling in platform crates — returns nothing to paste.
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn read_clipboard_files_impl() -> Vec<String> {
    Vec::new()
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

/// Stage a file dropped from the OS into the webview onto a temp path and
/// return that path. Used by the chat input's drop handler only when WebView2
/// does NOT expose `File.path` on the dropped `File` (Tauri's OLE drop target
/// is disabled so `DragDropEvent` never fires; the bytes arrive via
/// `dataTransfer.files`). The returned path is fed into the same paste
/// pipeline (`resolvePastePayload`) so a dropped file becomes an `@path`
/// reference / image attachment, exactly like a pasted file.
#[command]
pub fn stage_dropped_file(name: String, base64: String) -> Result<String, String> {
    let _trace = crate::diagnostics::trace_command("stage_dropped_file");
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| format!("invalid base64: {e}"))?;

    let dir = std::env::temp_dir().join("aide-dropped");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create temp dir: {e}"))?;

    // 防御：只取最终文件名，丢弃任何路径分隔符。
    let clean = name.rsplit(['/', '\\']).next().unwrap_or(&name);
    let target = unique_drop_path(&dir, clean);

    std::fs::write(&target, &bytes).map_err(|e| format!("write temp file: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

/// Resolve `dir/name` to a non-existing path, appending ` (n)` before the
/// extension on collision so repeated drops of the same file don't overwrite.
fn unique_drop_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let direct = dir.join(name);
    if !direct.exists() {
        return direct;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    };
    for i in 1..100_000u32 {
        let trial = if ext.is_empty() {
            format!("{stem} ({i})")
        } else {
            format!("{stem} ({i}).{ext}")
        };
        let p = dir.join(&trial);
        if !p.exists() {
            return p;
        }
    }
    direct
}
