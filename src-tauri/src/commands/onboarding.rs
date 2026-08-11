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

/// 启动 Claude OAuth 登录。返回授权 URL（A2 控制通道成功）或 degraded=true（降级到 API key）。
///
/// TODO(OAuth): A2（claude_authenticate 控制通道）需 runtime 请求-响应/事件通道——现
/// `send_to_runtime` 是 fire-and-forget，拿不回 authorize URL；A1（spawn `claude auth login`）
/// 需验证无 TTY 行为。两者均未接入，当前直接返回 degraded=true，前端降级到 API key。
/// OAuth 实际接入拆成后续独立任务（见 docs/superpowers/specs/2026-08-11-onboarding-design.md §6.4）。
#[tauri::command]
pub async fn claude_start_login() -> Result<LoginStartResult, String> {
    Ok(LoginStartResult {
        authorize_url: None,
        degraded: true,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")] // authorize_url → authorizeUrl，对齐 api.ts
pub struct LoginStartResult {
    pub authorize_url: Option<String>,
    pub degraded: bool,
}