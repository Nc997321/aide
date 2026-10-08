//! 回归守卫：**Tauri 命令不准用 `WebviewWindow` 当参数。**
//!
//! `WebviewWindow` 提取器要求「窗口只有一个 webview」。内嵌浏览器用 `Window::add_child` 给窗口挂了第二个
//! webview 之后，所有声明了它的命令都会失败，报 `current webview is not a WebviewWindow`——2026-10-01 真机：
//! 打开内置浏览器后，面板对原生视图的 set_bounds / set_displayed 全被拒绝，页面悬在窗口里、位置不跟随、标签页
//! 对不上（同一缺陷还连带废掉了「粘贴 / 拖入本机文件上传」「在资源管理器中显示」「最近项目记录」）。
//!
//! 只需要窗口标签 / AppHandle 的命令用 `tauri::Window`；确实要碰 webview 本身的（devtools）用 `tauri::Webview`。

use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let p = entry.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|e| e == "rs") {
            out.push(p);
        }
    }
}

/// 取每个 `#[tauri::command]` 之后到函数体 `{` 之前的签名文本。
fn command_signatures(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = src;
    while let Some(i) = rest.find("#[tauri::command]") {
        rest = &rest[i + "#[tauri::command]".len()..];
        if let Some(open) = rest.find('{') {
            out.push(rest[..open].to_string());
        }
    }
    out
}

#[test]
fn no_tauri_command_takes_a_webview_window_argument() {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let mut offenders = Vec::new();
    for f in files {
        let src = std::fs::read_to_string(&f).unwrap();
        for sig in command_signatures(&src) {
            if sig.contains("WebviewWindow") {
                let name = sig.split("fn ").nth(1).and_then(|s| s.split('(').next()).unwrap_or("?").trim().to_string();
                offenders.push(format!("{} :: {name}", f.display()));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "these commands take `WebviewWindow` and break as soon as the window hosts a child webview (embedded browser); use `tauri::Window`:\n{}",
        offenders.join("\n")
    );
}

/// 守卫本身不是空转：能认出违规签名、放过合规签名。
#[test]
fn the_guard_recognises_offending_and_compliant_signatures() {
    let bad = "#[tauri::command]\npub async fn x(window: WebviewWindow, a: u8) -> Result<(), String> {\n}";
    let good = "#[tauri::command]\npub async fn y(window: tauri::Window, a: u8) -> Result<(), String> {\n}\nfn helper(w: &WebviewWindow) {}";
    assert!(command_signatures(bad).iter().any(|s| s.contains("WebviewWindow")));
    assert!(!command_signatures(good).iter().any(|s| s.contains("WebviewWindow")));
}
