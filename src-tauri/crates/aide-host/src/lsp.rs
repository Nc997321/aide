//! `aide-host lsp`：在目标机上起一个语言服务器，然后把 stdio 原样透传。
//!
//! 与 `agent` 同构（一条独立的 wsl/ssh 管道，对面就是那个进程的原生协议）：LSP 帧不进
//! serve 的 JSON-RPC 多路复用——桌面的 LspManager 整套（分帧、请求表、reader、诊断）直接复用，
//! 只需要一条「对面就是语言服务器」的管道。
//!
//! 首行 [`LspInit`]：候选命令按序在**登录环境**的 PATH 上找（rustup / nvm / pipx 装的
//! 服务器都只在那里），找到第一个就用。一个都没有 → 退出码 127 + stderr 说清试了什么
//! （桌面把 stderr 拼进握手失败的原因，用户看得到该装什么）。

use std::process::Stdio;

use aide_host::protocol::LspInit;
use tokio::io::{AsyncBufReadExt, BufReader};

pub async fn run() -> i32 {
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut first = String::new();
    if stdin.read_line(&mut first).await.unwrap_or(0) == 0 {
        eprintln!("[aide-host lsp] no init line");
        return 2;
    }
    let init: LspInit = match serde_json::from_str(first.trim()) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("[aide-host lsp] bad init line: {e}");
            return 2;
        }
    };
    let login = crate::login::login_env().await;
    let Some((program, args)) = pick(&init.candidates, |name| crate::login::which(name, login.as_ref()))
    else {
        let tried: Vec<&str> = init
            .candidates
            .iter()
            .filter_map(|c| c.first().map(String::as_str))
            .collect();
        eprintln!(
            "[aide-host lsp] no language server found on this machine (tried: {}). \
             Install one and make sure it is on the PATH of your login shell.",
            tried.join(", ")
        );
        return 127;
    };

    let mut cmd = tokio::process::Command::new(&program);
    if let Some(env) = &login {
        cmd.env_clear().envs(env);
    }
    cmd.args(&args)
        .current_dir(&init.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[aide-host lsp] failed to start `{program}`: {e}");
            return 127;
        }
    };
    let mut child_in = child.stdin.take().expect("piped");
    let mut child_out = child.stdout.take().expect("piped");
    // 桌面 → server：BufReader 里首行之后已缓冲的字节会先被 copy 吐出，不丢帧。
    // 桌面断开（EOF）→ 关掉 server 的 stdin；多数 server 随之退出，不退的由 kill_on_drop 收。
    let upstream = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut stdin, &mut child_in).await;
    });
    let downstream = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        let _ = tokio::io::copy(&mut child_out, &mut out).await;
    });
    let status = tokio::select! {
        s = child.wait() => s.ok().and_then(|s| s.code()).unwrap_or(1),
        _ = upstream => {
            // 桌面走了：给 server 一点时间自己退出，再强杀。
            match tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await {
                Ok(Ok(s)) => s.code().unwrap_or(0),
                _ => {
                    let _ = child.kill().await;
                    0
                }
            }
        }
    };
    let _ = downstream.await;
    status
}

/// 候选里第一个找得到的：返回（解析后的程序路径，其余参数）。
fn pick(
    candidates: &[Vec<String>],
    which: impl Fn(&str) -> Option<String>,
) -> Option<(String, Vec<String>)> {
    candidates.iter().find_map(|c| {
        let (name, rest) = c.split_first()?;
        which(name).map(|p| (p, rest.to_vec()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_resolvable_candidate_wins() {
        let cands = vec![
            vec!["missing-ls".to_string(), "--stdio".to_string()],
            vec!["rust-analyzer".to_string()],
            vec!["also-here".to_string()],
        ];
        let got = pick(&cands, |n| (n != "missing-ls").then(|| format!("/usr/bin/{n}")));
        assert_eq!(got, Some(("/usr/bin/rust-analyzer".to_string(), vec![])));
        assert!(pick(&cands, |_| None).is_none());
        assert!(pick(&[vec![]], |n| Some(n.to_string())).is_none(), "空 argv 不是候选");
    }
}
