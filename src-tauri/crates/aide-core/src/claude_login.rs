//! Claude 官方账号登录：驱动随包 claude CLI 自己的 `auth login / status / logout`。
//!
//! Aide 不自己实现 OAuth——授权链接、PKCE、换 token、写凭据全是 CLI 的事（client_id 是
//! CLI 专用的，凭据文件格式也归它管）。这里只做三件事：把 CLI 打印的登录链接递给界面；
//! 把用户粘贴的授权码写进 CLI 的输入；等它退出、如实报成败。
//!
//! 登录发生在 **Host** 上（凭据写进这台 Host 的 `~/.aide/claude`，不跨 Host 同步）。浏览器
//! 则在用户面前的机器上：
//!  - 本机 Host：CLI 自己开浏览器，登录完由它起的本地回调接住，用户不用粘贴任何东西；
//!  - WSL / SSH Host：回调到不了目标机，由 GUI 在本机打开登录链接，页面最后给一串授权码，
//!    用户粘贴回来（`submit_code`）。这时不让 CLI 在目标机上尝试开浏览器（`open_on_host`）。
//!
//! 2026-10-12 实测（CLI 2.1.296，无 TTY）：stdout 先打登录链接（OSC 8 超链接包着），然后
//! 停在 `Paste code here if prompted >` 读 stdin；成功退出码 0，失败退出码 1、原因在 stderr。

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as TokioMutex};

/// CLI 起来后多久没打出登录链接就算启动失败。
const URL_TIMEOUT: Duration = Duration::from_secs(20);
/// 一次登录最多等多久（用户去浏览器里操作的时间）。到点收掉进程，不留孤儿。
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

/// 一次登录走到哪了（界面轮询）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum LoginPhase {
    /// 没有进行中的登录。
    Idle,
    /// CLI 在等浏览器回调或授权码。
    Waiting,
    Succeeded,
    Failed { error: String },
}

/// `claude auth status --json` 里界面用得上的部分。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    /// `claude.ai`（订阅）/ `console`（API 计费）/ `none`…——CLI 的原值，不解释。
    pub auth_method: String,
    pub email: Option<String>,
    pub subscription_type: Option<String>,
}

/// 起 CLI 需要的东西（调用方从 Core 取齐，本模块不碰设置与端口）。
pub struct CliContext {
    pub exe: PathBuf,
    pub config_dir: PathBuf,
    /// 代理等进程级 env（与 sidecar 进程同一份来源）。
    pub env: HashMap<String, String>,
}

struct Running {
    stdin: ChildStdin,
    /// 发一下（或被 drop）= 收掉这次登录。
    cancel: oneshot::Sender<()>,
}

struct Shared {
    phase: LoginPhase,
    /// 每次 `start` 加一：旧登录的收尾不许覆盖新登录的状态。
    generation: u64,
}

pub struct ClaudeLogin {
    shared: Arc<Mutex<Shared>>,
    running: TokioMutex<Option<Running>>,
}

impl Default for ClaudeLogin {
    fn default() -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared { phase: LoginPhase::Idle, generation: 0 })),
            running: TokioMutex::new(None),
        }
    }
}

fn cli_command(ctx: &CliContext, args: &[&str]) -> Command {
    let mut cmd = Command::new(&ctx.exe);
    cmd.args(args)
        .envs(&ctx.env)
        .env("CLAUDE_CONFIG_DIR", &ctx.config_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd
}

/// 从 CLI 的一行输出里取登录链接。链接被 OSC 8 超链接序列包着（`ESC]8;;URL ESC\文字…`），
/// 所以取到第一个控制字符 / 空白为止。
pub fn extract_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url: String = line[start..]
        .chars()
        .take_while(|c| !c.is_control() && !c.is_whitespace())
        .collect();
    (url.len() > "https://".len()).then_some(url)
}

/// stderr 里给用户看的失败原因：取最后一个非空行（前面可能有警告），没有就给兜底。
fn failure_reason(stderr: &str) -> String {
    stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .map(str::to_string)
        .unwrap_or_else(|| "登录没有完成".to_string())
}

pub fn parse_status(json: &str) -> Result<AuthStatus, String> {
    let v: serde_json::Value =
        serde_json::from_str(json.trim()).map_err(|e| format!("读不懂 claude auth status 的输出：{e}"))?;
    let text = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Ok(AuthStatus {
        logged_in: v.get("loggedIn").and_then(|x| x.as_bool()).unwrap_or(false),
        auth_method: text("authMethod").unwrap_or_default(),
        email: text("email"),
        subscription_type: text("subscriptionType"),
    })
}

impl ClaudeLogin {
    pub fn phase(&self) -> LoginPhase {
        self.shared.lock().unwrap().phase.clone()
    }

    /// 开始一次登录，返回登录链接。已有进行中的登录会被收掉（用户重点了一次按钮）。
    /// `open_on_host = false`：不让 CLI 在这台机器上开浏览器（GUI 不在这台机器上）。
    pub async fn start(&self, ctx: &CliContext, open_on_host: bool) -> Result<String, String> {
        let mut running = self.running.lock().await;
        running.take(); // drop 旧的 cancel sender → 旧登录的看守收掉进程
        let generation = {
            let mut shared = self.shared.lock().unwrap();
            shared.generation += 1;
            shared.phase = LoginPhase::Waiting;
            shared.generation
        };

        let mut cmd = cli_command(ctx, &["auth", "login", "--claudeai"]);
        if !open_on_host {
            // CLI 用 BROWSER 指定的程序开链接；给个什么都不做的，它就只打印链接。
            // 只有 unix 的远程 Host 走这里（本机 Host 恒 open_on_host）。
            #[cfg(unix)]
            cmd.env("BROWSER", "true");
        }
        let mut child = cmd.spawn().map_err(|e| {
            self.finish(generation, LoginPhase::Idle);
            format!("启动 claude CLI 失败：{e}")
        })?;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");

        // stdout：找到登录链接就交回，之后继续读到 EOF（不读的话管道写满会卡住 CLI）。
        let (url_tx, url_rx) = oneshot::channel::<String>();
        tokio::spawn(async move {
            let mut url_tx = Some(url_tx);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                // 先看这行有没有链接，再取 sender：反过来写会在第一行（没链接）就把它丢掉。
                if let Some(url) = extract_url(&line) {
                    if let Some(tx) = url_tx.take() {
                        let _ = tx.send(url);
                    }
                }
            }
        });
        let stderr_task = tokio::spawn(async move {
            let mut buf = String::new();
            let _ = stderr.read_to_string(&mut buf).await;
            buf
        });

        // 看守：等进程退出 / 被取消 / 超时，落终态。
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let shared = Arc::clone(&self.shared);
        tokio::spawn(async move {
            let outcome = tokio::select! {
                status = child.wait() => Some(status),
                _ = cancel_rx => None,
                _ = tokio::time::sleep(LOGIN_TIMEOUT) => {
                    let _ = child.kill().await;
                    set_phase(&shared, generation, LoginPhase::Failed {
                        error: "登录超时（10 分钟内没有完成），请重新开始".to_string(),
                    });
                    return;
                }
            };
            let Some(status) = outcome else {
                // 被取消（或被新的一次登录顶掉）：收掉进程；状态由取消方 / 新登录负责。
                let _ = child.kill().await;
                return;
            };
            let stderr = stderr_task.await.unwrap_or_default();
            let phase = match status {
                Ok(s) if s.success() => LoginPhase::Succeeded,
                Ok(_) => LoginPhase::Failed { error: failure_reason(&stderr) },
                Err(e) => LoginPhase::Failed { error: format!("等待 claude CLI 退出失败：{e}") },
            };
            set_phase(&shared, generation, phase);
        });

        match tokio::time::timeout(URL_TIMEOUT, url_rx).await {
            Ok(Ok(url)) => {
                *running = Some(Running { stdin, cancel: cancel_tx });
                Ok(url)
            }
            // stdout 关了还没见到链接 = 进程起来就退了：等看守按 stderr 落终态，拿它的原因。
            Ok(Err(_)) => {
                for _ in 0..100 {
                    if self.phase() != LoginPhase::Waiting {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                drop(cancel_tx);
                let reason = match self.phase() {
                    LoginPhase::Failed { error } => error,
                    _ => "claude CLI 没有给出登录链接".to_string(),
                };
                self.finish(generation, LoginPhase::Idle);
                Err(reason)
            }
            Err(_) => {
                drop(cancel_tx);
                self.finish(generation, LoginPhase::Idle);
                Err("claude CLI 迟迟没有给出登录链接".to_string())
            }
        }
    }

    /// 把用户粘贴的授权码交给 CLI。结果不在这里返回——看 `phase()`。
    pub async fn submit_code(&self, code: &str) -> Result<(), String> {
        let code = code.trim();
        if code.is_empty() {
            return Err("授权码是空的".to_string());
        }
        let mut running = self.running.lock().await;
        let Some(r) = running.as_mut() else {
            return Err("没有进行中的登录，请重新开始".to_string());
        };
        r.stdin
            .write_all(format!("{code}\n").as_bytes())
            .await
            .map_err(|e| format!("把授权码交给 claude CLI 失败：{e}"))?;
        r.stdin.flush().await.map_err(|e| e.to_string())
    }

    /// 放弃这次登录。
    pub async fn cancel(&self) {
        if let Some(r) = self.running.lock().await.take() {
            let _ = r.cancel.send(());
        }
        let mut shared = self.shared.lock().unwrap();
        shared.generation += 1; // 让还没收尾的看守写不进来
        shared.phase = LoginPhase::Idle;
    }

    fn finish(&self, generation: u64, phase: LoginPhase) {
        set_phase(&self.shared, generation, phase);
    }
}

fn set_phase(shared: &Mutex<Shared>, generation: u64, phase: LoginPhase) {
    let mut shared = shared.lock().unwrap();
    if shared.generation == generation {
        shared.phase = phase;
    }
}

async fn run_to_end(ctx: &CliContext, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = cli_command(ctx, args);
    cmd.stdin(Stdio::null());
    tokio::time::timeout(Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| "claude CLI 没有响应".to_string())?
        .map_err(|e| format!("启动 claude CLI 失败：{e}"))
}

/// 这台 Host 上的登录状态（问 CLI，不自己读凭据文件）。
pub async fn status(ctx: &CliContext) -> Result<AuthStatus, String> {
    let out = run_to_end(ctx, &["auth", "status", "--json"]).await?;
    parse_status(&String::from_utf8_lossy(&out.stdout))
}

pub async fn logout(ctx: &CliContext) -> Result<(), String> {
    let out = run_to_end(ctx, &["auth", "logout"]).await?;
    if out.status.success() {
        Ok(())
    } else {
        Err(failure_reason(&String::from_utf8_lossy(&out.stderr)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn ctx_for(exe: &Path) -> CliContext {
        CliContext { exe: exe.to_path_buf(), config_dir: std::env::temp_dir(), env: HashMap::new() }
    }

    /// 2026-10-12 从 CLI 2.1.296 抓的原样输出（参数已截短）：链接被 OSC 8 序列包了两遍。
    #[test]
    fn extracts_the_url_out_of_the_osc8_hyperlink() {
        let line = "If the browser didn't open, visit: \u{1b}]8;;https://claude.com/cai/oauth/authorize?code=true&state=abc\u{1b}\\https://claude.com/cai/oauth/authorize?code=true&state=abc\u{1b}]8;;\u{1b}\\";
        assert_eq!(
            extract_url(line).as_deref(),
            Some("https://claude.com/cai/oauth/authorize?code=true&state=abc")
        );
        assert_eq!(extract_url("Opening browser to sign in…"), None);
        assert_eq!(extract_url("see https://"), None);
    }

    #[test]
    fn status_json_maps_to_what_the_ui_shows() {
        let s = parse_status(
            r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"pro","orgId":"x"}"#,
        )
        .unwrap();
        assert!(s.logged_in);
        assert_eq!(s.auth_method, "claude.ai");
        assert_eq!(s.email.as_deref(), Some("a@b.c"));
        assert_eq!(s.subscription_type.as_deref(), Some("pro"));

        let out = parse_status(r#"{"loggedIn":false,"authMethod":"none"}"#).unwrap();
        assert_eq!(out, AuthStatus { auth_method: "none".into(), ..Default::default() });
        assert!(parse_status("not json").is_err());
    }

    #[test]
    fn failure_reason_is_the_last_stderr_line() {
        assert_eq!(
            failure_reason("warning: x\nLogin failed: Request failed with status code 400\n\n"),
            "Login failed: Request failed with status code 400"
        );
        assert_eq!(failure_reason(""), "登录没有完成");
    }

    /// 对着**真的** claude CLI 验证我们依赖的输出形态（登录链接、status 的 JSON）——升级 SDK
    /// 后跑一遍，CLI 改了输出这里先红。不登录、不碰真实凭据（配置目录是临时的）。
    /// `AIDE_CLAUDE_EXE=<claude 路径> cargo test -p aide-core --lib real_cli -- --ignored`
    #[tokio::test]
    #[ignore = "needs AIDE_CLAUDE_EXE pointing at the bundled claude CLI"]
    async fn real_cli_prints_a_login_link_and_reports_status() {
        let exe = PathBuf::from(std::env::var("AIDE_CLAUDE_EXE").expect("set AIDE_CLAUDE_EXE"));
        let config_dir = std::env::temp_dir().join(format!("aide-claude-login-real-{}", std::process::id()));
        std::fs::create_dir_all(&config_dir).unwrap();
        let ctx = CliContext { exe, config_dir, env: HashMap::new() };

        let st = status(&ctx).await.unwrap();
        assert!(!st.logged_in, "fresh config dir must be logged out: {st:?}");

        let login = ClaudeLogin::default();
        let url = login.start(&ctx, false).await.unwrap();
        assert!(url.starts_with("https://") && url.contains("oauth"), "{url}");
        assert_eq!(login.phase(), LoginPhase::Waiting);
        login.cancel().await;
        assert_eq!(login.phase(), LoginPhase::Idle);
    }

    /// 用一个假 CLI（shell 脚本）走完整条流程：打链接 → 读授权码 → 按授权码决定成败。
    #[cfg(unix)]
    mod with_fake_cli {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn fake_cli(name: &str, body: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("aide-claude-login-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("claude");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        const PASTE_FLOW: &str = r#"echo "Opening browser to sign in…"
printf 'If the browser did not open, visit: \033]8;;https://example.test/authorize?state=s\033\\link\033]8;;\033\\\n'
printf 'Paste code here if prompted > '
read code
if [ "$code" = "good" ]; then exit 0; fi
echo "Login failed: bad code" >&2
exit 1"#;

        async fn wait_for_end(login: &ClaudeLogin) -> LoginPhase {
            for _ in 0..200 {
                match login.phase() {
                    LoginPhase::Waiting => tokio::time::sleep(Duration::from_millis(20)).await,
                    done => return done,
                }
            }
            panic!("login never left Waiting");
        }

        #[tokio::test]
        async fn pasted_code_completes_the_login() {
            let login = ClaudeLogin::default();
            let url = login.start(&ctx_for(&fake_cli("ok", PASTE_FLOW)), false).await.unwrap();
            assert_eq!(url, "https://example.test/authorize?state=s");
            assert_eq!(login.phase(), LoginPhase::Waiting);
            login.submit_code("  good ").await.unwrap();
            assert_eq!(wait_for_end(&login).await, LoginPhase::Succeeded);
        }

        #[tokio::test]
        async fn a_rejected_code_reports_the_cli_reason() {
            let login = ClaudeLogin::default();
            login.start(&ctx_for(&fake_cli("bad", PASTE_FLOW)), false).await.unwrap();
            login.submit_code("nope").await.unwrap();
            assert_eq!(
                wait_for_end(&login).await,
                LoginPhase::Failed { error: "Login failed: bad code".into() }
            );
        }

        #[tokio::test]
        async fn cancel_returns_to_idle_and_a_late_code_is_refused() {
            let login = ClaudeLogin::default();
            login.start(&ctx_for(&fake_cli("cancel", PASTE_FLOW)), false).await.unwrap();
            login.cancel().await;
            assert_eq!(login.phase(), LoginPhase::Idle);
            assert!(login.submit_code("good").await.is_err());
        }

        #[tokio::test]
        async fn a_cli_that_dies_before_printing_a_link_fails_with_its_reason() {
            let login = ClaudeLogin::default();
            let exe = fake_cli("dies", "echo 'no network' >&2\nexit 1");
            let err = login.start(&ctx_for(&exe), false).await.unwrap_err();
            assert_eq!(err, "no network");
        }

        #[tokio::test]
        async fn a_missing_cli_is_reported_and_leaves_no_login_running() {
            let login = ClaudeLogin::default();
            let err = login.start(&ctx_for(Path::new("/nonexistent/claude")), false).await.unwrap_err();
            assert!(err.contains("启动 claude CLI 失败"), "{err}");
            assert_eq!(login.phase(), LoginPhase::Idle);
        }
    }
}
