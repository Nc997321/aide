//! 远程语言服务器的 stdio 翻译层：桌面 LspManager ⇄（本层）⇄ `aide-host lsp` 管道。
//!
//! LspManager 按**桌面形态**管理工作区（`\\wsl.localhost\Debian\home\u\p`，URI 为
//! `file:////wsl.localhost/Debian/home/u/p/…`），而目标机上的服务器只认目标机路径
//! （`file:///home/u/p/…`）。本层解帧、改写 JSON 里的 URI / 路径、重新成帧——LspManager
//! 与 transport 一行不改，远程服务器对它们就是「又一个 stdio 进程」。
//!
//! 改写规则（两个方向都**不碰文本字段**：文档正文、hover markdown、诊断消息、补全文本
//! 里出现的路径是内容，不是协议字段——改了就是篡改用户代码）：
//! - 桌面 → 目标机：以桌面 URI 前缀开头的串换成 `file://` + POSIX；桌面形态的普通路径
//!   （initializationOptions 里的 SDK 路径等）换成 POSIX。
//! - 目标机 → 桌面：`file:///…` 换成桌面 URI 前缀 + 同一 POSIX 尾巴。
//! - 对象的**键**同样改写（`WorkspaceEdit.changes` 以 URI 为键）。

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};

use super::path::{self as rpath, HostId};
use crate::lsp::transport::{format_frame, Framer};

/// 值是**内容**而非协议字段的键：不改写。
const TEXT_KEYS: &[&str] = &[
    "text",
    "newText",
    "insertText",
    "label",
    "detail",
    "documentation",
    "value",
    "message",
    "contents",
];

/// 桌面侧该主机的 URI 前缀（不带尾斜杠）：`file:////wsl.localhost/Debian`。
/// 与 `lsp::protocol::path_to_uri` 对桌面形态路径的产出逐字一致（测试钉住）。
pub fn desktop_uri_prefix(host: &HostId) -> String {
    crate::lsp::protocol::path_to_uri(&host.desktop_prefix())
}

#[derive(Clone, Copy)]
enum Dir {
    ToTarget,
    ToDesktop,
}

fn rewrite_str(host: &HostId, prefix: &str, s: &str, dir: Dir) -> Option<String> {
    match dir {
        Dir::ToTarget => {
            if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
                let tail = &s[prefix.len()..];
                if tail.is_empty() || tail.starts_with('/') {
                    return Some(format!("file://{}", if tail.is_empty() { "/" } else { tail }));
                }
            }
            match rpath::parse(s) {
                Some((h, posix)) if &h == host => Some(posix),
                _ => None,
            }
        }
        Dir::ToDesktop => s
            .strip_prefix("file:///")
            .map(|rest| format!("{prefix}/{rest}")),
    }
}

fn rewrite(host: &HostId, prefix: &str, v: &mut Value, dir: Dir) {
    match v {
        Value::String(s) => {
            if let Some(n) = rewrite_str(host, prefix, s, dir) {
                *s = n;
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| rewrite(host, prefix, x, dir)),
        Value::Object(o) => {
            let old = std::mem::take(o);
            for (k, mut val) in old {
                if !TEXT_KEYS.contains(&k.as_str()) {
                    rewrite(host, prefix, &mut val, dir);
                }
                let key = rewrite_str(host, prefix, &k, dir).unwrap_or(k);
                o.insert(key, val);
            }
        }
        _ => {}
    }
}

/// 桌面发出的一条消息 → 目标机形态。
pub fn to_target(host: &HostId, v: &mut Value) {
    rewrite(host, &desktop_uri_prefix(host), v, Dir::ToTarget);
}

/// 服务器发来的一条消息 → 桌面形态。
pub fn to_desktop(host: &HostId, v: &mut Value) {
    rewrite(host, &desktop_uri_prefix(host), v, Dir::ToDesktop);
}

/// 在子进程的 stdin/stdout 上套翻译层。返回（给 LspManager 写的一端，给它读的一端）。
/// 任一方向断开 → 对应任务结束、另一端随之 EOF（LspManager 的 reader 据此判定 server 死亡）。
pub fn translate<W, R>(host: HostId, mut child_in: W, mut child_out: R) -> (DuplexStream, DuplexStream)
where
    W: AsyncWrite + Unpin + Send + 'static,
    R: AsyncRead + Unpin + Send + 'static,
{
    let (mgr_write, mut from_mgr) = tokio::io::duplex(1 << 20);
    let (mut to_mgr, mgr_read) = tokio::io::duplex(1 << 20);
    let h_out = host.clone();
    tokio::spawn(async move {
        let mut framer = Framer::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = match from_mgr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for mut msg in framer.feed(&buf[..n]) {
                to_target(&h_out, &mut msg);
                if child_in.write_all(&format_frame(&msg)).await.is_err() {
                    return;
                }
            }
            if child_in.flush().await.is_err() {
                return;
            }
        }
        let _ = child_in.shutdown().await;
    });
    tokio::spawn(async move {
        let mut framer = Framer::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = match child_out.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for mut msg in framer.feed(&buf[..n]) {
                to_desktop(&host, &mut msg);
                if to_mgr.write_all(&format_frame(&msg)).await.is_err() {
                    return;
                }
            }
        }
        let _ = to_mgr.shutdown().await;
    });
    (mgr_write, mgr_read)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wsl() -> HostId {
        HostId::Wsl("Debian".into())
    }

    /// 前缀必须与 LspManager 真实产出的 URI 同形——不同形就一条都改不到（静默失效）。
    #[test]
    fn prefix_matches_what_the_manager_produces() {
        let uri = crate::lsp::protocol::path_to_uri("\\\\wsl.localhost\\Debian\\home\\u\\p\\a.rs");
        assert!(uri.starts_with(&desktop_uri_prefix(&wsl())), "{uri}");
        assert_eq!(desktop_uri_prefix(&wsl()), "file:////wsl.localhost/Debian");
    }

    #[test]
    fn outgoing_uris_paths_and_keys_become_target_form_but_text_is_untouched() {
        let mut v = json!({
            "method": "textDocument/didOpen",
            "params": {
                "rootUri": "file:////wsl.localhost/Debian/home/u/p",
                "textDocument": {
                    "uri": "file:////wsl.localhost/Debian/home/u/p/src/a.ts",
                    "text": "// see file:////wsl.localhost/Debian/home/u/p/x"
                },
                "initializationOptions": { "tsserver": { "path": "\\\\wsl.localhost\\Debian\\home\\u\\p\\node_modules\\typescript\\lib" } },
                "changes": { "file:////wsl.localhost/Debian/home/u/p/b.ts": [] },
                "other": "C:\\Users\\x"
            }
        });
        to_target(&wsl(), &mut v);
        let p = &v["params"];
        assert_eq!(p["rootUri"], "file:///home/u/p");
        assert_eq!(p["textDocument"]["uri"], "file:///home/u/p/src/a.ts");
        assert_eq!(p["textDocument"]["text"], "// see file:////wsl.localhost/Debian/home/u/p/x");
        assert_eq!(p["initializationOptions"]["tsserver"]["path"], "/home/u/p/node_modules/typescript/lib");
        assert!(p["changes"].get("file:///home/u/p/b.ts").is_some());
        assert_eq!(p["other"], "C:\\Users\\x", "本机 / 别的主机路径不动");
    }

    #[test]
    fn incoming_uris_become_desktop_form_and_round_trip() {
        let mut v = json!({
            "result": [{ "uri": "file:///home/u/p/src/b.ts", "range": {} }],
            "params": { "diagnostics": [{ "message": "see file:///home/u/p/c.ts" }] }
        });
        to_desktop(&wsl(), &mut v);
        let uri = v["result"][0]["uri"].as_str().unwrap().to_string();
        assert_eq!(uri, "file:////wsl.localhost/Debian/home/u/p/src/b.ts");
        assert_eq!(v["params"]["diagnostics"][0]["message"], "see file:///home/u/p/c.ts");
        // 桌面拿到的 URI 解回路径后仍能被识别为该主机的远程路径
        let back = crate::lsp::protocol::uri_to_path(&uri);
        assert_eq!(rpath::parse(&back), Some((wsl(), "/home/u/p/src/b.ts".into())));
    }

    #[tokio::test]
    async fn pipe_translates_frames_in_both_directions() {
        let (child_in_w, mut child_in_r) = tokio::io::duplex(1 << 16);
        let (mut child_out_w, child_out_r) = tokio::io::duplex(1 << 16);
        let (mut mgr_w, mut mgr_r) = translate(wsl(), child_in_w, child_out_r);

        mgr_w
            .write_all(&format_frame(&json!({"params": {"uri": "file:////wsl.localhost/Debian/home/u/a.rs"}})))
            .await
            .unwrap();
        let mut framer = Framer::new();
        let mut buf = vec![0u8; 4096];
        let n = child_in_r.read(&mut buf).await.unwrap();
        assert_eq!(framer.feed(&buf[..n])[0]["params"]["uri"], "file:///home/u/a.rs");

        child_out_w
            .write_all(&format_frame(&json!({"result": {"uri": "file:///home/u/b.rs"}})))
            .await
            .unwrap();
        let mut framer = Framer::new();
        let n = mgr_r.read(&mut buf).await.unwrap();
        assert_eq!(
            framer.feed(&buf[..n])[0]["result"]["uri"],
            "file:////wsl.localhost/Debian/home/u/b.rs"
        );
    }
}
