//! 首次安装引导相关命令。

#[allow(unused_imports)]
use crate::registry::{blocking, Command as HostCommand};
#[allow(unused_imports)]
use crate::{command, Core};
#[allow(unused_imports)]
use serde::Deserialize;
#[allow(unused_imports)]
use std::sync::Arc;

use crate::claude_login::{AuthStatus, CliContext, LoginPhase};

pub static COMMANDS: &[HostCommand] = &[
    command!("claude_credentials_exist", claude_credentials_exist),
    command!("claude_login_start", claude_login_start),
    command!("claude_login_submit_code", claude_login_submit_code),
    command!("claude_login_state", claude_login_state),
    command!("claude_login_cancel", claude_login_cancel),
    command!("claude_auth_status", claude_auth_status),
    command!("claude_logout", claude_logout),
];

/// `~/.aide/claude/.credentials.json` 是否存在——claude.exe OAuth 登录成功后会把 token 写到这里
/// （CLAUDE_CONFIG_DIR 由 runtime 强制指向 ~/.aide/claude/）。
///
/// 引导登录步用它判断"已登录 → 自动跳过"；上下文兜底用它判断"无凭证 → 拦截首条消息"。
/// 只查文件存在性，不读不解析（格式由 claude.exe 自管，逆向脆弱）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCredentialsExistArgs {
}

async fn claude_credentials_exist(_core: Arc<Core>, a: ClaudeCredentialsExistArgs) -> Result<bool, String> {
    let _ = a;
    blocking(move || -> Result<bool, String> { Ok((|| -> bool {
    std::fs::metadata(crate::paths::claude_home().join(".credentials.json")).is_ok()
})()) }).await
}

/// 起随包 claude CLI 需要的上下文：二进制在哪（前门回答）、Aide 自管的 claude home、
/// 代理（与 sidecar 进程同一份来源——WSL 这类不走代理就连不上 Anthropic 的机器靠它）。
async fn cli_context(core: &Arc<Core>) -> Result<CliContext, String> {
    let exe = core
        .resources
        .claude_exe()
        .ok_or_else(|| "这台 Host 上没有随包的 claude CLI，无法用账号登录（可改用 API key）".to_string())?;
    let settings = core.settings.clone();
    let proxy = blocking(move || Ok(crate::app_settings::public_settings(&settings)?.proxy)).await?;
    let mut env = core.resources.agent_env();
    env.extend(crate::runtime::env::runtime_process_env(&proxy));
    Ok(CliContext { exe, config_dir: crate::paths::claude_home(), env })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLoginStartArgs {
    /// 让 CLI 在 Host 上开浏览器并自己接回调（本机 Host）。false = GUI 不在这台机器上，
    /// 由 GUI 打开返回的链接、用户粘贴授权码（WSL / SSH Host）。
    #[serde(default)]
    open_on_host: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartResult {
    pub authorize_url: String,
}

/// 开始用 Claude 账号登录，返回登录链接。之后轮询 `claude_login_state`。
async fn claude_login_start(core: Arc<Core>, a: ClaudeLoginStartArgs) -> Result<LoginStartResult, String> {
    let ctx = cli_context(&core).await?;
    let authorize_url = core.claude_login.start(&ctx, a.open_on_host).await?;
    Ok(LoginStartResult { authorize_url })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLoginSubmitCodeArgs {
    code: String,
}

/// 把登录页最后给的授权码交给 CLI（成败看 `claude_login_state`）。
async fn claude_login_submit_code(core: Arc<Core>, a: ClaudeLoginSubmitCodeArgs) -> Result<(), String> {
    core.claude_login.submit_code(&a.code).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoArgs {}

async fn claude_login_state(core: Arc<Core>, _a: NoArgs) -> Result<LoginPhase, String> {
    Ok(core.claude_login.phase())
}

async fn claude_login_cancel(core: Arc<Core>, _a: NoArgs) -> Result<(), String> {
    core.claude_login.cancel().await;
    Ok(())
}

/// 这台 Host 上的 Claude 账号登录状态（问 CLI）。
async fn claude_auth_status(core: Arc<Core>, _a: NoArgs) -> Result<AuthStatus, String> {
    crate::claude_login::status(&cli_context(&core).await?).await
}

async fn claude_logout(core: Arc<Core>, _a: NoArgs) -> Result<(), String> {
    core.claude_login.cancel().await;
    crate::claude_login::logout(&cli_context(&core).await?).await
}
