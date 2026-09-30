//! `aide-host lsp` 的端到端：真起二进制，候选里第一个找不到、第二个是 `cat`（回声服务器）
//! ——验证①按序挑候选 ②首行之后的字节原样透传（含首行同一次写入里已缓冲的部分）。
#![cfg(unix)]

use std::io::{Read, Write};
use std::process::{Command, Stdio};

#[test]
fn lsp_mode_picks_a_candidate_and_passes_bytes_through() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_aide-host"))
        .arg("lsp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn aide-host lsp");
    let frame = "Content-Length: 17\r\n\r\n{\"jsonrpc\":\"2.0\"}";
    {
        let mut stdin = child.stdin.take().unwrap();
        // 首行与第一帧同一次写入：BufReader 读首行时会把帧也吞进缓冲，不许丢。
        let init = r#"{"candidates":[["no-such-language-server-xyz"],["cat"]],"cwd":"/"}"#;
        write!(stdin, "{init}\n{frame}").unwrap();
    } // 关 stdin → cat 读到 EOF 退出
    let mut out = String::new();
    child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
    let status = child.wait().unwrap();
    assert_eq!(out, frame);
    assert!(status.success(), "{status:?}");
}

#[test]
fn lsp_mode_without_any_server_exits_127_and_says_what_it_tried() {
    let out = Command::new(env!("CARGO_BIN_EXE_aide-host"))
        .arg("lsp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut c| {
            c.stdin
                .take()
                .unwrap()
                .write_all(br#"{"candidates":[["no-such-ls-a"],["no-such-ls-b","--stdio"]],"cwd":"/"}"#)?;
            c.wait_with_output()
        })
        .expect("run aide-host lsp");
    assert_eq!(out.status.code(), Some(127));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("no-such-ls-a") && err.contains("no-such-ls-b"), "{err}");
}
