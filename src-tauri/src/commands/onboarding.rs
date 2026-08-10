//! 首次安装引导相关命令。

/// `~/.aide/claude/.credentials.json` 是否存在——claude.exe OAuth 登录成功后会把 token 写到这里
/// （CLAUDE_CONFIG_DIR 由 runtime 强制指向 ~/.aide/claude/）。
///
/// 引导登录步用它判断"已登录 → 自动跳过"；上下文兜底用它判断"无凭证 → 拦截首条消息"。
/// 只查文件存在性，不读不解析（格式由 claude.exe 自管，逆向脆弱）。
#[tauri::command]
pub fn claude_credentials_exist() -> bool {
    std::fs::metadata(super::claude_home().join(".credentials.json")).is_ok()
}