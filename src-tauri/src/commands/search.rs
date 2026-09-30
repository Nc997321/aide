//! 文件内搜索 / 批量替换的 Tauri 薄包装；实现在 [`aide_workspace::search`]
//! （与远程工作区的 aide-host 共用同一份）。

pub use aide_workspace::search::*;

#[tauri::command]
pub async fn search_in_files(
    query: String,
    cwd: String,
    options: SearchOptions,
) -> Result<SearchResponse, String> {
    tokio::task::spawn_blocking(move || search_in_files_blocking(&query, &cwd, &options))
        .await
        .map_err(|e| format!("search_in_files task panicked: {}", e))?
}

#[tauri::command]
pub async fn replace_in_files_preview(
    query: String,
    replacement: String,
    cwd: String,
    options: SearchOptions,
) -> Result<ReplacePreviewResponse, String> {
    tokio::task::spawn_blocking(move || {
        replace_in_files_preview_blocking(&query, &replacement, &cwd, &options)
    })
    .await
    .map_err(|e| format!("replace_in_files_preview task panicked: {}", e))?
}

#[tauri::command]
pub async fn apply_replacements(files: Vec<ReplaceFileInput>) -> Result<ApplyResult, String> {
    tokio::task::spawn_blocking(move || apply_replacements_blocking(files))
        .await
        .map_err(|e| format!("apply_replacements task panicked: {}", e))?
}

