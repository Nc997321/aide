//! Rust：rust-analyzer。捆绑 + PATH 发现；init 注入 excludeGlobs。
//!
//! **rust-analyzer 默认即 LSP server**（stdin/stdout 读 Content-Length 帧），不传任何 flag。
//! `--stdio` 从不是 rust-analyzer 的 flag，1.96+ 显式拒绝（`unexpected flag: '--stdio'`）。
//! rustup proxy shim 同理：无 flag 时转发给真 binary 进 LSP；`--stdio` 被 rustup 自身拦截
//! （报 unexpected flag）→ 握手 channel closed。所以 RustProfile 必须覆写 launch_args 为空、
//! supplement_explicit 不补 --stdio，否则 PATH 发现（which 找到 proxy）与用户填 proxy 路径
//! 都会启动失败。

use crate::lsp::registry::ServerProfile;
use serde_json::Value;
use std::path::Path;

pub struct RustProfile;

impl ServerProfile for RustProfile {
    fn bundled(&self) -> Option<(&'static str, &'static str)> {
        Some(("rust", "rust-analyzer"))
    }

    /// rust-analyzer 默认即 LSP（无 flag）；--stdio 会被 1.96+ 拒绝。
    fn launch_args(&self, _data_dir: Option<&Path>) -> Vec<String> {
        vec![]
    }

    /// 不补 --stdio（rust-analyzer 不接受）。用户显式传的 args 原样保留
    /// （兼容旧版 rust-analyzer 或用户确实需要时）。
    fn supplement_explicit(&self, _args: &mut Vec<String>, _data_dir: Option<&Path>) {}

    fn init_options(&self, exclude_globs: &[String]) -> Value {
        serde_json::json!({ "excludeGlobs": exclude_globs })
    }
}