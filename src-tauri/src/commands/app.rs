use tauri::AppHandle;

/// 应用版本号（package_info，纯内存读取，inline 命令安全）。
/// 前端品牌区/关于页用；不进远程 RPC 白名单（PWA 无此需求）。
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}
