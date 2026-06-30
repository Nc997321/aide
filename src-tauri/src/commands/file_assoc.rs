//! Windows「打开方式」集成：把 Aide 注册为「已注册应用程序」。
//!
//! 资源管理器右键「打开方式 → Aide」会以 `aide.exe <path>` 二次启动；
//! `tauri-plugin-single-instance` 把 argv 转发到首个实例，由 `lib.rs` 的回调
//! emit `open-file-preview` 事件（热启动）。冷启动（首次即被带参唤起）时回调
//! 不会触发，故 setup 把路径暂存到 `PendingOpenFile`，前端 mount 时通过
//! `consume_pending_open_file` 取走兜底。
//!
//! 注册表全部写在 HKCU（per-user、免管理员、不抢默认程序）。仅写
//! `OpenWithProgids` 的裸 ProgID 会被 Windows 当成低优先级、埋在「其他应用」
//! 末尾甚至要展开「更多应用」才看得见。这里做完整的「已注册应用程序」注册：
//! - ProgID `Software\Classes\Aide.File`（FriendlyAppName + shell\open\command）
//! - 应用注册 `Software\Classes\Applications\<exe>`（FriendlyAppName + command）
//! - `RegisteredApplications\Aide` → `Applications\<exe>\Capabilities`
//!   （ApplicationName + FileAssociations\.ext = Aide.File）
//! - 每个扩展名：`OpenWithProgids\Aide.File` + `OpenWithList\<exe>`
//! 写完调 `SHChangeNotify(SHCNE_ASSOCCHANGED)` 刷新 shell 缓存，立即生效。

use std::sync::Mutex;

use tauri::State;

use super::settings::{load_config, save_config};

/// 冷启动时由 setup 存入、前端 mount 时消费的待预览路径。
pub struct PendingOpenFile(pub Mutex<Option<String>>);

const PROG_ID: &str = "Aide.File";
const APP_NAME: &str = "Aide";
const APP_DESCRIPTION: &str = "Claude Code 桌面壳";

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
fn exe_filename(exe: &str) -> String {
    std::path::Path::new(exe)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "aide.exe".to_string())
}

/// 写 shell\open\command 与 DefaultIcon 到一个已存在的 key。
#[cfg(windows)]
fn write_open_command(key: &winreg::RegKey, exe: &str) -> Result<(), String> {
    let (icon, _) = key
        .create_subkey("DefaultIcon")
        .map_err(|e| format!("Failed to create DefaultIcon: {}", e))?;
    icon.set_value("", &format!("{},0", exe))
        .map_err(|e| format!("Failed to set icon: {}", e))?;
    let (cmd, _) = key
        .create_subkey("shell\\open\\command")
        .map_err(|e| format!("Failed to create shell\\open\\command: {}", e))?;
    cmd.set_value("", &format!("\"{}\" \"%1\"", exe))
        .map_err(|e| format!("Failed to set open command: {}", e))?;
    Ok(())
}

/// 注册 ProgID、Applications\<exe>、Capabilities 外壳、RegisteredApplications。
#[cfg(windows)]
fn ensure_app_registration(exe: &str) -> Result<(), String> {
    use winreg::{enums::*, RegKey};
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let exe_name = exe_filename(exe);

    // ProgID Aide.File
    let (prog, _) = hkcu
        .create_subkey(format!("Software\\Classes\\{}", PROG_ID))
        .map_err(|e| format!("Failed to create ProgID: {}", e))?;
    prog.set_value("", &"Aide File")
        .map_err(|e| format!("Failed to set ProgID label: {}", e))?;
    prog.set_value("FriendlyAppName", &APP_NAME)
        .map_err(|e| format!("Failed to set FriendlyAppName: {}", e))?;
    write_open_command(&prog, exe)?;

    // Applications\<exe> —— 让 Windows 把 exe 识别为「应用程序」，给出友好名称
    let app_path = format!("Software\\Classes\\Applications\\{}", exe_name);
    let (app, _) = hkcu
        .create_subkey(&app_path)
        .map_err(|e| format!("Failed to create Applications key: {}", e))?;
    app.set_value("FriendlyAppName", &APP_NAME)
        .map_err(|e| format!("Failed to set app FriendlyAppName: {}", e))?;
    write_open_command(&app, exe)?;

    // Capabilities 外壳（FileAssociations 的每个扩展名在 register_ext 里填）
    let caps_path = format!("{}\\Capabilities", app_path);
    let (caps, _) = hkcu
        .create_subkey(&caps_path)
        .map_err(|e| format!("Failed to create Capabilities: {}", e))?;
    caps.set_value("ApplicationName", &APP_NAME)
        .map_err(|e| format!("Failed to set ApplicationName: {}", e))?;
    caps.set_value("ApplicationDescription", &APP_DESCRIPTION)
        .map_err(|e| format!("Failed to set ApplicationDescription: {}", e))?;
    let _ = caps.create_subkey("FileAssociations");

    // RegisteredApplications —— 进入「已注册应用程序」名单，优先级提升
    let (ra, _) = hkcu
        .create_subkey("Software\\RegisteredApplications")
        .map_err(|e| format!("Failed to open RegisteredApplications: {}", e))?;
    ra.set_value(APP_NAME, &caps_path)
        .map_err(|e| format!("Failed to set RegisteredApplications: {}", e))?;

    Ok(())
}

#[cfg(windows)]
fn register_ext(ext: &str, exe: &str) -> Result<(), String> {
    use winreg::{enums::*, RegKey};
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let exe_name = exe_filename(exe);

    let (ext_key, _) = hkcu
        .create_subkey(format!("Software\\Classes\\.{}", ext))
        .map_err(|e| format!("Failed to create .{}: {}", ext, e))?;

    // OpenWithProgids：裸 ProgID 入口（兜底）
    let (owp, _) = ext_key
        .create_subkey("OpenWithProgids")
        .map_err(|e| format!("Failed to create OpenWithProgids: {}", e))?;
    owp.set_value(PROG_ID, &"")
        .map_err(|e| format!("Failed to set OpenWithProgids: {}", e))?;

    // OpenWithList\<exe>：经典入口，配合 Applications\<exe> 显示友好名称
    let (owl, _) = ext_key
        .create_subkey("OpenWithList")
        .map_err(|e| format!("Failed to create OpenWithList: {}", e))?;
    owl.set_value(&exe_name, &"")
        .map_err(|e| format!("Failed to set OpenWithList: {}", e))?;

    // Capabilities\FileAssociations\.ext = ProgID
    let fa_path = format!(
        "Software\\Classes\\Applications\\{}\\Capabilities\\FileAssociations",
        exe_name
    );
    let (fa, _) = hkcu
        .create_subkey(&fa_path)
        .map_err(|e| format!("Failed to create FileAssociations: {}", e))?;
    fa.set_value(format!(".{}", ext), &PROG_ID)
        .map_err(|e| format!("Failed to set FileAssociations value: {}", e))?;

    Ok(())
}

#[cfg(windows)]
fn unregister_ext(ext: &str, exe: &str) -> Result<(), String> {
    use winreg::{enums::*, RegKey};
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let exe_name = exe_filename(exe);

    // OpenWithProgids\Aide.File
    if let Ok(owp) = hkcu.open_subkey_with_flags(
        format!("Software\\Classes\\.{}\\OpenWithProgids", ext),
        KEY_WRITE,
    ) {
        let _ = owp.delete_value(PROG_ID);
    }
    // OpenWithList\<exe>
    if let Ok(owl) = hkcu.open_subkey_with_flags(
        format!("Software\\Classes\\.{}\\OpenWithList", ext),
        KEY_WRITE,
    ) {
        let _ = owl.delete_value(&exe_name);
    }
    // Capabilities\FileAssociations\.ext
    if let Ok(fa) = hkcu.open_subkey_with_flags(
        format!(
            "Software\\Classes\\Applications\\{}\\Capabilities\\FileAssociations",
            exe_name
        ),
        KEY_WRITE,
    ) {
        let _ = fa.delete_value(format!(".{}", ext));
    }
    Ok(())
}

/// 写完注册表后通知 shell 刷新文件关联缓存，让「打开方式」立即看到新条目，
/// 不必重启 explorer。
#[cfg(windows)]
fn notify_assoc_changed() {
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    // SAFETY: SHChangeNotify 用 null 指针 + SHCNE_ASSOCCHANGED 表示全局关联变更，
    // 无需有效 PIDL，是文档允许的调用形式。
    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
}

#[tauri::command]
pub fn register_open_with(extensions: Vec<String>) -> Result<(), String> {
    let exts: Vec<String> = extensions.iter().filter_map(|e| sanitize_ext(e)).collect();
    #[cfg(windows)]
    {
        let exe = current_exe_string()?;
        ensure_app_registration(&exe)?;
        for e in &exts {
            register_ext(e, &exe)?;
        }
        notify_assoc_changed();
    }
    let _ = exts;
    Ok(())
}

#[tauri::command]
pub fn unregister_open_with(extensions: Vec<String>) -> Result<(), String> {
    let exts: Vec<String> = extensions.iter().filter_map(|e| sanitize_ext(e)).collect();
    #[cfg(windows)]
    {
        let exe = current_exe_string()?;
        for e in &exts {
            let _ = unregister_ext(e, &exe);
        }
        notify_assoc_changed();
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
    let mut merged = config
        .get("settings")
        .cloned()
        .unwrap_or(serde_json::json!({}));
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