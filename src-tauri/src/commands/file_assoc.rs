//! Windows「打开方式」集成：注册表注册 + 冷启动 pending 路径。
//!
//! 资源管理器右键「打开方式 → Aide」会以 `aide.exe <path>` 二次启动；
//! `tauri-plugin-single-instance` 把 argv 转发到首个实例，由 `lib.rs` 的回调
//! emit `open-file-preview` 事件（热启动）。冷启动（首次即被带参唤起）时回调
//! 不会触发，故 setup 把路径暂存到 `PendingOpenFile`，前端 mount 时通过
//! `consume_pending_open_file` 取走兜底。
//!
//! 注册表全部写在 HKCU（per-user、免管理员、不抢默认程序）：
//! - ProgID `Software\Classes\Aide.File` + `shell\open\command = "<exe>" "%1"`
//! - 每个扩展名 `.xxx\OpenWithProgids` 下加值名 `Aide.File`（空字符串）→
//!   仅让 Aide 出现在「打开方式」列表，不改默认程序。

use std::sync::Mutex;

use tauri::State;

use super::settings::{load_config, save_config};

/// 冷启动时由 setup 存入、前端 mount 时消费的待预览路径。
pub struct PendingOpenFile(pub Mutex<Option<String>>);

const PROG_ID: &str = "Aide.File";
const PROG_ID_LABEL: &str = "Aide File";

#[tauri::command]
pub fn consume_pending_open_file(state: State<'_, PendingOpenFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

/// 规范扩展名：小写、去前导 `.`、`[a-z0-9]{1,16}`，非法返回 None。
fn sanitize_ext(raw: &str) -> Option<String> {
    let s = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    if s.is_empty() || s.len() > 16 || !s.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(s)
}

#[cfg(windows)]
fn current_exe_string() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Failed to resolve current exe: {}", e))
}

#[cfg(windows)]
fn ensure_prog_id(exe: &str) -> Result<(), String> {
    use winreg::{enums::*, RegKey};
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (prog, _) = hkcu
        .create_subkey(format!("Software\\Classes\\{}", PROG_ID))
        .map_err(|e| format!("Failed to create ProgID: {}", e))?;
    prog.set_value("", &PROG_ID_LABEL)
        .map_err(|e| format!("Failed to set ProgID label: {}", e))?;
    let (icon, _) = prog
        .create_subkey("DefaultIcon")
        .map_err(|e| format!("Failed to create DefaultIcon: {}", e))?;
    icon.set_value("", &format!("{},0", exe))
        .map_err(|e| format!("Failed to set icon: {}", e))?;
    let (cmd, _) = prog
        .create_subkey("shell\\open\\command")
        .map_err(|e| format!("Failed to create shell\\open\\command: {}", e))?;
    cmd.set_value("", &format!("\"{}\" \"%1\"", exe))
        .map_err(|e| format!("Failed to set open command: {}", e))?;
    Ok(())
}

#[cfg(windows)]
fn register_ext(ext: &str) -> Result<(), String> {
    use winreg::{enums::*, RegKey};
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (ext_key, _) = hkcu
        .create_subkey(format!("Software\\Classes\\.{}", ext))
        .map_err(|e| format!("Failed to create .{}: {}", ext, e))?;
    let (owls, _) = ext_key
        .create_subkey("OpenWithProgids")
        .map_err(|e| format!("Failed to create OpenWithProgids: {}", e))?;
    // 空字符串 REG_SZ：仅注册到「打开方式」列表，不改默认程序。
    owls.set_value(PROG_ID, &"")
        .map_err(|e| format!("Failed to set OpenWithProgids: {}", e))?;
    Ok(())
}

#[cfg(windows)]
fn unregister_ext(ext: &str) -> Result<(), String> {
    use winreg::{enums::*, RegKey};
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let owls = hkcu
        .open_subkey_with_flags(
            format!("Software\\Classes\\.{}\\OpenWithProgids", ext),
            KEY_WRITE,
        )
        .map_err(|e| format!("Failed to open .{}\\OpenWithProgids: {}", ext, e))?;
    owls.delete_value(PROG_ID)
        .map_err(|e| format!("Failed to delete OpenWithProgids value: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn register_open_with(extensions: Vec<String>) -> Result<(), String> {
    let exts: Vec<String> = extensions.iter().filter_map(|e| sanitize_ext(e)).collect();
    #[cfg(windows)]
    {
        let exe = current_exe_string()?;
        ensure_prog_id(&exe)?;
        for e in &exts {
            register_ext(e)?;
        }
    }
    let _ = exts;
    Ok(())
}

#[tauri::command]
pub fn unregister_open_with(extensions: Vec<String>) -> Result<(), String> {
    let exts: Vec<String> = extensions.iter().filter_map(|e| sanitize_ext(e)).collect();
    #[cfg(windows)]
    {
        for e in &exts {
            // 注销时扩展名可能已不存在，忽略其错误以保证幂等。
            let _ = unregister_ext(e);
        }
    }
    let _ = exts;
    Ok(())
}

/// 原子地更新 `open_with_extensions` 设置并按 diff 同步注册表。
///
/// 不走通用 `set_settings`：那条路是字段级 merge、不感知注册表副作用，
/// 会让设置与注册表脱钩。这里先落盘再 diff 旧/新集合，新增注册、移除注销。
#[tauri::command]
pub fn set_open_with_extensions(new_exts: Vec<String>) -> Result<(), String> {
    let new_exts: Vec<String> = new_exts.iter().filter_map(|e| sanitize_ext(e)).collect();

    let mut config = load_config();
    if config.is_null() {
        config = serde_json::json!({});
    }
    let old: Vec<String> = config
        .get("settings")
        .and_then(|s| s.get("open_with_extensions"))
        .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|e| sanitize_ext(&e))
        .collect();

    // 落盘 open_with_extensions
    let mut merged = config.get("settings").cloned().unwrap_or(serde_json::json!({}));
    merged["open_with_extensions"] =
        serde_json::to_value(&new_exts).map_err(|e| e.to_string())?;
    config["settings"] = merged;
    save_config(&config)?;

    let added: Vec<String> = new_exts.iter().filter(|e| !old.contains(e)).cloned().collect();
    let removed: Vec<String> = old.iter().filter(|e| !new_exts.contains(e)).cloned().collect();
    if !added.is_empty() {
        register_open_with(added)?;
    }
    if !removed.is_empty() {
        unregister_open_with(removed)?;
    }
    Ok(())
}